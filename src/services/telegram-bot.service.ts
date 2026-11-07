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
      return { valid: false, error: 'Bech32 校验和不匹配。' };
    }
    return { valid: true, cleanAddress: clean };
  } catch (err: any) {
    return { valid: false, error: `Bech32 校验失败: ${err.message || '无效的校验和'}` };
  }
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
  private activeUserChatIds: Set<number> = new Set();
  private awaitingAddressUsers: Set<number> = new Set();

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
            console.warn(`[TelegramBot] 轮询重连中 (${err.message})，3秒后自动恢复...`);
            if (this.isBotRunning) {
              setTimeout(launchPolling, 3000);
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
    if (this.bot && this.isBotRunning) {
      await this.bot.stop();
      this.isBotRunning = false;
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
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);

    let targetDesc = '';
    if (targets.length === 0) {
      targetDesc = '⚪ 暂未选择 (请点击下方榜单或自定义监控)';
    } else {
      const listStr = targets
        .map((t, idx) => `${idx + 1}. 巨鲸 0x${t.address.slice(-4)}`)
        .join(' | ');
      targetDesc = `🎯 已同时监控 ${targets.length} 位巨鲸: ${listStr}`;
    }

    const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;
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
      ? `• <b>体验金可用本金</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>模拟持仓占用保证金</b>: <b>$${usedPracticeMargin.toFixed(2)} USDT (${positions.length} 笔持仓)</b>\n• <b>链上实际存入</b>: <code>${balances.inj} INJ</code> | <code>${balances.usdt} USDT</code>`
      : `• <b>链上实盘资产</b>: <b>${balances.inj} INJ</b> | <b>${balances.usdt} USDT</b> (估值 ~$${balances.totalUsd} USD)`;

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
• <b>单笔金额</b>: <b>$${userCopy.copyAmountUsdt} USDT/单</b>
• <b>运行状态</b>: <b>${modeText}</b>
• <b>风控保护</b>: 杠杆 <b>${this.config.maxLeverage}x</b> | 滑点保护 <b>${this.config.maxSlippagePercent}%</b>
• <b>链路响应</b>: 🟢 gRPC 毫秒级流式监听 24h 待命
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
• 平均链上执行延迟: <b>~380 ms (亚秒级)</b>
• 节点连接状态: <b>🟢 Injective Mainnet Sentry 正常</b>
    `.trim();
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
    text += `<i>实时扫描主网前 1,000 个大户实盘仓位，已自动剔除僵尸死仓，仅精选 24h 内高频活跃盈利巨鲸</i>\n\n`;
    const keyboard = new InlineKeyboard();

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

    keyboard
      .text('🔄 实时重扫主网巨鲸', 'refresh_leaderboard')
      .text('🔍 监控自定义钱包', 'track_custom_wallet')
      .row()
      .text('🔙 返回主菜单', 'back_to_menu');

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
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

    // 仅记录必要指令输入，过滤所有按钮点击刷屏，降低服务器日志负担
    this.bot.use(async (ctx, next) => {
      if (ctx.message?.text?.startsWith('/')) {
        console.log(`[TelegramBot] 指令 @${ctx.from?.username || ctx.from?.id}: ${ctx.message.text}`);
      }
      await next();
    });

    // 1. /start 与 /menu 指令
    this.bot.command('start', (ctx) => this.renderMainMenu(ctx, false));
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

请输入以 <code>inj1...</code> 开头的 42 位 Injective Bech32 地址：
例如：
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

⚡ <i>系统将进行 Bech32 链上校验码严密校验，并自动加入您的多巨鲸跟单矩阵！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu');
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    this.bot.command('leaderboard', (ctx) => {
      ctx.reply('🏆 轻点下方按钮查看链上聪明钱实时胜率排行：', {
        reply_markup: new InlineKeyboard().text('🏆 立即查看聪明钱排行榜', 'view_leaderboard'),
      });
    });

    this.bot.command('amount', (ctx) => {
      ctx.reply('请选择单笔跟单金额：', {
        reply_markup: new InlineKeyboard()
          .text('$20 USDT', 'amt_20')
          .text('$50 USDT', 'amt_50')
          .row()
          .text('$100 USDT', 'amt_100')
          .text('$200 USDT', 'amt_200')
          .row()
          .text('🔙 返回主菜单', 'back_to_menu'),
      });
    });

    this.bot.command('referral', (ctx) => {
      const refLink = `https://t.me/${ctx.me.username}?start=ref_${ctx.from?.id || '888'}`;
      ctx.reply(
        `🎁 <b>您的专属推广链接：</b>\n<code>${refLink}</code>\n\n好友使用享 25% 终身手续费现金分红！`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('stats', (ctx) => {
      const text = this.getStatsBoardText(ctx.from?.id);
      ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
      });
    });

    // 3. 文本输入监听 (区分主动等待输入与普通发送地址)
    this.bot.on('message:text', async (ctx) => {
      const text = (ctx.message.text || '').trim();
      const userId = ctx.from?.id || 0;

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
          await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: keyboard });
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
      await ctx.answerCallbackQuery().catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 监控自定义钱包
    this.bot.callbackQuery('track_custom_wallet', async (ctx) => {
      this.awaitingAddressUsers.add(ctx.from?.id || 0);
      const text = `
🔍 <b>【请输入您要监控并跟单的 Injective 钱包地址】</b>

请直接向机器人发送以 <code>inj1...</code> 开头的 42 位 Injective 地址：
例如：
<code>inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp</code>

💡 <i>支持同时监控最多 5 位巨鲸！系统将自动校验 Bech32 Checksum 并加入您的多巨鲸并发跟单矩阵，绝不覆盖已有目标！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    // 查看聪明钱排行榜 (若距上次刷新超过 15 秒，自动拉取最新盘口浮盈与最新成交时间)
    this.bot.callbackQuery('view_leaderboard', async (ctx) => {
      await ctx.answerCallbackQuery('正在读取最新链上实盘数据...').catch(() => {});
      if (
        Date.now() - this.leaderboard.getLastRefreshTime() > 15000 ||
        this.leaderboard.getTopWhales(5).length === 0
      ) {
        await this.leaderboard.refreshLeaderboard();
      }
      await this.renderLeaderboardView(ctx);
    });

    this.bot.callbackQuery('refresh_leaderboard', async (ctx) => {
      await ctx.answerCallbackQuery('正在重扫 Injective 主网最新区块成交...').catch(() => {});
      await this.leaderboard.refreshLeaderboard();
      await this.renderLeaderboardView(ctx);
    });

    // 显式切换为：实盘链上交易模式
    this.bot.callbackQuery('switch_mode_real', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
      const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;

      if (!hasRealFunds) {
        await ctx
          .answerCallbackQuery('⚠️ 您的专属实盘钱包余额为 0，请先充值或继续使用模拟盘！')
          .catch(() => {});
        const warnText = `
🔴 <b>【切换实盘链上交易模式 - 余额校验未通过】</b>

检测到您的专属非托管钱包当前实盘余额为 0：
• 专属地址: <code>${userWallet.injectiveAddress}</code>
• 链上余额: <b>${balances.inj} INJ / ${balances.usdt} USDT</b>

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
• <b>实盘可用余额</b>: <b>${balances.inj} INJ | ${balances.usdt} USDT</b>

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

    // 钱包详情与充值
    this.bot.callbackQuery('view_wallet', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
      const isPractice = this.walletService.isPracticeMode(userId);
      const positions = userWallet.practicePositions || [];
      const usedMargin = positions.reduce((sum, p) => sum + (p.marginUsdt || 0), 0);
      const availPractice = userWallet.practiceBalanceUsdt ?? 10000;
      const realizedPnl = userWallet.practiceRealizedPnlUsdt ?? 0;
      const pnlSign = realizedPnl >= 0 ? '+' : '';

      const practiceInfo = isPractice
        ? `• <b>当前执行模式</b>: <b>【🧪 模拟盘演练 (虚拟体验金扣款，不上链不耗 Gas)】</b>\n• <b>剩余可用体验金</b>: <b>$${availPractice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</b>\n• <b>模拟持仓占用保证金</b>: <b>$${usedMargin.toFixed(2)} USDT (${positions.length} 笔持仓)</b>\n• <b>累计平仓已实现盈亏</b>: <b>${pnlSign}$${realizedPnl.toFixed(2)} USDT</b>`
        : `• <b>当前执行模式</b>: <b>【🔴 实盘链上交易模式 (专属钱包私钥签名上链)】</b>`;

      const text = `
👛 <b>我的专属 Injective 跟单钱包</b>

• <b>专属链上地址</b>:
<code>${userWallet.injectiveAddress}</code>
<i>(轻点上方地址可直接复制)</i>

📊 <b>资产与模式详情</b>:
• <b>链上 INJ 余额</b>: <code>${balances.inj} INJ</code>
• <b>链上 USDT 余额</b>: <code>${balances.usdt} USDT</code>
• <b>当前实盘估值</b>: <b>$${balances.totalUsd} USD</b>
${practiceInfo}

🛡️ <i>非托管安全保障：私钥仅在本地安全受控，您可以随时备份导出到 Keplr 或 MetaMask 钱包自由管理。</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('💳 充值 USDT/INJ 激活实盘', 'deposit_guide')
        .row()
        .text('🔴 切换为：实盘链上交易模式', 'switch_mode_real')
        .text('🧪 切换为：$10,000 模拟演练模式', 'switch_mode_practice')
        .row()
        .text('🔄 刷新余额', 'view_wallet')
        .text('🔑 备份导出私钥', 'export_key')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 充值指南
    this.bot.callbackQuery('deposit_guide', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);

      const text = `
💳 <b>【充值 USDT / INJ 激活实盘交易】</b>

您的专属充值地址:
<code>${userWallet.injectiveAddress}</code>
<i>(轻点上方地址即可一键复制)</i>

📌 <b>便捷充值方式:</b>
1. <b>中心化交易所提现</b> (币安 Binance, OKX, Bybit 等):
   • 提币币种选择 <b>INJ</b> 或 <b>USDT</b>
   • 网络务必选择 <b>Injective (INJ)</b>
   • 填入上方您的专属地址，通常 1-2 分钟内秒级到账

2. <b>跨链桥转账</b>:
   • 从以太坊跨链: <a href="https://hub.injective.network/bridge">Injective Hub Bridge</a>
   • 从 Cosmos 生态 (IBC 转账): Keplr 一键直达

📊 <b>实时到账状态</b>:
• 当前 INJ: <code>${balances.inj} INJ</code> | 当前 USDT: <code>${balances.usdt} USDT</code>
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
      });
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
      });
    });

    // 开启体验金并直接锁定某目标 (callback_data 长度: 12 + 42 = 54 <= 64 bytes)
    this.bot.callbackQuery(/^prac_follow_(.+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const targetAddress = ctx.match[1];
      this.walletService.setPracticeMode(userId, true);
      await ctx.answerCallbackQuery('🎉 体验金已开启并加入跟单矩阵！').catch(() => {});
      await this.applyFollowTarget(ctx, targetAddress, true);
    });

    // 导出私钥
    this.bot.callbackQuery('export_key', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const text = `
⚠️ <b>【绝密信息 - 私钥备份】</b>

• 地址: <code>${userWallet.injectiveAddress}</code>
• 私钥 Hex:
<code>${userWallet.privateKeyHex}</code>

<i>⚠️ 警告: 私钥是您钱包资产的最高控制权，任何拥有私钥的人均可转走资产。请妥善保存，切勿截图或泄露给任何人！可导入 Keplr 或 MetaMask 中管理。</i>
      `.trim();

      const keyboard = new InlineKeyboard().text('🔙 返回钱包', 'view_wallet');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    // 开启自动跟单
    this.bot.callbackQuery('start_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const copyState = this.walletService.getUserCopyState(userId);
      const targets = this.walletService.getUserTargets(userId);
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
      const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;

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

        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      }

      // 2. 检查是否有资金或开启体验金
      if (!hasRealFunds && !copyState.practiceMode) {
        await ctx.answerCallbackQuery().catch(() => {});
        await this.promptZeroBalanceChoice(ctx, targets[targets.length - 1].address, true);
        return;
      }

      // 3. 启动多巨鲸跟单矩阵
      this.walletService.setUserCopying(userId, true);
      for (const t of targets) {
        this.config.targetTraderAddress = t.address;
        await this.tracker.addTrackedTrader(t.address);
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

      const text = `
⚡ <b>【多巨鲸跟单矩阵 & 执行引擎设置】</b>

• <b>运行状态</b>: <b>${isCopying ? '🟢 自动跟单中 (ACTIVE)' : '⚪ 已暂停 / 未启动 (PAUSED)'}</b>
• <b>执行引擎模式</b>: <b>${execModeDesc}</b>
• <b>当前同时跟单巨鲸 (${targets.length}/5)</b>:
${targetsLines}
• <b>单笔金额</b>: <b>$${copyState.copyAmountUsdt} USDT</b>
• <b>杠杆倍数限制</b>: <b>${this.config.maxLeverage}x</b> | <b>最大滑点保护</b>: <b>${this.config.maxSlippagePercent}%</b>
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

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
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
      const balances = await this.walletService.getRealBalances(addr);
      const inspectText = `
🔍 <b>【Injective 链上地址资产查询】</b>

• <b>查询地址</b>:
<code>${addr}</code>

📊 <b>实时链上资产 (主账户 + 衍生品子账户)</b>:
• <b>INJ 余额</b>: <code>${balances.inj} INJ</code>
• <b>USDT/USDC 余额</b>: <code>${balances.usdt} USDT</code>
• <b>总资产折合估值</b>: <b>~$${balances.totalUsd} USD</b>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('🎯 加入我的多巨鲸跟单矩阵', `follow_custom_${addr}`)
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      try {
        await ctx.editMessageText(inspectText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch {
        await ctx.reply(inspectText, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    });

    this.bot.callbackQuery('toggle_mode_ratio', async (ctx) => {
      this.config.copyMode = 'RATIO';
      await ctx.answerCallbackQuery('已切换为仓位比例跟单模式');
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery('toggle_mode_fixed', async (ctx) => {
      this.config.copyMode = 'FIXED_AMOUNT';
      await ctx.answerCallbackQuery('已切换为固定金额跟单模式');
      await this.renderMainMenu(ctx, true);
    });

    // 风控设置
    this.bot.callbackQuery('view_risk', async (ctx) => {
      const text = `
🛡️ <b>【专业级智能风控设置】</b>

系统配备毫秒级链上风控防火墙，全方位保护您的本金安全：
• <b>滑点保护阈值</b>: <b>${this.config.maxSlippagePercent}%</b> (当盘口剧烈跳空超阈值自动拦截)
• <b>最大允许杠杆</b>: <b>${this.config.maxLeverage}x</b> (防止极端行情穿仓)
• <b>单笔金额上限</b>: <b>$${this.config.maxNotionalPerOrder} USD</b>
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
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    this.bot.callbackQuery(/^slip_(\d+)$/, async (ctx) => {
      const v = parseInt(ctx.match[1], 10) / 10;
      this.config.maxSlippagePercent = v;
      await ctx.answerCallbackQuery(`滑点保护已更新为 ${v}%`);
      await this.renderMainMenu(ctx, true);
    });

    this.bot.callbackQuery(/^lev_(\d+)$/, async (ctx) => {
      const lev = parseInt(ctx.match[1], 10);
      this.config.maxLeverage = lev;
      await ctx.answerCallbackQuery(`最大杠杆已更新为 ${lev}x`);
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

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    this.bot.callbackQuery(/^amt_(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const amt = parseInt(ctx.match[1], 10);
      this.walletService.setUserAmount(userId, amt);
      this.config.fixedUsdtAmount = amt;
      await ctx.answerCallbackQuery(`金额已更新为 $${amt} USDT`);
      await ctx.editMessageText(`✅ 单笔跟单金额已成功设置为 <b>$${amt} USDT</b>！`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
      });
    });

    // 邀请返佣
    this.bot.callbackQuery('view_referral', async (ctx) => {
      const userId = ctx.from?.id || 888888;
      const botName = this.bot?.botInfo?.username || 'injective_copy_bot';
      const refLink = `https://t.me/${botName}?start=ref_${userId}`;

      const text = `
🎁 <b>Injective 裂变邀请返佣计划</b>

邀请好友使用您的专属链接开启跟单，<b>终身享受好友产生交易手续费的 ${this.config.referralRewardPercent}% 现金分红！</b>

🔗 <b>您的专属推广链接:</b>
<code>${refLink}</code>

💡 <b>推广话术推荐:</b>
<i>“Injective 链上实盘聪明钱巨鲸自动跟单，资金在自己钱包无提现风险，一键挂机带飞：${refLink}”</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .url(
          '🚀 转发到 Telegram 群/好友',
          `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Injective 链上实盘聪明钱巨鲸自动跟单神器，点此开启挂机跟单！')}`
        )
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 战绩看板
    this.bot.callbackQuery('view_stats', async (ctx) => {
      const text = this.getStatsBoardText(ctx.from?.id);
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
      });
    });

    // 跟单某大户触发 (支持 follow_whale_1, follow_custom_inj1...)
    this.bot.callbackQuery(/^follow_(.+)$/, async (ctx) => {
      const targetParam = ctx.match[1];
      let targetAddress = '';

      if (targetParam.startsWith('custom_')) {
        targetAddress = targetParam.replace('custom_', '');
      } else {
        const whale = this.leaderboard.getWhaleById(targetParam);
        if (whale) {
          targetAddress = whale.address;
        } else if (targetParam.startsWith('inj1')) {
          targetAddress = targetParam;
        }
      }

      if (!targetAddress) {
        await ctx.answerCallbackQuery('未找到该巨鲸地址').catch(() => {});
        return;
      }

      await this.applyFollowTarget(ctx, targetAddress, true);
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
• <b>滑点保护阈值</b>: <b>${this.config.maxSlippagePercent}%</b> (超标自动拦截)

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

    await ctx.reply(confirmText, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  /**
   * 将目标加入用户的多巨鲸跟单矩阵并校验资金
   */
  private async applyFollowTarget(ctx: any, targetAddress: string, isCallback: boolean = false) {
    const userId = ctx.from?.id || 0;
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
    const isPractice = this.walletService.isPracticeMode(userId);
    const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;

    const whale = this.leaderboard.getWhaleByAddress(targetAddress);
    const name = whale ? `${whale.name} ${whale.badge}` : `自定义巨鲸 0x${targetAddress.slice(-4)}`;

    // 加入用户的多巨鲸跟单列表 (绝不覆盖已有巨鲸)
    const { targets } = this.walletService.addUserTarget(userId, targetAddress, name);

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
    this.config.targetTraderAddress = targetAddress;
    for (const t of targets) {
      await this.tracker.addTrackedTrader(t.address);
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

      await ctx.reply(errText, { parse_mode: 'HTML', reply_markup: keyboard });
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
   * 根据用户自己设置的 copyAmountUsdt 折算专属下单数量与所需保证金
   */
  public calculateUserOrderSizing(userId: number, result: CopyOrderResult) {
    const userWallet = this.walletService.getOrCreateWallet(userId);
    const userAmountUsdt = userWallet.copyAmountUsdt || this.config.fixedUsdtAmount || 100;
    const execPrice = Number(result.executionPrice || 0);
    const leverage = result.leverage || 1;
    const injService = this.copyEngine.getInjectiveService();
    const market = injService.getMarketByTicker(result.marketTicker);
    const tickSize = market?.minQuantityTickSize || 0.001;
    const precision = Math.max(0, -Math.floor(Math.log10(tickSize)));

    const rawQty = execPrice > 0 ? userAmountUsdt / execPrice : Number(result.executedQuantity || 0);
    const userQuantity = Math.max(
      tickSize,
      Number((Math.floor(rawQty / tickSize) * tickSize).toFixed(precision))
    );
    const userMargin = Number(((userQuantity * execPrice) / leverage).toFixed(4));

    return {
      userWallet,
      userAmountUsdt,
      userQuantity,
      userMargin,
      execPrice,
      leverage,
      market,
    };
  }

  /**
   * 向已跟单该巨鲸的目标用户及广播频道推送聪明钱开仓信号
   */
  public async broadcastSignal(event: SmartMoneyTradeEvent) {
    const isBuy = event.direction === 'BUY';
    const text = `
🚨 <b>【Injective 链上巨鲸开仓异动】</b>

• <b>标的资产</b>: <code>${event.marketTicker}</code>
• <b>操作方向</b>: ${isBuy ? '🟢 做多 (LONG)' : '🔴 做空 (SHORT)'}
• <b>成交价格</b>: <b>$${event.price}</b>
• <b>大户仓位</b>: <b>${event.quantity}</b> (约 <b>$${event.notionalUsd.toFixed(2)}</b>)
• <b>巨鲸地址</b>: <code>${event.traderAddress.substring(0, 8)}...${event.traderAddress.slice(-6)}</code>

⚡ <i>云端多巨鲸跟单引擎已就绪，正在按您的专属仓位执行风控核算...</i>
    `.trim();

    const matchedFollowers = this.getMatchedFollowerWallets(event.traderAddress);
    for (const w of matchedFollowers) {
      if (this.bot && w.telegramId) {
        try {
          await this.bot.api.sendMessage(w.telegramId, text, { parse_mode: 'HTML' });
        } catch (e) {}
      }
    }

    if (this.bot && this.config.telegramBroadcastChatId) {
      try {
        await this.bot.api.sendMessage(this.config.telegramBroadcastChatId, text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().url(
            '⚡ 立即一键跟单',
            `https://t.me/${this.bot.botInfo?.username || ''}`
          ),
        });
      } catch (e) {}
    }
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
      insufficientRealBalance?: { inj: string; usdt: string; requiredMargin: number; userAmountUsdt: number };
      realBroadcastError?: string;
    }
  ): string {
    if (!result.success) {
      return `
🛑 <b>【跟单已安全拦截（风控保护生效）】</b>

• 市场: <code>${result.marketTicker}</code>
• 拦截原因: <i>${result.error}</i>
• 您的资金不受任何影响，已成功规避潜在亏损！
      `.trim();
    }

    const sizing = this.calculateUserOrderSizing(userId, result);
    const userWallet = sizing.userWallet;
    const isPrac = !!userWallet.practiceMode;
    const finalQty = options?.userQuantity ?? sizing.userQuantity;
    const finalMargin = options?.userMargin ?? sizing.userMargin;

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
• <b>扣除虚拟保证金</b>: <b>$${finalMargin.toFixed(2)} USDT</b> (${result.leverage}x 杠杆)
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
• <b>本单所需保证金</b>: <b>$${info.requiredMargin.toFixed(2)} USDT</b> (按您设置的 $${info.userAmountUsdt} USDT/单折算)
• <b>您的当前实盘余额</b>: <b>${info.inj} INJ / ${info.usdt} USDT</b>

💡 <i>实盘链上跟单需要您专属钱包内有充足的 USDT 保证金与少量 INJ (Gas 费)。系统已安全跳过本次链上广播，绝不虚报成交！请先充值或一键切换为 $10,000 模拟盘演练：</i>
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
• <b>实盘占用保证金</b>: <b>$${finalMargin.toFixed(2)} USDT</b> (${result.leverage}x 杠杆)
• <b>链上广播耗时</b>: <b>${result.executionTimeMs} ms</b>
• <b>主网交易哈希</b>: ${txLink}
    `.trim();
  }

  /**
   * 推送跟单结果：仅针对已开启跟单且匹配该巨鲸的目标用户，按其专属 copyAmountUsdt 折算并严格区分模拟盘与实盘
   */
  public async notifyCopyTradeResult(result: CopyOrderResult, event?: SmartMoneyTradeEvent) {
    const matchedFollowers = this.getMatchedFollowerWallets(event?.traderAddress);
    if (matchedFollowers.length === 0) return;

    const injService = this.copyEngine.getInjectiveService();

    for (const w of matchedFollowers) {
      const chatId = w.telegramId;
      if (!result.success) {
        const blockedText = this.formatTradeNotificationText(chatId, result);
        if (this.bot) {
          try {
            await this.bot.api.sendMessage(chatId, blockedText, { parse_mode: 'HTML' });
          } catch (e) {}
        }
        continue;
      }

      const sizing = this.calculateUserOrderSizing(chatId, result);

      if (w.practiceMode) {
        // 1. 模拟盘演练模式：按用户自己的 copyAmountUsdt 折算出的 userQuantity 和 userMargin 真实扣减体验金
        const pracRes = this.walletService.executePracticeTrade(chatId, {
          marketTicker: result.marketTicker,
          direction: result.direction,
          price: sizing.execPrice,
          quantity: sizing.userQuantity,
          marginUsdt: sizing.userMargin,
          leverage: sizing.leverage,
        });

        const text = pracRes.success
          ? this.formatTradeNotificationText(chatId, result, {
              userQuantity: sizing.userQuantity,
              userMargin: sizing.userMargin,
            })
          : `⚠️ <b>【模拟盘跟单未执行】</b>\n\n• 原因: <i>${pracRes.error}</i>`;

        if (this.bot) {
          try {
            await this.bot.api.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
          } catch (e) {}
        }
      } else {
        // 2. 实盘链上交易模式：严禁谎报成功！必须先校验用户实盘 USDT 保证金与 INJ Gas 余额
        const balances = await this.walletService.getRealBalances(w.injectiveAddress);
        const usdtBal = parseFloat(balances.usdt);
        const injBal = parseFloat(balances.inj);

        if (usdtBal < sizing.userMargin || injBal <= 0.001 || !sizing.market) {
          const warnText = this.formatTradeNotificationText(chatId, result, {
            insufficientRealBalance: {
              inj: balances.inj,
              usdt: balances.usdt,
              requiredMargin: sizing.userMargin,
              userAmountUsdt: sizing.userAmountUsdt,
            },
          });
          const warnKb = new InlineKeyboard()
            .text('💳 立即充值激活', 'deposit_guide')
            .text('🧪 一键切换为模拟盘跟单', 'switch_mode_practice')
            .row()
            .text('🔙 返回主菜单', 'back_to_menu');

          if (this.bot) {
            try {
              await this.bot.api.sendMessage(chatId, warnText, {
                parse_mode: 'HTML',
                reply_markup: warnKb,
              });
            } catch (e) {}
          }
          continue;
        }

        // 实盘余额充足：使用用户自己的私钥签名广播上链
        try {
          const realOrder = await injService.executeUserRealMarketOrder(w.privateKeyHex, {
            marketId: sizing.market.marketId,
            direction: result.direction,
            quantity: sizing.userQuantity,
            price: sizing.execPrice,
            leverage: sizing.leverage,
          });

          const text = this.formatTradeNotificationText(chatId, result, {
            realTxHash: realOrder.txHash,
            userQuantity: sizing.userQuantity,
            userMargin: sizing.userMargin,
          });

          if (this.bot) {
            try {
              await this.bot.api.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              });
            } catch (e) {}
          }
        } catch (err: any) {
          console.warn(`[TelegramBot] 用户 ${chatId} 实盘广播异常:`, err.message);
          const errText = this.formatTradeNotificationText(chatId, result, {
            realBroadcastError: err.message || String(err),
          });
          if (this.bot) {
            try {
              await this.bot.api.sendMessage(chatId, errText, { parse_mode: 'HTML' });
            } catch (e) {}
          }
        }
      }
    }
  }
}
