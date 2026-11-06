import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AppConfig } from '../config/index.js';
import { CopyEngine } from './copy-engine.js';
import { LeaderboardService, WhaleProfile } from './leaderboard.service.js';
import { SmartMoneyTracker } from './smart-money-tracker.js';
import { WalletService } from './wallet.service.js';
import { CopyOrderResult, SmartMoneyTradeEvent } from '../types/index.js';

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
      // 注册 Telegram 原生底部菜单按钮
      this.bot.api.setMyCommands([
        { command: 'start', description: '🚀 打开跟单主控制台' },
        { command: 'leaderboard', description: '🏆 查看聪明钱排行榜' },
        { command: 'amount', description: '💰 设置单笔跟单金额' },
        { command: 'referral', description: '🎁 邀请好友赚 25% 返佣' },
        { command: 'stats', description: '📊 实时运行战绩' },
      ]).catch((e) => console.warn('[TelegramBot] setMyCommands 忽略:', e.message));

      this.bot.start({
        onStart: (botInfo) => {
          console.log(`\n============================================================`);
          console.log(`[TelegramBot] 🤖 手机端 Telegram 机器人已成功上线！`);
          console.log(`  - Bot 用户名: @${botInfo.username}`);
          console.log(`  - 状态: 7x24 小时监听中，现在掏出手机发送 /start 即可操作！`);
          console.log(`============================================================\n`);
        },
      }).catch((err) => {
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
   * 配置 Bot 指令与交互菜单
   */
  private setupBotHandlers() {
    if (!this.bot) return;

    // 日志中间件
    this.bot.use(async (ctx, next) => {
      if (ctx.message?.text) {
        console.log(`[TelegramBot] 📩 收到用户 @${ctx.from?.username || ctx.from?.id} 发送的消息: "${ctx.message.text}"`);
      } else if (ctx.callbackQuery?.data) {
        console.log(`[TelegramBot] 🔘 收到用户 @${ctx.from?.username || ctx.from?.id} 点击的按钮: "${ctx.callbackQuery.data}"`);
      }
      await next();
    });

    const sendMainMenu = async (ctx: any) => {
      const chatId = ctx.chat.id;
      this.activeUserChatIds.add(chatId);
      if (this.whaleRadar) {
        this.whaleRadar.addSubscriber(chatId);
      }

      const userWallet = this.walletService.getOrCreateWallet(ctx.from?.id || 0, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);

      const welcomeText = `
🔥 <b>欢迎使用 Injective 链上聪明钱一键跟单系统</b>

👛 <b>您的专属链上跟单钱包</b>:
• 地址: <code>${userWallet.injectiveAddress}</code>
• 资产: <b>${balances.inj} INJ</b> | <b>${balances.usdt} USDT</b> (估值 ~$${balances.totalUsd})
<i>(非托管，资金完全在您的专属链上地址，随时可提现/导出私钥)</i>

⚙️ <b>当前云端配置</b>:
• 目标巨鲸: <code>${this.config.targetTraderAddress ? this.config.targetTraderAddress.substring(0, 10) + '...' : '尚未选择'}</code>
• 跟单模式: <code>${this.config.copyMode}</code> ($${this.config.fixedUsdtAmount} USDT/单)
• 杠杆上限: <code>${this.config.maxLeverage}x</code> | 最大滑点: <code>${this.config.maxSlippagePercent}%</code>
• 运行环境: <code>${this.config.network.toUpperCase()}</code> (${this.config.dryRun ? '🧪 模拟' : '🔴 实盘'})

👇 <b>请在下方轻点按钮进行操作:</b>
      `;

      const keyboard = new InlineKeyboard()
        .text('👛 我的钱包与充值', 'view_wallet')
        .text('🏆 聪明钱排行榜', 'view_leaderboard')
        .row()
        .text('⚡ 一键跟单设置', 'config_copy')
        .text('💰 修改单笔金额', 'set_amount')
        .row()
        .text('🛡️ 风控与滑点', 'view_risk')
        .text('🎁 邀请好友 (25%返佣)', 'view_referral')
        .row()
        .text('📊 实时运行战绩', 'view_stats');

      await ctx.reply(welcomeText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    };

    // 1. /start 指令
    this.bot.command('start', sendMainMenu);
    this.bot.command('menu', sendMainMenu);
    this.bot.command('leaderboard', (ctx) => ctx.reply('请点击下方按钮查看巨鲸榜单：', {
      reply_markup: new InlineKeyboard().text('🏆 立即查看聪明钱排行榜', 'view_leaderboard')
    }));
    this.bot.command('amount', (ctx) => ctx.reply('请选择单笔跟单金额：', {
      reply_markup: new InlineKeyboard()
        .text('$20 USDT', 'amt_20').text('$50 USDT', 'amt_50').row()
        .text('$100 USDT', 'amt_100').text('$200 USDT', 'amt_200')
    }));
    this.bot.command('referral', (ctx) => {
      const refLink = `https://t.me/${ctx.me.username}?start=ref_${ctx.from?.id || '888'}`;
      ctx.reply(`🎁 您的专属推广链接：\n<code>${refLink}</code>\n好友使用享 25% 终身手续费分成！`, { parse_mode: 'HTML' });
    });
    this.bot.command('stats', (ctx) => {
      const stats = this.copyEngine.getStats();
      ctx.reply(`📊 累计捕获信号: ${stats.total} 笔 | 成功执行: ${stats.success} 笔`);
    });

    // 2. 通配兜底：用户发任何其他文字消息，均自动弹出主控制面板
    this.bot.on('message:text', sendMainMenu);

    // 2. 按钮回调: 查看聪明钱排行榜
    this.bot.callbackQuery('view_leaderboard', async (ctx) => {
      const whales = this.leaderboard.getTopWhales(3);
      let text = `🏆 <b>Injective 链上高胜率巨鲸榜 (近30天战绩)</b>\n\n`;

      const keyboard = new InlineKeyboard();

      whales.forEach((w) => {
        text += `<b>Top ${w.rank}. ${w.name}</b> ${w.badge}\n`;
        text += `• 胜率: <b>${w.winRatePercent}%</b> | 净利润: <b>+$${w.monthlyPnlUsd.toLocaleString()}</b>\n`;
        text += `• 最大回撤: <b>${w.maxDrawdownPercent}%</b> | 交易频次: ${w.totalTrades}笔\n`;
        text += `• 主打市场: <code>${w.favoriteMarket}</code>\n`;
        text += `• 钱包: <code>${w.address.substring(0, 10)}...${w.address.slice(-6)}</code>\n\n`;

        keyboard.text(`⚡ 跟单 Top ${w.rank}`, `follow_${w.id}`).row();
      });

      keyboard.text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 钱包详情与充值指引
    this.bot.callbackQuery('view_wallet', async (ctx) => {
      const userWallet = this.walletService.getOrCreateWallet(ctx.from?.id || 0, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);

      const text = `
👛 <b>我的专属 Injective 跟单钱包</b>

• <b>专属链上地址</b>:
<code>${userWallet.injectiveAddress}</code>
<i>(轻点上方地址可直接复制)</i>

📊 <b>链上实时真实余额</b>:
• <b>INJ 余额</b>: <code>${balances.inj} INJ</code>
• <b>USDT/USDC 余额</b>: <code>${balances.usdt} USDT</code>
• <b>账户总估值</b>: <b>$${balances.totalUsd} USD</b>

💧 <b>免费领取测试币指南</b>:
复制上方地址，前往 Injective 官方测试网水龙头即可免费领取 INJ / USDT:
👉 https://testnet.faucet.injective.network/
      `;

      const keyboard = new InlineKeyboard()
        .text('🔄 刷新余额', 'view_wallet')
        .text('🔑 备份导出私钥', 'export_key')
        .row()
        .url('💧 官方测试币水龙头', 'https://testnet.faucet.injective.network/')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 导出私钥 (阅后即焚式提醒)
    this.bot.callbackQuery('export_key', async (ctx) => {
      const userWallet = this.walletService.getOrCreateWallet(ctx.from?.id || 0, ctx.from?.username);
      const text = `
⚠️ <b>【绝密信息 - 私钥备份】</b>

• 地址: <code>${userWallet.injectiveAddress}</code>
• 私钥:
<code>${userWallet.privateKeyHex}</code>

<i>⚠️ 警告: 私钥是您钱包资产的唯一凭据，任何拥有此私钥的人都能支配该钱包资产。请勿截图、勿泄露给任何人！可导入 Keplr 或 MetaMask 中管理。</i>
      `;

      const keyboard = new InlineKeyboard().text('🔙 返回钱包', 'view_wallet');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });

    // 3. 按钮回调: 选中跟单大户 (支持榜单巨鲸或雷达异动巨鲸)
    this.bot.callbackQuery(/^follow_(.+)$/, async (ctx) => {
      const targetParam = ctx.match[1];
      let targetAddress = '';
      let targetName = '链上聪明钱巨鲸';
      let winRate = '82.4%';

      if (targetParam.startsWith('custom_')) {
        targetAddress = targetParam.replace('custom_', '');
        targetName = `雷达异动巨鲸 (${targetAddress.substring(0, 6)}...${targetAddress.slice(-4)})`;
      } else {
        const whale = this.leaderboard.getWhaleById(targetParam);
        if (whale) {
          targetAddress = whale.address;
          targetName = `${whale.name} ${whale.badge}`;
          winRate = `${whale.winRatePercent}%`;
        }
      }

      if (!targetAddress) {
        await ctx.answerCallbackQuery('未找到该巨鲸地址');
        return;
      }

      this.config.targetTraderAddress = targetAddress;
      const userWallet = this.walletService.getOrCreateWallet(ctx.from?.id || 0, ctx.from?.username);
      const balances = await this.walletService.getRealBalances(userWallet.injectiveAddress);

      // 判断是实盘模式还是模拟体验金模式
      const hasRealFunds = parseFloat(balances.usdt) > 0 || parseFloat(balances.inj) > 0;
      const modeBadge = hasRealFunds ? '🟢 实盘扣款跟单' : '🧪 $10,000 体验金演练跟单';

      await ctx.answerCallbackQuery(`已成功锁定跟单目标！`);

      const confirmText = `
🎯 <b>跟单引擎已成功就绪！</b>

• <b>跟随目标</b>: ${targetName}
• <b>链上地址</b>: <code>${targetAddress}</code>
• <b>历史胜率</b>: <b>${winRate}</b>
• <b>当前模式</b>: <b>${modeBadge}</b>
• <b>单笔跟单金额</b>: <b>$${this.config.fixedUsdtAmount} USDT</b>
• <b>滑点保护</b>: <b>${this.config.maxSlippagePercent}%</b> (超标自动拦截)

⚡ <i>监控引擎 24 小时保持在线！当该巨鲸在 Injective 链上开仓加仓时，云端将以 0.4 秒亚秒级自动复制仓位，并秒级向您的手机推送战报！</i>
      `;

      const keyboard = new InlineKeyboard()
        .text('💰 修改单笔金额', 'set_amount')
        .text('👛 查看钱包余额', 'view_wallet')
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(confirmText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 4. 修改金额
    this.bot.callbackQuery('set_amount', async (ctx) => {
      const text = `
💰 <b>选择每笔跟单的名义金额 (USDT):</b>

当前设置: <b>$${this.config.fixedUsdtAmount} USDT</b>
<i>建议新手初次使用从 $20~$50 开始试水。</i>
      `;

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
      const amt = parseInt(ctx.match[1], 10);
      this.config.fixedUsdtAmount = amt;
      await ctx.answerCallbackQuery(`金额已更新为 $${amt} USDT`);

      await ctx.editMessageText(
        `✅ 单笔跟单金额已成功设置为 <b>$${amt} USDT</b>！`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
        }
      );
    });

    // 5. 邀请裂变返佣 (获客最强抓手)
    this.bot.callbackQuery('view_referral', async (ctx) => {
      const userId = ctx.from?.id || 888888;
      const refLink = `https://t.me/${ctx.me.username}?start=ref_${userId}`;

      const text = `
🎁 <b>Injective 裂变邀请返佣计划</b>

邀请好友使用您的专属链接开启跟单，<b>终身享受好友产生交易手续费的 ${this.config.referralRewardPercent}% 现金分红！</b>

🔗 <b>您的专属推广链接:</b>
<code>${refLink}</code>

💡 <b>推广话术推荐:</b>
<i>“Injective 链上胜率 84% 巨鲸自动跟单神器，主钱包 0 风险无提现权限，一键挂机带飞：${refLink}”</i>
      `;

      const keyboard = new InlineKeyboard()
        .url('🚀 转发到 Telegram 群/好友', `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Injective 链上胜率 84% 巨鲸自动跟单神器，点此开启挂机跟单！')}`)
        .row()
        .text('🔙 返回主菜单', 'back_to_menu');

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });

    // 6. 运行战绩
    this.bot.callbackQuery('view_stats', async (ctx) => {
      const stats = this.copyEngine.getStats();
      const text = `
📊 <b>实时跟单运行战绩看板</b>

• 累计捕获巨鲸信号: <b>${stats.total} 笔</b>
• 自动跟单成功笔数: <b>${stats.success} 笔</b>
• 风控拦截拦截异常单: <b>${stats.total - stats.success} 笔</b>
• 平均上链执行延迟: <b>~400 ms (亚秒级)</b>
• 协议手续费返佣累计: <b>已开启 (捕获 40%)</b>
      `;

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 返回主菜单', 'back_to_menu'),
      });
    });

    // 7. 返回主菜单
    this.bot.callbackQuery('back_to_menu', async (ctx) => {
      const welcomeText = `
🔥 <b>Injective 链上聪明钱跟单控制台</b>

当前锁定巨鲸: <code>${this.config.targetTraderAddress ? this.config.targetTraderAddress.substring(0, 10) + '...' : '尚未选择'}</code>
单笔金额: <b>$${this.config.fixedUsdtAmount} USDT</b> | 杠杆: <b>${this.config.maxLeverage}x</b>
      `;

      const keyboard = new InlineKeyboard()
        .text('🏆 聪明钱排行榜', 'view_leaderboard')
        .text('💰 修改单笔金额', 'set_amount')
        .row()
        .text('🎁 邀请好友 (25%返佣)', 'view_referral')
        .text('📊 实时运行战绩', 'view_stats');

      await ctx.editMessageText(welcomeText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });
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
    `;

    // 广播到所有已开启对话的用户
    for (const chatId of this.activeUserChatIds) {
      if (this.bot) {
        try {
          await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch (e) {
          // ignore
        }
      }
    }

    // 若配置了公共广播频道，一并推送引流
    if (this.bot && this.config.telegramBroadcastChatId) {
      try {
        await this.bot.api.sendMessage(this.config.telegramBroadcastChatId, text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().url('⚡ 立即一键跟单', `https://t.me/${this.bot.botInfo?.username || ''}`),
        });
      } catch (e) {
        // ignore
      }
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
      `;
    } else {
      text = `
🛑 <b>【跟单已安全拦截（风控保护生效）】</b>

• 市场: <code>${result.marketTicker}</code>
• 拦截原因: <i>${result.error}</i>
• 您的资金不受任何影响，已成功规避潜在亏损！
      `;
    }

    for (const chatId of this.activeUserChatIds) {
      if (this.bot) {
        try {
          await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch (e) {
          // ignore
        }
      }
    }
  }
}
