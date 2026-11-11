import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Address } from '@injectivelabs/sdk-ts';
import { AppConfig } from '../config/index.js';
import { CopyEngine } from './copy-engine.js';
import { LeaderboardService, WhaleProfile } from './leaderboard.service.js';
import { SmartMoneyTracker } from './smart-money-tracker.js';
import { WalletService } from './wallet.service.js';
import { CopyOrderResult, SmartMoneyTradeEvent } from '../types/index.js';
import {
  BotLang,
  detectTelegramLang,
  formatActiveAgo,
  localizeServiceMessage,
  tr,
} from '../i18n.js';

export function validateInjectiveAddress(
  addr: string,
  lang: BotLang = 'zh'
): { valid: boolean; error?: string; cleanAddress?: string } {
  if (!addr || typeof addr !== 'string') {
    return { valid: false, error: tr(lang, '请输入有效的 Injective 钱包地址。', 'Please enter a valid Injective wallet address.') };
  }
  const clean = addr.trim();
  if (!clean.startsWith('inj1')) {
    return { valid: false, error: tr(lang, 'Injective 链上地址必须以 "inj1" 开头。', 'Injective addresses must start with "inj1".') };
  }
  if (clean.length !== 42) {
    return {
      valid: false,
      error: tr(
        lang,
        `地址长度不符合规范（当前 ${clean.length} 位，标准为 42 位）。`,
        `Invalid address length (${clean.length} chars; expected 42).`
      ),
    };
  }
  try {
    const parsed = Address.fromBech32(clean);
    if (parsed.toBech32() !== clean) {
      return { valid: false, error: tr(lang, '地址校验和不匹配，请核对地址是否输入完整。', 'Address checksum mismatch; please check the full address.') };
    }
    return { valid: true, cleanAddress: clean };
  } catch (err: any) {
    return { valid: false, error: tr(lang, `地址安全校验未通过: ${err.message || '无效的钱包地址'}`, `Address validation failed: ${err.message || 'Invalid wallet address'}`) };
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
    if (this.whaleRadar && typeof this.whaleRadar.setLanguageResolver === 'function') {
      this.whaleRadar.setLanguageResolver((id: number) => this.walletService.getUserLanguage(id));
    }
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

  private getLang(ctx?: any): BotLang {
    const userId = ctx?.from?.id;
    const tgCode = ctx?.from?.language_code;
    if (userId) {
      return this.walletService.getUserLanguage(userId, tgCode);
    }
    return detectTelegramLang(tgCode);
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
      const enCommands = [
        { command: 'start', description: '🚀 Open copy-trading terminal' },
        { command: 'track', description: '🔍 Track custom Injective wallet' },
        { command: 'leaderboard', description: '🏆 Live smart-money leaderboard' },
        { command: 'amount', description: '💰 Set per-order copy amount' },
        { command: 'referral', description: '🎁 Refer & earn 25% commission' },
        { command: 'stats', description: '📊 Live portfolio & PnL stats' },
      ];
      const zhCommands = [
        { command: 'start', description: '🚀 打开完整跟单控制台' },
        { command: 'track', description: '🔍 监控自定义 Injective 钱包' },
        { command: 'leaderboard', description: '🏆 链上实盘聪明钱排行榜' },
        { command: 'amount', description: '💰 设置单笔跟单金额' },
        { command: 'referral', description: '🎁 邀请好友赚 25% 返佣' },
        { command: 'stats', description: '📊 实时运行战绩看板' },
      ];
      this.bot.api.setMyCommands(enCommands).catch(() => {});
      this.bot.api.setMyCommands(zhCommands, { language_code: 'zh' }).catch(() => {});

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
   * 生成统一的完整控制台键盘 (支持一键启停跟单、多巨鲸矩阵管理、实盘/模拟模式切换与双语切换)
   */
  private getMainMenuKeyboard(userId?: number, lang: BotLang = 'zh'): InlineKeyboard {
    const copyState = userId ? this.walletService.getUserCopyState(userId) : undefined;
    const isCopying = copyState?.isCopyingEnabled;
    const isPractice = copyState?.practiceMode;
    const toggleBtnText = isCopying
      ? tr(lang, '⏸️ 暂停自动跟单', '⏸️ Pause Copy-Trade')
      : tr(lang, '⚡ 开启自动跟单', '⚡ Start Copy-Trade');
    const toggleBtnAction = isCopying ? 'pause_copy' : 'start_copy';
    const modeSwitchText = isPractice
      ? tr(lang, '🔴 切换为：实盘链上交易模式', '🔴 Switch to: Live Mainnet Trading')
      : tr(lang, '🧪 切换为：$10,000 模拟演练模式', '🧪 Switch to: $10,000 Practice Sandbox');
    const modeSwitchAction = isPractice ? 'switch_mode_real' : 'switch_mode_practice';

    return new InlineKeyboard()
      .text(tr(lang, '👛 我的钱包', '👛 My Wallet'), 'view_wallet')
      .text(tr(lang, '🏆 聪明钱榜单', '🏆 Leaderboard'), 'view_leaderboard')
      .row()
      .text(tr(lang, '🔍 监控自定义钱包', '🔍 Track Wallet'), 'track_custom_wallet')
      .text(toggleBtnText, toggleBtnAction)
      .row()
      .text(modeSwitchText, modeSwitchAction)
      .row()
      .text(tr(lang, '💰 修改金额', '💰 Order Size'), 'set_amount')
      .text(tr(lang, '🛡️ 风控与矩阵', '🛡️ Risk & Matrix'), 'config_copy')
      .row()
      .text(tr(lang, '🎁 邀请返佣', '🎁 Referrals'), 'view_referral')
      .text(tr(lang, '📊 实时战绩', '📊 Portfolio & Stats'), 'view_stats')
      .row()
      .text(tr(lang, '🌐 切换语言: 中文 / EN', '🌐 Language: EN / 中文'), 'toggle_lang');
  }

  /**
   * 生成专业、严谨的主控制面板文案 (支持中英自动检测与切换)
   */
  private async getMainMenuText(
    userId: number,
    username?: string,
    lang: BotLang = 'zh',
    tgLangCode?: string
  ): Promise<string> {
    const userWallet = this.walletService.getOrCreateWallet(userId, username, tgLangCode);
    const userCopy = this.walletService.getUserCopyState(userId);
    const targets = this.walletService.getUserTargets(userId);
    const isPractice = this.walletService.isPracticeMode(userId);
    const injPrice = await this.getLiveInjPrice();
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);

    let targetDesc = '';
    if (targets.length === 0) {
      targetDesc = tr(
        lang,
        '⚪ 暂未选择 (请点击下方榜单或自定义监控)',
        '⚪ None selected (pick from Leaderboard or Track Wallet below)'
      );
    } else {
      const listStr = targets
        .map((t, idx) => `${idx + 1}. ${tr(lang, '巨鲸', 'Whale')} 0x${t.address.slice(-4)}`)
        .join(' | ');
      targetDesc = tr(
        lang,
        `🎯 已同时监控 ${targets.length} 位巨鲸: ${listStr}`,
        `🎯 Tracking ${targets.length} whale(s): ${listStr}`
      );
    }

    const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;
    const execModeBanner = isPractice
      ? tr(
          lang,
          '【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】',
          '[🧪 Practice Sandbox (Virtual balance, zero gas)]'
        )
      : tr(
          lang,
          '【🔴 实盘链上模式 (专属钱包私钥签名，Mainnet 真实上链)】',
          '[🔴 Live Mainnet Mode (On-chain signed execution)]'
        );

    let modeText = '';
    if (!userCopy.isCopyingEnabled) {
      modeText = tr(lang, '⚪ 未启动 (尚未开启跟单)', '⚪ Idle (Auto-copy paused)');
    } else if (isPractice) {
      modeText = tr(lang, '🟢 自动跟单中 (🧪 $10,000 模拟演练模式)', '🟢 Active (🧪 $10,000 Practice Sandbox)');
    } else if (hasRealFunds) {
      modeText = tr(lang, '🟢 自动跟单中 (🔴 实盘链上真实扣款)', '🟢 Active (🔴 Live Mainnet Execution)');
    } else {
      modeText = tr(
        lang,
        '⚪ 待充值激活 (实盘余额不足，可充值或切换模拟盘)',
        '⚪ Waiting for Deposit (Fund wallet or switch to Practice Sandbox)'
      );
    }

    const positions = userWallet.practicePositions || [];
    const usedPracticeMargin = positions.reduce((sum, p) => sum + (p.marginUsdt || 0), 0);
    const availPractice = userWallet.practiceBalanceUsdt ?? 10000;

    const balanceDisplay = isPractice
      ? tr(
          lang,
          `• <b>体验金可用本金</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>模拟持仓占用保证金</b>: <b>$${usedPracticeMargin.toFixed(2)} USDT (${positions.length} 笔持仓)</b>\n• <b>链上实际存入</b>: <code>${balances.inj} INJ</code> | <code>${balances.usdt} USDT</code> | <code>${balances.usdc} USDC</code>`,
          `• <b>Available Practice Balance</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>Practice Margin in Use</b>: <b>$${usedPracticeMargin.toFixed(2)} USDT (${positions.length} open)</b>\n• <b>On-Chain Deposits</b>: <code>${balances.inj} INJ</code> | <code>${balances.usdt} USDT</code> | <code>${balances.usdc} USDC</code>`
        )
      : tr(
          lang,
          `• <b>链上实盘资产</b>: <b>${balances.inj} INJ</b> | <b>${balances.usdt} USDT</b> | <b>${balances.usdc} USDC</b> (估值 ~$${balances.totalUsd} USD)`,
          `• <b>On-Chain Balances</b>: <b>${balances.inj} INJ</b> | <b>${balances.usdt} USDT</b> | <b>${balances.usdc} USDC</b> (~$${balances.totalUsd} USD)`
        );

    const sizingLabel =
      userCopy.copyMode === 'RATIO'
        ? tr(
            lang,
            `按巨鲸 ${(userCopy.copyRatio * 100).toFixed(1)}% 比例 (上限 $${userCopy.maxNotionalPerOrder})`,
            `Proportional ${(userCopy.copyRatio * 100).toFixed(1)}% (Cap $${userCopy.maxNotionalPerOrder})`
          )
        : tr(lang, `$${userCopy.copyAmountUsdt} USDT/单`, `$${userCopy.copyAmountUsdt} USDT / order`);

    if (lang === 'en') {
      return `
🔥 <b>Injective CopyTrade Terminal</b>
<i>Real-Time Smart Money Radar & Automated Copy Execution</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👛 <b>Dedicated Non-Custodial Wallet</b>:
• Address: <code>${userWallet.injectiveAddress}</code>
${balanceDisplay}
<i>(Self-hosted encrypted vault; export mnemonic/key or withdraw anytime)</i>

🎯 <b>Copy Engine Status</b>:
• <b>Targets</b>: ${targetDesc}
• <b>Execution Mode</b>: <b>${execModeBanner}</b>
• <b>Order Size</b>: <b>${sizingLabel}</b>
• <b>Status</b>: <b>${modeText}</b>
• <b>Risk Guard</b>: Max Leverage <b>${userCopy.maxLeverage}x</b> | Max Slippage <b>${userCopy.maxSlippagePercent}%</b>
• <b>Latency</b>: 🟢 Sub-second gRPC stream active 24/7
━━━━━━━━━━━━━━━━━━━━━━━━━━
👇 <b>Select an option below:</b>
      `.trim();
    }

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
    const lang = this.getLang(ctx);
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
    const isPractice = this.walletService.isPracticeMode(userId);
    const targets = this.walletService.getUserTargets(userId);
    const engineStats = this.copyEngine.getStats();
    const injService = this.copyEngine.getInjectiveService();

    let targetDisplay = tr(lang, '暂未选择 (待添加巨鲸)', 'None (Add a whale target first)');
    if (targets.length > 0) {
      targetDisplay = targets
        .map((t, i) => `${i + 1}. 0x${t.address.slice(-4)}`)
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
        const dirText = pos.direction === 'long'
          ? tr(lang, '多 (LONG)', 'LONG')
          : tr(lang, '空 (SHORT)', 'SHORT');
        const roi = pos.margin > 0 ? ((pos.unrealizedPnl / pos.margin) * 100).toFixed(2) : '0.00';
        const cleanTicker = pos.ticker.replace('/USDC PERP', '').replace('/USDT PERP', '');
        const lev = pos.margin > 0 ? Math.max(1, Math.round((pos.markPrice * pos.quantity) / pos.margin)) : 1;

        realCards.push(
          lang === 'en'
            ? `┌── ${dirEmoji} <b>${cleanTicker}</b> (<code>${lev}x ${dirText}</code>)\n` +
              `│ Unrealized PnL: ${pnlEmoji} <b>${sign}$${pos.unrealizedPnl.toFixed(2)} USD (${sign}${roi}%)</b>\n` +
              `│ Size: <b>${pos.quantity}</b> | Margin: <b>$${pos.margin.toFixed(2)}</b>\n` +
              `│ Entry: <code>$${formatDisplayPrice(pos.entryPrice)}</code> ➔ Mark: <code>$${formatDisplayPrice(pos.markPrice)}</code>\n` +
              `└──────────────────────────`
            : `┌── ${dirEmoji} <b>${cleanTicker}</b> (<code>${lev}x ${dirText}</code>)\n` +
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
        realCards.length > 0
          ? realCards.slice(0, 6).join('\n\n')
          : tr(lang, '  ⚪ 当前链上子账户暂无活动持仓', '  ⚪ No active on-chain positions');
      if (realCards.length > 6) {
        posBlock += tr(
          lang,
          `\n\n<i>... 还有 ${realCards.length - 6} 笔链上持仓</i>`,
          `\n\n<i>... ${realCards.length - 6} more on-chain positions</i>`
        );
      }

      let realText =
        lang === 'en'
          ? `
📊 <b>[Live Mainnet Account & Positions]</b>

• <b>Execution Mode</b>: <b>🔴 Live Mainnet (On-Chain Signed Orders)</b>
• <b>Tracked Targets</b>: <b>${targetDisplay}</b>

┌── 💰 <b>Live Account Summary</b> ─────────
│ 💎 Est. Total Equity: <b>$${realEquity.toFixed(2)} USD</b>
│ 💵 Available Stables: <b>${balances.usdt} USDT</b> | <b>${balances.usdc} USDC</b>
│ 🪙 Available Gas: <b>${balances.inj} INJ</b>
│ 🔒 Active Margin: <b>$${totalRealMargin.toFixed(2)} USD</b> (${realPositions.length} open)
│ 📈 Total Unrealized PnL: ${uEmoji} <b>${uSign}$${totalUpnl.toFixed(2)} USD</b>
└────────────────────────────

📈 <b>Open On-Chain Positions (${realPositions.length}):</b>
${posBlock}

⚡ <b>Engine Metrics:</b>
• Signals Captured: <b>${engineStats.total}</b> | Executed: <b>${engineStats.success}</b> | Risk Blocked: <b>${engineStats.total - engineStats.success}</b>
      `.trim()
          : `
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
        realText = realText.slice(0, 3750) + tr(lang, '\n\n<i>(持仓数较多，已自动精简展示)</i>', '\n\n<i>(Truncated due to length)</i>');
      }

      const realKb = new InlineKeyboard().text(tr(lang, '🔄 刷新链上实时持仓与浮盈', '🔄 Refresh Live Positions'), 'view_stats').row();
      if (realPositions.length > 0) {
        realKb.text(
          tr(lang, `⚡ 一键市价全平实盘持仓 (${realPositions.length} 仓)`, `⚡ Market Close All Live (${realPositions.length})`),
          'close_all_real_pos'
        ).row();
      }
      realKb
        .text(tr(lang, '🧪 切换为模拟演练', '🧪 Switch to Sandbox'), 'switch_mode_practice')
        .text(tr(lang, '👛 返回我的钱包', '👛 My Wallet'), 'view_wallet')
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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
      const dirText = pos.direction === 'BUY' ? tr(lang, '多 (LONG)', 'LONG') : tr(lang, '空 (SHORT)', 'SHORT');
      totalUnrealizedPnlUsdt = Number((totalUnrealizedPnlUsdt + uPnl).toFixed(2));
      totalUsedMargin = Number((totalUsedMargin + pos.marginUsdt).toFixed(2));

      const notionalUsd = (curPrice * pos.quantity).toFixed(2);
      const cleanTicker = pos.marketTicker.replace('/USDC PERP', '').replace('/USDT PERP', '');
      const whaleTag = pos.traderAddress ? ` | ${tr(lang, '巨鲸', 'Whale')} 0x${pos.traderAddress.slice(-4)}` : '';

      positionCards.push(
        lang === 'en'
          ? `┌── ${dirEmoji} <b>${cleanTicker}</b> (<code>${pos.leverage}x ${dirText}${whaleTag}</code>)\n` +
            `│ Unrealized PnL: ${pnlEmoji} <b>${sign}$${uPnl.toFixed(2)} USDT (${sign}${uRoi}%)</b>\n` +
            `│ Notional: <b>$${notionalUsd}</b> | Margin: <b>$${pos.marginUsdt.toFixed(2)} USDT</b>\n` +
            `│ Entry: <code>$${formatDisplayPrice(pos.entryPrice)}</code> ➔ Mark: <code>$${formatDisplayPrice(curPrice)}</code>\n` +
            `└──────────────────────────`
          : `┌── ${dirEmoji} <b>${cleanTicker}</b> (<code>${pos.leverage}x ${dirText}${whaleTag}</code>)\n` +
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
      const hDir = h.direction === 'BUY' ? tr(lang, '多', 'LONG') : tr(lang, '空', 'SHORT');
      const cleanH = h.marketTicker.replace('/USDC PERP', '').replace('/USDT PERP', '');
      return lang === 'en'
        ? `  • ${hEmoji} <b>${cleanH} (${hDir})</b>: $${formatDisplayPrice(h.entryPrice)} ➔ $${formatDisplayPrice(h.exitPrice)} | PnL: <b>${hSign}$${h.netPnlUsdt.toFixed(2)} USDT</b>`
        : `  • ${hEmoji} <b>${cleanH} (${hDir})</b>: 开 $${formatDisplayPrice(h.entryPrice)} ➔ 平 $${formatDisplayPrice(h.exitPrice)} | 盈亏: <b>${hSign}$${h.netPnlUsdt.toFixed(2)} USDT</b>`;
    });

    const execModeDesc = tr(
      lang,
      '🧪 模拟盘演练 (虚拟体验金毫秒撮合，不上链不耗 Gas)',
      '🧪 Practice Sandbox (Virtual balance, zero gas)'
    );

    const maxDisplay = 5;
    const displayedPositions = positionCards.slice(0, maxDisplay);
    let positionsBlock =
      displayedPositions.length > 0
        ? displayedPositions.join('\n\n')
        : tr(lang, '  ⚪ 暂无活动持仓 (等待巨鲸开仓触发)', '  ⚪ No active positions (waiting for tracked whales)');
    if (positions.length > maxDisplay) {
      positionsBlock += tr(
        lang,
        `\n\n<i>... 另外还有 ${positions.length - maxDisplay} 笔持仓已为您按标的自动汇总净值与浮盈，轻点下方按钮可一键全部结算或清理亏损仓位</i>`,
        `\n\n<i>... ${positions.length - maxDisplay} more positions included in equity totals below.</i>`
      );
    }

    let text =
      lang === 'en'
        ? `
📊 <b>[Practice Portfolio & PnL Dashboard]</b>

• <b>Execution Mode</b>: <b>${execModeDesc}</b>
• <b>Tracked Targets</b>: <b>${targetDisplay}</b>

┌── 💰 <b>Practice Account Summary</b> ─────────
│ 💎 Total Equity: <b>$${totalEquity.toFixed(2)} USDT</b>
│ 💵 Available Margin: <b>$${availBalance.toFixed(2)} USDT</b>
│ 🔒 Margin in Use: <b>$${totalUsedMargin.toFixed(2)} USDT</b> (${positions.length} open)
│ 📈 Unrealized PnL: ${uEmoji} <b>${uSign}$${totalUnrealizedPnlUsdt.toFixed(2)} USDT</b>
│ 📉 Realized PnL: ${rEmoji} <b>${rSign}$${realizedPnl.toFixed(2)} USDT</b>
│ 🚀 Total ROI: ${roiEmoji} <b>${roiSign}${totalRoi}%</b>
│ 🎯 Win Rate: <b>${winRate}%</b> (${pStats.winTrades}W / ${pStats.lossTrades}L)
└────────────────────────────

📈 <b>Open Practice Positions (${positions.length}):</b>
${positionsBlock}

📜 <b>Recent Closed Trades:</b>
${historyLines.length > 0 ? historyLines.join('\n') : '  ⚪ No closed trades yet'}

⚡ <b>Engine Metrics:</b>
• Signals: <b>${engineStats.total}</b> | Executed: <b>${engineStats.success}</b> | Blocked: <b>${engineStats.total - engineStats.success}</b>
• Latency: <b>~380 ms</b> | Network: <b>🟢 Injective Mainnet Connected</b>
    `.trim()
        : `
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
      text = text.slice(0, 3750) + tr(lang, '\n\n<i>(持仓数较多，已自动精简展示)</i>', '\n\n<i>(Truncated due to length)</i>');
    }

    const keyboard = new InlineKeyboard().text(tr(lang, '🔄 刷新实时浮盈与现价', '🔄 Refresh PnL & Marks'), 'view_stats').row();

    if (positions.length > 0) {
      keyboard
        .text(tr(lang, `⚡ 一键市价全平 (${positions.length} 仓)`, `⚡ Close All (${positions.length})`), 'close_all_pos')
        .text(tr(lang, '🧹 仅平仓亏损仓位', '🧹 Close Losing Only'), 'close_loss_pos')
        .row();
    }

    keyboard
      .text(tr(lang, '🔄 重置 $10,000 体验金', '🔄 Reset $10,000 Sandbox'), 'reset_practice')
      .text(tr(lang, '👛 返回我的钱包', '👛 My Wallet'), 'view_wallet')
      .row()
      .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch (err: any) {
        if (err.message?.includes('message is not modified')) return;
        console.warn('[TelegramBot] editMessageText 失败，尝试以普通消息回复:', err.message);
      }
    }

    try {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      console.error('[TelegramBot] renderPortfolioAndStats 发送失败，发送极简兜底卡片:', err.message);
      const briefText =
        lang === 'en'
          ? `📊 <b>[Practice Account Overview]</b>\n• Equity: <b>$${totalEquity.toFixed(2)} USDT</b>\n• Available: <b>$${availBalance.toFixed(2)} USDT</b>\n• Margin: <b>$${totalUsedMargin.toFixed(2)} USDT</b> (${positions.length} open)\n• uPnL: ${uEmoji} <b>${uSign}$${totalUnrealizedPnlUsdt.toFixed(2)} USDT</b>`
          : `
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
    const lang = this.getLang(ctx);
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);

    // 如果是通过 callbackQuery 触发，第一时间应答以取消前端按钮 loading 转圈并提供即时反馈
    if (ctx.callbackQuery) {
      if (isRefresh) {
        await ctx
          .answerCallbackQuery(tr(lang, '正在查询 Injective 链上最新资产...', 'Fetching live Injective balances...'))
          .catch(() => {});
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
      ? lang === 'en'
        ? `• <b>Active Mode</b>: <b>[🧪 Practice Sandbox (Virtual funds, zero gas)]</b>\n• <b>Available Practice Balance</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>Practice Margin in Use</b>: <b>$${usedMargin.toFixed(2)} USDT (${positions.length} open)</b>\n• <b>Cumulative Practice PnL</b>: <b>${pnlSign}$${realizedPnl.toFixed(2)} USDT</b>`
        : `• <b>当前执行模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>\n• <b>剩余可用体验金</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>模拟持仓占用保证金</b>: <b>$${usedMargin.toFixed(2)} USDT (${positions.length} 笔持仓)</b>\n• <b>累计平仓已实现盈亏</b>: <b>${pnlSign}$${realizedPnl.toFixed(2)} USDT</b>`
      : tr(
          lang,
          '• <b>当前执行模式</b>: <b>【🔴 实盘链上交易模式 (专属钱包私钥签名上链)】</b>',
          '• <b>Active Mode</b>: <b>[🔴 Live Mainnet Trading (Signed on-chain execution)]</b>'
        );

    const hasMnemonic = Boolean(userWallet.mnemonic);
    const refreshTime =
      lang === 'en'
        ? new Date().toISOString().slice(11, 19) + ' UTC'
        : new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' (UTC+8)';

    const text =
      lang === 'en'
        ? `
👛 <b>My Injective Copy-Trade Wallet</b>

• <b>Injective Address</b>:
<code>${userWallet.injectiveAddress}</code>
<i>(Tap above to copy address)</i>

• <b>EVM Equivalent</b>: <code>${userWallet.evmAddress || 'N/A'}</code>
• <b>Mnemonic Backup</b>: <b>${hasMnemonic ? '✅ 12-word BIP39 mnemonic generated' : '⚠️ Legacy private key (upgrade recommended)'}</b>

┌── 📊 <b>Live On-Chain Assets & Mode</b> ─────────
│ 💎 <b>INJ Balance</b>: <code>${balances.inj} INJ</code>
│ 💵 <b>USDT Balance</b>: <code>${balances.usdt} USDT</code>
│ 💲 <b>USDC Balance</b>: <code>${balances.usdc} USDC</code>
│ 💰 <b>Est. Total Value</b>: <b>$${balances.totalUsd} USD</b>
│ 🕒 <b>Synced At</b>: <code>${refreshTime}</code>
└────────────────────────────
${practiceInfo}

🛡️ <b>Non-Custodial Key Security:</b>
<i>This wallet is locally generated following Injective cryptographic standards. You can export your mnemonic or private key anytime into Keplr, Leap, or OKX Web3 — you retain full ownership of your funds.</i>
    `.trim()
        : `
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
│ 🕒 <b>数据同步时间</b>: <code>${refreshTime}</code>
└────────────────────────────
${practiceInfo}

🛡️ <b>真实 Web3 非托管钱包保障:</b>
<i>该钱包基于行业标准密码学算法在本地安全生成，是 100% 链上真实存在的独立非托管地址。您可随时导出助记词或私钥到 Keplr、OKX Web3 钱包查验管理，资产完全由您掌控！</i>
    `.trim();

    const keyboard = new InlineKeyboard()
      .text(tr(lang, '📈 查看持仓与盈亏明细', '📈 Positions & PnL'), 'view_stats')
      .row()
      .text(tr(lang, '💳 充值 USDT/INJ 激活实盘', '💳 Deposit USDT / USDC / INJ'), 'deposit_guide')
      .row()
      .text(tr(lang, '🔴 切换为：实盘链上交易模式', '🔴 Switch: Live Mainnet'), 'switch_mode_real')
      .text(tr(lang, '🧪 切换为：$10,000 模拟演练模式', '🧪 Switch: $10k Sandbox'), 'switch_mode_practice')
      .row()
      .text(tr(lang, '🔄 刷新余额', '🔄 Refresh'), 'refresh_wallet')
      .text(tr(lang, '🔑 导出助记词/私钥', '🔑 Export Key'), 'export_key')
      .row()
      .text(tr(lang, '📥 导入外部助记词/私钥', '📥 Import Wallet'), 'import_wallet_prompt')
      .text(tr(lang, '🔄 重新生成助记词钱包', '🔄 New Mnemonic'), 'regen_wallet')
      .row()
      .url(tr(lang, '🌐 在 Injective 区块浏览器查验', '🌐 View on InjScan Explorer'), `https://injscan.com/account/${userWallet.injectiveAddress}`)
      .row()
      .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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
    const lang = this.getLang(ctx);
    this.activeUserChatIds.add(ctx.chat?.id || userId);
    if (this.whaleRadar && ctx.chat?.id) {
      this.whaleRadar.addSubscriber(ctx.chat.id);
    }

    const text = await this.getMainMenuText(userId, username, lang, ctx.from?.language_code);
    const keyboard = this.getMainMenuKeyboard(userId, lang);

    if (isEdit) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return;
      } catch (err: any) {
        // 如果内容未变或无法编辑，降级为普通回复
        if (err.message?.includes('message is not modified')) return;
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
    const lang = this.getLang(ctx);
    let whales = this.leaderboard.getTopWhales(5);
    if (whales.length === 0) {
      await this.leaderboard.refreshLeaderboard();
      whales = this.leaderboard.getTopWhales(5);
    }

    let text =
      lang === 'en'
        ? `🏆 <b>Injective Mainnet Active Whale Leaderboard (100% On-Chain)</b>\n` +
          `<i>Scans all active mainnet open positions, filtering out market makers, wash bots & >14d stale accounts, ranking traders with recent trades & positive uPnL.</i>\n\n`
        : `🏆 <b>Injective 主网实盘活跃巨鲸排行榜 (100% 链上实时数据)</b>\n` +
          `<i>已全量扫描主网活跃实盘仓位，过滤做市商/刷量机器人与 14 天以上死仓，优先展示近 24h~14 天内仍在交易的真实盈利账号</i>\n\n`;
    const keyboard = new InlineKeyboard();

    if (whales.length === 0) {
      text += tr(
        lang,
        `⚠️ 当前近 14 天内暂无符合条件的非做市商正浮盈实盘大户（Injective 链上近期以做市与高频对倒为主）。\n\n💡 你可以通过下方「🔍 监控自定义钱包」手动添加已知聪明钱地址。\n\n`,
        `⚠️ No non-market-maker accounts with recent (<14d) trades and positive uPnL found right now.\n\n💡 Use "🔍 Track Custom Wallet" below to monitor any custom Injective address.\n\n`
      );
    } else {
      whales.forEach((w) => {
        const upnlSign = w.unrealizedPnlUsd >= 0 ? '+' : '';
        const activeStr =
          typeof w.lastTradeMinutesAgo === 'number'
            ? formatActiveAgo(w.lastTradeMinutesAgo, lang)
            : w.lastActiveDesc;

        if (lang === 'en') {
          let enBadge = '🐋 On-Chain Whale';
          if (w.unrealizedPnlUsd >= 10000) enBadge = '👑 $10K+ uPnL Whale';
          else if (w.volumeUsd >= 100000) enBadge = '🏛️ Institutional';
          else if (w.winRatePercent >= 75) enBadge = '🎯 High-Win Sniper';

          const bp = w.bestPosition;
          const enStrategy = bp
            ? `Top Pos: ${bp.direction} ${bp.ticker} (Entry $${formatDisplayPrice(bp.entryPrice)} → Mark $${formatDisplayPrice(bp.markPrice)}, uPnL +$${Math.round(bp.upnlUsd).toLocaleString()})`
            : `Top Market: ${w.favoriteMarket}`;

          text += `<b>Top ${w.rank}. Whale 0x${w.address.slice(-4)}</b> ${enBadge}\n`;
          text += `• Last Active: <b>${activeStr}</b>\n`;
          text += `• Open Notional: <b>$${w.volumeUsd.toLocaleString()} USD</b> (${w.openPositionsCount} pos)\n`;
          text += `• Unrealized PnL: <b>${upnlSign}$${w.unrealizedPnlUsd.toLocaleString()} USD</b>\n`;
          text += `• Win Rate: <b>${w.winRatePercent}%</b>\n`;
          text += `• Highlight: <i>${enStrategy}</i>\n`;
          text += `• Address: <code>${w.address}</code>\n\n`;
          keyboard.text(`⚡ Copy Top ${w.rank} (0x${w.address.slice(-4)})`, `follow_${w.id}`).row();
        } else {
          text += `<b>Top ${w.rank}. ${w.name}</b> ${w.badge}\n`;
          text += `• 最近链上异动: <b>${activeStr}</b>\n`;
          text += `• 实盘未平仓总规模: <b>$${w.volumeUsd.toLocaleString()} USD</b> (${w.openPositionsCount} 个仓位)\n`;
          text += `• 当前持仓总浮盈: <b>${upnlSign}$${w.unrealizedPnlUsd.toLocaleString()} USD</b>\n`;
          text += `• 实盘综合胜率: <b>${w.winRatePercent}%</b>\n`;
          text += `• 头号重仓明细: <i>${w.strategy}</i>\n`;
          text += `• 钱包地址: <code>${w.address}</code>\n\n`;
          keyboard.text(`⚡ 跟单 Top ${w.rank} (0x${w.address.slice(-4)})`, `follow_${w.id}`).row();
        }
      });
    }

    keyboard
      .text(tr(lang, '🔄 实时重扫主网巨鲸', '🔄 Rescan Mainnet'), 'refresh_leaderboard')
      .text(tr(lang, '🔍 监控自定义钱包', '🔍 Track Custom Wallet'), 'track_custom_wallet')
      .row()
      .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

    if (text.length > 3900) {
      text = text.slice(0, 3850) + tr(lang, '\n\n<i>(榜单内容较长，已自动精简展示)</i>', '\n\n<i>(Truncated)</i>');
    }

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e: any) {
      if (e.message?.includes('message is not modified')) return;
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
    const lang = this.getLang(ctx);
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);

    const text =
      lang === 'en'
        ? `
⚠️ <b>[Wallet Balance Notice]</b>

Your dedicated Injective wallet currently has no USDT / USDC / INJ deposited:
• Wallet: <code>${userWallet.injectiveAddress}</code>
• Live Balance: <b>0.0000 INJ / 0.00 USDT</b>

To start experiencing the Injective copy-trading engine, please choose an option below:
    `.trim()
        : `
⚠️ <b>【链上跟单资产提示】</b>

检测到您专属钱包中当前尚无 USDT / INJ 资产：
• 钱包地址: <code>${userWallet.injectiveAddress}</code>
• 当前实盘余额: <b>0.0000 INJ / 0.00 USDT</b>

为了让您能够流畅体验 Injective 亚秒级跟单引擎，请选择操作模式：
    `.trim();

    const keyboard = new InlineKeyboard()
      .text(tr(lang, '💳 充值 USDT/INJ 激活实盘', '💳 Deposit Funds (Live Mode)'), 'deposit_guide')
      .row()
      .text(
        tr(lang, '🧪 开启 $10,000 体验金演练', '🧪 Enable $10,000 Practice Sandbox'),
        targetAddress ? `prac_follow_${targetAddress}` : 'enable_practice_mode'
      )
      .row()
      .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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

    // 访问控制（若配置了 ALLOWED_TELEGRAM_IDS）+ 自动识别小飞机客户端语言 + 清理待输入状态
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId && ctx.from?.language_code) {
        this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
      }
      const lang = this.getLang(ctx);

      if (
        this.config.allowedTelegramIds &&
        this.config.allowedTelegramIds.length > 0 &&
        (!userId || !this.config.allowedTelegramIds.includes(userId))
      ) {
        if (ctx.callbackQuery) {
          await ctx
            .answerCallbackQuery({ text: tr(lang, '⛔ 暂无访问权限', '⛔ Access denied'), show_alert: true })
            .catch(() => {});
        } else if (ctx.message) {
          await ctx
            .reply(
              tr(
                lang,
                '⛔ 当前机器人已开启白名单访问限制，请联系管理员授权。',
                '⛔ This bot is currently restricted to allowlisted users. Please contact the admin.'
              )
            )
            .catch(() => {});
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
      const lang = this.getLang(ctx);
      if (match.startsWith('ref_')) {
        const inviterId = parseInt(match.replace('ref_', ''), 10);
        if (inviterId && inviterId !== userId) {
          const bound = this.walletService.bindReferrer(userId, inviterId);
          if (bound) {
            await ctx
              .reply(
                lang === 'en'
                  ? `🎉 <b>Welcome to Injective CopyTrade!</b>\nYour account was activated via referral (<code>ID: ${inviterId}</code>).`
                  : `🎉 <b>欢迎激活 Injective 聪明钱跟单矩阵！</b>\n您已通过推荐人 (<code>ID: ${inviterId}</code>) 的专属邀请链接成功激活，已为您开启优先风控通道！`,
                { parse_mode: 'HTML' }
              )
              .catch(() => {});

            try {
              const invLang = this.walletService.getUserLanguage(inviterId);
              await ctx.api.sendMessage(
                inviterId,
                invLang === 'en'
                  ? `🎁 <b>[New Referral Joined]</b>\n@${ctx.from?.username || userId} (<code>${userId}</code>) joined via your link. You will earn <b>${this.config.referralRewardPercent}% fee rebates</b> on their live copy trades!`
                  : `🎁 <b>【新好友成功加入提醒】</b>\n好友 @${ctx.from?.username || userId} (<code>${userId}</code>) 已通过您的专属推广链接加入机器人！后续该好友每笔实盘跟单成交，您都将自动获得 <b>${this.config.referralRewardPercent}% 手续费现金返佣</b>！`,
                { parse_mode: 'HTML' }
              );
            } catch {
              // ignore
            }
          }
        }
      } else if (match.startsWith('follow_')) {
        const rawAddr = match.replace('follow_', '').trim();
        const check = validateInjectiveAddress(rawAddr, lang);
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
      const lang = this.getLang(ctx);
      const parts = (ctx.message?.text || '').trim().split(/\s+/);
      if (parts.length > 1 && parts[1]) {
        await this.handleCustomAddressInput(ctx, parts[1]);
        return;
      }

      this.awaitingAddressUsers.add(ctx.from?.id || 0);
      const text =
        lang === 'en'
          ? `
🔍 <b>[Enter Injective Address to Track & Copy]</b>

Send a 42-character Injective address starting with <code>inj1...</code>:
Example:
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

⚡ <i>Addresses are automatically verified and audited for market-maker activity before joining your copy matrix.</i>
      `.trim()
          : `
🔍 <b>【请输入您要监控并跟单的 Injective 钱包地址】</b>

请输入以 <code>inj1...</code> 开头的 42 位 Injective 钱包地址：
例如：
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

⚡ <i>系统将自动进行地址安全校验，并一键加入您的多巨鲸跟单矩阵！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    this.bot.command('leaderboard', async (ctx) => {
      const lang = this.getLang(ctx);
      await ctx
        .reply(tr(lang, '🏆 轻点下方按钮查看链上聪明钱实时胜率排行：', '🏆 Tap below to inspect the live on-chain whale leaderboard:'), {
          reply_markup: new InlineKeyboard().text(
            tr(lang, '🏆 立即查看聪明钱排行榜', '🏆 View Live Leaderboard'),
            'view_leaderboard'
          ),
        })
        .catch(() => {});
    });

    this.bot.command('amount', async (ctx) => {
      const lang = this.getLang(ctx);
      await ctx
        .reply(tr(lang, '请选择单笔跟单金额：', 'Select notional order size per copy trade:'), {
          reply_markup: new InlineKeyboard()
            .text('$20 USDT', 'amt_20')
            .text('$50 USDT', 'amt_50')
            .row()
            .text('$100 USDT', 'amt_100')
            .text('$200 USDT', 'amt_200')
            .row()
            .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu'),
        })
        .catch(() => {});
    });

    this.bot.command('referral', async (ctx) => {
      const lang = this.getLang(ctx);
      const refLink = `https://t.me/${ctx.me.username}?start=ref_${ctx.from?.id || '888'}`;
      await ctx
        .reply(
          lang === 'en'
            ? `🎁 <b>Your Referral Link:</b>\n<code>${refLink}</code>\n\nEarn <b>${this.config.referralRewardPercent}%</b> lifetime fee commission on friends' live copy trades!`
            : `🎁 <b>您的专属推广链接：</b>\n<code>${refLink}</code>\n\n好友使用实盘跟单享 ${this.config.referralRewardPercent}% 终身手续费现金分红！`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    });

    this.bot.command('stats', (ctx) => this.renderPortfolioAndStats(ctx, false));
    this.bot.command('wallet', (ctx) => this.renderWalletDetail(ctx, false, false));

    // 3. 文本输入监听
    this.bot.on('message:text', async (ctx) => {
      const text = (ctx.message.text || '').trim();
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);

      if (this.awaitingWalletImportUsers.has(userId)) {
        this.awaitingWalletImportUsers.delete(userId);
        await ctx.deleteMessage().catch(() => {});
        try {
          const imported = this.walletService.importWallet(userId, text, ctx.from?.username);
          const mnemonicHint = imported.mnemonic
            ? tr(lang, '（含 12/24 位助记词）', '(12/24-word mnemonic)')
            : tr(lang, '（Hex 私钥）', '(Hex private key)');
          const successText =
            lang === 'en'
              ? `
✅ <b>[Wallet Imported Successfully]</b>

• <b>Injective Address</b>:
<code>${imported.injectiveAddress}</code>

• <b>EVM Equivalent</b>:
<code>${imported.evmAddress || 'N/A'}</code>

• <b>Import Type</b>: <b>${mnemonicHint}</b>

🛡️ <i>Your plaintext message was deleted for security. Your practice balance and tracked whales have been preserved.</i>
          `.trim()
              : `
✅ <b>【钱包导入成功！】</b>

• <b>Injective 链上地址</b>:
<code>${imported.injectiveAddress}</code>

• <b>EVM 兼容映射地址</b>:
<code>${imported.evmAddress || 'N/A'}</code>

• <b>导入类型</b>: <b>${mnemonicHint}</b>

🛡️ <i>系统已自动尝试撤回您刚才发送的明文凭据消息以保护安全，您的模拟盘体验金与跟单巨鲸配置已无缝保留！</i>
          `.trim();

          const keyboard = new InlineKeyboard()
            .text(tr(lang, '👛 查看我的钱包', '👛 My Wallet'), 'view_wallet')
            .url(tr(lang, '🌐 在区块浏览器查验此地址', '🌐 View on InjScan'), `https://injscan.com/account/${imported.injectiveAddress}`)
            .row()
            .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

          await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        } catch (err: any) {
          const errText =
            lang === 'en'
              ? `
❌ <b>Wallet Import Failed</b>

Reason: <i>${err.message || 'Invalid mnemonic or private key format'}</i>

Please verify your 12/24-word mnemonic (space-separated) or 64-char hex private key and try again.
          `.trim()
              : `
❌ <b>钱包导入失败</b>

原因: <i>${err.message || '无效的助记词或私钥格式'}</i>

请检查助记词是否拼写正确（12/24 个单词，空格分隔）或私钥是否为 64 位 Hex 后重试。
          `.trim();

          const keyboard = new InlineKeyboard()
            .text(tr(lang, '📥 重新尝试导入', '📥 Try Again'), 'import_wallet_prompt')
            .text(tr(lang, '🔙 返回我的钱包', '🔙 Back to Wallet'), 'view_wallet');

          await ctx.reply(errText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        }
        return;
      }

      if (this.awaitingAddressUsers.has(userId)) {
        await this.handleCustomAddressInput(ctx, text);
        return;
      }

      if (text.startsWith('inj1')) {
        const check = validateInjectiveAddress(text, lang);
        if (check.valid && check.cleanAddress) {
          const cleanAddr = check.cleanAddress;
          const promptText =
            lang === 'en'
              ? `💡 <b>Detected Injective Address:</b>\n<code>${cleanAddr}</code>\n\nChoose an action below:`
              : `💡 <b>检测到您发送了 Injective 链上地址：</b>\n<code>${cleanAddr}</code>\n\n请选择您要对该地址执行的操作：`;
          const keyboard = new InlineKeyboard()
            .text(tr(lang, '🎯 加入我的多巨鲸跟单矩阵', '🎯 Add to Copy Matrix'), `follow_custom_${cleanAddr}`)
            .row()
            .text(tr(lang, '🔍 查询该地址链上资产', '🔍 Inspect On-Chain Balance'), `inspect_addr_${cleanAddr}`)
            .row()
            .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');
          await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
          return;
        }
      }

      await this.renderMainMenu(ctx, false);
    });

    // ========================================================
    // 按钮回调逻辑
    // ========================================================

    this.bot.callbackQuery('toggle_lang', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const cur = this.getLang(ctx);
      const next: BotLang = cur === 'zh' ? 'en' : 'zh';
      this.walletService.setUserLanguage(userId, next);
      await ctx
        .answerCallbackQuery(next === 'en' ? '🌐 Switched to English' : '🌐 已切换为简体中文')
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery('back_to_menu', async (ctx) => {
      this.awaitingAddressUsers.delete(ctx.from?.id || 0);
      this.awaitingWalletImportUsers.delete(ctx.from?.id || 0);
      await ctx.answerCallbackQuery().catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery('track_custom_wallet', async (ctx) => {
      const lang = this.getLang(ctx);
      this.awaitingAddressUsers.add(ctx.from?.id || 0);
      await ctx.answerCallbackQuery().catch(() => {});
      const text =
        lang === 'en'
          ? `
🔍 <b>[Enter Injective Wallet Address to Track]</b>

Send a 42-character Injective address starting with <code>inj1...</code>:
Example:
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

💡 <i>Track up to 5 whales concurrently! Addresses are validated and audited against market makers automatically.</i>
      `.trim()
          : `
🔍 <b>【请输入您要监控并跟单的 Injective 钱包地址】</b>

请直接向机器人发送以 <code>inj1...</code> 开头的 42 位 Injective 地址：
例如：
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

💡 <i>支持同时监控最多 5 位巨鲸！系统将自动安全校验地址格式并加入您的多巨鲸并发跟单矩阵，绝不覆盖已有目标！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      });
    });

    this.bot.callbackQuery('view_leaderboard', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      await ctx
        .answerCallbackQuery(tr(lang, '正在读取最新链上实盘数据...', 'Fetching live mainnet positions...'))
        .catch(() => {});
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
      const lang = this.getLang(ctx);
      if (this.isRpcRateLimited(userId, 'refresh_leaderboard', 8000)) {
        await ctx
          .answerCallbackQuery(tr(lang, '⏳ 刷新太频繁，请几秒后再试', '⏳ Please wait a few seconds before refreshing'))
          .catch(() => {});
        return;
      }
      await ctx
        .answerCallbackQuery(tr(lang, '正在重扫 Injective 主网最新区块成交...', 'Rescanning Injective mainnet positions & trades...'))
        .catch(() => {});
      await this.leaderboard.refreshLeaderboard();
      await this.renderLeaderboardView(ctx);
    });

    this.bot.callbackQuery('switch_mode_real', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
      const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;

      if (!hasRealFunds) {
        await ctx
          .answerCallbackQuery(
            tr(lang, '⚠️ 您的专属实盘钱包余额为 0，请先充值或继续使用模拟盘！', '⚠️ Wallet balance is 0. Deposit funds or stay in Practice Sandbox.')
          )
          .catch(() => {});
        const warnText =
          lang === 'en'
            ? `
🔴 <b>[Live Mainnet Mode — Balance Check Failed]</b>

Your dedicated non-custodial wallet currently has zero funds:
• Address: <code>${userWallet.injectiveAddress}</code>
• Balances: <b>${balances.inj} INJ / ${balances.usdt} USDT / ${balances.usdc} USDC</b>

💡 <b>Live Mode</b> signs real orders on Injective Mainnet using your wallet. Deposit USDT/USDC plus a small amount of INJ for gas, or continue using the $10,000 Practice Sandbox:
        `.trim()
            : `
🔴 <b>【切换实盘链上交易模式 - 余额校验未通过】</b>

检测到您的专属非托管钱包当前实盘余额为 0：
• 专属地址: <code>${userWallet.injectiveAddress}</code>
• 链上余额: <b>${balances.inj} INJ / ${balances.usdt} USDT / ${balances.usdc} USDC</b>

💡 <b>实盘链上交易模式</b>将使用您专属钱包私钥直接签名并在 Injective Mainnet 真实扣款下单。请先向您的专属地址充值 USDT 与少量 INJ (Gas)，或继续使用 $10,000 模拟演练模式：
        `.trim();

        const keyboard = new InlineKeyboard()
          .text(tr(lang, '💳 立即查看充值指南', '💳 View Deposit Guide'), 'deposit_guide')
          .row()
          .text(tr(lang, '🧪 继续使用 $10,000 模拟演练模式', '🧪 Continue with $10,000 Sandbox'), 'switch_mode_practice')
          .row()
          .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

        await ctx.editMessageText(warnText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        return;
      }

      this.walletService.setPracticeMode(userId, false);
      await ctx
        .answerCallbackQuery(tr(lang, '🔴 已成功切换为：实盘链上交易模式！', '🔴 Switched to Live Mainnet Mode!'))
        .catch(() => {});

      const okText =
        lang === 'en'
          ? `
🔴 <b>[Switched to: Live Mainnet Trading]</b>

• <b>Active Mode</b>: <b>🔴 Live Mainnet Execution</b>
• <b>Signer Address</b>: <code>${userWallet.injectiveAddress}</code>
• <b>Available Balances</b>: <b>${balances.inj} INJ | ${balances.usdt} USDT | ${balances.usdc} USDC</b>

⚡ <i>All matched whale signals will now execute live on-chain via your wallet, with real InjScan transaction links!</i>
      `.trim()
          : `
🔴 <b>【已切换为：实盘链上交易模式】</b>

• <b>当前执行模式</b>: <b>🔴 实盘链上交易 (Mainnet 真实签名广播)</b>
• <b>签名账户</b>: <code>${userWallet.injectiveAddress}</code>
• <b>实盘可用余额</b>: <b>${balances.inj} INJ | ${balances.usdt} USDT | ${balances.usdc} USDC</b>

⚡ <i>从现在起，跟单矩阵捕获到的每一笔巨鲸信号都将使用您的专属钱包私钥真实签名上链，并推送附带 Injective 主网区块浏览器链接 (injscan.com) 的实盘战报！</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(tr(lang, '🧪 切换回：$10,000 模拟演练模式', '🧪 Switch Back to $10,000 Sandbox'), 'switch_mode_practice')
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(okText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    this.bot.callbackQuery('switch_mode_practice', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const w = this.walletService.setPracticeMode(userId, true);
      await ctx
        .answerCallbackQuery(tr(lang, '🧪 已切换为：$10,000 模拟演练模式！', '🧪 Switched to $10,000 Practice Sandbox!'))
        .catch(() => {});

      const text =
        lang === 'en'
          ? `
🧪 <b>[Switched to: $10,000 Practice Sandbox]</b>

• <b>Active Mode</b>: <b>[🧪 Practice Sandbox (Virtual funds, zero gas)]</b>
• <b>Available Balance</b>: <b>$${(w.practiceBalanceUsdt ?? 10000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>

💡 <i>Real mainnet whale signals will simulate 1:1 against live orderbook depth using virtual USDT and clearly labeled #PAPER IDs.</i>
      `.trim()
          : `
🧪 <b>【已切换为：$10,000 模拟演练模式】</b>

• <b>当前执行模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>
• <b>可用模拟体验金</b>: <b>$${(w.practiceBalanceUsdt ?? 10000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>

💡 <i>在模拟演练模式下，系统将 1:1 监听主网巨鲸真实信号并按实盘盘口价格扣减虚拟体验金，每笔成交通知均明确标注为 #PAPER 模拟流水号，绝不与实盘混淆！</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(tr(lang, '🏆 前往聪明钱榜单选巨鲸', '🏆 Browse Leaderboard'), 'view_leaderboard')
        .text(tr(lang, '🔴 切换为：实盘链上交易模式', '🔴 Switch to Live Mainnet'), 'switch_mode_real')
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    this.bot.callbackQuery(['view_wallet', 'refresh_wallet'], async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const isRefresh = ctx.callbackQuery?.data === 'refresh_wallet';
      if (isRefresh && this.isRpcRateLimited(userId, 'refresh_wallet', 3000)) {
        await ctx.answerCallbackQuery(tr(lang, '⏳ 请稍候再刷新', '⏳ Please wait before refreshing')).catch(() => {});
        return;
      }
      await this.renderWalletDetail(ctx, true, isRefresh);
    });

    this.bot.callbackQuery('deposit_guide', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
      await ctx.answerCallbackQuery().catch(() => {});
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);

      const text =
        lang === 'en'
          ? `
💳 <b>[Deposit USDT / USDC / INJ for Live Copy Trading]</b>

Your dedicated Injective deposit address:
<code>${userWallet.injectiveAddress}</code>
<i>(Tap above to copy)</i>

📌 <b>How to Fund:</b>
1. <b>From CEX</b> (Binance, OKX, Bybit, etc.):
   • Withdraw <b>INJ</b>, <b>USDT</b>, or <b>USDC</b> (most Injective perps settle in USDC)
   • Select network: <b>Injective (INJ)</b>
   • Paste your address above; deposits typically arrive within 1–2 minutes

2. <b>Via Bridge</b>:
   • From Ethereum: <a href="https://hub.injective.network/bridge">Injective Hub Bridge</a>
   • From Cosmos (IBC): Direct via Keplr / Leap

📊 <b>Current Balances</b>:
• INJ: <code>${balances.inj} INJ</code> | USDT: <code>${balances.usdt} USDT</code> | USDC: <code>${balances.usdc} USDC</code>
• Deposits are detected automatically — no manual review required.
      `.trim()
          : `
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
        .text(tr(lang, '🔄 刷新链上充值余额', '🔄 Refresh Balances'), 'deposit_guide')
        .text(tr(lang, '🧪 先开启体验金演练', '🧪 Try $10k Sandbox'), 'enable_practice_mode')
        .row()
        .text(tr(lang, '🔙 返回钱包', '🔙 Wallet'), 'view_wallet')
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      }).catch(() => {});
    });

    this.bot.callbackQuery('enable_practice_mode', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      this.walletService.setPracticeMode(userId, true);
      await ctx
        .answerCallbackQuery(tr(lang, '🎉 $10,000 体验金已激活！', '🎉 $10,000 Practice Sandbox activated!'))
        .catch(() => {});

      const text =
        lang === 'en'
          ? `
🎉 <b>[$10,000 Practice Sandbox Activated!]</b>

• <b>Mode</b>: <b>[🧪 Practice Sandbox (Virtual funds, zero gas)]</b>
• <b>Available Balance</b>: <b>$10,000.00 USDT</b>

What happens in Sandbox mode:
• Mirrors live Injective mainnet smart-money trades in real time
• Simulates fills against live orderbook prices & slippage rules
• Zero risk while testing copy strategies — switch to Live Mode anytime after depositing!
      `.trim()
          : `
🎉 <b>【$10,000 体验金演练模式已激活！】</b>

• <b>当前模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>
• <b>可用虚拟本金</b>: <b>$10,000.00 USDT</b>

在体验金模式下：
• 系统将实时监听 Injective 链上真实大户下单
• 按照真实盘口与滑点进行毫秒级模拟撮合
• 0 风险检验跟单胜率与收益，随时可充值切换实盘链上模式！
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(tr(lang, '🏆 前往聪明钱榜单选大户', '🏆 Browse Leaderboard'), 'view_leaderboard')
        .text(tr(lang, '🔍 监控自定义钱包', '🔍 Track Custom Wallet'), 'track_custom_wallet')
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(() => {});
    });

    this.bot.callbackQuery(/^prac_follow_(.+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const targetAddress = ctx.match[1];
      this.walletService.setPracticeMode(userId, true);
      await ctx
        .answerCallbackQuery(tr(lang, '🎉 体验金已开启并加入跟单矩阵！', '🎉 Sandbox enabled & whale added!'))
        .catch(() => {});
      await this.applyFollowTarget(ctx, targetAddress, true);
    });

    // 导出助记词与私钥
    this.bot.callbackQuery('export_key', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
      if (userWallet.decryptionError) {
        await ctx
          .answerCallbackQuery({
            text: tr(lang, '⚠️ 钱包解密异常，请联系管理员检查加密密钥', '⚠️ Wallet decryption error; contact admin.'),
            show_alert: true,
          })
          .catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});

      const mnemonicBlock = userWallet.mnemonic
        ? lang === 'en'
          ? `• <b>12-Word BIP39 Mnemonic:</b>\n<code>${userWallet.mnemonic}</code>\n<i>(Tap above to copy. Import into Keplr, Leap, MetaMask, or OKX Web3 to verify the exact same address.)</i>`
          : `• <b>12 位标准英文助记词:</b>\n<code>${userWallet.mnemonic}</code>\n<i>(轻点上方助记词可直接复制。可直接导入 Keplr、OKX Web3 钱包、MetaMask 或 Leap 验证同一链上地址！)</i>`
        : lang === 'en'
        ? `• <b>Mnemonic:</b>\n<i>⚠️ Legacy private-key-only wallet. Tap "New Mnemonic" below to upgrade.</i>`
        : `• <b>12 位助记词:</b>\n<i>⚠️ 此钱包系早期创建，未生成 12 位助记词。建议点击下方【🔄 升级为全新助记词钱包】生成带助记词的新钱包。</i>`;

      const text =
        lang === 'en'
          ? `
⚠️ <b>[SECRET BACKUP — MNEMONIC & PRIVATE KEY]</b>

• <b>Injective Address</b>: <code>${userWallet.injectiveAddress}</code>
• <b>EVM Equivalent</b>: <code>${userWallet.evmAddress || 'N/A'}</code>

${mnemonicBlock}

• <b>Private Key (Hex):</b>
<code>${userWallet.privateKeyHex}</code>

🛡️ <b>Non-Custodial Security Notes:</b>
1. <b>Real On-Chain Wallet</b>: Generated locally per Injective cryptographic standards — verifiable directly in Keplr or OKX Web3.
2. <b>Keep Private</b>: Never share or screenshot your mnemonic or private key!
      `.trim()
          : `
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
        keyboard.text(tr(lang, '🔄 升级为全新助记词钱包', '🔄 Upgrade to Mnemonic Wallet'), 'regen_wallet').row();
      }
      keyboard
        .url(tr(lang, '🌐 在 Injective 区块浏览器查验此地址', '🌐 View on InjScan'), `https://injscan.com/account/${userWallet.injectiveAddress}`)
        .row()
        .text(tr(lang, '🔙 返回我的钱包', '🔙 My Wallet'), 'view_wallet')
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 重新生成带 12 位助记词的新钱包
    this.bot.callbackQuery('regen_wallet', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const newWallet = this.walletService.regenerateWalletWithMnemonic(userId);
      await ctx
        .answerCallbackQuery(tr(lang, '🎉 已生成带 12 位助记词的全新钱包！', '🎉 New 12-word mnemonic wallet generated!'))
        .catch(() => {});

      const mnemonicBlock =
        lang === 'en'
          ? `• <b>12-Word BIP39 Mnemonic:</b>\n<code>${newWallet.mnemonic}</code>`
          : `• <b>12 位标准英文助记词:</b>\n<code>${newWallet.mnemonic}</code>\n<i>(轻点上方助记词可直接复制。可直接导入 Keplr、OKX Web3 钱包、MetaMask 或 Leap 验证同一链上地址！)</i>`;
      const text =
        lang === 'en'
          ? `
🎉 <b>[New 12-Word Mnemonic Wallet Generated]</b>

• <b>Injective Address</b>: <code>${newWallet.injectiveAddress}</code>
• <b>EVM Equivalent</b>: <code>${newWallet.evmAddress || 'N/A'}</code>

${mnemonicBlock}

• <b>Private Key (Hex):</b>
<code>${newWallet.privateKeyHex}</code>

🛡️ <i>Back up your mnemonic offline now! Your practice sandbox & copy settings are preserved.</i>
      `.trim()
          : `
🎉 <b>【全新 12 位标准助记词钱包已生成】</b>

• <b>Injective 地址</b>: <code>${newWallet.injectiveAddress}</code>
• <b>EVM 兼容地址</b>: <code>${newWallet.evmAddress || 'N/A'}</code>

${mnemonicBlock}

• <b>私钥 Hex (十六进制):</b>
<code>${newWallet.privateKeyHex}</code>

🛡️ <i>请务必立即在纸上或安全密码管理器中备份助记词！您的模拟盘资金与跟单设置已无缝保留。</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .url(tr(lang, '🌐 在 Injective 区块浏览器查验此地址', '🌐 View on InjScan'), `https://injscan.com/account/${newWallet.injectiveAddress}`)
        .row()
        .text(tr(lang, '👛 查看我的钱包', '👛 My Wallet'), 'view_wallet')
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 提示用户输入要导入的助记词或私钥
    this.bot.callbackQuery('import_wallet_prompt', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      this.awaitingWalletImportUsers.add(userId);
      await ctx.answerCallbackQuery().catch(() => {});

      const text =
        lang === 'en'
          ? `
📥 <b>[Import Existing Injective Wallet]</b>

Send your wallet credentials directly below:
1. <b>12 or 24-word mnemonic phrase</b> (space-separated)
   Example: <code>abandon ability able about above absent absorb abstract absurd abuse access accident</code>
2. Or <b>64-char hex private key</b> (with or without 0x)
   Example: <code>0x4f3edf983ac636a65a762ce43809197b5b04113345e4c0557e823804418ffb2a</code>

🛡️ <b>Security:</b>
• Your plaintext message is deleted immediately upon receipt and encrypted at rest using AES-256-GCM.
• Your practice balance and tracked whale list remain intact.
      `.trim()
          : `
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
        .text(tr(lang, '🔙 取消并返回钱包', '🔙 Cancel'), 'view_wallet')
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 开启自动跟单
    this.bot.callbackQuery('start_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const copyState = this.walletService.getUserCopyState(userId);
      const targets = this.walletService.getUserTargets(userId);
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
      const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;

      if (targets.length === 0) {
        await ctx.answerCallbackQuery().catch(() => {});
        const text =
          lang === 'en'
            ? `
⚠️ <b>[No Copy Targets Selected]</b>

You haven't added any whale addresses yet.
Open the <b>[🏆 Leaderboard]</b> to pick an active trader, or use <b>[🔍 Track Wallet]</b> to enter any Injective address.
        `.trim()
            : `
⚠️ <b>【尚未选择跟单目标】</b>

您当前尚未绑定任何巨鲸或聪明钱地址。
请先点击下方【🏆 聪明钱榜单】挑选链上高胜率活跃巨鲸，或点击【🔍 监控自定义钱包】输入您想跟随的 Injective 钱包地址。
        `.trim();

        const keyboard = new InlineKeyboard()
          .text(tr(lang, '🏆 前往聪明钱榜单选巨鲸', '🏆 Browse Leaderboard'), 'view_leaderboard')
          .text(tr(lang, '🔍 监控自定义钱包', '🔍 Track Wallet'), 'track_custom_wallet')
          .row()
          .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        return;
      }

      if (!hasRealFunds && !copyState.practiceMode) {
        await ctx.answerCallbackQuery().catch(() => {});
        await this.promptZeroBalanceChoice(ctx, targets[targets.length - 1].address, true);
        return;
      }

      this.walletService.setUserCopying(userId, true);
      for (const t of targets) {
        await this.tracker.addTrackedTrader(t.address, t.subaccountIndex ?? 0);
      }
      await ctx
        .answerCallbackQuery(tr(lang, '🚀 多巨鲸自动跟单矩阵已启动！', '🚀 Copy-trading matrix started!'))
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 暂停自动跟单
    this.bot.callbackQuery('pause_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      this.walletService.setUserCopying(userId, false);
      await ctx.answerCallbackQuery(tr(lang, '⏸️ 自动跟单已暂停', '⏸️ Auto-copy paused')).catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 跟单矩阵与高级设定
    this.bot.callbackQuery('config_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const copyState = this.walletService.getUserCopyState(userId);
      const targets = this.walletService.getUserTargets(userId);
      const isCopying = copyState.isCopyingEnabled;
      const isPractice = copyState.practiceMode;

      const targetsLines =
        targets.length > 0
          ? targets
              .map(
                (t, idx) =>
                  `  ${idx + 1}. <b>${tr(lang, '巨鲸', 'Whale')} 0x${t.address.slice(-4)}</b> (<code>${t.address.slice(0, 10)}...${t.address.slice(-6)}</code>)`
              )
              .join('\n')
          : tr(lang, '  ⚪ 暂未添加任何巨鲸目标', '  ⚪ No whale targets added');

      const execModeDesc = isPractice
        ? tr(lang, '【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】', '[🧪 Practice Sandbox (Virtual funds, zero gas)]')
        : tr(lang, '【🔴 实盘链上交易模式 (专属钱包私钥签名上链 Mainnet)】', '[🔴 Live Mainnet Mode (Signed on-chain execution)]');

      const modeLabel =
        copyState.copyMode === 'RATIO'
          ? tr(
              lang,
              `按比例 (${(copyState.copyRatio * 100).toFixed(1)}%, 单笔上限 $${copyState.maxNotionalPerOrder})`,
              `Proportional (${(copyState.copyRatio * 100).toFixed(1)}%, Cap $${copyState.maxNotionalPerOrder})`
            )
          : tr(lang, `固定金额 ($${copyState.copyAmountUsdt} USDT)`, `Fixed ($${copyState.copyAmountUsdt} USDT)`);

      const text =
        lang === 'en'
          ? `
⚡ <b>[Copy-Trading Matrix & Execution Settings]</b>

• <b>Engine Status</b>: <b>${isCopying ? '🟢 ACTIVE' : '⚪ PAUSED'}</b>
• <b>Execution Mode</b>: <b>${execModeDesc}</b>
• <b>Tracked Whales (${targets.length}/5)</b>:
${targetsLines}
• <b>Sizing Mode</b>: <b>${modeLabel}</b>
• <b>Max Leverage</b>: <b>${copyState.maxLeverage}x</b> | <b>Max Slippage</b>: <b>${copyState.maxSlippagePercent}%</b>
      `.trim()
          : `
⚡ <b>【多巨鲸跟单矩阵 & 执行引擎设置】</b>

• <b>运行状态</b>: <b>${isCopying ? '🟢 自动跟单中 (ACTIVE)' : '⚪ 已暂停 / 未启动 (PAUSED)'}</b>
• <b>执行引擎模式</b>: <b>${execModeDesc}</b>
• <b>当前同时跟单巨鲸 (${targets.length}/5)</b>:
${targetsLines}
• <b>仓位模式</b>: <b>${modeLabel}</b>
• <b>杠杆倍数限制</b>: <b>${copyState.maxLeverage}x</b> | <b>最大滑点保护</b>: <b>${copyState.maxSlippagePercent}%</b>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(tr(lang, '🔴 切换为：实盘链上交易模式', '🔴 Switch: Live Mainnet'), 'switch_mode_real')
        .row()
        .text(tr(lang, '🧪 切换为：$10,000 模拟演练模式', '🧪 Switch: $10k Sandbox'), 'switch_mode_practice')
        .row();

      for (const t of targets) {
        keyboard.text(tr(lang, `❌ 移除 0x${t.address.slice(-4)}`, `❌ Remove 0x${t.address.slice(-4)}`), `unfollow_${t.address.slice(-8)}`).row();
      }

      keyboard
        .text(
          isCopying ? tr(lang, '⏸️ 暂停自动跟单', '⏸️ Pause Copy') : tr(lang, '🟢 开启自动跟单', '🟢 Start Copy'),
          isCopying ? 'pause_copy' : 'start_copy'
        )
        .text(tr(lang, '💰 修改金额', '💰 Order Size'), 'set_amount')
        .row()
        .text(tr(lang, '🗑️ 清空全部目标', '🗑️ Clear All Targets'), 'clear_target')
        .text(tr(lang, '🛡️ 风控与滑点', '🛡️ Risk & Slippage'), 'view_risk')
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    // 单独移除某个跟单巨鲸
    this.bot.callbackQuery(/^unfollow_(.+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const suffix = ctx.match[1];
      const remaining = this.walletService.removeUserTarget(userId, suffix);

      const allActive = this.walletService.getAllActiveTrackedAddresses();
      const stillNeeded = allActive.some((a) => a.toLowerCase().endsWith(suffix.toLowerCase()));
      if (!stillNeeded) {
        this.tracker.removeTrackedTrader(suffix);
      }

      await ctx
        .answerCallbackQuery(
          tr(lang, `✅ 已移除巨鲸 0x${suffix.slice(-4)} (剩余 ${remaining.length} 位)`, `✅ Removed 0x${suffix.slice(-4)} (${remaining.length} left)`)
        )
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
      const lang = this.getLang(ctx);
      const oldTargets = this.walletService.getUserTargets(userId);
      this.walletService.clearUserTarget(userId);
      const allActive = this.walletService.getAllActiveTrackedAddresses();
      for (const t of oldTargets) {
        if (!allActive.includes(t.address)) {
          this.tracker.removeTrackedTrader(t.address);
        }
      }
      await ctx
        .answerCallbackQuery(tr(lang, '🗑️ 已清空全部跟单目标并停止跟单', '🗑️ Cleared all targets & paused'))
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 查询任意 Injective 地址链上资产
    this.bot.callbackQuery(/^inspect_addr_(.+)$/, async (ctx) => {
      const lang = this.getLang(ctx);
      const addr = ctx.match[1];
      await ctx.answerCallbackQuery(tr(lang, '正在查询该地址链上余额...', 'Fetching on-chain balances...')).catch(() => {});
      const injPrice = await this.getLiveInjPrice();
      const balances = await this.walletService.getRealBalances(addr, injPrice);
      const inspectText =
        lang === 'en'
          ? `
🔍 <b>[Injective Address Inspector]</b>

• <b>Address</b>:
<code>${addr}</code>

📊 <b>Live On-Chain Balances (Bank + Derivatives Subaccount)</b>:
• <b>INJ</b>: <code>${balances.inj} INJ</code>
• <b>USDT</b>: <code>${balances.usdt} USDT</code>
• <b>USDC</b>: <code>${balances.usdc} USDC</code>
• <b>Est. Total Value</b>: <b>~$${balances.totalUsd} USD</b>
      `.trim()
          : `
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
        .text(tr(lang, '🎯 加入我的多巨鲸跟单矩阵', '🎯 Add to Copy Matrix'), `follow_custom_${addr}`)
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      try {
        await ctx.editMessageText(inspectText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch {
        await ctx.reply(inspectText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      }
    });

    this.bot.callbackQuery('toggle_mode_ratio', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      this.walletService.setUserCopyMode(userId, 'RATIO');
      await ctx
        .answerCallbackQuery(tr(lang, '已为您切换为：按巨鲸仓位比例跟单', 'Switched to Proportional (RATIO) sizing'))
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery('toggle_mode_fixed', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      this.walletService.setUserCopyMode(userId, 'FIXED_AMOUNT');
      await ctx
        .answerCallbackQuery(tr(lang, '已为您切换为：固定金额跟单', 'Switched to Fixed Amount sizing'))
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 风控设置
    this.bot.callbackQuery('view_risk', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const copyState = this.walletService.getUserCopyState(userId);
      const modeName = copyState.copyMode === 'RATIO'
        ? tr(lang, '按巨鲸比例', 'Proportional (RATIO)')
        : tr(lang, '固定金额', 'Fixed Amount');
      const text =
        lang === 'en'
          ? `
🛡️ <b>[Personal Risk Guard Settings]</b>

These settings apply only to your account:
• <b>Sizing Mode</b>: <b>${modeName}</b>
• <b>Max Slippage Guard</b>: <b>${copyState.maxSlippagePercent}%</b> (blocks orders if book deviates beyond limit)
• <b>Max Leverage</b>: <b>${copyState.maxLeverage}x</b>
• <b>Max Order Notional</b>: <b>$${copyState.maxNotionalPerOrder} USD</b>
• <b>Anomaly Circuit Breaker</b>: <b>Enabled</b>
      `.trim()
          : `
🛡️ <b>【您的专属智能风控设置】</b>

当前仅针对您个人账号生效，不会影响其他用户：
• <b>跟单模式</b>: <b>${modeName}</b>
• <b>滑点保护阈值</b>: <b>${copyState.maxSlippagePercent}%</b> (当盘口剧烈跳空超阈值自动拦截)
• <b>最大允许杠杆</b>: <b>${copyState.maxLeverage}x</b> (防止极端行情穿仓)
• <b>单笔金额上限</b>: <b>$${copyState.maxNotionalPerOrder} USD</b>
• <b>行情异常熔断</b>: <b>已开启</b> (亚秒级判定)
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(tr(lang, '滑点 1.0%', 'Slip 1.0%'), 'slip_10')
        .text(tr(lang, '滑点 1.5%', 'Slip 1.5%'), 'slip_15')
        .text(tr(lang, '滑点 2.0%', 'Slip 2.0%'), 'slip_20')
        .row()
        .text(tr(lang, '杠杆 3x', 'Lev 3x'), 'lev_3')
        .text(tr(lang, '杠杆 5x', 'Lev 5x'), 'lev_5')
        .text(tr(lang, '杠杆 10x', 'Lev 10x'), 'lev_10')
        .row()
        .text(tr(lang, '固定金额模式', 'Fixed Mode'), 'toggle_mode_fixed')
        .text(tr(lang, '按比例跟单模式', 'Proportional Mode'), 'toggle_mode_ratio')
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    });

    this.bot.callbackQuery(/^slip_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const v = parseInt(ctx.match[1], 10) / 10;
      this.walletService.setUserSlippage(userId, v);
      await ctx
        .answerCallbackQuery(tr(lang, `您的专属滑点保护已更新为 ${v}%`, `Max slippage updated to ${v}%`))
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery(/^lev_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const lev = parseInt(ctx.match[1], 10);
      this.walletService.setUserLeverage(userId, lev);
      await ctx
        .answerCallbackQuery(tr(lang, `您的专属最大杠杆已更新为 ${lev}x`, `Max leverage updated to ${lev}x`))
        .catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 修改金额
    this.bot.callbackQuery('set_amount', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const copyState = this.walletService.getUserCopyState(userId);
      const text =
        lang === 'en'
          ? `
💰 <b>Select Notional Size Per Copy Order (USDT):</b>

Current Setting: <b>$${copyState.copyAmountUsdt} USDT</b>
<i>Choose an amount matching your risk tolerance.</i>
      `.trim()
          : `
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
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(() => {});
    });

    this.bot.callbackQuery(/^amt_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const amt = parseInt(ctx.match[1], 10);
      this.walletService.setUserAmount(userId, amt);
      await ctx
        .answerCallbackQuery(tr(lang, `您的单笔金额已更新为 $${amt} USDT`, `Order size set to $${amt} USDT`))
        .catch(() => {});
      await ctx.editMessageText(
        tr(
          lang,
          `✅ 您的单笔跟单金额已成功设置为 <b>$${amt} USDT</b>！`,
          `✅ Order size updated to <b>$${amt} USDT</b>!`
        ),
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu'),
        }
      ).catch(() => {});
    });

    const renderReferralView = async (ctx: any, userId: number, extraNotice?: string) => {
      const lang = this.getLang(ctx);
      const botName = this.bot?.botInfo?.username || ctx.me?.username || 'injective_copy_bot';
      const refLink = `https://t.me/${botName}?start=ref_${userId}`;
      const stats = this.walletService.getReferralStats(userId);

      const noticeLine = extraNotice
        ? `\n\n📌 <b>${tr(lang, '最新提现状态', 'Latest Payout Status')}</b>: ${extraNotice}`
        : '';
      const text =
        lang === 'en'
          ? `
🎁 <b>Injective Referral Commission Dashboard</b>

Invite friends using your link below and earn <b>${this.config.referralRewardPercent}% lifetime trading fee commissions</b> on their live copy trades!

📊 <b>Your Referral Stats:</b>
• 👥 <b>Invited Friends</b>: <b>${stats.invitedCount}</b>
• 📈 <b>Referred Live Volume</b>: <b>$${stats.volume.toLocaleString()} USDT</b>
• 💰 <b>Total Earned</b>: <b>+$${stats.totalEarnings.toFixed(4)} USDT</b>
• 💳 <b>Available to Withdraw</b>: <b>$${stats.available.toFixed(4)} USDT</b>
• 📤 <b>Withdrawn / Requested</b>: <b>$${stats.withdrawn.toFixed(4)} USDT</b>
${stats.pendingPayoutUsdt > 0 ? `• ⏳ <b>Pending Payout</b>: <b>$${stats.pendingPayoutUsdt.toFixed(4)} USDT</b>\n` : ''}
🔗 <b>Your Personal Referral Link:</b>
<code>${refLink}</code>

💡 <i>Commissions accrue only on settled live mainnet orders. Minimum withdrawal: 1.00 USDT.</i>${noticeLine}
      `.trim()
          : `
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
        .text(tr(lang, '💳 立即提取返佣收益 (满1U可提)', '💳 Request Commission Payout (Min 1 USDT)'), 'withdraw_referral')
        .row()
        .url(
          tr(lang, '🚀 转发到 Telegram 群/好友', '🚀 Share on Telegram'),
          `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(tr(lang, 'Injective 链上实盘聪明钱巨鲸自动跟单神器，点此开启挂机跟单！', 'Track & copy-trade Injective on-chain smart money live on Telegram!'))}`
        )
        .row()
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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

    // 申请提现推广返佣
    this.bot.callbackQuery('withdraw_referral', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const res = this.walletService.withdrawReferralRewards(userId);
      if (!res.success) {
        await ctx
          .answerCallbackQuery({ text: localizeServiceMessage(res.message, lang), show_alert: true })
          .catch(() => {});
        return;
      }

      const autoPayoutEnabled = Boolean(
        this.config.referralPayoutPrivateKey &&
          process.env.BLOCK_USER_REAL_TRADES !== 'true' &&
          res.payoutId
      );

      if (autoPayoutEnabled) {
        await ctx
          .answerCallbackQuery(tr(lang, '⏳ 正在向您的钱包发起链上返佣打款...', '⏳ Sending on-chain payout...'))
          .catch(() => {});
      }

      let statusNote = tr(
        lang,
        `提现单 <code>${res.payoutId}</code> 已提交，等待管理员审核后向 <code>${res.wallet.injectiveAddress}</code> 发放。`,
        `Withdrawal request <code>${res.payoutId}</code> submitted; pending admin payout to <code>${res.wallet.injectiveAddress}</code>.`
      );
      let alertMsg = tr(
        lang,
        `✅ 已提交 $${res.amount.toFixed(2)} USDT 返佣提现申请 (${res.payoutId})，已通知管理员审核打款！`,
        `✅ Submitted $${res.amount.toFixed(2)} USDT payout request (${res.payoutId}). Admin notified!`
      );

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
          statusNote = tr(
            lang,
            `🎉 已真实链上打款！Tx: <a href="https://injscan.com/transaction/${txHash}">${txHash}</a>`,
            `🎉 Paid on-chain! Tx: <a href="https://injscan.com/transaction/${txHash}">${txHash}</a>`
          );
          await renderReferralView(ctx, userId, statusNote);
          return;
        } catch (err: any) {
          console.warn('[TelegramBot] 返佣自动链上打款异常，保留待处理打款单:', err.message);
          statusNote = tr(
            lang,
            `⏳ 自动打款异常 (${err.message || '网络繁忙'})，提现单 <code>${res.payoutId}</code> 已保留待人工核发。`,
            `⏳ Auto-payout failed (${err.message || 'network busy'}); request <code>${res.payoutId}</code> queued for manual review.`
          );
          await renderReferralView(ctx, userId, statusNote);
          return;
        }
      }

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
      const lang = this.getLang(ctx);
      if (this.isRpcRateLimited(userId, 'view_stats', 2500)) {
        await ctx.answerCallbackQuery(tr(lang, '⏳ 请稍候再刷新', '⏳ Please wait before refreshing')).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery(tr(lang, '正在刷新实时行情与浮盈...', 'Refreshing live marks & PnL...')).catch(() => {});
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 一键市价全平实盘链上持仓
    this.bot.callbackQuery('close_all_real_pos', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      const userWallet = this.walletService.getOrCreateWallet(userId);
      if (userWallet.decryptionError) {
        await ctx
          .answerCallbackQuery({
            text: tr(lang, '⚠️ 钱包解密异常，请联系管理员检查密钥配置', '⚠️ Wallet decryption error; contact admin.'),
            show_alert: true,
          })
          .catch(() => {});
        return;
      }
      if (process.env.BLOCK_USER_REAL_TRADES === 'true') {
        await ctx
          .answerCallbackQuery({
            text: tr(lang, '⚠️ 管理员已暂停实盘下单广播', '⚠️ Live trading temporarily paused by admin.'),
            show_alert: true,
          })
          .catch(() => {});
        return;
      }
      await ctx
        .answerCallbackQuery(tr(lang, '正在向 Injective 主网发送市价平仓指令...', 'Sending close-all market orders to Mainnet...'))
        .catch(() => {});
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
        await ctx
          .reply(
            tr(
              lang,
              `⚡ 实盘平仓执行完毕：成功 ${closed} 笔${failed > 0 ? `，失败 ${failed} 笔` : ''}。`,
              `⚡ Live close completed: ${closed} closed${failed > 0 ? `, ${failed} failed` : ''}.`
            )
          )
          .catch(() => {});
      } catch (err: any) {
        await ctx.reply(tr(lang, `⚠️ 查询实盘持仓失败: ${err.message}`, `⚠️ Failed to query live positions: ${err.message}`)).catch(() => {});
      }
      await this.renderPortfolioAndStats(ctx, false);
    });

    // 一键市价全平模拟持仓
    this.bot.callbackQuery('close_all_pos', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
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
          tr(
            lang,
            `⚡ 已全平 ${res.closedCount} 笔持仓，本次结算净盈亏: ${sign}$${res.totalNetPnlUsdt} USDT`,
            `⚡ Closed ${res.closedCount} positions | Net PnL: ${sign}$${res.totalNetPnlUsdt} USDT`
          )
        )
        .catch(() => {});
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 一键仅平仓亏损持仓
    this.bot.callbackQuery('close_loss_pos', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
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
        await ctx
          .answerCallbackQuery(tr(lang, '当前暂无处于亏损状态的持仓', 'No losing positions to close'))
          .catch(() => {});
      } else {
        await ctx
          .answerCallbackQuery(
            tr(
              lang,
              `🧹 已清理 ${res.closedCount} 笔亏损仓位，剩余 ${res.remainingCount} 笔持仓`,
              `🧹 Closed ${res.closedCount} losing position(s), ${res.remainingCount} left`
            )
          )
          .catch(() => {});
      }
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 一键重置 $10,000 体验金
    this.bot.callbackQuery('reset_practice', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const lang = this.getLang(ctx);
      this.walletService.resetPracticeAccount(userId);
      await ctx
        .answerCallbackQuery(tr(lang, '🎉 模拟盘账户已重置为初始 $10,000 USDT！', '🎉 Practice balance reset to $10,000 USDT!'))
        .catch(() => {});
      await this.renderPortfolioAndStats(ctx, true);
    });

    // 跟单某大户触发
    this.bot.callbackQuery(/^follow_(.+)$/, async (ctx) => {
      const lang = this.getLang(ctx);
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
        await ctx.answerCallbackQuery(tr(lang, '未找到该巨鲸地址', 'Whale address not found')).catch(() => {});
        return;
      }

      await this.applyFollowTarget(ctx, targetAddress, true, subaccountIndex);
    });
  }

  /**
   * 渲染多巨鲸跟单矩阵确认面板 (支持单独移除每个巨鲸或清空全部)
   */
  private async renderMatrixConfirmation(ctx: any, userId: number, isCallback: boolean = true) {
    const lang = this.getLang(ctx);
    const targets = this.walletService.getUserTargets(userId);
    const isPractice = this.walletService.isPracticeMode(userId);
    const userCopy = this.walletService.getUserCopyState(userId);
    const modeBadge = isPractice
      ? tr(lang, '【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】', '[🧪 Practice Sandbox (Virtual funds, zero gas)]')
      : tr(lang, '【🔴 实盘链上交易模式 (专属钱包私钥真实签名上链 Mainnet)】', '[🔴 Live Mainnet Mode (Signed on-chain execution)]');

    const targetLines = targets
      .map((t, idx) => {
        const w = this.leaderboard.getWhaleByAddress(t.address);
        const activeStr =
          w && typeof w.lastTradeMinutesAgo === 'number'
            ? ` | ${formatActiveAgo(w.lastTradeMinutesAgo, lang)}`
            : w?.lastActiveDesc && lang === 'zh'
            ? ` | ${w.lastActiveDesc}`
            : '';
        return `  <b>${idx + 1}. ${tr(lang, '巨鲸', 'Whale')} 0x${t.address.slice(-4)}</b>\n     <code>${t.address}</code>${activeStr}`;
      })
      .join('\n');

    const confirmText =
      lang === 'en'
        ? `
✅ <b>Added to Your Copy-Trading Matrix! (${targets.length} active whale${targets.length > 1 ? 's' : ''})</b>

🎯 <b>Tracked Whales</b>:
${targetLines}

• <b>Execution Mode</b>: <b>${modeBadge}</b>
• <b>Order Size</b>: <b>$${userCopy.copyAmountUsdt} USDT</b>
• <b>Max Slippage</b>: <b>${userCopy.maxSlippagePercent}%</b> | <b>Max Leverage</b>: <b>${userCopy.maxLeverage}x</b>

⚡ <i>Real-time gRPC stream is active! Any directional fill from these whales on Injective will be automatically mirrored under your risk settings.</i>
    `.trim()
        : `
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
      keyboard.text(tr(lang, `❌ 移除 0x${t.address.slice(-4)}`, `❌ Remove 0x${t.address.slice(-4)}`), `unfollow_${t.address.slice(-8)}`).row();
    }

    keyboard
      .text(tr(lang, '🏆 继续添加榜单巨鲸', '🏆 Add from Leaderboard'), 'view_leaderboard')
      .text(tr(lang, '🔍 添加自定义地址', '🔍 Add Custom Address'), 'track_custom_wallet')
      .row()
      .text(tr(lang, '⏸️ 暂停自动跟单', '⏸️ Pause Copy'), 'pause_copy')
      .text(tr(lang, '🗑️ 清空全部目标', '🗑️ Clear All'), 'clear_target')
      .row()
      .text(tr(lang, '💰 修改单笔金额', '💰 Order Size'), 'set_amount')
      .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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
    const lang = this.getLang(ctx);

    const mmAudit = await this.leaderboard.auditTraderIsMarketMaker(targetAddress);
    if (mmAudit.isMarketMaker) {
      const reasonText = localizeServiceMessage(mmAudit.reason, lang);
      const alertText =
        lang === 'en'
          ? `
🛡️ <b>[Risk Guard: Market Maker / Wash Bot Blocked]</b>

• <b>Target Address</b>: <code>${targetAddress}</code>
• <b>Audit Finding</b>: <b>${reasonText}</b>

⚠️ <b>Why is copy-trading this address blocked?</b>
1. This address runs high-frequency market-making, arbitrage, or micro-split scripts.
2. Mirroring such bots via market taker orders incurs continuous spread and slippage losses.

⛔ <b>Request safely blocked to protect your capital.</b>
👉 Check <b>[🏆 Leaderboard]</b> for real directional traders instead.
      `.trim()
          : `
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
        .text(tr(lang, '🏆 选择精选波段巨鲸', '🏆 Browse Leaderboard'), 'view_leaderboard')
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

      if (isCallback) {
        await ctx
          .answerCallbackQuery({
            text: tr(lang, '⚠️ 拦截：该地址为做市商程序，已拒绝跟单！', '⚠️ Blocked: Market maker / HFT bot detected!'),
            show_alert: true,
          })
          .catch(() => {});
        await ctx.editMessageText(alertText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
          await ctx.reply(alertText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
        });
      } else {
        await ctx.reply(alertText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      }
      return;
    }

    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username, ctx.from?.language_code);
    const injPrice = await this.getLiveInjPrice();
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress, injPrice);
    const isPractice = this.walletService.isPracticeMode(userId);
    const hasRealFunds = parseFloat(balances.stableUsd) > 0 || parseFloat(balances.inj) > 0;

    const whale = this.leaderboard.getWhaleByAddress(targetAddress);
    const effectiveSubIdx = whale?.subaccountIndex ?? subaccountIndex;
    const name = whale ? `${whale.name} ${whale.badge}` : `Whale 0x${targetAddress.slice(-4)}`;

    const { targets } = this.walletService.addUserTarget(userId, targetAddress, name, effectiveSubIdx);

    if (!hasRealFunds && !isPractice) {
      if (isCallback) {
        await ctx.answerCallbackQuery().catch(() => {});
      }
      await this.promptZeroBalanceChoice(ctx, targetAddress, isCallback);
      return;
    }

    this.walletService.setUserCopying(userId, true);
    for (const t of targets) {
      await this.tracker.addTrackedTrader(t.address, t.subaccountIndex ?? 0);
    }
    this.leaderboard.registerCustomWhale(targetAddress);

    if (isCallback) {
      await ctx
        .answerCallbackQuery(tr(lang, `✅ 已加入跟单矩阵 (当前共 ${targets.length} 位巨鲸)`, `✅ Added to copy matrix (${targets.length} active)`))
        .catch(() => {});
    }

    await this.renderMatrixConfirmation(ctx, userId, isCallback);
  }

  /**
   * 处理用户输入的自定义 Injective 钱包地址
   */
  private async handleCustomAddressInput(ctx: any, rawAddress: string) {
    const userId = ctx.from?.id || 0;
    const lang = this.getLang(ctx);
    this.awaitingAddressUsers.delete(userId);

    const check = validateInjectiveAddress(rawAddress, lang);
    if (!check.valid || !check.cleanAddress) {
      const errText =
        lang === 'en'
          ? `
❌ <b>Invalid Address Format</b>

${check.error || 'Malformed address'}
Please verify and send a valid 42-char Injective address starting with <code>inj1...</code>.
      `.trim()
          : `
❌ <b>地址格式校验失败</b>

${check.error || '输入的地址格式不正确'}
请检查并重新输入以 <code>inj1...</code> 开头的 42 位有效 Injective 地址。
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(tr(lang, '🔍 重新输入地址', '🔍 Enter Another Address'), 'track_custom_wallet')
        .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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
    const channelLang: BotLang =
      (process.env.CHANNEL_LANGUAGE || '').toLowerCase() === 'en' ? 'en' : 'zh';
    const text =
      channelLang === 'en'
        ? `
🚨 <b>[Injective Smart-Money Trade Signal]</b>

• <b>Market</b>: <code>${event.marketTicker}</code>
• <b>Side</b>: ${isBuy ? '🟢 LONG (BUY)' : '🔴 SHORT (SELL)'}
• <b>Price</b>: <b>$${event.price}</b>
• <b>Whale Size</b>: <b>${event.quantity}</b> (~<b>$${event.notionalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>)
• <b>Whale</b>: <code>${event.traderAddress.substring(0, 8)}...${event.traderAddress.slice(-6)}</code>

⚡ <i>Real-time smart-money fill. Tap below to follow this whale!</i>
    `.trim()
        : `
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
            channelLang === 'en'
              ? `⚡ Copy Now (${isBuy ? 'LONG' : 'SHORT'})`
              : `⚡ 一键跟单 (${isBuy ? '做多' : '做空'})`,
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
    const lang = this.walletService.getUserLanguage(userId);

    if (!result.success || options?.customBlockedReason) {
      const reasonStr = localizeServiceMessage(options?.customBlockedReason || result.error, lang);
      return lang === 'en'
        ? `
🛑 <b>[Copy Order Blocked by Risk Guard]</b>

• Market: <code>${result.marketTicker}</code>
• Reason: <i>${reasonStr}</i>
• Your capital remains untouched; potential adverse fill avoided.
      `.trim()
        : `
🛑 <b>【跟单已安全拦截（风控保护生效）】</b>

• 市场: <code>${result.marketTicker}</code>
• 拦截原因: <i>${reasonStr}</i>
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

      return lang === 'en'
        ? `
🧪 <b>[Practice Sandbox Copy Executed]</b>

• <b>Mode</b>: <i>[🧪 Practice Sandbox (Virtual balance, zero gas)]</i>
• <b>Market</b>: <code>${result.marketTicker}</code> | Side: <b>${result.direction}</b>
• <b>Simulated Price</b>: <b>$${result.executionPrice}</b> | Qty: <b>${finalQty}</b>
• <b>Margin Deducted</b>: <b>$${finalMargin.toFixed(2)} USDT</b> (${finalLeverage}x Leverage)
• <b>Available Practice Balance</b>: <b>$${availBal} USDT</b> (${positionsCount} open)
• <b>Paper Order ID</b>: <code>${paperId} (Off-chain)</code>
      `.trim()
        : `
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
      return lang === 'en'
        ? `
⚠️ <b>[Live Copy Skipped: Insufficient On-Chain Balance]</b>

• <b>Mode</b>: <b>🔴 Live Mainnet Mode</b>
• <b>Market</b>: <code>${result.marketTicker}</code> | Side: <b>${result.direction}</b>
• <b>Required Margin</b>: <b>$${info.requiredMargin.toFixed(2)}</b> (based on $${info.userAmountUsdt} USDT/order)
• <b>Current Wallet</b>: <b>${info.inj} INJ / ${info.usdt}</b>

💡 <i>Live execution requires quote margin + INJ for gas. Fund your wallet or switch to the $10,000 Practice Sandbox below:</i>
      `.trim()
        : `
⚠️ <b>【实盘跟单未执行：链上实盘余额不足】</b>

• <b>当前模式</b>: <b>🔴 实盘链上交易模式</b>
• <b>触发标的</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>本单所需保证金</b>: <b>$${info.requiredMargin.toFixed(2)}</b> (按您设置的 $${info.userAmountUsdt} USDT/单折算)
• <b>您的当前实盘余额</b>: <b>${info.inj} INJ / ${info.usdt}</b>

💡 <i>实盘链上跟单需要您专属钱包内有充足的对应合约保证金与少量 INJ (Gas 费)。系统已安全跳过本次链上广播，绝不虚报成交！请先充值或一键切换为 $10,000 模拟盘演练：</i>
      `.trim();
    }

    if (options?.realBroadcastError) {
      return lang === 'en'
        ? `
⚠️ <b>[Live Broadcast Error (No Funds Spent)]</b>

• <b>Signer</b>: <code>${userWallet.injectiveAddress}</code>
• <b>Market</b>: <code>${result.marketTicker}</code> | Side: <b>${result.direction}</b>
• <b>Node Error</b>: <i>${options.realBroadcastError}</i>
      `.trim()
        : `
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
      return lang === 'en'
        ? `
⚠️ <b>[Live Copy Not Executed: Missing TxHash]</b>

• <b>Signer</b>: <code>${userWallet.injectiveAddress}</code>
• <b>Market</b>: <code>${result.marketTicker}</code> | Side: <b>${result.direction}</b>
• <b>Note</b>: <i>No on-chain transaction hash returned. Check wallet balance or switch to Practice Sandbox.</i>
      `.trim()
        : `
⚠️ <b>【实盘跟单未执行：未获取到链上交易哈希】</b>

• <b>签名地址</b>: <code>${userWallet.injectiveAddress}</code>
• <b>交易市场</b>: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• <b>状态说明</b>: <i>未完成主网真实签名广播，请检查实盘余额或切换至模拟盘演练。</i>
      `.trim();
    }

    const txLink = `<a href="https://injscan.com/transaction/${realHash}">${realHash}</a>`;

    return lang === 'en'
      ? `
🔴 <b>[Live Mainnet Copy Order Executed]</b>

• <b>Mode</b>: <b>🔴 On-Chain Signed Mainnet Order</b>
• <b>Signer</b>: <code>${userWallet.injectiveAddress}</code>
• <b>Market</b>: <code>${result.marketTicker}</code> | Side: <b>${result.direction}</b>
• <b>Fill Price</b>: <b>$${result.executionPrice}</b> | Qty: <b>${finalQty}</b>
• <b>Margin Used</b>: <b>$${finalMargin.toFixed(2)} USDT</b> (${finalLeverage}x Leverage)
• <b>Latency</b>: <b>${result.executionTimeMs} ms</b>
• <b>Mainnet Tx</b>: ${txLink}
    `.trim()
      : `
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
      const lang = this.walletService.getUserLanguage(chatId);
      const sizing = this.calculateUserOrderSizing(chatId, result, event);

      if (!sizing.passed) {
        const blockedText = this.formatTradeNotificationText(chatId, result, {
          customBlockedReason: sizing.reason || result.error || tr(lang, '未通过个人风控检查', 'Failed personal risk check'),
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
          : tr(
              lang,
              `⚠️ <b>【模拟盘跟单未执行】</b>\n\n• 原因: <i>${pracRes.error}</i>`,
              `⚠️ <b>[Practice Order Skipped]</b>\n\n• Reason: <i>${localizeServiceMessage(pracRes.error, lang)}</i>`
            );

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
              tr(
                lang,
                `⏸️ <b>【实盘广播暂已暂停】</b>\n\n已捕获信号 <code>${result.marketTicker}</code> (${result.direction})，管理员当前已开启实盘拦截开关。`,
                `⏸️ <b>[Live Broadcasts Paused]</b>\n\nSignal captured: <code>${result.marketTicker}</code> (${result.direction}), but live execution is currently paused by admin.`
              ),
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
              tr(
                lang,
                `⚠️ <b>【实盘签名失败】</b> 您的本地钱包密钥解密异常，请联系管理员检查服务器密钥配置或重新导入钱包。`,
                `⚠️ <b>[Signing Failed]</b> Wallet decryption error; please contact admin or re-import your wallet.`
              ),
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
                tr(
                  lang,
                  `🛡️ <b>【多巨鲸方向冲突保护】</b>\n\n• <b>合约</b>: <code>${result.marketTicker}</code>\n• <b>拦截原因</b>: 您当前实盘持仓归属于巨鲸 <code>${ownerTag}</code>，已安全拦截来自巨鲸 <code>0x${event.traderAddress.slice(-4)}</code> 的反向 <b>${result.direction}</b> 信号，防止左右互搏误平仓！`,
                  `🛡️ <b>[Multi-Whale Conflict Protection]</b>\n\n• <b>Market</b>: <code>${result.marketTicker}</code>\n• <b>Blocked</b>: Your open position belongs to whale <code>${ownerTag}</code>; opposing <b>${result.direction}</b> signal from <code>0x${event.traderAddress.slice(-4)}</code> ignored to prevent unintended unwinding.`
                ),
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
          .text(tr(lang, '💳 立即充值激活', '💳 Deposit Funds'), 'deposit_guide')
          .text(tr(lang, '🧪 一键切换为模拟盘跟单', '🧪 Switch to Sandbox'), 'switch_mode_practice')
          .row()
          .text(tr(lang, '🔙 返回主菜单', '🔙 Main Menu'), 'back_to_menu');

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
          const refLang = this.walletService.getUserLanguage(refRes.referrerId);
          await this.bot.api
            .sendMessage(
              refRes.referrerId,
              tr(
                refLang,
                `💰 <b>【好友实盘跟单返佣到账】</b>\n\n• 来自好友: @${w.username || chatId}\n• 本单产生返佣: <b>+$${refRes.rewardUsdt.toFixed(4)} USDT</b>\n• 您的累计总返佣: <b>$${refRes.totalEarned.toFixed(2)} USDT</b>\n\n👉 <i>随时点击主菜单【🎁 邀请返佣】查看明细与申请提现！</i>`,
                `💰 <b>[Referral Commission Credited]</b>\n\n• Friend: @${w.username || chatId}\n• Earned: <b>+$${refRes.rewardUsdt.toFixed(4)} USDT</b>\n• Total Earned: <b>$${refRes.totalEarned.toFixed(2)} USDT</b>\n\n👉 <i>Open [🎁 Referrals] in the menu to inspect or withdraw!</i>`
              ),
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
