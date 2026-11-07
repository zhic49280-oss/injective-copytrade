import { config, validateConfig } from './config/index.js';
import { InjectiveService } from './services/injective.service.js';
import { RiskManager } from './services/risk-manager.js';
import { SmartMoneyTracker } from './services/smart-money-tracker.js';
import { CopyEngine } from './services/copy-engine.js';
import { LeaderboardService } from './services/leaderboard.service.js';
import { WalletService } from './services/wallet.service.js';
import { WhaleRadarService } from './services/whale-radar.service.js';
import { TelegramBotService } from './services/telegram-bot.service.js';

async function main() {
  console.log(`
========================================================================
  🚀 Injective CopyTrade (MVP + TG Bot) - 链上聪明钱一键跟单系统
========================================================================
  * 网络环境: ${config.network.toUpperCase()}
  * 跟单模式: ${config.copyMode} (${config.copyMode === 'FIXED_AMOUNT' ? `$${config.fixedUsdtAmount} USDT/单` : `${(config.copyRatio * 100).toFixed(1)}% 比例`})
  * 风控阈值: 最大滑点 ${config.maxSlippagePercent}% | 单笔上限 $${config.maxNotionalPerOrder} | 杠杆上限 ${config.maxLeverage}x
  * 模式状态: ${config.dryRun ? '🧪 DRY_RUN (模拟执行模式)' : '🔴 LIVE (真实交易上链)'}
  * TG 机器人: ${config.telegramBotToken ? '📱 已配置' : '⚪ 未配置 (请查看下方指南)'}
========================================================================
  `);

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.warn(`[Config Warning] 检测到配置项提示:`);
    validation.errors.forEach((e) => console.warn(`  ⚠️  ${e}`));
    console.log(`\n提示: 当前将以 DRY_RUN 演示监听模式运行。如需真实上链，请配置 .env 文件。\n`);
  }

  // 1. 初始化 Injective 核心通信服务
  console.log(`[Init] 正在连接 Injective 节点并加载衍生品市场数据...`);
  const injectiveService = new InjectiveService(config);

  try {
    const markets = await injectiveService.loadMarkets();
    console.log(`[Init] ✅ 成功加载 ${markets.size} 个衍生品永续合约市场！`);
    if (injectiveService.followerAddress) {
      console.log(`[Init] 🔑 跟单操作钱包地址: ${injectiveService.followerAddress}`);
      console.log(`[Init] 📦 跟单操作子账户:   ${injectiveService.followerSubaccountId}`);
    }
  } catch (err: any) {
    console.error(`[Init] ❌ 衍生品市场加载失败:`, err.message);
    process.exit(1);
  }

  // 2. 初始化风控、执行引擎、用户钱包服务与巨鲸雷达
  const riskManager = new RiskManager(config);
  const copyEngine = new CopyEngine(config, injectiveService, riskManager);
  const leaderboard = new LeaderboardService(injectiveService.endpoints, config.networkName);
  const walletService = new WalletService(config, injectiveService.endpoints);
  const whaleRadar = new WhaleRadarService(config, injectiveService.endpoints);

  const allMarketIds = Array.from((await injectiveService.loadMarkets()).keys());
  console.log(`[Init] 🏆 正在聚合 Injective 链上真实巨鲸战绩榜单...`);
  await leaderboard.refreshLeaderboard(allMarketIds);
  console.log(`[Init] ✅ 链上聪明钱榜单聚合完成，当前前列大户数: ${leaderboard.getTopWhales().length}`);

  // 3. 初始化聪明钱监听器并恢复所有活跃用户的多巨鲸跟单矩阵
  const tracker = new SmartMoneyTracker(config, injectiveService);
  const activeTargets = walletService.getAllActiveTrackedAddresses();
  for (const addr of activeTargets) {
    await tracker.addTrackedTrader(addr);
  }

  // 4. 初始化并启动 Telegram 手机端机器人服务
  const telegramBot = new TelegramBotService(config, copyEngine, tracker, leaderboard, walletService, whaleRadar);
  await telegramBot.start();
  if (telegramBot.bot) {
    whaleRadar.setBot(telegramBot.bot);
  }
  whaleRadar.setMonitoredMarkets(allMarketIds);
  await whaleRadar.start(6000);

  // 5. 绑定事件：大户交易捕获 -> TG 广播 -> 执行跟单 -> TG 推送结果
  tracker.on('trade', async (event) => {
    try {
      // 手机端/频道实时播报大户异动
      await telegramBot.broadcastSignal(event);

      // 执行自动跟单与风控
      const result = await copyEngine.handleSignal(event);

      // 手机端秒级推送跟单结果 (区分模拟盘演练与用户专属私钥实盘广播)
      await telegramBot.notifyCopyTradeResult(result, event);
    } catch (e: any) {
      console.error(`[Main] 信号处理异常:`, e.message);
    }
  });

  // 6. 启动链上监听
  await tracker.start();

  console.log(`\n👀 系统正在实时监听中... 按 Ctrl+C 可停止程序。\n`);

  // 优雅退出处理
  const shutdown = async () => {
    console.log(`\n[Shutdown] 接收到退出信号，正在关闭监听与连接...`);
    tracker.stop();
    await telegramBot.stop();
    const stats = copyEngine.getStats();
    console.log(`[Shutdown] 本次运行跟单统计: 捕获总单数: ${stats.total}, 成功跟单: ${stats.success}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal Error] 程序运行崩溃:', err);
  process.exit(1);
});
