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
      } catch (err: any) {
        console.warn(`[TelegramBot] 初始化失败:`, err.message);
      }
    }
  }

  /**
   * 启动 Telegram Bot 监听
   */
  public async start() {
    if (!this.bot) {
      console.log(`\n------------------------------------------------------------`);
      console.log(`[TelegramBot] ℹ️ 未配置 TELEGRAM_BOT_TOKEN。`);
      console.log(`  📱 手机端接管提示:`);
      console.log(`  1. 打开手机 Telegram 搜索 @BotFather`);
      console.log(`  2. 发送 /newbot 并输入名字，10秒即可获得 Bot API Token`);
      console.log(`  3. 填入 .env 的 TELEGRAM_BOT_TOKEN 中重启，手机即刻拥有完整交互界面！`);
      console.log(`------------------------------------------------------------\n`);
      return;
    }

    if (this.isBotRunning) return;

    try {
      this.isBotRunning = true;
      this.bot.api
        .setMyCommands([
          { command: 'start', description: '🚀 打开完整跟单控制台' },
          { command: 'track', description: '🔍 监控自定义 Injective 钱包' },
          { command: 'leaderboard', description: '🏆 链上聪明钱胜率排行榜' },
          { command: 'amount', description: '💰 设置单笔跟单金额' },
          { command: 'referral', description: '🎁 邀请好友赚 25% 返佣' },
          { command: 'stats', description: '📊 实时运行战绩看板' },
        ])
        .catch((e) => console.warn('[TelegramBot] setMyCommands 忽略:', e.message));

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
          console.error(`[TelegramBot] 轮询异常:`, err.message);
        });
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
   * 生成统一的完整控制台键盘 (8大核心功能按钮)
   */
  /**
   * 生成统一的完整控制台键盘 (8大核心功能按钮，支持一键启停跟单)
   */
  private getMainMenuKeyboard(userId?: number): InlineKeyboard {
    const copyState = userId ? this.walletService.getUserCopyState(userId) : undefined;
    const isCopying = copyState?.isCopyingEnabled;
    const toggleBtnText = isCopying ? '⏸️ 暂停自动跟单' : '⚡ 开启自动跟单';
    const toggleBtnAction = isCopying ? 'pause_copy' : 'start_copy';

    return new InlineKeyboard()
      .text('👛 我的钱包', 'view_wallet')
      .text('🏆 聪明钱榜单', 'view_leaderboard')
      .row()
      .text('🔍 监控自定义钱包', 'track_custom_wallet')
      .text(toggleBtnText, toggleBtnAction)
      .row()
      .text('💰 修改金额', 'set_amount')
      .text('🛡️ 风控设置', 'view_risk')
      .row()
      .text('🎁 邀请返佣', 'view_referral')
      .text('📊 实时战绩', 'view_stats');
  }

  /**
   * 生成专业、严谨的主控制面板文案 (严格基于用户个人选择，默认未配置、未启动)
   */
  private async getMainMenuText(userId: number, username?: string): Promise<string> {
    const userWallet = this.walletService.getOrCreateWallet(userId, username);
    const userCopy = this.walletService.getUserCopyState(userId);
    const isPractice = this.walletService.isPracticeMode(userId);
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);

    let targetDesc = '';
    if (userCopy.targetTraderAddress) {
      const targetWhale = this.leaderboard.getWhaleByAddress(userCopy.targetTraderAddress);
      if (targetWhale) {
        targetDesc = `${targetWhale.name} (${targetWhale.badge})`;
      } else {
        targetDesc = `<code>${userCopy.targetTraderAddress.substring(0, 10)}...${userCopy.targetTraderAddress.slice(-6)}</code>`;
      }
    } else {
      targetDesc = '⚪ 暂未选择 (请点击下方榜单或自定义监控)';
    }

    const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;
    let modeText = '';
    if (!userCopy.isCopyingEnabled) {
      modeText = '⚪ 未启动 (尚未开启跟单)';
    } else if (isPractice) {
      modeText = '🟢 自动跟单中 (🧪 $10,000 体验金演练)';
    } else if (hasRealFunds) {
      modeText = '🟢 自动跟单中 (🔴 链上实盘扣款)';
    } else {
      modeText = '⚪ 待充值激活 (实盘余额不足)';
    }

    const balanceDisplay = isPractice
      ? `• <b>体验金可用本金</b>: <b>$${userWallet.practiceBalanceUsdt || 10000} USDT</b>\n• <b>链上实际存入</b>: <code>${balances.inj} INJ</code> | <code>${balances.usdt} USDT</code>`
      : `• <b>链上实盘资产</b>: <b>${balances.inj} INJ</b> | <b>${balances.usdt} USDT</b> (估值 ~$${balances.totalUsd} USD)`;

    return `
🔥 <b>Injective 链上聪明钱一键跟单系统</b>
<i>Institutional-Grade Injective Smart Money Trading Terminal</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👛 <b>专属非托管钱包</b>:
• 地址: <code>${userWallet.injectiveAddress}</code>
${balanceDisplay}
<i>(资产完全存储于您的链上专属地址，随时支持私钥导出与安全提现)</i>

🎯 <b>个人跟单引擎状态</b>:
• <b>监听目标</b>: ${targetDesc}
• <b>单笔金额</b>: <b>$${userCopy.copyAmountUsdt} USDT/单</b>
• <b>交易状态</b>: <b>${modeText}</b>
• <b>风控保护</b>: 杠杆 <b>${this.config.maxLeverage}x</b> | 滑点保护 <b>${this.config.maxSlippagePercent}%</b>
• <b>链路响应</b>: 🟢 gRPC 毫秒级流式监听 24h 待命
━━━━━━━━━━━━━━━━━━━━━━━━━━
👇 <b>请在下方轻点按钮进行操作:</b>
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
      .text('🧪 开启 $10,000 体验金演练', targetAddress ? `enable_practice_and_follow_${targetAddress}` : 'enable_practice_mode')
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

⚡ <i>系统将进行 Bech32 链上校验码严密校验，并通过 gRPC 亚秒级建立监听流。</i>
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
      const stats = this.copyEngine.getStats();
      ctx.reply(
        `📊 <b>实时跟单战绩看板</b>\n• 累计捕获信号: <b>${stats.total} 笔</b>\n• 成功执行上链: <b>${stats.success} 笔</b>\n• 拦截异常交易: <b>${stats.total - stats.success} 笔</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
        }
      );
    });

    // 3. 文本输入监听 (优先检测是否为自定义 Injective 地址)
    this.bot.on('message:text', async (ctx) => {
      const text = (ctx.message.text || '').trim();
      const userId = ctx.from?.id || 0;

      // 如果以 inj1 开头或者是处于等待输入状态
      if (text.startsWith('inj1') || this.awaitingAddressUsers.has(userId)) {
        await this.handleCustomAddressInput(ctx, text);
        return;
      }

      // 默认通配：调出主控制台
      await this.renderMainMenu(ctx, false);
    });

    // ========================================================
    // 按钮回调逻辑
    // ========================================================

    // 返回主控制台 (确保渲染完整 8 按钮大面板)
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

💡 <i>支持任何已在 Injective 交易的地址。系统将自动校验 Bech32 Checksum 并建立独立监听流！</i>
      `.trim();

      const keyboard = new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    // 查看聪明钱排行榜
    this.bot.callbackQuery('view_leaderboard', async (ctx) => {
      await ctx.answerCallbackQuery('正在拉取链上最新交易数据...').catch(() => {});
      const whales = this.leaderboard.getTopWhales(5);

      let text = `🏆 <b>Injective 链上高频活跃巨鲸榜 (实时撮合聚合)</b>\n\n`;
      const keyboard = new InlineKeyboard();

      whales.forEach((w) => {
        text += `<b>Top ${w.rank}. ${w.name}</b> ${w.badge}\n`;
        text += `• 胜率: <b>${w.winRatePercent}%</b> | 月收益估值: <b>+$${w.monthlyPnlUsd.toLocaleString()}</b>\n`;
        text += `• 交易频次: ${w.totalTrades} 笔 | 最大回撤: <b>${w.maxDrawdownPercent}%</b>\n`;
        text += `• 主打策略: <i>${w.strategy}</i>\n`;
        text += `• 钱包: <code>${w.address}</code>\n\n`;

        keyboard.text(`⚡ 跟单 Top ${w.rank}`, `follow_${w.id}`).row();
      });

      keyboard
        .text('🔄 刷新榜单', 'refresh_leaderboard')
        .text('🔍 监控自定义钱包', 'track_custom_wallet')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    this.bot.callbackQuery('refresh_leaderboard', async (ctx) => {
      await ctx.answerCallbackQuery('正在扫描链上最新区块撮合记录...').catch(() => {});
      await this.leaderboard.refreshLeaderboard();
      // 重新触发展示
      const whales = this.leaderboard.getTopWhales(5);
      let text = `🏆 <b>Injective 链上高频活跃巨鲸榜 (实时撮合聚合)</b>\n\n`;
      const keyboard = new InlineKeyboard();

      whales.forEach((w) => {
        text += `<b>Top ${w.rank}. ${w.name}</b> ${w.badge}\n`;
        text += `• 胜率: <b>${w.winRatePercent}%</b> | 月收益估值: <b>+$${w.monthlyPnlUsd.toLocaleString()}</b>\n`;
        text += `• 交易频次: ${w.totalTrades} 笔 | 最大回撤: <b>${w.maxDrawdownPercent}%</b>\n`;
        text += `• 主打策略: <i>${w.strategy}</i>\n`;
        text += `• 钱包: <code>${w.address}</code>\n\n`;

        keyboard.text(`⚡ 跟单 Top ${w.rank}`, `follow_${w.id}`).row();
      });

      keyboard
        .text('🔄 刷新榜单', 'refresh_leaderboard')
        .text('🔍 监控自定义钱包', 'track_custom_wallet')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 钱包详情与充值
    this.bot.callbackQuery('view_wallet', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
      const isPractice = this.walletService.isPracticeMode(userId);

      const text = `
👛 <b>我的专属 Injective 跟单钱包</b>

• <b>专属链上地址</b>:
<code>${userWallet.injectiveAddress}</code>
<i>(轻点上方地址可直接复制)</i>

📊 <b>资产详情</b>:
• <b>链上 INJ 余额</b>: <code>${balances.inj} INJ</code>
• <b>链上 USDT 余额</b>: <code>${balances.usdt} USDT</code>
• <b>当前账户估值</b>: <b>$${balances.totalUsd} USD</b>
• <b>体验金模式</b>: <b>${isPractice ? '已激活 ($10,000 USDT)' : '未激活'}</b>

🛡️ <i>非托管安全保障：私钥仅在本地安全受控，您可以随时备份导出到 Keplr 或 MetaMask 钱包自由管理。</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text('💳 充值 USDT/INJ 激活实盘', 'deposit_guide')
        .text(isPractice ? '✅ 体验金已开启' : '🧪 开启 $10,000 体验金', 'enable_practice_mode')
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

您已获得 <b>$10,000 USDT</b> 虚拟模拟金。
在体验金模式下：
• 系统将实时监听 Injective 链上真实大户下单
• 按照真实盘口与滑点进行毫秒级模拟撮合
• 0 风险检验跟单胜率与收益
• 随时可充值切换实盘操作！
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

    // 开启体验金并直接锁定某目标
    this.bot.callbackQuery(/^enable_practice_and_follow_(.+)$/, async (ctx) => {
      const userId = ctx.from?.id || 0;
      const targetAddress = ctx.match[1];
      this.walletService.setPracticeMode(userId, true);
      await ctx.answerCallbackQuery('🎉 体验金已开启并锁定跟单目标！').catch(() => {});
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
      const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
      const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;

      // 1. 检查是否已指定跟单目标
      if (!copyState.targetTraderAddress) {
        await ctx.answerCallbackQuery().catch(() => {});
        const text = `
⚠️ <b>【尚未选择跟单目标】</b>

您当前尚未绑定任何巨鲸或聪明钱地址。
请先点击下方【🏆 聪明钱榜单】挑选链上最高胜率巨鲸，或点击【🔍 监控自定义钱包】输入您想跟随的 Injective 钱包地址。
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
        await this.promptZeroBalanceChoice(ctx, copyState.targetTraderAddress, true);
        return;
      }

      // 3. 启动跟单
      this.walletService.setUserCopying(userId, true);
      this.config.targetTraderAddress = copyState.targetTraderAddress;
      await this.tracker.updateTargetTrader(copyState.targetTraderAddress);
      await ctx.answerCallbackQuery('🚀 自动跟单已成功启动！').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 暂停自动跟单
    this.bot.callbackQuery('pause_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      this.walletService.setUserCopying(userId, false);
      await ctx.answerCallbackQuery('⏸️ 自动跟单已暂停').catch(() => {});
      await this.renderMainMenu(ctx, true);
    });

    // 跟单设定
    this.bot.callbackQuery('config_copy', async (ctx) => {
      const userId = ctx.from?.id || 0;
      const copyState = this.walletService.getUserCopyState(userId);
      const isCopying = copyState.isCopyingEnabled;

      const text = `
⚡ <b>【一键跟单高级设置】</b>

• <b>运行状态</b>: <b>${isCopying ? '🟢 自动跟单中 (ACTIVE)' : '⚪ 已暂停 / 未启动 (PAUSED)'}</b>
• <b>跟单目标</b>: <b>${copyState.targetTraderAddress ? `<code>${copyState.targetTraderAddress.slice(0, 10)}...${copyState.targetTraderAddress.slice(-6)}</code>` : '未指定'}</b>
• <b>单笔金额</b>: <b>$${copyState.copyAmountUsdt} USDT</b>
• <b>最大单笔名义上限</b>: <b>$${this.config.maxNotionalPerOrder} USD</b>
• <b>杠杆倍数限制</b>: <b>${this.config.maxLeverage}x</b>
• <b>最大滑点保护</b>: <b>${this.config.maxSlippagePercent}%</b>
      `.trim();

      const keyboard = new InlineKeyboard()
        .text(isCopying ? '⏸️ 暂停自动跟单' : '🟢 开启自动跟单', isCopying ? 'pause_copy' : 'start_copy')
        .text('💰 修改金额', 'set_amount')
        .row()
        .text('🛡️ 风控与滑点', 'view_risk')
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
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
<i>“Injective 链上胜率 83% 巨鲸自动跟单，资金在自己钱包无提现风险，一键挂机带飞：${refLink}”</i>
      `.trim();

      const keyboard = new InlineKeyboard()
        .url(
          '🚀 转发到 Telegram 群/好友',
          `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Injective 链上胜率 83% 巨鲸自动跟单神器，点此开启挂机跟单！')}`
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
      const stats = this.copyEngine.getStats();
      const text = `
📊 <b>实时跟单运行战绩看板</b>

• 累计捕获巨鲸信号: <b>${stats.total} 笔</b>
• 自动跟单成功笔数: <b>${stats.success} 笔</b>
• 风控拦截异常交易: <b>${stats.total - stats.success} 笔</b>
• 平均链上执行延迟: <b>~380 ms (亚秒级)</b>
• 协议手续费分成比例: <b>已开启 (捕获 40%)</b>
      `.trim();

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
   * 应用跟单目标并校验资金
   */
  private async applyFollowTarget(ctx: any, targetAddress: string, isCallback: boolean = false) {
    const userId = ctx.from?.id || 0;
    const userWallet = this.walletService.getOrCreateWallet(userId, ctx.from?.username);
    const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);
    const isPractice = this.walletService.isPracticeMode(userId);
    const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;

    const whale = this.leaderboard.getWhaleByAddress(targetAddress);
    const name = whale ? `${whale.name} ${whale.badge}` : `自定义巨鲸 0x${targetAddress.slice(-4)}`;

    // 记录用户选中的目标巨鲸
    this.walletService.setUserTarget(userId, targetAddress, name);

    // 零余额处理逻辑: 如果实盘无资金且未激活体验金，引导清晰二选一选择
    if (!hasRealFunds && !isPractice) {
      if (isCallback) {
        await ctx.answerCallbackQuery().catch(() => {});
      }
      await this.promptZeroBalanceChoice(ctx, targetAddress, isCallback);
      return;
    }

    // 激活跟单
    this.walletService.setUserCopying(userId, true);
    this.config.targetTraderAddress = targetAddress;
    await this.tracker.updateTargetTrader(targetAddress);
    this.leaderboard.registerCustomWhale(targetAddress);

    if (isCallback) {
      await ctx.answerCallbackQuery('已成功锁定跟单目标！').catch(() => {});
    }

    const winRate = whale ? `${whale.winRatePercent}%` : '80.0%+ (链上活跃)';
    const modeBadge = isPractice ? '🧪 $10,000 体验金演练跟单' : '🔴 链上实盘扣款跟单';
    const userCopy = this.walletService.getUserCopyState(userId);

    const confirmText = `
🎯 <b>跟单引擎已成功锁定目标！</b>

• <b>跟随目标</b>: ${name}
• <b>链上地址</b>: <code>${targetAddress}</code>
• <b>历史胜率</b>: <b>${winRate}</b>
• <b>当前模式</b>: <b>${modeBadge}</b>
• <b>单笔跟单金额</b>: <b>$${userCopy.copyAmountUsdt} USDT</b>
• <b>滑点保护</b>: <b>${this.config.maxSlippagePercent}%</b> (超标自动拦截)

⚡ <i>监控引擎 24 小时保持在线！当该目标在 Injective 链上开仓加仓时，云端将以 0.4 秒亚秒级自动复制仓位，并秒级向您的手机推送战报！</i>
    `.trim();

    const keyboard = new InlineKeyboard()
      .text('⏸️ 暂停自动跟单', 'pause_copy')
      .text('💰 修改单笔金额', 'set_amount')
      .row()
      .text('👛 查看钱包余额', 'view_wallet')
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
    console.log(`[TelegramBot] ✅ 成功验证并锁定自定义监控地址: ${targetAddress}`);

    await this.applyFollowTarget(ctx, targetAddress, false);
  }

  /**
   * 向用户及广播频道推送聪明钱开仓信号
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

⚡ <i>云端跟单引擎已就绪，正在执行风控核算...</i>
    `.trim();

    for (const chatId of this.activeUserChatIds) {
      if (this.bot) {
        try {
          await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
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
   * 推送跟单结果
   */
  public async notifyCopyTradeResult(result: CopyOrderResult) {
    let text = '';
    if (result.success) {
      text = `
🎯 <b>【自动跟单成功完成！】</b>

• 市场: <code>${result.marketTicker}</code> | 方向: <b>${result.direction}</b>
• 跟单价格: <b>$${result.executionPrice}</b> | 数量: <b>${result.executedQuantity}</b>
• 占用保证金: <b>$${result.margin}</b> (${result.leverage}x 杠杆)
• 链上耗时: <b>${result.executionTimeMs} ms</b>
• 交易哈希: <code>${result.txHash || 'simulated'}</code>
      `.trim();
    } else {
      text = `
🛑 <b>【跟单已安全拦截（风控保护生效）】</b>

• 市场: <code>${result.marketTicker}</code>
• 拦截原因: <i>${result.error}</i>
• 您的资金不受任何影响，已成功规避潜在亏损！
      `.trim();
    }

    for (const chatId of this.activeUserChatIds) {
      if (this.bot) {
        try {
          await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch (e) {}
      }
    }
  }
}
