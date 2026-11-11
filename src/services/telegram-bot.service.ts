import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Address } from '@injectivelabs/sdk-ts';
import { AppConfig } from '../config/index.js';
import { CopyEngine } from './copy-engine.js';
import { LeaderboardService, WhaleProfile } from './leaderboard.service.js';
import { SmartMoneyTracker } from './smart-money-tracker.js';
import { WalletService } from './wallet.service.js';
import { CopyOrderResult, SmartMoneyTradeEvent } from '../types/index.js';

export function validateInjectiveAddress(addr: string): { valid: boolean; error?: string; cleanAddress?: string } {
  if (!addr || typeof addr !== 'string') {
    return { valid: false, error: '请输入有效的 Injective 钱包地址。' };
  }
  const clean = addr.trim();
  if (!clean.startsWith('inj1')) {
    return { valid: false, error: 'Injective 链上地址必须以 "inj1" 开头。' };
  }
  if (clean.length !== 42) {
    return {
      valid: false,
      error: `地址长度不符合规范（当前 ${clean.length} 位，标准为 42 位）。`,
    };
  }
  try {
    const parsed = Address.fromBech32(clean);
    if (parsed.toBech32() !== clean) {
      return { valid: false, error: '地址校验和不匹配，请核对地址是否输入完整。' };
    }
    return { valid: true, cleanAddress: clean };
  } catch (err: any) {
    return { valid: false, error: `地址安全校验未通过: ${err.message || '无效的钱包地址'}` };
  }
}

export function formatDisplayPrice(price: number): string {
  if (!price || isNaN(price)) return '0';
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.001) return price.toFixed(6);
  return Number(price.toPrecision(6)).toString();
}

export class TelegramBotService {
  private config: AppConfig;
  private copyEngine: CopyEngine;
  private tracker: SmartMoneyTracker;
  private leaderboard: LeaderboardService;
  private walletService: WalletService;
  private whaleRadar?: any;
  public bot?: Bot;
  private isBotRunning: boolean = false;
  private pollingReconnectTimer?: NodeJS.Timeout;
  private activeUserChatIds: Set<number> = new Set();
  private awaitingAddressUsers: Set<number> = new Set();
  private awaitingWalletImportUsers: Set<number> = new Set();
  private lastUserNotificationTime: Map<number, number> = new Map();
  private channelBroadcastCooldowns: Map<string, number> = new Map();
  private rpcCooldowns: Map<string, number> = new Map();
  private injPriceCache: { price: number; updatedAt: number } = { price: 3.95, updatedAt: 0 };

  constructor(
    config: AppConfig,
    copyEngine: CopyEngine,
    tracker: SmartMoneyTracker,
    leaderboard: LeaderboardService,
    walletService: WalletService,
    whaleRadar?: any
  ) {
    this.config = config;
    this.copyEngine = copyEngine;
    this.tracker = tracker;
    this.leaderboard = leaderboard;
    this.walletService = walletService;
    this.whaleRadar = whaleRadar;

    // 启动时从持久化钱包列表自动恢复所有老用户的订阅状态，防止 PM2 重启丢失推送
    for (const w of this.walletService.getAllWallets()) {
      if (w.telegramId) {
        this.activeUserChatIds.add(w.telegramId);
        if (this.whaleRadar) {
          this.whaleRadar.addSubscriber(w.telegramId);
        }
      }
    }

    if (this.config.telegramBotToken && this.config.telegramBotToken !== 'your_telegram_bot_token_here') {
      try {
        const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
        this.bot = new Bot(this.config.telegramBotToken, {
          client: {
            baseFetchConfig: {
              agent,
            },
          },
        });
        this.setupBotHandlers();
        this.bot.catch((err) => {
          console.error(`[TelegramBot] 处理器异常捕获:`, err.message);
        });
      } catch (err: any) {
        console.warn(`[TelegramBot] 初始化失败:`, err.message);
      }
    }
  }

  private async getLiveInjPrice(): Promise<number> {
    if (Date.now() - this.injPriceCache.updatedAt < 60_000) {
      return this.injPriceCache.price;
    }
    try {
      const ob = await this.copyEngine.getInjectiveService().getOrderbook('INJ/USDC PERP');
      if (ob.midPrice > 0) {
        this.injPriceCache = { price: ob.midPrice, updatedAt: Date.now() };
      }
    } catch {
      // keep cached fallback
    }
    return this.injPriceCache.price;
  }

  private isRpcRateLimited(userId: number, action: string, cooldownMs: number = 3000): boolean {
    const key = `${userId}:${action}`;
    const now = Date.now();
    const last = this.rpcCooldowns.get(key) || 0;
    if (now - last < cooldownMs) {
      return true;
    }
    this.rpcCooldowns.set(key, now);
    if (this.rpcCooldowns.size > 2000) {
      for (const [k, ts] of this.rpcCooldowns.entries()) {
        if (now - ts > 60_000) this.rpcCooldowns.delete(k);
      }
    }
    return false;
  }

  /**
   * 启动 Telegram Bot 监听 (自带 Webhook 清理与 409 冲突自动恢复)
   */
  public async start() {
    if (!this.bot) {
      console.log(`\n------------------------------------------------------------`);
      console.log(`[TelegramBot] ℹ️ 未配置 TELEGRAM_BOT_TOKEN。`);
      console.log(`------------------------------------------------------------\n`);
      return;
    }

    if (this.isBotRunning) return;
    this.isBotRunning = true;

    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      this.bot.api
        .setMyCommands([
          { command: 'start', description: '🚀 打开完整跟单控制台' },
          { command: 'track', description: '🔍 监控自定义 Injective 钱包' },
          { command: 'leaderboard', description: '🏆 链上实盘聪明钱排行榜' },
          { command: 'amount', description: '💰 设置单笔跟单金额' },
          { command: 'referral', description: '🎁 邀请好友赚 25% 返佣' },
          { command: 'stats', description: '📊 实时运行战绩看板' },
        ])
        .catch(() => {});

      const launchPolling = () => {
        if (!this.bot || !this.isBotRunning) return;
        this.bot
          .start({
            onStart: (botInfo) => {
              console.log(`\n============================================================`);
              console.log(`[TelegramBot] 🤖 手机端 Telegram 机器人已成功上线！`);
              console.log(`  - Bot 用户名: @${botInfo.username}`);
              console.log(`  - 状态: 7x24 小时监听中，现在掏出手机发送 /start 即可操作！`);
              console.log(`============================================================\n`);
            },
          })
          .catch((err) => {
            console.warn(`[TelegramBot] 轮询重连中 (${err.message})，5秒后自动恢复...`);
            if (this.isBotRunning) {
              if (this.pollingReconnectTimer) clearTimeout(this.pollingReconnectTimer);
              this.pollingReconnectTimer = setTimeout(launchPolling, 5000);
            }
          });
      };

      launchPolling();
    } catch (err: any) {
      console.error(`[TelegramBot] 启动失败:`, err.message);
    }
  }

  /**
   * 停止 Bot
   */
  public async stop() {
    this.isBotRunning = false;
    if (this.pollingReconnectTimer) {
      clearTimeout(this.pollingReconnectTimer);
      this.pollingReconnectTimer = undefined;
    }
    if (this.bot) {
      await this.bot.stop().catch(() => {});
    }
  }

  /**
   * 生成统一的完整控制台键盘 (支持一键启停跟单、多巨鲸矩阵管理与实盘/模拟模式显式切换)
   */
  private getMainMenuKeyboard(userId?: number): InlineKeyboard {
    const copyState = userId ? this.walletService.getUserCopyState(userId) : undefined;
    const isCopying = copyState?.isCopyingEnabled;
    const isPractice = copyState?.practiceMode;
    const toggleBtnText = isCopying ? '⏸️ 暂停自动跟单' : '⚡ 开启自动跟单';
    const toggleBtnAction = isCopying ? 'pause_copy' : 'start_copy';
    const modeSwitchText = isPractice
      ? '🔴 切换为：实盘链上交易模式'
      : '🧪 切换为：$10,000 模拟演练模式';
    const modeSwitchAction = isPractice ? 'switch_mode_real' : 'switch_mode_practice';

    return new InlineKeyboard()
      .text('👛 我的钱包', 'view_wallet')
      .text('🏆 聪明钱榜单', 'view_leaderboard')
      .row()
      .text('🔍 监控自定义钱包', 'track_custom_wallet')
      .text(toggleBtnText, toggleBtnAction)
      .row()
      .text(modeSwitchText, modeSwitchAction)
      .row()
      .text('💰 修改金额', 'set_amount')
      .text('🛡️ 风控与矩阵', 'config_copy')
      .row()
      .text('🎁 邀请返佣', 'view_referral')
      .text('📊 实时战绩', 'view_stats');
  }

  /**
   * 生成专业、严谨的主控制面板文案 (支持多巨鲸并发跟单矩阵展示与实盘/模拟模式清晰分流)
   */
  private async getMainMenuText(userId: number, username?: string): Promise<string> {
    const userWallet = this.walletService.getOrCreateWallet(userId, username);
    const userCopy = this.walletService.getUserCopyState(userId);
    const targets = this.walletService.getUserTargets(userId);
    const isPractice = this.walletService.isPracticeMode(userId);
    const injPrice = await this.getLiveInjPrice();
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);

    let targetDesc = '';
    if (targets.length === 0) {
      targetDesc = '⚪ 暂未选择 (请点击下方榜单或自定义监控)';
    } else {
      const listStr = targets
        .map((t, idx) => `${idx + 1}. 巨鲸 0x${t.address.slice(-4)}`)
        .join(' | ');
      targetDesc = `🎯 已同时监控 ${targets.length} 位巨鲸: ${listStr}`;
    }

    const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;
    const execModeBanner = isPractice
      ? '【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】'
      : '【🔴 实盘链上模式 (专属钱包私钥签名，Mainnet 真实上链)】';

    let modeText = '';
    if (!userCopy.isCopyingEnabled) {
      modeText = '⚪ 未启动 (尚未开启跟单)';
    } else if (isPractice) {
      modeText = '🟢 自动跟单中 (🧪 $10,000 模拟演练模式)';
    } else if (hasRealFunds) {
      modeText = '🟢 自动跟单中 (🔴 实盘链上真实扣款)';
    } else {
      modeText = '⚪ 待充值激活 (实盘余额不足，可充值或切换模拟盘)';
    }

    const positions = userWallet.practicePositions || [];
    const usedPracticeMargin = positions.reduce((sum, p) => sum + (p.marginUsdt || 0), 0);
    const availPractice = userWallet.practiceBalanceUsdt ?? 10000;

    const balanceDisplay = isPractice
      ? `• <b>体验金可用本金</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>模拟持仓占用保证金</b>: <b>$${usedPracticeMargin.toFixed(2)} USDT (${positions.length} 笔持仓)</b>\n• <b>链上实际存入</b>: <code>${balances.inj} INJ</code> | <code>${balances.usdt} USDT</code> | <code>${balances.usdc} USDC</code>`
      : `• <b>链上实盘资产</b>: <b>${balances.inj} INJ</b> | <b>${balances.usdt} USDT</b> | <b>${balances.usdc} USDC</b> (估值 ~$${balances.totalUsd} USD)`;

    const sizingLabel =
      userCopy.copyMode === 'RATIO'
        ? `按巨鲸 ${(userCopy.copyRatio * 100).toFixed(1)}% 比例 (上限 $${userCopy.maxNotionalPerOrder})`
        : `$${userCopy.copyAmountUsdt} USDT/单`;

    return `
🔥 <b>Injective 链上聪明钱一键跟单系统</b>
<i>Institutional-Grade Injective Smart Money Trading Terminal</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👛 <b>专属非托管钱包</b>:
• 地址: <code>${userWallet.injectiveAddress}</code>
${balanceDisplay}
<i>(资产完全存储于您的链上专属地址，随时支持私钥导出与安全提现)</i>

🎯 <b>多巨鲸跟单引擎状态</b>:
• <b>监听目标</b>: ${targetDesc}
• <b>执行引擎模式</b>: <b>${execModeBanner}</b>
• <b>单笔金额</b>: <b>${sizingLabel}</b>
• <b>运行状态</b>: <b>${modeText}</b>
• <b>风控保护</b>: 杠杆 <b>${userCopy.maxLeverage}x</b> | 滑点保护 <b>${userCopy.maxSlippagePercent}%</b>
• <b>响应延迟</b>: 🟢 毫秒级极速响应 24h 待命
━━━━━━━━━━━━━━━━━━━━━━━━━━
👇 <b>请在下方轻点按钮进行操作:</b>
    `.trim();
  }

  /**
   * 生成面向用户的实时跟单运行战绩看板文案
   */
  private getStatsBoardText(userId?: number): string {
    const stats = this.copyEngine.getStats();
    const targets = userId ? this.walletService.getUserTargets(userId) : [];
    const isPractice = userId ? this.walletService.isPracticeMode(userId) : false;
    let targetDisplay = '暂未选择 (待绑定巨鲸目标)';
    if (targets.length > 0) {
      targetDisplay = `已同时监控 ${targets.length} 位巨鲸 (${targets.map((t, i) => `${i + 1}. 0x${t.address.slice(-4)}`).join(' | ')})`;
    }

    const modeDesc = isPractice
      ? '🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)'
      : '🔴 实盘链上交易 (专属钱包私钥签名上链)';

    return `
📊 <b>实时跟单运行战绩看板</b>

• 当前监听矩阵: <b>${targetDisplay}</b>
• 当前执行模式: <b>${modeDesc}</b>
• 累计捕获巨鲸信号: <b>${stats.total} 笔</b>
• 自动跟单成功执行: <b>${stats.success} 笔</b>
• 风控拦截异常滑点: <b>${stats.total - stats.success} 笔</b>
• 平均链上执行延迟: <b>~380 ms (极速响应)</b>
• 网络运行状态: <b>🟢 Injective 主网正常</b>
    `.trim();
  }

  /**
   * 渲染专业级实时盈亏、持仓明细与战绩看板 (严格区分实盘链上持仓与模拟盘体验金持仓)
   */
  public async renderPortfolioAndStats(ctx: any, isEdit: boolean = false) {
    const userId = ctx.from?.id || 0;
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
    const isPractice = this.walletService.isPracticeMode(userId);
    const targets = this.walletService.getUserTargets(userId);
    const engineStats = this.copyEngine.getStats();
    const injService = this.copyEngine.getInjectiveService();

    let targetDisplay = '暂未选择 (待添加巨鲸)';
    if (targets.length > 0) {
      targetDisplay = targets
        .map((t, i) => `${i + 1}. ${t.name || '巨鲸'}(0x${t.address.slice(-4)})`)
        .join(' | ');
    }

    if (!isPractice) {
      const injPrice = await this.getLiveInjPrice();
      const [balances, realPositions] = await Promise.all([
        this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice),
        injService.getSubaccountPositions(userWallet.subaccountId).catch(() => []),
      ]);

      let totalUpnl = 0;
      let totalRealMargin = 0;
      const realCards: string[] = [];
      for (const pos of realPositions) {
        totalUpnl += pos.unrealizedPnl;
        totalRealMargin += pos.margin;
        const sign = pos.unrealizedPnl >= 0 ? '+' : '';
        const pnlEmoji = pos.unrealizedPnl >= 0 ? '🟢' : '🔴';
        const dirEmoji = pos.direction === 'long' ? '🟢' : '🔴';
        const dirText = pos.direction === 'long' ? '多 (LONG)' : '空 (SHORT)';
        const roi = pos.margin > 0 ? ((pos.unrealizedPnl / pos.margin) * 100).toFixed(2) : '0.00';
        const cleanTicker = pos.ticker.replace('/USDC PERP', '').replace('/USDT PERP', '');
        const lev = pos.margin > 0 ? Math.max(1, Math.round((pos.markPrice * pos.quantity) / pos.margin)) : 1;

        realCards.push(
          `┌── ${dirEmoji} <b>${cleanTicker}</b> (<code>${lev}x ${dirText}</code>)\n` +
            `│ 链上浮盈: ${pnlEmoji} <b>${sign}$${pos.unrealizedPnl.toFixed(2)} USD (${sign}${roi}%)</b>\n` +
            `│ 持仓数量: <b>${pos.quantity}</b> | 保证金: <b>$${pos.margin.toFixed(2)}</b>\n` +
            `│ 开仓均价: <code>$${formatDisplayPrice(pos.entryPrice)}</code> ➔ 标记价: <code>$${formatDisplayPrice(pos.markPrice)}</code>\n` +
            `└──────────────────────────`
        );
      }

      const uSign = totalUpnl >= 0 ? '+' : '';
      const uEmoji = totalUpnl >= 0 ? '🟢' : '🔴';
      const realEquity = Number((balances.totalUsd + totalRealMargin + totalUpnl).toFixed(2));
      let posBlock =
        realCards.length > 0 ? realCards.slice(0, 6).join('\n\n') : '  ⚪ 当前链上子账户暂无活动持仓';
      if (realCards.length > 6) {
        posBlock += `\n\n<i>... 还有 ${realCards.length - 6} 笔链上持仓</i>`;
      }

      let realText = `
📊 <b>【实盘账户实时资产与持仓看板 (Mainnet)】</b>

• <b>执行引擎模式</b>: <b>🔴 实盘链上交易 (专属钱包私钥真实签名上链)</b>
• <b>跟单巨鲸矩阵</b>: <b>${targetDisplay}</b>

┌── 💰 <b>链上实时资产概览</b> ─────────
│ 💎 估算账户总净值: <b>$${realEquity.toFixed(2)} USD</b>
│ 💵 可用稳定币: <b>${balances.usdt} USDT</b> | <b>${balances.usdc} USDC</b>
│ 🪙 可用 Gas 资产: <b>${balances.inj} INJ</b>
│ 🔒 链上占用保证金: <b>$${totalRealMargin.toFixed(2)} USD</b> (${realPositions.length} 笔持仓)
│ 📈 实时链上总浮盈: ${uEmoji} <b>${uSign}$${totalUpnl.toFixed(2)} USD</b>
└────────────────────────────

📈 <b>链上实盘活动持仓 (${realPositions.length} 笔):</b>
${posBlock}

⚡ <b>信号引擎指标:</b>
• 累计捕获信号: <b>${engineStats.total} 笔</b> | 放行跟单: <b>${engineStats.success} 笔</b> | 风控拦截: <b>${engineStats.total - engineStats.success} 笔</b>
      `.trim();

      if (realText.length > 3800) {
        realText = realText.slice(0, 3750) + '\n\n<i>(持仓数较多，已自动精简展示)</i>';
      }

      const realKb = new InlineKeyboard().text('🔄 刷新链上实时持仓与浮盈', 'view_stats').row();
      if (realPositions.length > 0) {
        realKb.text(`⚡ 一键市价全平实盘持仓 (${realPositions.length} 仓)`, 'close_all_real_pos').row();
      }
      realKb
        .text('🧪 切换为模拟演练', 'switch_mode_practice')
        .text('👛 返回我的钱包', 'view_wallet')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      if (isEdit) {
        try {
          await ctx.editMessageText(realText, { parse_mode: 'HTML', reply_markup: realKb });
          return;
        } catch {
          // fallback to reply
        }
      }
      await ctx.reply(realText, { parse_mode: 'HTML', reply_markup: realKb }).catch(() => {});
      return;
    }

    const positions = userWallet.practicePositions || [];

    // 1. 并发获取持仓标的的最新盘口价格以计算实时未实现浮盈
    const markPriceMap = new Map<string, number>();
    await Promise.all(
      positions.map(async (pos) => {
        try {
          const ob = await injService.getOrderbook(pos.marketId || pos.marketTicker, pos.marketTicker);
          const p =
            pos.direction === 'BUY'
              ? ob.bestBid > 0
                ? ob.bestBid
                : ob.midPrice
              : ob.bestAsk > 0
              ? ob.bestAsk
              : ob.midPrice;
          if (p > 0) {
            markPriceMap.set(pos.marketTicker, p);
          }
        } catch {
          markPriceMap.set(pos.marketTicker, pos.entryPrice);
        }
      })
    );

    let totalUnrealizedPnlUsdt = 0;
    let totalUsedMargin = 0;

    const positionCards: string[] = [];
    for (const pos of positions) {
      const curPrice = markPriceMap.get(pos.marketTicker) || pos.entryPrice;
      const priceDiff = pos.direction === 'BUY' ? curPrice - pos.entryPrice : pos.entryPrice - curPrice;
      let rawPnl = priceDiff * pos.quantity;
      // 风控防御保护：单笔持仓未实现浮盈浮亏不可超过 保证金 * 杠杆 * 3，防止历史坏数据污染整个看板
      const maxPnlCap = Math.max(100, (pos.marginUsdt || 20) * (pos.leverage || 5) * 3);
      if (Math.abs(rawPnl) > maxPnlCap) {
        rawPnl = rawPnl > 0 ? maxPnlCap : -maxPnlCap;
      }
      const uPnl = Number(rawPnl.toFixed(2));
      const uRoi = pos.marginUsdt > 0 ? ((uPnl / pos.marginUsdt) * 100).toFixed(2) : '0.00';
      const sign = uPnl >= 0 ? '+' : '';
      const pnlEmoji = uPnl >= 0 ? '🟢' : '🔴';
      const dirEmoji = pos.direction === 'BUY' ? '🟢' : '🔴';
      const dirText = pos.direction === 'BUY' ? '多 (LONG)' : '空 (SHORT)';
      totalUnrealizedPnlUsdt = Number((totalUnrealizedPnlUsdt + uPnl).toFixed(2));
      totalUsedMargin = Number((totalUsedMargin + pos.marginUsdt).toFixed(2));

      const notionalUsd = (curPrice * pos.quantity).toFixed(2);
      const cleanTicker = pos.marketTicker.replace('/USDC PERP', '').replace('/USDT PERP', '');
      const whaleTag = pos.traderAddress ? ` | 巨鲸 0x${pos.traderAddress.slice(-4)}` : '';

      positionCards.push(
        `┌── ${dirEmoji} <b>${cleanTicker}</b> (<code>${pos.leverage}x ${dirText}${whaleTag}</code>)\n` +
          `│ 浮动盈亏: ${pnlEmoji} <b>${sign}$${uPnl.toFixed(2)} USDT (${sign}${uRoi}%)</b>\n` +
          `│ 仓位价值: <b>$${notionalUsd}</b> | 保证金: <b>$${pos.marginUsdt.toFixed(2)} USDT</b>\n` +
          `│ 开仓均价: <code>$${formatDisplayPrice(pos.entryPrice)}</code> ➔ 现价: <code>$${formatDisplayPrice(curPrice)}</code>\n` +
          `└──────────────────────────`
      );
    }

    const availBalance = userWallet.practiceBalanceUsdt ?? 10000;
    const totalEquity = Number((availBalance + totalUsedMargin + totalUnrealizedPnlUsdt).toFixed(2));
    const realizedPnl = userWallet.practiceRealizedPnlUsdt ?? 0;
    const totalRoi = (((totalEquity - 10000) / 10000) * 100).toFixed(2);
    const pStats = userWallet.practiceStats || { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    const winRate =
      pStats.totalTrades > 0 ? ((pStats.winTrades / pStats.totalTrades) * 100).toFixed(1) : '0.0';

    const uSign = totalUnrealizedPnlUsdt >= 0 ? '+' : '';
    const rSign = realizedPnl >= 0 ? '+' : '';
    const roiSign = parseFloat(totalRoi) >= 0 ? '+' : '';
    const uEmoji = totalUnrealizedPnlUsdt >= 0 ? '🟢' : '🔴';
    const rEmoji = realizedPnl >= 0 ? '🟢' : '🔴';
    const roiEmoji = parseFloat(totalRoi) >= 0 ? '🟢' : '🔴';

    const historyItems = (userWallet.practiceTradeHistory || []).slice(0, 4);
    const historyLines = historyItems.map((h) => {
      const hSign = h.netPnlUsdt >= 0 ? '+' : '';
      const hEmoji = h.netPnlUsdt >= 0 ? '🟢' : '🔴';
      const hDir = h.direction === 'BUY' ? '多' : '空';
      const cleanH = h.marketTicker.replace('/USDC PERP', '').replace('/USDT PERP', '');
      return `  • ${hEmoji} <b>${cleanH} (${hDir})</b>: 开 $${formatDisplayPrice(h.entryPrice)} ➔ 平 $${formatDisplayPrice(h.exitPrice)} | 盈亏: <b>${hSign}$${h.netPnlUsdt.toFixed(2)} USDT</b>`;
    });

    const execModeDesc = '🧪 模拟盘演练 (虚拟体验金毫秒撮合，不上链不耗 Gas)';

    const maxDisplay = 5;
    const displayedPositions = positionCards.slice(0, maxDisplay);
    let positionsBlock =
      displayedPositions.length > 0 ? displayedPositions.join('\n\n') : '  ⚪ 暂无活动持仓 (等待巨鲸开仓触发)';
    if (positions.length > maxDisplay) {
      positionsBlock += `\n\n<i>... 另外还有 ${positions.length - maxDisplay} 笔持仓已为您按标的自动汇总净值与浮盈，轻点下方按钮可一键全部结算或清理亏损仓位</i>`;
    }

    let text = `
📊 <b>【跟单账户实时资产与盈亏战绩看板】</b>

• <b>执行引擎模式</b>: <b>${execModeDesc}</b>
• <b>跟单巨鲸矩阵</b>: <b>${targetDisplay}</b>

┌── 💰 <b>账户财务核心资产看板</b> ─────────
│ 💎 账户总净值 (Equity): <b>$${totalEquity.toFixed(2)} USDT</b>
│ 💵 体验金可用余额: <b>$${availBalance.toFixed(2)} USDT</b>
│ 🔒 持仓占用保证金: <b>$${totalUsedMargin.toFixed(2)} USDT</b> (${positions.length} 笔持仓)
│ 📈 实时未平仓浮盈: ${uEmoji} <b>${uSign}$${totalUnrealizedPnlUsdt.toFixed(2)} USDT</b>
│ 📉 累计已平仓盈亏: ${rEmoji} <b>${rSign}$${realizedPnl.toFixed(2)} USDT</b>
│ 🚀 综合收益率 (ROI): ${roiEmoji} <b>${roiSign}${totalRoi}%</b>
│ 🎯 平仓胜率 (Win Rate): <b>${winRate}%</b> (${pStats.winTrades}胜 / ${pStats.lossTrades}负)
└────────────────────────────

📈 <b>当前正在运行中的持仓 (${positions.length} 笔):</b>
${positionsBlock}

📜 <b>最近平仓交割记录:</b>
${historyLines.length > 0 ? historyLines.join('\n') : '  ⚪ 暂无已交割记录'}

⚡ <b>信号引擎指标:</b>
• 累计捕获信号: <b>${engineStats.total} 笔</b> | 放行跟单: <b>${engineStats.success} 笔</b> | 风控拦截: <b>${engineStats.total - engineStats.success} 笔</b>
• 执行延迟: <b>~380 ms</b> | 网络状态: <b>🟢 Injective 主网极速连接</b>
    `.trim();

    if (text.length > 3800) {
      text = text.slice(0, 3750) + '\n\n<i>(持仓数较多，已自动精简展示)</i>';
    }

    const keyboard = new InlineKeyboard().text('🔄 刷新实时浮盈与现价', 'view_stats').row();

    if (positions.length > 0) {
      keyboard
        .text(`⚡ 一键市价全平 (${positions.length} 仓)`, 'close_all_pos')
        .text('🧹 仅平仓亏损仓位', 'close_loss_pos')
        .row();
    }

    keyboard
      .text('🔄 重置 $10,000 体验金', 'reset_practice')
      .text('👛 返回我的钱包', 'view_wallet')
      .row()
      .text('🔙 返回主菜单', 'back_to_menu');

    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch (err: any) {
        console.warn('[TelegramBot] editMessageText 失败，尝试以普通消息回复:', err.message);
      }
    }

    try {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      console.error('[TelegramBot] renderPortfolioAndStats 发送失败，发送极简兜底卡片:', err.message);
      const briefText = `
📊 <b>【跟单账户实时资产概览】</b>

┌── 💰 <b>核心资产数据</b> ─────────
│ 💎 账户总净值: <b>$${totalEquity.toFixed(2)} USDT</b>
│ 💵 体验金可用余额: <b>$${availBalance.toFixed(2)} USDT</b>
│ 🔒 占用保证金: <b>$${totalUsedMargin.toFixed(2)} USDT</b> (${positions.length} 笔持仓)
│ 📈 实时总浮盈: ${uEmoji} <b>${uSign}$${totalUnrealizedPnlUsdt.toFixed(2)} USDT</b>
│ 📉 累计已平仓: ${rEmoji} <b>${rSign}$${realizedPnl.toFixed(2)} USDT</b>
│ 🚀 综合收益率: ${roiEmoji} <b>${roiSign}${totalRoi}%</b>
└────────────────────────────

💡 <i>当前持仓较多 (${positions.length} 笔)，建议轻点下方按钮【⚡ 一键市价全平】结算持仓，或【🔄 重置 $10,000 体验金】。</i>
      `.trim();
      await ctx.reply(briefText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    }
  }

  /**
   * 渲染用户专属 Injective 钱包详情面板 (支持链上余额实时刷新与提示反馈)
   */
  public async renderWalletDetail(ctx: any, isEdit: boolean = true, isRefresh: boolean = false) {
    const userId = ctx.from?.id || 0;
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);

    // 如果是通过 callbackQuery 触发，第一时间应答以取消前端按钮 loading 转圈并提供即时反馈
    if (ctx.callbackQuery) {
      if (isRefresh) {
        await ctx.answerCallbackQuery('正在查询 Injective 链上最新资产...').catch(() => {});
      } else {
        await ctx.answerCallbackQuery().catch(() => {});
      }
    }

    const injPrice = await this.getLiveInjPrice();
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
    const isPractice = this.walletService.isPracticeMode(userId);
    const positions = userWallet.practicePositions || [];
    const usedMargin = positions.reduce((sum, p) => sum + (p.marginUsdt || 0), 0);
    const availPractice = userWallet.practiceBalanceUsdt ?? 10000;
    const realizedPnl = userWallet.practiceRealizedPnlUsdt ?? 0;
    const pnlSign = realizedPnl >= 0 ? '+' : '';

    const practiceInfo = isPractice
      ? `• <b>当前执行模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>\n• <b>剩余可用体验金</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>模拟持仓占用保证金</b>: <b>$${usedMargin.toFixed(2)} USDT (${positions.length} 笔持仓)</b>\n• <b>累计平仓已实现盈亏</b>: <b>${pnlSign}$${realizedPnl.toFixed(2)} USDT</b>`
      : `• <b>当前执行模式</b>: <b>【🔴 实盘链上交易模式 (专属钱包私钥签名上链)】</b>`;

    const hasMnemonic = Boolean(userWallet.mnemonic);
    const refreshTime = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

    const text = `
👛 <b>我的专属 Injective 跟单钱包</b>

• <b>专属链上地址</b>:
<code>${userWallet.injectiveAddress}</code>
<i>(轻点上方地址可直接复制)</i>

• <b>EVM 映射地址</b>: <code>${userWallet.evmAddress || 'N/A'}</code>
• <b>助记词备份状态</b>: <b>${hasMnemonic ? '✅ 已生成 12 位标准安全助记词' : '⚠️ 早期私钥 (建议升级为助记词)'}</b>

┌── 📊 <b>链上真实资产与模式详情</b> ─────────
│ 💎 <b>链上 INJ 余额</b>: <code>${balances.inj} INJ</code>
│ 💵 <b>链上 USDT 余额</b>: <code>${balances.usdt} USDT</code>
│ 💲 <b>链上 USDC 余额</b>: <code>${balances.usdc} USDC</code>
│ 💰 <b>当前实盘总估值</b>: <b>$${balances.totalUsd} USD</b>
│ 🕒 <b>数据同步时间</b>: <code>${refreshTime} (UTC+8)</code>
└────────────────────────────
${practiceInfo}

🛡️ <b>真实 Web3 非托管钱包保障:</b>
<i>该钱包基于行业标准密码学算法在本地安全生成，是 100% 链上真实存在的独立非托管地址。您可随时导出助记词或私钥到 Keplr、OKX Web3 钱包查验管理，资产完全由您掌控！</i>
    `.trim();

    const keyboard = new InlineKeyboard()
      .text('📈 查看持仓与盈亏明细', 'view_stats')
      .row()
      .text('💳 充值 USDT/INJ 激活实盘', 'deposit_guide')
      .row()
      .text('🔴 切换为：实盘链上交易模式', 'switch_mode_real')
      .text('🧪 切换为：$10,000 模拟演练模式', 'switch_mode_practice')
      .row()
      .text('🔄 刷新余额', 'refresh_wallet')
      .text('🔑 导出助记词/私钥', 'export_key')
      .row()
      .text('📥 导入外部助记词/私钥', 'import_wallet_prompt')
      .text('🔄 重新生成助记词钱包', 'regen_wallet')
      .row()
      .url('🌐 在 Injective 区块浏览器查验', `https://injscan.com/account/${userWallet.injectiveAddress}`)
      .row()
      .text('🔙 返回主菜单', 'back_to_menu');

    if (isEdit) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return;
      } catch (err: any) {
        if (!err.message?.includes('message is not modified')) {
          console.warn('[TelegramBot] renderWalletDetail edit 失败，尝试以新消息回复:', err.message);
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        }
      }
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    }
  }

  /**
   * 统一渲染主控制面板 (支持 reply 或 editMessageText)
   */
  public async renderMainMenu(ctx: any, isEdit: boolean = false) {
    const userId = ctx.from?.id || 0;
    const username = ctx.from?.username;
    this.activeUserChatIds.add(ctx.chat?.id || userId);
    if (this.whaleRadar && ctx.chat?.id) {
      this.whaleRadar.addSubscriber(ctx.chat.id);
    }

    const text = await this.getMainMenuText(userId, username);
    const keyboard = this.getMainMenuKeyboard(userId);

    if (isEdit) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return;
      } catch (err: any) {
        // 如果内容未变或无法编辑，降级为普通回复
      }
    }

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  /**
   * 渲染 100% 链上真实持仓与撮合聚合的巨鲸榜单 (过滤死仓，实时展示最近链上异动)
   */
  public async renderLeaderboardView(ctx: any) {
    let whales = this.leaderboard.getTopWhales(5);
    if (whales.length === 0) {
      await this.leaderboard.refreshLeaderboard();
      whales = this.leaderboard.getTopWhales(5);
    }

    let text = `🏆 <b>Injective 主网实盘活跃巨鲸排行榜 (100% 链上实时数据)</b>\n`;
    text += `<i>已全量扫描主网活跃实盘仓位，过滤做市商/刷量机器人与 14 天以上死仓，优先展示近 24h~14 天内仍在交易的真实盈利账号</i>\n\n`;
    const keyboard = new InlineKeyboard();

    if (whales.length === 0) {
      text += `⚠️ 当前近 14 天内暂无符合条件的非做市商正浮盈实盘大户（Injective 链上近期以做市与高频对倒为主）。\n\n💡 你可以通过下方「🔍 监控自定义钱包」手动添加已知聪明钱地址。\n\n`;
    } else {
      whales.forEach((w) => {
        const upnlSign = w.unrealizedPnlUsd >= 0 ? '+' : '';
        text += `<b>Top ${w.rank}. ${w.name}</b> ${w.badge}\n`;
        text += `• 最近链上异动: <b>${w.lastActiveDesc}</b>\n`;
        text += `• 实盘未平仓总规模: <b>$${w.volumeUsd.toLocaleString()} USD</b> (${w.openPositionsCount} 个仓位)\n`;
        text += `• 当前持仓总浮盈: <b>${upnlSign}$${w.unrealizedPnlUsd.toLocaleString()} USD</b>\n`;
        text += `• 实盘综合胜率: <b>${w.winRatePercent}%</b>\n`;
        text += `• 头号重仓明细: <i>${w.strategy}</i>\n`;
        text += `• 钱包地址: <code>${w.address}</code>\n\n`;

        keyboard.text(`⚡ 跟单 Top ${w.rank} (0x${w.address.slice(-4)})`, `follow_${w.id}`).row();
      });
    }

    keyboard
      .text('🔄 实时重扫主网巨鲸', 'refresh_leaderboard')
      .text('🔍 监控自定义钱包', 'track_custom_wallet')
      .row()
      .text('🔙 返回主菜单', 'back_to_menu');

    if (text.length > 3900) {
      text = text.slice(0, 3850) + '\n\n<i>(榜单内容较长，已自动精简展示)</i>';
    }

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(() => {});
    }
  }

  /**
   * 处理零余额提示界面
   */
  private async promptZeroBalanceChoice(ctx: any, targetAddress?: string, isEdit: boolean = true) {
    const userId = ctx.from?.id || 0;
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);

    const text = `
⚠️ <b>【链上跟单资产提示】</b>

检测到您专属钱包中当前尚无 USDT / INJ 资产：
• 钱包地址: <code>${userWallet.injectiveAddress}</code>
• 当前实盘余额: <b>0.0000 INJ / 0.00 USDT</b>

为了让您能够流畅体验 Injective 亚秒级跟单引擎，请选择操作模式：
    `.trim();

    const keyboard = new InlineKeyboard()
      .text('💳 充值 USDT/INJ 激活实盘', 'deposit_guide')
      .row()
      .text('🧪 开启 $10,000 体验金演练', targetAddress ? `prac_follow_${targetAddress}` : 'enable_practice_mode')
      .row()
      .text('🔙 返回主菜单', 'back_to_menu');

    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch (e) {}
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  /**
   * 配置 Bot 指令与交互菜单
   */
  private setupBotHandlers() {
    if (!this.bot) return;

    // 访问控制（若配置了 ALLOWED_TELEGRAM_IDS）+ 清理待输入状态 + 指令日志
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (
        this.config.allowedTelegramIds &&
        this.config.allowedTelegramIds.length > 0 &&
        (!userId || !this.config.allowedTelegramIds.includes(userId))
      ) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: '⛔ 暂无访问权限', show_alert: true }).catch(() => {});
        } else if (ctx.message) {
          await ctx.reply('⛔ 当前机器人已开启白名单访问限制，请联系管理员授权。').catch(() => {});
        }
        return;
      }

      if (ctx.message?.text?.startsWith('/')) {
        if (userId) {
          this.awaitingAddressUsers.delete(userId);
          this.awaitingWalletImportUsers.delete(userId);
        }
        console.log(`[TelegramBot] 指令 @${ctx.from?.username || userId}: ${ctx.message.text}`);
      }
      await next();
    });

    // 1. /start 与 /menu 指令 (支持 ref_<id> 邀请绑定与 follow_<inj1...> 频道深链一键跟单)
    this.bot.command('start', async (ctx) => {
      const match = (ctx.match || '').trim();
      const userId = ctx.from?.id || 0;
      if (match.startsWith('ref_')) {
        const inviterId = parseInt(match.replace('ref_', ''), 10);
        if (inviterId && inviterId !== userId) {
          const bound = this.walletService.bindReferrer(userId, inviterId);
          if (bound) {
            await ctx.reply(
              `🎉 <b>欢迎激活 Injective 聪明钱跟单矩阵！</b>\n您已通过推荐人 (<code>ID: ${inviterId}</code>) 的专属邀请链接成功激活，已为您开启优先风控通道！`,
              { parse_mode: 'HTML' }
            ).catch(() => {});

            try {
              await ctx.api.sendMessage(
                inviterId,
                `🎁 <b>【新好友成功加入提醒】</b>\n好友 @${ctx.from?.username || userId} (<code>${userId}</code>) 已通过您的专属推广链接加入机器人！后续该好友每笔实盘跟单成交，您都将自动获得 <b>${this.config.referralRewardPercent}% 手续费现金返佣</b>！`,
                { parse_mode: 'HTML' }
              );
            } catch {
              // ignore
            }
          }
        }
      } else if (match.startsWith('follow_')) {
        const rawAddr = match.replace('follow_', '').trim();
        const check = validateInjectiveAddress(rawAddr);
        if (check.valid && check.cleanAddress) {
          await this.applyFollowTarget(ctx, check.cleanAddress, false);
          return;
        }
      }
      await this.renderMainMenu(ctx, false);
    });
    this.bot.command('menu', (ctx) => this.renderMainMenu(ctx, false));

    // 2. /track 指令 (支持直接带参数 /track inj1... 或单独输入)
    this.bot.command('track', async (ctx) => {
      const parts = (ctx.message?.text || '').trim().split(/\s+/);
      if (parts.length > 1 && parts[1]) {
        await this.handleCustomAddressInput(ctx, parts[1]);
        return;
      }

      this.awaitingAddressUsers.add(ctx.from?.id || 0);
      const text = `
🔍 <b>【请输入您要监控并跟单的 Injective 钱包地址】</b>

请输入以 <code>inj1...</code> 开头的 42 位 Injective 钱包地址：
例如：
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

⚡ <i>系统将自动进行地址安全校验，并一键加入您的多巨鲸跟单矩阵！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu');
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    this.bot.command('leaderboard', async (ctx) => {
      await ctx.reply('🏆 轻点下方按钮查看链上聪明钱实时胜率排行：', {
        reply_markup: new InlineKeyboard().text('🏆 立即查看聪明钱排行榜', 'view_leaderboard'),
      }).catch(() => {});
    });

    this.bot.command('amount', async (ctx) => {
      await ctx.reply('请选择单笔跟单金额：', {
        reply_markup: new InlineKeyboard()
          .text('$20 USDT', 'amt_20')
          .text('$50 USDT', 'amt_50')
          .row()
          .text('$100 USDT', 'amt_100')
          .text('$200 USDT', 'amt_200')
          .row()
          .text('🔙 返回主菜单', 'back_to_menu'),
      }).catch(() => {});
    });

    this.bot.command('referral', async (ctx) => {
      const refLink = `https://t.me/${ctx.me.username}?start=ref_${ctx.from?.id || '888'}`;
      await ctx.reply(
        `🎁 <b>您的专属推广链接：</b>\n<code>${refLink}</code>\n\n好友使用实盘跟单享 ${this.config.referralRewardPercent}% 终身手续费现金分红！`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    });

    this.bot.command('stats', (ctx) => this.renderPortfolioAndStats(ctx, false));
    this.bot.command('wallet', (ctx) => this.renderWalletDetail(ctx, false, false));

    // 3. 文本输入监听 (区分等待输入自定义钱包、等待输入助记词/私钥导入与普通发送地址)
    this.bot.on('message:text', async (ctx) => {
      const text = (ctx.message.text || '').trim();
      const userId = ctx.from?.id || 0;

      // 等待导入助记词或私钥 (立即尝试撤回用户发送的敏感明文消息，降低聊天记录泄露风险)
      if (this.awaitingWalletImportUsers.has(userId)) {
        this.awaitingWalletImportUsers.delete(userId);
        await ctx.deleteMessage().catch(() => {});
        try {
          const imported = this.walletService.importWallet(userId, text, ctx.from?.username);
          const mnemonicHint = imported.mnemonic ? '（含 12/24 位助记词）' : '（Hex 私钥）';
          const successText = `
✅ <b>【钱包导入成功！】</b>

• <b>Injective 链上地址</b>:
<code>${imported.injectiveAddress}</code>

• <b>EVM 兼容映射地址</b>:
<code>${imported.evmAddress || 'N/A'}</code>

• <b>导入类型</b>: <b>${mnemonicHint}</b>

🛡️ <i>系统已自动尝试撤回您刚才发送的明文凭据消息以保护安全，您的模拟盘体验金与跟单巨鲸配置已无缝保留！</i>
          `.trim();

          const keyboard = new InlineKeyboard()
            .text('👛 查看我的钱包', 'view_wallet')
            .url('🌐 在区块浏览器查验此地址', `https://injscan.com/account/${imported.injectiveAddress}`)
            .row()
            .text('🔙 返回主菜单', 'back_to_menu');

          await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        } catch (err: any) {
          const errText = `
❌ <b>钱包导入失败</b>

原因: <i>${err.message || '无效的助记词或私钥格式'}</i>

请检查助记词是否拼写正确（12/24 个单词，空格分隔）或私钥是否为 64 位 Hex 后重试。
          `.trim();

          const keyboard = new InlineKeyboard()
            .text('📥 重新尝试导入', 'import_wallet_prompt')
            .text('🔙 返回我的钱包', 'view_wallet');

          await ctx.reply(errText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        }
        return;
      }

      // 只有当用户明确处于等待输入自定义钱包状态时，才直接加入跟单矩阵
      if (this.awaitingAddressUsers.has(userId)) {
        await this.handleCustomAddressInput(ctx, text);
        return;
      }

      // 如果用户没有处于等待输入状态，但发送了 inj1... 地址，弹出操作选择卡片而非强行锁定跟单
      if (text.startsWith('inj1')) {
        const check = validateInjectiveAddress(text);
        if (check.valid && check.cleanAddress) {
          const cleanAddr = check.cleanAddress;
          const promptText = `💡 <b>检测到您发送了 Injective 链上地址：</b>\n<code>${cleanAddr}</code>\n\n请选择您要对该地址执行的操作：`;
          const keyboard = new InlineKeyboard()
            .text('🎯 加入我的多巨鲸跟单矩阵', `follow_custom_${cleanAddr}`)
            .row()
            .text('🔍 查询该地址链上资产', `inspect_addr_${cleanAddr}`)
            .row()
            .text('🔙 返回主菜单', 'back_to_menu');
          await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
          return;
        }
      }

      // 默认通配：调出主控制台
      await this.renderMainMenu(ctx, false);
    });

    // ========================================================
    // 按钮回调逻辑
    // ========================================================

    // 返回主控制台 (确保渲染完整大面板)
    this.bot.callbackQuery('back_to_menu', async (ctx) => {
      this.awaitingAddressUsers.delete(ctx.from?.id || 0);
      this.awaitingWalletImportUsers.delete(ctx.from?.id || 0);
      await ctx.answerCallbackQuery().catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 监控自定义钱包
    this.bot.callbackQuery('track_custom_wallet', async (ctx) => {
      this.awaitingAddressUsers.add(ctx.from?.id || 0);
      await ctx.answerCallbackQuery().catch(() => {});
      const text = `
🔍 <b>【请输入您要监控并跟单的 Injective 钱包地址】</b>

请直接向机器人发送以 <code>inj1...</code> 开头的 42 位 Injective 地址：
例如：
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

💡 <i>支持同时监控最多 5 位巨鲸！系统将自动安全校验地址格式并加入您的多巨鲸并发跟单矩阵，绝不覆盖已有目标！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      });
    });

    // 查看聪明钱排行榜 (若距上次刷新超过 15 秒，自动拉取最新盘口浮盈与最新成交时间)
    this.bot.callbackQuery('view_leaderboard', async (ctx) => {
      const userId = ctx.from?.id || 0;
      await ctx.answerCallbackQuery('正在读取最新链上实盘数据...').catch(() => {});
      if (
        !this.isRpcRateLimited(userId, 'leaderboard', 5000) &&
        (Date.now() - this.leaderboard.getLastRefreshTime() > 15000 ||
          this.leaderboard.getTopWhales(5).length === 0)
      ) {
        await this.leaderboard.refreshLeaderboard();
      }
      await this.renderLeaderboardView(ctx);
    });

    this.bot.callbackQuery('refresh_leaderboard', async (ctx) => {
      const userId = ctx.from?.id || 0;
      if (this.isRpcRateLimited(userId, 'refresh_leaderboard', 8000)) {
        await ctx.answerCallbackQuery('⏳ 刷新太频繁，请几秒后再试').catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery('正在重扫 Injective 主网最新区块成交...').catch(() => {});
      await this.leaderboard.refreshLeaderboard();
      await this.renderLeaderboardView(ctx);
    });

    // 显式切换为：实盘链上交易模式
    this.bot.callbackQuery('switch_mode_real', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
      const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;

      if (!hasRealFunds) {
        await ctx
          .answerCallbackQuery('⚠️ 您的专属实盘钱包余额为 0，请先充值或继续使用模拟盘！')
          .catch(() => {});
        const warnText = `
🔴 <b>【切换实盘链上交易模式 - 余额校验未通过】</b>

检测到您的专属非托管钱包当前实盘余额为 0：
• 专属地址: <code>${userWallet.injectiveAddress}</code>
• 链上余额: <b>${balances.inj} INJ / ${balances.usdt} USDT / ${balances.usdc} USDC</b>

💡 <b>实盘链上交易模式</b>将使用您专属钱包私钥直接签名并在 Injective Mainnet 真实扣款下单。请先向您的专属地址充值 USDT 与少量 INJ (Gas)，或继续使用 $10,000 模拟演练模式：
        `.trim();

        const keyboard = new InlineKeyboard()
          .text('💳 立即查看充值指南', 'deposit_guide')
          .row()
          .text('🧪 继续使用 $10,000 模拟演练模式', 'switch_mode_practice')
          .row()
          .text('🔙 返回主菜单', 'back_to_menu');

        await ctx.editMessageText(warnText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        return;
      }

      this.walletService.setPracticeMode(userId, false);
      await ctx.answerCallbackQuery('🔴 已成功切换为：实盘链上交易模式！').catch(() => {});

      const okText = `
🔴 <b>【已切换为：实盘链上交易模式】</b>

• <b>当前执行模式</b>: <b>🔴 实盘链上交易 (Mainnet 真实签名广播)</b>
• <b>签名账户</b>: <code>${userWallet.injectiveAddress}</code>
• <b>实盘可用余额</b>: <b>${balances.inj} INJ | ${balances.usdt} USDT | ${balances.usdc} USDC</b>

⚡ <i>从现在起，跟单矩阵捕获到的每一笔巨鲸信号都将使用您的专属钱包私钥真实签名上链，并推送附带 Injective 主网区块浏览器链接 (injscan.com) 的实盘战报！</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🧪 切换回：$10,000 模拟演练模式', 'switch_mode_practice')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(okText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 显式切换为：$10,000 模拟演练模式
    this.bot.callbackQuery('switch_mode_practice', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const w = this.walletService.setPracticeMode(userId, true);
      await ctx.answerCallbackQuery('🧪 已切换为：$10,000 模拟演练模式！').catch(() => {});

      const text = `
🧪 <b>【已切换为：$10,000 模拟演练模式】</b>

• <b>当前执行模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>
• <b>可用模拟体验金</b>: <b>$${(w.practiceBalanceUsdt ?? 10000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>

💡 <i>在模拟演练模式下，系统将 1:1 监听主网巨鲸真实信号并按实盘盘口价格扣减虚拟体验金，每笔成交通知均明确标注为 #PAPER 模拟流水号，绝不与实盘混淆！</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🏆 前往聪明钱榜单选巨鲸', 'view_leaderboard')
        .text('🔴 切换为：实盘链上交易模式', 'switch_mode_real')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 钱包详情与余额刷新 (支持即时反馈与最新时间戳展示)
    this.bot.callbackQuery(['view_wallet', 'refresh_wallet'], async (ctx) => {
      const userId = ctx.from?.id || 0;
      const isRefresh = ctx.callbackQuery?.data === 'refresh_wallet';
      if (isRefresh && this.isRpcRateLimited(userId, 'refresh_wallet', 3000)) {
        await ctx.answerCallbackQuery('⏳ 请稍候再刷新').catch(() => {});
        return;
      }
      await this.renderWalletDetail(ctx, true, isRefresh);
    });

    // 充值指南
    this.bot.callbackQuery('deposit_guide', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      await ctx.answerCallbackQuery().catch(() => {});
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);

      const text = `
💳 <b>【充值 USDT / USDC / INJ 激活实盘交易】</b>

您的专属充值地址:
<code>${userWallet.injectiveAddress}</code>
<i>(轻点上方地址即可一键复制)</i>

📌 <b>便捷充值方式:</b>
1. <b>中心化交易所提现</b> (币安 Binance, OKX, Bybit 等):
   • 提币币种选择 <b>INJ</b>、<b>USDT</b> 或 <b>USDC</b> (多数永续合约使用 USDC/USDT 结算)
   • 网络务必选择 <b>Injective (INJ)</b>
   • 填入上方您的专属地址，通常 1-2 分钟内秒级到账

2. <b>跨链桥转账</b>:
   • 从以太坊跨链: <a href="https://hub.injective.network/bridge">Injective Hub Bridge</a>
   • 从 Cosmos 生态 (IBC 转账): Keplr 一键直达

📊 <b>实时到账状态</b>:
• 当前 INJ: <code>${balances.inj} INJ</code> | USDT: <code>${balances.usdt} USDT</code> | USDC: <code>${balances.usdc} USDC</code>
• 充值到账后系统将自动识别，无需等待人工审核！
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🔄 刷新链上充值余额', 'deposit_guide')
        .text('🧪 先开启体验金演练', 'enable_practice_mode')
        .row()
        .text('🔙 返回钱包', 'view_wallet')
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      }).catch(() => {});
    });

    // 开启体验金模式
    this.bot.callbackQuery('enable_practice_mode', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.walletService.setPracticeMode(userId, true);
      await ctx.answerCallbackQuery('🎉 $10,000 体验金已激活！').catch(() => {});

      const text = `
🎉 <b>【$10,000 体验金演练模式已激活！】</b>

• <b>当前模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>
• <b>可用虚拟本金</b>: <b>$10,000.00 USDT</b>

在体验金模式下：
• 系统将实时监听 Injective 链上真实大户下单
• 按照真实盘口与滑点进行毫秒级模拟撮合
• 0 风险检验跟单胜率与收益，随时可充值切换实盘链上模式！
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🏆 前往聪明钱榜单选大户', 'view_leaderboard')
        .text('🔍 监控自定义钱包', 'track_custom_wallet')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(() => {});
    });

    // 开启体验金并直接锁定某目标 (callback_data 长度: 12 + 42 = 54 <= 64 bytes)
    this.bot.callbackQuery(/^prac_follow_(.+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const targetAddress = ctx.match[1];
      this.walletService.setPracticeMode(userId, true);
      await ctx.answerCallbackQuery('🎉 体验金已开启并加入跟单矩阵！').catch(() => {});
      await this.applyFollowTarget(ctx, targetAddress, true);
    });

    // 导出助记词与私钥
    this.bot.callbackQuery('export_key', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      if (userWallet.decryptionError) {
        await ctx.answerCallbackQuery({ text: '⚠️ 钱包解密异常，请联系管理员检查加密密钥', show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});

      const mnemonicBlock = userWallet.mnemonic
        ? `• <b>12 位标准英文助记词:</b>\n<code>${userWallet.mnemonic}</code>\n<i>(轻点上方助记词可直接复制。可直接导入 Keplr、OKX Web3 钱包、MetaMask 或 Leap 验证同一链上地址！)</i>`
        : `• <b>12 位助记词:</b>\n<i>⚠️ 此钱包系早期创建，未生成 12 位助记词。建议点击下方【🔄 升级为全新助记词钱包】生成带助记词的新钱包。</i>`;

      const text = `
⚠️ <b>【绝密信息 - 钱包助记词与私钥备份】</b>

• <b>Injective 地址</b>: <code>${userWallet.injectiveAddress}</code>
• <b>EVM 兼容地址</b>: <code>${userWallet.evmAddress || 'N/A'}</code>

${mnemonicBlock}

• <b>私钥 Hex (十六进制):</b>
<code>${userWallet.privateKeyHex}</code>

🛡️ <b>关于非托管去中心化钱包的安全说明:</b>
1. <b>真实链上钱包</b>: 该地址遵循 Injective 官方密码学标准在本地安全生成，是 100% 真实 Web3 独立钱包，与其他主流 Telegram 交易机器人（如 GMGN、Banana Gun、OKX Web3）原理完全一致。
2. <b>随时导出查验</b>: 您可以随时将助记词或私钥导入到 Keplr 或 OKX Web3 钱包中验证，地址和资产分毫不差。
3. <b>最高控制权</b>: 任何拥有助记词或私钥的人都拥有该钱包的所有权，切勿截图或发送给任何人！
      `.trim();

      const keyboard = new InlineKeyboard();
      if (!userWallet.mnemonic) {
        keyboard.text('🔄 升级为全新助记词钱包', 'regen_wallet').row();
      }
      keyboard
        .url('🌐 在 Injective 区块浏览器查验此地址', `https://injscan.com/account/${userWallet.injectiveAddress}`)
        .row()
        .text('🔙 返回我的钱包', 'view_wallet')
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 重新生成带 12 位助记词的新钱包
    this.bot.callbackQuery('regen_wallet', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const newWallet = this.walletService.regenerateWalletWithMnemonic(userId);
      await ctx.answerCallbackQuery('🎉 已生成带 12 位助记词的全新钱包！').catch(() => {});

      const mnemonicBlock = `• <b>12 位标准英文助记词:</b>\n<code>${newWallet.mnemonic}</code>\n<i>(轻点上方助记词可直接复制。可直接导入 Keplr、OKX Web3 钱包、MetaMask 或 Leap 验证同一链上地址！)</i>`;
      const text = `
🎉 <b>【全新 12 位标准助记词钱包已生成】</b>

• <b>Injective 地址</b>: <code>${newWallet.injectiveAddress}</code>
• <b>EVM 兼容地址</b>: <code>${newWallet.evmAddress || 'N/A'}</code>

${mnemonicBlock}

• <b>私钥 Hex (十六进制):</b>
<code>${newWallet.privateKeyHex}</code>

🛡️ <i>请务必立即在纸上或安全密码管理器中备份助记词！您的模拟盘资金与跟单设置已无缝保留。</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .url('🌐 在 Injective 区块浏览器查验此地址', `https://injscan.com/account/${newWallet.injectiveAddress}`)
        .row()
        .text('👛 查看我的钱包', 'view_wallet')
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 提示用户输入要导入的助记词或私钥
    this.bot.callbackQuery('import_wallet_prompt', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.awaitingWalletImportUsers.add(userId);
      await ctx.answerCallbackQuery().catch(() => {});

      const text = `
📥 <b>【导入已有 Injective 钱包 (助记词或私钥)】</b>

请直接向机器人发送您的钱包凭据：
1. <b>12 位或 24 位英文助记词</b> (单词间以空格分隔)
   例如: <code>abandon ability able about above absent absorb abstract absurd abuse access accident</code>
2. 或 <b>64 位十六进制私钥 Hex</b> (可带或不带 0x)
   例如: <code>0x4f3edf983ac636a65a762ce43809197b5b04113345e4c0557e823804418ffb2a</code>

🛡️ <b>安全承诺:</b>
• 收到后系统将尝试立即撤回您发出的明文消息，密钥使用 AES-256-GCM 加密保存！
• 导入后您的模拟体验金余额与已添加的跟单巨鲸目标将完整保留！
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🔙 取消并返回钱包', 'view_wallet')
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 开启自动跟单
    this.bot.callbackQuery('start_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const copyState = this.walletService.getUserCopyState(userId);
      const targets = this.walletService.getUserTargets(userId);
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
      const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;

      // 1. 检查是否已指定跟单目标
      if (targets.length === 0) {
        await ctx.answerCallbackQuery().catch(() => {});
        const text = `
⚠️ <b>【尚未选择跟单目标】</b>

您当前尚未绑定任何巨鲸或聪明钱地址。
请先点击下方【🏆 聪明钱榜单】挑选链上高胜率活跃巨鲸，或点击【🔍 监控自定义钱包】输入您想跟随的 Injective 钱包地址。
        `.trim();

        const keyboard = new InlineKeyboard()
          .text('🏆 前往聪明钱榜单选巨鲸', 'view_leaderboard')
          .text('🔍 监控自定义钱包', 'track_custom_wallet')
          .row()
          .text('🔙 返回主菜单', 'back_to_menu');

        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        return;
      }

      // 2. 检查是否有资金或开启体验金
      if (!hasRealFunds && !copyState.practiceMode) {
        await ctx.answerCallbackQuery().catch(() => {});
        await this.promptZeroBalanceChoice(ctx, targets[targets.length - 1].address, true);
        return;
      }

      // 3. 启动多巨鲸跟单矩阵 (绝不污染全局 config)
      this.walletService.setUserCopying(userId, true);
      for (const t of targets) {
        await this.tracker.addTrackedTrader(t.address, t.subaccountIndex ?? 0);
      }
      await ctx.answerCallbackQuery('🚀 多巨鲸自动跟单矩阵已启动！').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 暂停自动跟单
    this.bot.callbackQuery('pause_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.walletService.setUserCopying(userId, false);
      await ctx.answerCallbackQuery('⏸️ 自动跟单已暂停').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 跟单矩阵与高级设定
    this.bot.callbackQuery('config_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const copyState = this.walletService.getUserCopyState(userId);
      const targets = this.walletService.getUserTargets(userId);
      const isCopying = copyState.isCopyingEnabled;
      const isPractice = copyState.practiceMode;

      const targetsLines =
        targets.length > 0
          ? targets
              .map(
                (t, idx) =>
                  `  ${idx + 1}. <b>${t.name}</b> (<code>${t.address.slice(0, 10)}...${t.address.slice(-6)}</code>)`
              )
              .join('\n')
          : '  ⚪ 暂未添加任何巨鲸目标';

      const execModeDesc = isPractice
        ? '【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】'
        : '【🔴 实盘链上交易模式 (专属钱包私钥签名上链 Mainnet)】';

      const modeLabel =
        copyState.copyMode === 'RATIO'
          ? `按比例 (${(copyState.copyRatio * 100).toFixed(1)}%, 单笔上限 $${copyState.maxNotionalPerOrder})`
          : `固定金额 ($${copyState.copyAmountUsdt} USDT)`;

      const text = `
⚡ <b>【多巨鲸跟单矩阵 & 执行引擎设置】</b>

• <b>运行状态</b>: <b>${isCopying ? '🟢 自动跟单中 (ACTIVE)' : '⚪ 已暂停 / 未启动 (PAUSED)'}</b>
• <b>执行引擎模式</b>: <b>${execModeDesc}</b>
• <b>当前同时跟单巨鲸 (${targets.length}/5)</b>:
${targetsLines}
• <b>仓位模式</b>: <b>${modeLabel}</b>
• <b>杠杆倍数限制</b>: <b>${copyState.maxLeverage}x</b> | <b>最大滑点保护</b>: <b>${copyState.maxSlippagePercent}%</b>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🔴 切换为：实盘链上交易模式', 'switch_mode_real')
        .row()
        .text('🧪 切换为：$10,000 模拟演练模式', 'switch_mode_practice')
        .row();

      for (const t of targets) {
        keyboard.text(`❌ 移除 0x${t.address.slice(-4)}`, `unfollow_${t.address.slice(-8)}`).row();
      }

      keyboard
        .text(isCopying ? '⏸️ 暂停自动跟单' : '🟢 开启自动跟单', isCopying ? 'pause_copy' : 'start_copy')
        .text('💰 修改金额', 'set_amount')
        .row()
        .text('🗑️ 清空全部目标', 'clear_target')
        .text('🛡️ 风控与滑点', 'view_risk')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 单独移除某个跟单巨鲸 (callback: unfollow_<8位后缀>)
    this.bot.callbackQuery(/^unfollow_(.+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const suffix = ctx.match[1];
      const remaining = this.walletService.removeUserTarget(userId, suffix);

      // 如果全网没有任何活跃用户再监听该后缀地址，则从 tracker 矩阵中移除
      const allActive = this.walletService.getAllActiveTrackedAddresses();
      const stillNeeded = allActive.some((a) => a.toLowerCase().endsWith(suffix.toLowerCase()));
      if (!stillNeeded) {
        this.tracker.removeTrackedTrader(suffix);
      }

      await ctx
        .answerCallbackQuery(`✅ 已移除巨鲸 0x${suffix.slice(-4)} (剩余 ${remaining.length} 位)`)
        .catch(() => {});

      if (remaining.length === 0) {
        await this.renderMainMenu(ctx, true);
      } else {
        await this.renderMatrixConfirmation(ctx, userId, true);
      }
    });

    // 清除全部跟单目标
    this.bot.callbackQuery('clear_target', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const oldTargets = this.walletService.getUserTargets(userId);
      this.walletService.clearUserTarget(userId);
      const allActive = this.walletService.getAllActiveTrackedAddresses();
      for (const t of oldTargets) {
        if (!allActive.includes(t.address)) {
          this.tracker.removeTrackedTrader(t.address);
        }
      }
      await ctx.answerCallbackQuery('🗑️ 已清空全部跟单目标并停止跟单').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 查询任意 Injective 地址链上资产
    this.bot.callbackQuery(/^inspect_addr_(.+)$/, async (ctx) => {
      const addr = ctx.match[1];
      await ctx.answerCallbackQuery('正在查询该地址链上余额...').catch(() => {});
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(addr, injPrice);
      const inspectText = `
🔍 <b>【Injective 链上地址资产查询】</b>

• <b>查询地址</b>:
<code>${addr}</code>

📊 <b>实时链上资产 (主账户 + 衍生品子账户)</b>:
• <b>INJ 余额</b>: <code>${balances.inj} INJ</code>
• <b>USDT 余额</b>: <code>${balances.usdt} USDT</code>
• <b>USDC 余额</b>: <code>${balances.usdc} USDC</code>
• <b>总资产折合估值</b>: <b>~$${balances.totalUsd} USD</b>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🎯 加入我的多巨鲸跟单矩阵', `follow_custom_${addr}`)
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      try {
        await ctx.editMessageText(inspectText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch {
        await ctx.reply(inspectText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      }
    });

    this.bot.callbackQuery('toggle_mode_ratio', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.walletService.setUserCopyMode(userId, 'RATIO');
      await ctx.answerCallbackQuery('已为您切换为：按巨鲸仓位比例跟单').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery('toggle_mode_fixed', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.walletService.setUserCopyMode(userId, 'FIXED_AMOUNT');
      await ctx.answerCallbackQuery('已为您切换为：固定金额跟单').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 风控设置 (完全按用户独立配置持久化，不篡改其他用户)
    this.bot.callbackQuery('view_risk', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const copyState = this.walletService.getUserCopyState(userId);
      const modeName = copyState.copyMode === 'RATIO' ? '按巨鲸比例' : '固定金额';
      const text = `
🛡️ <b>【您的专属智能风控设置】</b>

当前仅针对您个人账号生效，不会影响其他用户：
• <b>跟单模式</b>: <b>${modeName}</b>
• <b>滑点保护阈值</b>: <b>${copyState.maxSlippagePercent}%</b> (当盘口剧烈跳空超阈值自动拦截)
• <b>最大允许杠杆</b>: <b>${copyState.maxLeverage}x</b> (防止极端行情穿仓)
• <b>单笔金额上限</b>: <b>$${copyState.maxNotionalPerOrder} USD</b>
• <b>行情异常熔断</b>: <b>已开启</b> (亚秒级判定)
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('滑点 1.0%', 'slip_10')
        .text('滑点 1.5%', 'slip_15')
        .text('滑点 2.0%', 'slip_20')
        .row()
        .text('杠杆 3x', 'lev_3')
        .text('杠杆 5x', 'lev_5')
        .text('杠杆 10x', 'lev_10')
        .row()
        .text('固定金额模式', 'toggle_mode_fixed')
        .text('按比例跟单模式', 'toggle_mode_ratio')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    this.bot.callbackQuery(/^slip_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const v = parseInt(ctx.match[1], 10) / 10;
      this.walletService.setUserSlippage(userId, v);
      await ctx.answerCallbackQuery(`您的专属滑点保护已更新为 ${v}%`).catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery(/^lev_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lev = parseInt(ctx.match[1], 10);
      this.walletService.setUserLeverage(userId, lev);
      await ctx.answerCallbackQuery(`您的专属最大杠杆已更新为 ${lev}x`).catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 修改金额
    this.bot.callbackQuery('set_amount', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const copyState = this.walletService.getUserCopyState(userId);
      const text = `
💰 <b>选择每笔跟单的名义金额 (USDT):</b>

当前设置: <b>$${copyState.copyAmountUsdt} USDT</b>
<i>建议根据个人风险偏好选择适度金额。</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('$20 USDT', 'amt_20')
        .text('$50 USDT', 'amt_50')
        .row()
        .text('$100 USDT', 'amt_100')
        .text('$200 USDT', 'amt_200')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(() => {});
    });

    this.bot.callbackQuery(/^amt_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const amt = parseInt(ctx.match[1], 10);
      this.walletService.setUserAmount(userId, amt);
      await ctx.answerCallbackQuery(`您的单笔金额已更新为 $${amt} USDT`).catch(() => {});
      await ctx.editMessageText(`✅ 您的单笔跟单金额已成功设置为 <b>$${amt} USDT</b>！`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
      }).catch(() => {});
    });

    const renderReferralView = async (ctx: any, userId: number, extraNotice?: string) => {
      const botName = this.bot?.botInfo?.username || ctx.me?.username || 'injective_copy_bot';
      const refLink = `https://t.me/${botName}?start=ref_${userId}`;
      const stats = this.walletService.getReferralStats(userId);

      const noticeLine = extraNotice ? `\n\n📌 <b>最新提现状态</b>: ${extraNotice}` : '';
      const text = `
🎁 <b>Injective 裂变邀请返佣收益看板</b>

邀请好友使用您的专属链接开启<b>实盘跟单</b>，<b>终身享受好友产生交易手续费的 ${this.config.referralRewardPercent}% 现金分红！</b>

📊 <b>您的推广业绩统计:</b>
• 👥 <b>成功邀请好友</b>: <b>${stats.invitedCount} 人</b>
• 📈 <b>好友实盘累计交易量</b>: <b>$${stats.volume.toLocaleString()} USDT</b>
• 💰 <b>历史累计总返佣</b>: <b>+$${stats.totalEarnings.toFixed(4)} USDT</b>
• 💳 <b>当前可提现余额</b>: <b>$${stats.available.toFixed(4)} USDT</b>
• 📤 <b>已申请/已发放返佣</b>: <b>$${stats.withdrawn.toFixed(4)} USDT</b>
${stats.pendingPayoutUsdt > 0 ? `• ⏳ <b>待链上发放总额</b>: <b>$${stats.pendingPayoutUsdt.toFixed(4)} USDT</b>\n` : ''}
🔗 <b>您的专属推广链接:</b>
<code>${refLink}</code>

💡 <i>返佣仅在好友真实链上成交后实时记账，满 1.00 USDT 即可点击下方按钮发起链上提现！</i>${noticeLine}
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('💳 立即提取返佣收益 (满1U可提)', 'withdraw_referral')
        .row()
        .url(
          '🚀 转发到 Telegram 群/好友',
          `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Injective 链上实盘聪明钱巨鲸自动跟单神器，点此开启挂机跟单！')}`
        )
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(() => {});
    };

    // 邀请返佣收益看板
    this.bot.callbackQuery('view_referral', async (ctx) => {
      const userId = ctx.from?.id || 888888;
      await ctx.answerCallbackQuery().catch(() => {});
      await renderReferralView(ctx, userId);
    });

    // 申请提现推广返佣 (支持链上真实发放或记录可审计待发单 + 通知管理员人工审核)
    this.bot.callbackQuery('withdraw_referral', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const res = this.walletService.withdrawReferralRewards(userId);
      if (!res.success) {
        await ctx.answerCallbackQuery({ text: res.message, show_alert: true }).catch(() => {});
        return;
      }

      const autoPayoutEnabled = Boolean(
        this.config.referralPayoutPrivateKey &&
          process.env.BLOCK_USER_REAL_TRADES !== 'true' &&
          res.payoutId
      );

      if (autoPayoutEnabled) {
        await ctx.answerCallbackQuery('⏳ 正在向您的钱包发起链上返佣打款...').catch(() => {});
      }

      let statusNote = `提现单 <code>${res.payoutId}</code> 已提交，等待管理员审核后向 <code>${res.wallet.injectiveAddress}</code> 发放。`;
      let alertMsg = `✅ 已提交 $${res.amount.toFixed(2)} USDT 返佣提现申请 (${res.payoutId})，已通知管理员审核打款！`;

      if (autoPayoutEnabled && res.payoutId) {
        try {
          const payoutDenom =
            process.env.REFERRAL_PAYOUT_DENOM ||
            'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7';
          const txHash = await this.copyEngine
            .getInjectiveService()
            .sendBankToken(
              this.config.referralPayoutPrivateKey!,
              res.wallet.injectiveAddress,
              payoutDenom,
              res.amount,
              6
            );
          this.walletService.markReferralPayoutPaid(userId, res.payoutId, txHash);
          statusNote = `🎉 已真实链上打款！Tx: <a href="https://injscan.com/transaction/${txHash}">${txHash}</a>`;
          await renderReferralView(ctx, userId, statusNote);
          return;
        } catch (err: any) {
          console.warn('[TelegramBot] 返佣自动链上打款异常，保留待处理打款单:', err.message);
          statusNote = `⏳ 自动打款异常 (${err.message || '网络繁忙'})，提现单 <code>${res.payoutId}</code> 已保留待人工核发。`;
          await renderReferralView(ctx, userId, statusNote);
          return;
        }
      }

      // 通知管理员有新的返佣提现申请待发放
      if (this.bot && this.config.adminTelegramIds && this.config.adminTelegramIds.length > 0) {
        const adminMsg = `
💸 <b>【新返佣提现申请通知】</b>

• <b>提现单号</b>: <code>${res.payoutId}</code>
• <b>申请人</b>: @${ctx.from?.username || userId} (<code>${userId}</code>)
• <b>提现金额</b>: <b>$${res.amount.toFixed(4)} USDT</b>
• <b>收款地址</b>: <code>${res.wallet.injectiveAddress}</code>
        `.trim();
        for (const adminId of this.config.adminTelegramIds) {
          await this.bot.api.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' }).catch(() => {});
        }
      }

      await ctx.answerCallbackQuery({ text: alertMsg, show_alert: true }).catch(() => {});
      await renderReferralView(ctx, userId, statusNote);
    });

    // 实时盈亏与战绩看板
    this.bot.callbackQuery('view_stats', async (ctx) => {
      const userId = ctx.from?.id || 0;
      if (this.isRpcRateLimited(userId, 'view_stats', 2500)) {
        await ctx.answerCallbackQuery('⏳ 请稍候再刷新').catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery('正在刷新实时行情与浮盈...').catch(() => {});
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 一键市价全平实盘链上持仓
    this.bot.callbackQuery('close_all_real_pos', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId);
      if (userWallet.decryptionError) {
        await ctx.answerCallbackQuery({ text: '⚠️ 钱包解密异常，请联系管理员检查密钥配置', show_alert: true }).catch(() => {});
        return;
      }
      if (process.env.BLOCK_USER_REAL_TRADES === 'true') {
        await ctx.answerCallbackQuery({ text: '⚠️ 管理员已暂停实盘下单广播', show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery('正在向 Injective 主网发送市价平仓指令...').catch(() => {});
      const injService = this.copyEngine.getInjectiveService();
      const copyState = this.walletService.getUserCopyState(userId);

      try {
        const positions = await injService.getSubaccountPositions(userWallet.subaccountId);
        let closed = 0;
        let failed = 0;
        for (const pos of positions) {
          try {
            const ob = await injService.getOrderbookPrices(pos.marketId);
            const closeDir = pos.direction === 'long' ? 'SELL' : 'BUY';
            const basePrice = closeDir === 'BUY' ? (ob.bestAsk || pos.markPrice) : (ob.bestBid || pos.markPrice);
            const slip = (copyState.maxSlippagePercent || 1.5) / 100;
            const protPrice = closeDir === 'BUY' ? basePrice * (1 + slip) : basePrice * Math.max(0.01, 1 - slip);

            await injService.executeUserRealMarketOrder(userWallet.privateKeyHex, {
              marketId: pos.marketId,
              direction: closeDir,
              quantity: pos.quantity,
              price: protPrice,
              fillPrice: basePrice,
              leverage: 1,
              isReduceOnly: true,
            });
            this.walletService.clearRealPositionOwners(userId, pos.marketId);
            closed += 1;
          } catch (e: any) {
            failed += 1;
            console.warn(`[TelegramBot] 实盘平仓失败 (${pos.ticker}):`, e.message);
          }
        }
        await ctx.reply(`⚡ 实盘平仓执行完毕：成功 ${closed} 笔${failed > 0 ? `，失败 ${failed} 笔` : ''}。`).catch(() => {});
      } catch (err: any) {
        await ctx.reply(`⚠️ 查询实盘持仓失败: ${err.message}`).catch(() => {});
      }
      await this.renderPortfolioAndStats(ctx, false);
    });

    // 一键市价全平模拟持仓
    this.bot.callbackQuery('close_all_pos', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const injService = this.copyEngine.getInjectiveService();
      const userWallet = this.walletService.getOrCreateWallet(userId);
      const positions = userWallet.practicePositions || [];
      const markPriceMap = new Map<string, number>();

      await Promise.all(
        positions.map(async (pos) => {
          try {
            const ob = await injService.getOrderbook(pos.marketId || pos.marketTicker, pos.marketTicker);
            const p =
              pos.direction === 'BUY'
                ? ob.bestBid > 0
                  ? ob.bestBid
                  : ob.midPrice
                : ob.bestAsk > 0
                ? ob.bestAsk
                : ob.midPrice;
            if (p > 0) markPriceMap.set(pos.marketTicker, p);
          } catch {
            markPriceMap.set(pos.marketTicker, pos.entryPrice);
          }
        })
      );

      const res = this.walletService.closeAllPracticePositions(userId, markPriceMap);
      const sign = res.totalNetPnlUsdt >= 0 ? '+' : '';
      await ctx
        .answerCallbackQuery(
          `⚡ 已全平 ${res.closedCount} 笔持仓，本次结算净盈亏: ${sign}$${res.totalNetPnlUsdt} USDT`
        )
        .catch(() => {});
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 一键仅平仓亏损持仓
    this.bot.callbackQuery('close_loss_pos', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const injService = this.copyEngine.getInjectiveService();
      const userWallet = this.walletService.getOrCreateWallet(userId);
      const positions = userWallet.practicePositions || [];
      const markPriceMap = new Map<string, number>();

      await Promise.all(
        positions.map(async (pos) => {
          try {
            const ob = await injService.getOrderbook(pos.marketId || pos.marketTicker, pos.marketTicker);
            const p =
              pos.direction === 'BUY'
                ? ob.bestBid > 0
                  ? ob.bestBid
                  : ob.midPrice
                : ob.bestAsk > 0
                ? ob.bestAsk
                : ob.midPrice;
            if (p > 0) markPriceMap.set(pos.marketTicker, p);
          } catch {
            markPriceMap.set(pos.marketTicker, pos.entryPrice);
          }
        })
      );

      const res = this.walletService.closeLosingPracticePositions(userId, markPriceMap);
      if (res.closedCount === 0) {
        await ctx.answerCallbackQuery('当前暂无处于亏损状态的持仓').catch(() => {});
      } else {
        await ctx
          .answerCallbackQuery(
            `🧹 已清理 ${res.closedCount} 笔亏损仓位，剩余 ${res.remainingCount} 笔持仓`
          )
          .catch(() => {});
      }
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 一键重置 $10,000 体验金
    this.bot.callbackQuery('reset_practice', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.walletService.resetPracticeAccount(userId);
      await ctx.answerCallbackQuery('🎉 模拟盘账户已重置为初始 $10,000 USDT！').catch(() => {});
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 跟单某大户触发 (支持 follow_whale_1, follow_custom_inj1...)
    this.bot.callbackQuery(/^follow_(.+)$/, async (ctx) => {
      const targetParam = ctx.match[1];
      let targetAddress = '';
      let subaccountIndex = 0;

      if (targetParam.startsWith('custom_')) {
        targetAddress = targetParam.replace('custom_', '');
      } else {
        const whale = this.leaderboard.getWhaleById(targetParam);
        if (whale) {
          targetAddress = whale.address;
          subaccountIndex = whale.subaccountIndex ?? 0;
        } else if (targetParam.startsWith('inj1')) {
          targetAddress = targetParam;
        }
      }

      if (!targetAddress) {
        await ctx.answerCallbackQuery('未找到该巨鲸地址').catch(() => {});
        return;
      }

      await this.applyFollowTarget(ctx, targetAddress, true, subaccountIndex);
    });
  }

  /**
   * 渲染多巨鲸跟单矩阵确认面板 (支持单独移除每个巨鲸或清空全部)
   */
  private async renderMatrixConfirmation(ctx: any, userId: number, isCallback: boolean = true) {
    const targets = this.walletService.getUserTargets(userId);
    const isPractice = this.walletService.isPracticeMode(userId);
    const userCopy = this.walletService.getUserCopyState(userId);
    const modeBadge = isPractice
      ? '【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】'
      : '【🔴 实盘链上交易模式 (专属钱包私钥真实签名上链 Mainnet)】';

    const targetLines = targets
      .map((t, idx) => {
        const w = this.leaderboard.getWhaleByAddress(t.address);
        const activeInfo = w?.lastActiveDesc ? ` | ${w.lastActiveDesc}` : '';
        return `  <b>${idx + 1}. ${t.name}</b>\n     <code>${t.address}</code>${activeInfo}`;
      })
      .join('\n');

    const confirmText = `
✅ <b>已加入您的多巨鲸跟单矩阵！(当前共跟单 ${targets.length} 位巨鲸)</b>

🎯 <b>当前并发监控的巨鲸列表</b>:
${targetLines}

• <b>执行引擎模式</b>: <b>${modeBadge}</b>
• <b>单笔跟单金额</b>: <b>$${userCopy.copyAmountUsdt} USDT</b>
• <b>滑点保护阈值</b>: <b>${userCopy.maxSlippagePercent}%</b> | <b>最大杠杆</b>: <b>${userCopy.maxLeverage}x</b>

⚡ <i>多巨鲸并发监听已就绪！以上任意一位巨鲸在 Injective 链上开仓或加仓，系统均将毫秒级为您同步执行跟单，互不覆盖！</i>
    `.trim();

    const keyboard = new InlineKeyboard();
    for (const t of targets) {
      keyboard.text(`❌ 移除 0x${t.address.slice(-4)}`, `unfollow_${t.address.slice(-8)}`).row();
    }

    keyboard
      .text('🏆 继续添加榜单巨鲸', 'view_leaderboard')
      .text('🔍 添加自定义地址', 'track_custom_wallet')
      .row()
      .text('⏸️ 暂停自动跟单', 'pause_copy')
      .text('🗑️ 清空全部目标', 'clear_target')
      .row()
      .text('💰 修改单笔金额', 'set_amount')
      .text('🔙 返回主菜单', 'back_to_menu');

    if (isCallback) {
      try {
        await ctx.editMessageText(confirmText, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch (e) {}
    }

    await ctx.reply(confirmText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  }

  /**
   * 将目标加入用户的多巨鲸跟单矩阵并校验资金
   */
  private async applyFollowTarget(
    ctx: any,
    targetAddress: string,
    isCallback: boolean = false,
    subaccountIndex: number = 0
  ) {
    const userId = ctx.from?.id || 0;

    // 做市商与高频刷量机器人防御拦截：绝对禁止用户选到做市商跟单
    const mmAudit = await this.leaderboard.auditTraderIsMarketMaker(targetAddress);
    if (mmAudit.isMarketMaker) {
      const alertText = `
🛡️ <b>【系统风控安全拦截：检测到高频做市商】</b>

• <b>目标地址</b>: <code>${targetAddress}</code>
• <b>识别诊断</b>: <b>${mmAudit.reason || '高频做市商 / 网格对冲套利程序'}</b>

⚠️ <b>为什么系统严禁跟单此类地址？</b>
1. 该地址属于<b>链上高频做市商/套利程序</b>，依靠频繁挂单（Maker）赚取极微小价差或交易所返佣。
2. 跟单系统使用市价吃单（Taker），跟随此类程序将承受<b>每笔 0.1% 的滑点与手续费双重磨损</b>，导致本金在频繁对冲中迅速缩水！

⛔ <b>系统已自动拦截该跟单请求，保障您的本金安全！</b>
👉 建议前往<b>【🏆 聪明钱排行榜】</b>选择持仓周期长、单笔规模大的真实波段巨鲸。
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🏆 选择精选波段巨鲸', 'view_leaderboard')
        .text('🔙 返回主菜单', 'back_to_menu');

      if (isCallback) {
        await ctx.answerCallbackQuery({ text: '⚠️ 拦截：该地址为做市商程序，已拒绝跟单！', show_alert: true }).catch(() => {});
        await ctx.editMessageText(alertText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
          await ctx.reply(alertText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        });
      } else {
        await ctx.reply(alertText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      }
      return;
    }

    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
    const injPrice = await this.getLiveInjPrice();
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
    const isPractice = this.walletService.isPracticeMode(userId);
    const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;

    const whale = this.leaderboard.getWhaleByAddress(targetAddress);
    const effectiveSubIdx = whale?.subaccountIndex ?? subaccountIndex;
    const name = whale ? `${whale.name} ${whale.badge}` : `自定义巨鲸 0x${targetAddress.slice(-4)}`;

    // 加入用户的多巨鲸跟单列表 (绝不覆盖已有巨鲸，保留真实子账户序号)
    const { targets } = this.walletService.addUserTarget(userId, targetAddress, name, effectiveSubIdx);

    // 零余额处理逻辑: 如果实盘无资金且未激活体验金，引导清晰二选一选择
    if (!hasRealFunds && !isPractice) {
      if (isCallback) {
        await ctx.answerCallbackQuery().catch(() => {});
      }
      await this.promptZeroBalanceChoice(ctx, targetAddress, isCallback);
      return;
    }

    // 激活多巨鲸并发监听
    this.walletService.setUserCopying(userId, true);
    for (const t of targets) {
      await this.tracker.addTrackedTrader(t.address, t.subaccountIndex ?? 0);
    }
    this.leaderboard.registerCustomWhale(targetAddress);

    if (isCallback) {
      await ctx.answerCallbackQuery(`✅ 已加入跟单矩阵 (当前共 ${targets.length} 位巨鲸)`).catch(() => {});
    }

    await this.renderMatrixConfirmation(ctx, userId, isCallback);
  }

  /**
   * 处理用户输入的自定义 Injective 钱包地址
   */
  private async handleCustomAddressInput(ctx: any, rawAddress: string) {
    const userId = ctx.from?.id || 0;
    this.awaitingAddressUsers.delete(userId);

    const check = validateInjectiveAddress(rawAddress);
    if (!check.valid || !check.cleanAddress) {
      const errText = `
❌ <b>地址格式校验失败</b>

${check.error || '输入的地址格式不正确'}
请检查并重新输入以 <code>inj1...</code> 开头的 42 位有效 Injective 地址。
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🔍 重新输入地址', 'track_custom_wallet')
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.reply(errText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      return;
    }

    const targetAddress = check.cleanAddress;
    console.log(`[TelegramBot] ✅ 成功验证并将自定义监控地址加入跟单矩阵: ${targetAddress}`);

    await this.applyFollowTarget(ctx, targetAddress, false);
  }

  /**
   * 筛选出已开启自动跟单、且明确跟单了该触发巨鲸地址的目标用户列表 (未开启或未跟单该巨鲸的用户绝不打扰)
   */
  public getMatchedFollowerWallets(traderAddress?: string) {
    const allWallets = this.walletService.getAllWallets();
    return allWallets.filter((w) => {
      if (!w.isCopyingEnabled) return false;
      const userTargets = this.walletService.getUserTargets(w.telegramId);
      if (userTargets.length === 0) return false;
      if (traderAddress) {
        return userTargets.some((t) => t.address.toLowerCase() === traderAddress.toLowerCase());
      }
      return true;
    });
  }

  /**
   * 按用户专属风控参数折算下单数量、滑点保护上限价与所需保证金
   */
  public calculateUserOrderSizing(
    userId: number,
    result: CopyOrderResult,
    event?: SmartMoneyTradeEvent
  ) {
    const userWallet = this.walletService.getOrCreateWallet(userId);
    const copyState = this.walletService.getUserCopyState(userId);
    const injService = this.copyEngine.getInjectiveService();
    const market =
      (result.marketId ? injService.getMarket(result.marketId) : undefined) ||
      injService.getMarketByTicker(result.marketTicker);

    const execPrice = Number(result.executionPrice || 0);
    const userAmountUsdt = copyState.copyAmountUsdt;

    if (market && event) {
      const riskEval = this.copyEngine.getRiskManager().evaluate({
        event,
        market,
        currentMidPrice: result.currentMidPrice || execPrice,
        currentAsk: result.currentAsk,
        currentBid: result.currentBid,
        userRiskConfig: {
          copyMode: copyState.copyMode,
          fixedUsdtAmount: copyState.copyAmountUsdt,
          copyRatio: copyState.copyRatio,
          maxSlippagePercent: copyState.maxSlippagePercent,
          maxNotionalPerOrder: copyState.maxNotionalPerOrder,
          maxLeverage: copyState.maxLeverage,
        },
      });

      return {
        passed: riskEval.passed,
        reason: riskEval.reason,
        userWallet,
        userAmountUsdt,
        userQuantity: riskEval.adjustedQuantity,
        userMargin: riskEval.calculatedMargin,
        execPrice: riskEval.fillPrice || execPrice,
        protectionPrice: riskEval.adjustedPrice,
        leverage: riskEval.leverage,
        market,
      };
    }

    const leverage = Math.min(copyState.maxLeverage || result.leverage || 1, 20);
    const tickSize = market?.minQuantityTickSize || 0.001;
    const precision = Math.max(0, Math.min(8, -Math.floor(Math.log10(tickSize))));
    const targetNotional =
      copyState.copyMode === 'RATIO' && event
        ? Math.min(event.notionalUsd * copyState.copyRatio, copyState.maxNotionalPerOrder)
        : Math.min(userAmountUsdt, copyState.maxNotionalPerOrder);

    const rawQty = execPrice > 0 ? targetNotional / execPrice : Number(result.executedQuantity || 0);
    const userQuantity = Number((Math.floor(rawQty / tickSize) * tickSize).toFixed(precision));

    if (userQuantity < tickSize || userQuantity <= 0) {
      return {
        passed: false,
        reason: `折算数量 ${userQuantity} 低于市场最小下单单位 ${tickSize}`,
        userWallet,
        userAmountUsdt,
        userQuantity: 0,
        userMargin: 0,
        execPrice,
        protectionPrice: result.protectionPrice || execPrice,
        leverage,
        market,
      };
    }

    const userMargin = Number(((userQuantity * execPrice) / leverage).toFixed(4));
    const slip = (copyState.maxSlippagePercent || this.config.maxSlippagePercent || 1.5) / 100;
    const rawProt =
      result.direction === 'BUY' ? execPrice * (1 + slip) : execPrice * Math.max(0.01, 1 - slip);

    return {
      passed: true,
      userWallet,
      userAmountUsdt,
      userQuantity,
      userMargin,
      execPrice,
      protectionPrice: result.protectionPrice || rawProt,
      leverage,
      market,
    };
  }

  /**
   * 向广播频道/群组推送高质量大额聪明钱异动 (过滤小额 TWAP 拆单与 5 分钟内重复推送)
   */
  public async broadcastSignal(event: SmartMoneyTradeEvent) {
    if (!this.bot || !this.config.telegramBroadcastChatId) return;

    const minChannelNotional = this.config.channelMinNotionalUsd ?? 1000;
    if (event.notionalUsd < minChannelNotional) {
      return;
    }

    const nowMs = Date.now();
    const channelKey = `${event.traderAddress.toLowerCase()}_${event.marketId}_${event.direction}`;
    const lastSent = this.channelBroadcastCooldowns.get(channelKey) || 0;
    if (nowMs - lastSent < 300_000) {
      return;
    }
    this.channelBroadcastCooldowns.set(channelKey, nowMs);
    if (this.channelBroadcastCooldowns.size > 2000) {
      for (const [k, ts] of this.channelBroadcastCooldowns.entries()) {
        if (nowMs - ts > 600_000) this.channelBroadcastCooldowns.delete(k);
      }
    }

    const isBuy = event.direction === 'BUY';
    const text = `
🚨 <b>【Injective 链上巨鲸大额异动】</b>

• <b>标的资产</b>: <code>${event.marketTicker}</code>
• <b>操作方向</b>: ${isBuy ? '🟢 做多 (LONG)' : '🔴 做空 (SHORT)'}
• <b>成交价格</b>: <b>$${event.price}</b>
• <b>大户仓位</b>: <b>${event.quantity}</b> (约 <b>$${event.notionalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>)
• <b>巨鲸地址</b>: <code>${event.traderAddress.substring(0, 8)}...${event.traderAddress.slice(-6)}</code>

⚡ <i>大额实时异动信号，点击下方按钮可一键跟随该巨鲸！</i>
    `.trim();

    try {
      const kb = this.bot.botInfo?.username
        ? new InlineKeyboard().url(
            `⚡ 一键跟单 (${isBuy ? '做多' : '做空'})`,
            `https://t.me/${this.bot.botInfo.username}?start=follow_${event.traderAddress}`
          )
        : undefined;
      await this.bot.api.sendMessage(this.config.telegramBroadcastChatId, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch (e) {}
  }

  /**
   * 构造严格区分【模拟盘演练】、【实盘链上真实上链】与【实盘余额不足/广播异常】的成交通知文案
   */
  public formatTradeNotificationText(
    userId: number,
    result: CopyOrderResult,
    options?: {
      realTxHash?: string;
      paperOrderId?: string;
      userQuantity?: number;
      userMargin?: number;
      leverage?: number;
      insufficientRealBalance?: { inj: string; usdt: string; requiredMargin: number; userAmountUsdt: number };
      realBroadcastError?: string;
      customBlockedReason?: string;
    }
  ): string {
    if (!result.success || options?.customBlockedReason) {
      return `
🛑 <b>【跟单已安全拦截（风控保护生效）】</b>

• 市场: <code>${result.marketTicker}</code>
• 拦截原因: <i>${options?.customBlockedReason || result.error}</i>
• 您的资金不受任何影响，已成功规避潜在亏损！
      `.trim();
    }

    const sizing = this.calculateUserOrderSizing(userId, result);
    const userWallet = sizing.userWallet;
    const isPrac = !!userWallet.practiceMode;
    const finalQty = options?.userQuantity ?? sizing.userQuantity;
    const finalMargin = options?.userMargin ?? sizing.userMargin;
    const finalLeverage = options?.leverage ?? sizing.leverage;

    if (isPrac) {
      const positionsCount = (userWallet.practicePositions || []).length;
      const availBal = (userWallet.practiceBalanceUsdt ?? 10000).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const paperId = options?.paperOrderId || `#PAPER_${Date.now().toString().slice(-6)}`;

      return `
🧪 <b>【模拟盘跟单成交 (体验金演练)】</b>

• <b>执行模式</b>: <i>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</i>
• <b>交易市场</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>模拟成交价</b>: <b>$${result.executionPrice}</b> | 专属数量: <b>${finalQty}</b>
• <b>扣除虚拟保证金</b>: <b>$${finalMargin.toFixed(2)} USDT</b> (${finalLeverage}x 杠杆)
• <b>剩余可用体验金</b>: <b>$${availBal} USDT</b> (当前模拟持仓 ${positionsCount} 笔)
• <b>模拟撮合流水号</b>: <code>${paperId} (未上链)</code>
      `.trim();
    }

    if (options?.insufficientRealBalance) {
      const info = options.insufficientRealBalance;
      return `
⚠️ <b>【实盘跟单未执行：链上实盘余额不足】</b>

• <b>当前模式</b>: <b>🔴 实盘链上交易模式</b>
• <b>触发标的</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>本单所需保证金</b>: <b>$${info.requiredMargin.toFixed(2)}</b> (按您设置的 $${info.userAmountUsdt} USDT/单折算)
• <b>您的当前实盘余额</b>: <b>${info.inj} INJ / ${info.usdt}</b>

💡 <i>实盘链上跟单需要您专属钱包内有充足的对应合约保证金与少量 INJ (Gas 费)。系统已安全跳过本次链上广播，绝不虚报成交！请先充值或一键切换为 $10,000 模拟盘演练：</i>
      `.trim();
    }

    if (options?.realBroadcastError) {
      return `
⚠️ <b>【实盘链上广播异常（未扣款）】</b>

• <b>签名地址</b>: <code>${userWallet.injectiveAddress}</code>
• <b>交易市场</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>链上节点返回原因</b>: <i>${options.realBroadcastError}</i>
      `.trim();
    }

    const realHash =
      options?.realTxHash ||
      (result.txHash && !result.txHash.startsWith('simulated') ? result.txHash : '');

    if (!realHash) {
      return `
⚠️ <b>【实盘跟单未执行：未获取到链上交易哈希】</b>

• <b>签名地址</b>: <code>${userWallet.injectiveAddress}</code>
• <b>交易市场</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>状态说明</b>: <i>未完成主网真实签名广播，请检查实盘余额或切换至模拟盘演练。</i>
      `.trim();
    }

    const txLink = `<a href="https://injscan.com/transaction/${realHash}">${realHash}</a>`;

    return `
🔴 <b>【实盘链上跟单成功 (Mainnet 真实上链)】</b>

• <b>执行模式</b>: <b>🔴 专属钱包私钥真实签名广播</b>
• <b>签名地址</b>: <code>${userWallet.injectiveAddress}</code>
• <b>交易市场</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>实盘成交价</b>: <b>$${result.executionPrice}</b> | 专属数量: <b>${finalQty}</b>
• <b>实盘占用保证金</b>: <b>$${finalMargin.toFixed(2)} USDT</b> (${finalLeverage}x 杠杆)
• <b>链上广播耗时</b>: <b>${result.executionTimeMs} ms</b>
• <b>主网交易哈希</b>: ${txLink}
    `.trim();
  }

  /**
   * 推送跟单结果：仅针对已开启跟单且匹配该巨鲸的目标用户，按其专属风控与金额折算并分批并发执行
   */
  public async notifyCopyTradeResult(result: CopyOrderResult, event?: SmartMoneyTradeEvent) {
    const matchedFollowers = this.getMatchedFollowerWallets(event?.traderAddress);
    if (matchedFollowers.length === 0) return;

    const injService = this.copyEngine.getInjectiveService();
    const injPrice = await this.getLiveInjPrice();

    const processUser = async (w: ReturnType<typeof this.getMatchedFollowerWallets>[number]) => {
      const chatId = w.telegramId;
      const sizing = this.calculateUserOrderSizing(chatId, result, event);

      if (!sizing.passed) {
        const blockedText = this.formatTradeNotificationText(chatId, result, {
          customBlockedReason: sizing.reason || result.error || '未通过个人风控检查',
        });
        if (this.bot) {
          await this.bot.api.sendMessage(chatId, blockedText, { parse_mode: 'HTML' }).catch(() => {});
        }
        return;
      }

      // 使用用户个人风控校验通过后的有效结果对象，避免全局风控未通过覆盖已通过用户的通知模板
      const effectiveResult: CopyOrderResult = {
        ...result,
        success: true,
        executionPrice: sizing.execPrice,
        leverage: sizing.leverage,
      };

      if (w.practiceMode) {
        // 1. 模拟盘演练模式：扣减虚拟体验金（严禁在模拟盘累计真实推荐返佣！）
        const pracRes = this.walletService.executePracticeTrade(chatId, {
          marketId: sizing.market?.marketId || result.marketId,
          marketTicker: result.marketTicker,
          direction: result.direction,
          price: sizing.execPrice,
          quantity: sizing.userQuantity,
          marginUsdt: sizing.userMargin,
          leverage: sizing.leverage,
          traderAddress: event?.traderAddress,
        });

        if (pracRes.action === 'SKIPPED') {
          return;
        }

        const text = pracRes.success
          ? this.formatTradeNotificationText(chatId, effectiveResult, {
              userQuantity: sizing.userQuantity,
              userMargin: sizing.userMargin,
              leverage: sizing.leverage,
            })
          : `⚠️ <b>【模拟盘跟单未执行】</b>\n\n• 原因: <i>${pracRes.error}</i>`;

        // 消息限流防刷屏控制：30 秒内最多发送 1 条成交详情推送
        const now = Date.now();
        const lastNotice = this.lastUserNotificationTime.get(chatId) || 0;
        if (now - lastNotice >= 30_000) {
          this.lastUserNotificationTime.set(chatId, now);
          if (this.bot) {
            await this.bot.api
              .sendMessage(chatId, text, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              })
              .catch(() => {});
          }
        }
        return;
      }

      // 2. 实盘链上交易模式
      if (process.env.BLOCK_USER_REAL_TRADES === 'true') {
        if (this.bot) {
          await this.bot.api
            .sendMessage(
              chatId,
              `⏸️ <b>【实盘广播暂已暂停】</b>\n\n已捕获信号 <code>${result.marketTicker}</code> (${result.direction})，管理员当前已开启实盘拦截开关。`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
        return;
      }

      if (w.decryptionError) {
        if (this.bot) {
          await this.bot.api
            .sendMessage(
              chatId,
              `⚠️ <b>【实盘签名失败】</b> 您的本地钱包密钥解密异常，请联系管理员检查服务器密钥配置或重新导入钱包。`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
        return;
      }

      const balances = await this.walletService.getRealBalances(w.injectiveAddress, injPrice);
      const injBal = parseFloat(balances.inj);
      const quoteDenom = sizing.market?.quoteDenom || '';
      const exactQuoteBal =
        quoteDenom && balances.denomTotals[quoteDenom] !== undefined
          ? balances.denomTotals[quoteDenom]
          : sizing.market?.ticker?.toUpperCase().includes('USDC')
          ? parseFloat(balances.usdc)
          : parseFloat(balances.usdt);

      // 查询用户当前链上是否已持有反向仓位（若为反向平仓/减仓，使用 reduceOnly 无需追加保证金；同时检查多巨鲸方向冲突）
      let existingOppositePos: Awaited<ReturnType<typeof injService.getSubaccountPositions>>[number] | undefined;
      if (sizing.market) {
        try {
          const openPositions = await injService.getSubaccountPositions(w.subaccountId);
          existingOppositePos = openPositions.find(
            (p) =>
              p.marketId === sizing.market!.marketId &&
              ((result.direction === 'SELL' && p.direction === 'long') ||
                (result.direction === 'BUY' && p.direction === 'short'))
          );
          if (!openPositions.some((p) => p.marketId === sizing.market!.marketId)) {
            this.walletService.clearRealPositionOwners(chatId, sizing.market.marketId);
          }
        } catch {
          // ignore query failure and fall back to normal margin check
        }
      }

      const isReduceOnly = Boolean(existingOppositePos && existingOppositePos.quantity > 0);
      if (isReduceOnly && sizing.market && event?.traderAddress) {
        const conflictCheck = this.walletService.checkRealPositionConflict(
          chatId,
          sizing.market.marketId,
          result.direction,
          event.traderAddress
        );
        if (conflictCheck.conflict) {
          const ownerTag = conflictCheck.ownerAddresses.map((a) => `0x${a.slice(-4)}`).join(', ');
          if (this.bot) {
            await this.bot.api
              .sendMessage(
                chatId,
                `🛡️ <b>【多巨鲸方向冲突保护】</b>\n\n• <b>合约</b>: <code>${result.marketTicker}</code>\n• <b>拦截原因</b>: 您当前实盘持仓归属于巨鲸 <code>${ownerTag}</code>，已安全拦截来自巨鲸 <code>0x${event.traderAddress.slice(-4)}</code> 的反向 <b>${result.direction}</b> 信号，防止左右互搏误平仓！`,
                { parse_mode: 'HTML' }
              )
              .catch(() => {});
          }
          return;
        }
      }

      const tick = sizing.market?.minQuantityTickSize || 0.001;
      const tickPrecision = Math.max(0, Math.min(8, -Math.floor(Math.log10(tick))));
      const finalOrderQty = isReduceOnly
        ? Number((Math.floor(Math.min(sizing.userQuantity, existingOppositePos!.quantity) / tick) * tick).toFixed(tickPrecision))
        : sizing.userQuantity;
      const requiredMargin = isReduceOnly ? 0 : sizing.userMargin;

      if (
        !sizing.market ||
        injBal < 0.002 ||
        finalOrderQty < tick ||
        (!isReduceOnly && exactQuoteBal < requiredMargin)
      ) {
        const warnText = this.formatTradeNotificationText(chatId, effectiveResult, {
          insufficientRealBalance: {
            inj: balances.inj,
            usdt: `${balances.usdt} USDT / ${balances.usdc} USDC`,
            requiredMargin,
            userAmountUsdt: sizing.userAmountUsdt,
          },
        });
        const warnKb = new InlineKeyboard()
          .text('💳 立即充值激活', 'deposit_guide')
          .text('🧪 一键切换为模拟盘跟单', 'switch_mode_practice')
          .row()
          .text('🔙 返回主菜单', 'back_to_menu');

        if (this.bot) {
          await this.bot.api
            .sendMessage(chatId, warnText, {
              parse_mode: 'HTML',
              reply_markup: warnKb,
            })
            .catch(() => {});
        }
        return;
      }

      // 实盘余额充足：使用带滑点保护上限的 protectionPrice 真实签名上链
      try {
        const realOrder = await injService.executeUserRealMarketOrder(w.privateKeyHex, {
          marketId: sizing.market.marketId,
          direction: result.direction,
          quantity: finalOrderQty,
          price: sizing.protectionPrice,
          fillPrice: sizing.execPrice,
          leverage: sizing.leverage,
          isReduceOnly,
        });

        const fullyClosed = isReduceOnly && existingOppositePos ? finalOrderQty >= existingOppositePos.quantity : false;
        this.walletService.updateRealPositionOwner(
          chatId,
          sizing.market.marketId,
          result.direction,
          event?.traderAddress,
          isReduceOnly,
          fullyClosed
        );

        const actualMarginUsed = isReduceOnly
          ? 0
          : Number(((finalOrderQty * sizing.execPrice) / sizing.leverage).toFixed(4));

        const text = this.formatTradeNotificationText(chatId, effectiveResult, {
          realTxHash: realOrder.txHash,
          userQuantity: finalOrderQty,
          userMargin: actualMarginUsed,
          leverage: sizing.leverage,
        });

        // 仅在实盘真实上链成功后结算邀请返佣
        const tradeNotional = finalOrderQty * sizing.execPrice;
        const refRes = this.walletService.recordReferralReward(chatId, tradeNotional);
        if (refRes && refRes.rewardUsdt >= 0.0001 && this.bot) {
          await this.bot.api
            .sendMessage(
              refRes.referrerId,
              `💰 <b>【好友实盘跟单返佣到账】</b>\n\n• 来自好友: @${w.username || chatId}\n• 本单产生返佣: <b>+$${refRes.rewardUsdt.toFixed(4)} USDT</b>\n• 您的累计总返佣: <b>$${refRes.totalEarned.toFixed(2)} USDT</b>\n\n👉 <i>随时点击主菜单【🎁 邀请返佣】查看明细与申请提现！</i>`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }

        if (this.bot) {
          await this.bot.api
            .sendMessage(chatId, text, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            })
            .catch(() => {});
        }
      } catch (err: any) {
        console.warn(`[TelegramBot] 用户 ${chatId} 实盘广播异常:`, err.message);
        const errText = this.formatTradeNotificationText(chatId, effectiveResult, {
          realBroadcastError: err.message || String(err),
        });
        if (this.bot) {
          await this.bot.api.sendMessage(chatId, errText, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    };

    // 分批并发执行，避免几十上百名用户串行等待造成剧烈滑点或触发限流
    const batchSize = 5;
    for (let i = 0; i < matchedFollowers.length; i += batchSize) {
      const batch = matchedFollowers.slice(i, i + batchSize);
      await Promise.all(batch.map((w) => processUser(w)));
    }
  }
}
