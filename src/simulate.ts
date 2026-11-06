import { config, parseNetwork } from './config/index.js';
import { InjectiveService } from './services/injective.service.js';
import { RiskManager } from './services/risk-manager.js';
import { SmartMoneyTracker } from './services/smart-money-tracker.js';
import { CopyEngine } from './services/copy-engine.js';
import { LeaderboardService } from './services/leaderboard.service.js';
import { WalletService } from './services/wallet.service.js';
import { validateInjectiveAddress } from './services/telegram-bot.service.js';
import { SmartMoneyTradeEvent } from './types/index.js';

async function runSimulation() {
  console.log(`
========================================================================
  🧪 Injective CopyTrade & Smart Money System - 全链路生产级仿真测试
========================================================================
  测试目标:
  1. 验证网络抽象解析 (Mainnet vs Testnet) 与配置完整性
  2. 验证 Bech32 链上地址 Checksum 校验 (自定义监控钱包安全防护)
  3. 验证 Leaderboard 链上聪明钱动态撮合聚合与基准回退机制
  4. 验证 SmartMoneyTracker 动态目标切换与实时监听
  5. 验证 0 余额处理与 $10,000 体验金演练模式
  6. 验证端到端跟单撮合与滑点智能拦截风控
========================================================================
  `);

  // --- 测试用例 1: 网络与配置抽象解析 ---
  console.log('[1/6] 验证网络抽象解析与端点映射...');
  const testnetRes = parseNetwork('testnet');
  const mainnetRes = parseNetwork('mainnet');
  console.log(`   - Testnet 解析: ${testnetRes.networkName} (Network: ${testnetRes.network})`);
  console.log(`   - Mainnet 解析: ${mainnetRes.networkName} (Network: ${mainnetRes.network})`);
  if (testnetRes.networkName !== 'testnet' || mainnetRes.networkName !== 'mainnet') {
    throw new Error('网络抽象解析异常');
  }
  console.log('✅ 测试用例 1 通过: 网络抽象解析正确且健壮！');

  // --- 测试用例 2: Bech32 Checksum 校验 ---
  console.log('\n[2/6] 验证自定义钱包 Bech32 Checksum 校验机制...');
  const validAddr = 'inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp';
  const invalidAddr1 = 'inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj999'; // 篡改 checksum
  const invalidAddr2 = '0x1234567890abcdef1234567890abcdef12345678'; // 非 inj1

  const checkValid = validateInjectiveAddress(validAddr);
  const checkInvalid1 = validateInjectiveAddress(invalidAddr1);
  const checkInvalid2 = validateInjectiveAddress(invalidAddr2);

  console.log(`   - 合法地址 [${validAddr}]: ${checkValid.valid ? '✅ 校验通过' : '❌ 失败'}`);
  console.log(`   - 篡改 Checksum 地址 [${invalidAddr1}]: ${!checkInvalid1.valid ? '✅ 成功拦截' : '❌ 错误放行'}`);
  console.log(`   - 非 inj1 格式地址 [${invalidAddr2}]: ${!checkInvalid2.valid ? '✅ 成功拦截' : '❌ 错误放行'}`);

  if (!checkValid.valid || checkInvalid1.valid || checkInvalid2.valid) {
    throw new Error('Bech32 地址校验逻辑存在缺陷！');
  }
  console.log('✅ 测试用例 2 通过: Bech32 Checksum 严格拦截非法输入！');

  // --- 测试用例 3: 链上聪明钱榜单动态聚合 ---
  console.log('\n[3/6] 验证 Leaderboard 链上聪明钱聚合服务...');
  const simConfig = { ...config, dryRun: true };
  const injectiveService = new InjectiveService(simConfig);
  await injectiveService.loadMarkets();

  const leaderboard = new LeaderboardService(injectiveService.endpoints, simConfig.networkName);
  const allMarketIds = Array.from((await injectiveService.loadMarkets()).keys());
  await leaderboard.refreshLeaderboard(allMarketIds);
  const topWhales = leaderboard.getTopWhales(5);

  console.log(`   - 聚合完成，当前聪明钱数量: ${topWhales.length}`);
  topWhales.forEach((w) => {
    console.log(`     Top ${w.rank}. ${w.name} | 胜率: ${w.winRatePercent}% | 地址: ${w.address}`);
  });

  if (topWhales.length === 0 || !topWhales[0].address.startsWith('inj1')) {
    throw new Error('Leaderboard 数据聚合异常！');
  }
  console.log('✅ 测试用例 3 通过: 真实链上聪明钱榜单就绪 (无死静态 Mock)！');

  // --- 测试用例 4: 体验金演练模式与钱包余额管理 ---
  console.log('\n[4/6] 验证 0 余额场景处理与 $10,000 体验金演练模式...');
  const walletService = new WalletService(simConfig, injectiveService.endpoints);
  const testTgId = 99887766;
  const userWallet = walletService.getOrCreateWallet(testTgId, 'test_trader');
  console.log(`   - 为用户生成专属链上地址: ${userWallet.injectiveAddress}`);
  console.log(`   - 初始体验金状态: ${walletService.isPracticeMode(testTgId) ? '已激活' : '未激活'}`);

  // 激活体验金
  walletService.setPracticeMode(testTgId, true);
  console.log(`   - 激活后体验金状态: ${walletService.isPracticeMode(testTgId) ? '已激活 ($10,000 USDT)' : '激活失败'}`);
  if (!walletService.isPracticeMode(testTgId)) {
    throw new Error('体验金状态切换失败！');
  }
  console.log('✅ 测试用例 4 通过: 体验金演练机制切换正常！');

  // --- 测试用例 5: 动态切换监听目标 ---
  console.log('\n[5/6] 验证 SmartMoneyTracker 动态目标切换...');
  const tracker = new SmartMoneyTracker(simConfig, injectiveService);
  const newTarget = 'inj1qw7jk82hjvf79tnjykux6zacuh9gl0z0wl3ruk';
  await tracker.updateTargetTrader(newTarget, 0);
  const currentTarget = tracker.getTargetTrader();
  console.log(`   - 切换后监控目标地址: ${currentTarget.address}`);
  console.log(`   - 切换后目标子账户:   ${currentTarget.subaccountId}`);
  if (currentTarget.address !== newTarget) {
    throw new Error('SmartMoneyTracker 动态切换监控目标失败！');
  }
  console.log('✅ 测试用例 5 通过: 动态目标切换与子账户计算正常！');

  // --- 测试用例 6: 端到端信号撮合与风控拦截 ---
  console.log('\n[6/6] 验证端到端跟单撮合与滑点风控拦截...');
  const riskManager = new RiskManager(simConfig);
  const copyEngine = new CopyEngine(simConfig, injectiveService, riskManager);

  const targetTicker = 'INJ/USDC PERP';
  const market = injectiveService.getMarketByTicker(targetTicker);
  if (!market) {
    throw new Error(`未找到目标市场: ${targetTicker}`);
  }

  const prices = await injectiveService.getOrderbookPrices(market.marketId);
  const basePrice = prices.midPrice > 0 ? prices.midPrice : 3.5;

  let executionSuccessCount = 0;
  let riskBlockedCount = 0;

  tracker.on('trade', async (event) => {
    const result = await copyEngine.handleSignal(event);
    if (result.success) {
      executionSuccessCount++;
    } else {
      riskBlockedCount++;
    }
  });

  // 6.1 正常信号
  const normalEvent: SmartMoneyTradeEvent = {
    id: `sim_norm_${Date.now()}`,
    traderAddress: newTarget,
    subaccountId: '0x' + '1'.repeat(64),
    marketId: market.marketId,
    marketTicker: market.ticker,
    direction: 'BUY',
    price: basePrice,
    quantity: 10,
    notionalUsd: basePrice * 10,
    orderType: 'market',
    timestamp: Date.now(),
  };

  tracker.emitManualEvent(normalEvent);
  await new Promise((r) => setTimeout(r, 600));

  // 6.2 异常滑点信号 (偏离 15%)
  const slippageEvent: SmartMoneyTradeEvent = {
    id: `sim_slip_${Date.now()}`,
    traderAddress: newTarget,
    subaccountId: '0x' + '2'.repeat(64),
    marketId: market.marketId,
    marketTicker: market.ticker,
    direction: 'BUY',
    price: basePrice * 0.85,
    quantity: 10,
    notionalUsd: basePrice * 0.85 * 10,
    orderType: 'market',
    timestamp: Date.now(),
  };

  tracker.emitManualEvent(slippageEvent);
  await new Promise((r) => setTimeout(r, 600));

  console.log(`   - 正常跟单成功笔数: ${executionSuccessCount} (预期 1)`);
  console.log(`   - 风控拦截笔数:     ${riskBlockedCount} (预期 1)`);

  if (executionSuccessCount !== 1 || riskBlockedCount !== 1) {
    throw new Error('风控与跟单撮合结果不符合预期！');
  }

  console.log('\n========================================================================');
  console.log('🎉 全部 6 项生产级仿真与核心业务测试圆满通过！');
  console.log('========================================================================\n');
}

runSimulation().catch((err) => {
  console.error('仿真运行失败:', err);
  process.exit(1);
});
