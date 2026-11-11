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
    if (!config.dryRun && !config.telegramBotToken && (!config.followerPrivateKey || config.followerPrivateKey === 'your_private_key_here')) {
      config.dryRun = true;
      console.log(`\n提示: 未配置私钥且未启用 TG Bot，已自动切换为 DRY_RUN 模拟监听模式。\n`);
    } else if (!config.followerPrivateKey && config.telegramBotToken) {
      console.log(`\n提示: 未配置全局 FOLLOWER_PRIVATE_KEY，系统将以【TG 多用户独立钱包托管模式】运行。\n`);
    }
  }

  // 1. 初始化 Injective 核心通信服务
  console.log(`[Init] 正在连接 Injective 节点并加载衍生品市场数据...`);
  const injectiveService = new InjectiveService(config);

  let allMarketIds: string[] = [];
  try {
    const markets = await injectiveService.loadMarkets();
    allMarketIds = Array.from(markets.keys());
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
  const leaderboard = new LeaderboardService(
    injectiveService.endpoints,
    config.networkName,
    injectiveService.getMarketDecimalsMap()
  );
  const walletService = new WalletService(config, injectiveService.endpoints);
  const whaleRadar = new WhaleRadarService(config, injectiveService.endpoints);

  console.log(`[Init] 🏆 正在聚合 Injective 链上真实巨鲸战绩榜单...`);
  await leaderboard.refreshLeaderboard(allMarketIds);
  console.log(`[Init] ✅ 链上聪明钱榜单聚合完成，当前前列大户数: ${leaderboard.getTopWhales().length}`);

  // 3. 初始化聪明钱监听器并恢复所有活跃用户的多巨鲸跟单矩阵 (含精确子账户索引)
  const tracker = new SmartMoneyTracker(config, injectiveService);
  const activeTargets = walletService.getAllActiveTrackedTargets();
  for (const target of activeTargets) {
    await tracker.addTrackedTrader(target.address, target.subaccountIndex);
  }

  // 4. 初始化并启动 Telegram 手机端机器人服务
  const telegramBot = new TelegramBotService(config, copyEngine, tracker, leaderboard, walletService, whaleRadar);
  await telegramBot.start();
  if (telegramBot.bot) {
    whaleRadar.setBot(telegramBot.bot);
  }
  whaleRadar.setMonitoredMarkets(allMarketIds);
  await whaleRadar.start(6000);

  // 定时刷新排行榜与市场缓存 (每 5 分钟)
  const leaderboardRefreshTimer = setInterval(() => {
    leaderboard.refreshLeaderboard(allMarketIds).catch(() => {});
  }, 5 * 60_000);

  // 5. 绑定事件：大户交易捕获 -> TG 广播 -> 执行跟单 -> TG 推送结果
  tracker.on('trade', async (event) => {
    try {
      await telegramBot.broadcastSignal(event);
      const result = await copyEngine.handleSignal(event);
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
    clearInterval(leaderboardRefreshTimer);
    tracker.stop();
    whaleRadar.stop();
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
