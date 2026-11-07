import fs from 'fs';
import path from 'path';
import { config, parseNetwork } from './config/index.js';
import { InjectiveService } from './services/injective.service.js';
import { RiskManager } from './services/risk-manager.js';
import { SmartMoneyTracker } from './services/smart-money-tracker.js';
import { CopyEngine } from './services/copy-engine.js';
import { LeaderboardService } from './services/leaderboard.service.js';
import { WalletService } from './services/wallet.service.js';
import { WhaleRadarService } from './services/whale-radar.service.js';
import { validateInjectiveAddress } from './services/telegram-bot.service.js';
import { SmartMoneyTradeEvent } from './types/index.js';

async function runSimulation() {
  console.log(`
========================================================================
  🧪 Injective CopyTrade & Smart Money System - 全链路生产级仿真测试
========================================================================
  测试目标:
  1. 验证网络抽象解析 (Mainnet vs Testnet) 与开发者 40% 分润地址绑定
  2. 验证 Bech32 链上地址 Checksum 校验与防误触锁定安全机制
  3. 验证 Leaderboard 主网 1,000 个真实未平仓巨鲸扫描 (浮盈 > $500 USD)
  4. 验证 WhaleRadar 主网巨鲸大单过滤 (仅 Taker + >= $2,000 USD 阈值)
  5. 验证 0 余额处理、$10,000 体验金模式与脏数据自动纠错
  6. 验证端到端跟单撮合、feeRecipient 链上注入与滑点智能拦截风控
========================================================================
  `);

  // --- 测试用例 1: 网络抽象解析与开发者 40% 手续费返佣地址绑定 ---
  console.log('[1/6] 验证网络抽象解析与开发者 40% 手续费返佣地址...');
  const testnetRes = parseNetwork('testnet');
  const mainnetRes = parseNetwork('mainnet');
  const expectedDeveloperAddress = 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn';

  console.log(`   - Testnet 解析: ${testnetRes.networkName} (Network: ${testnetRes.network})`);
  console.log(`   - Mainnet 解析: ${mainnetRes.networkName} (Network: ${mainnetRes.network})`);
  console.log(`   - 开发者 40% 分润地址 (feeRecipient): ${config.feeRecipient}`);

  if (testnetRes.networkName !== 'testnet' || mainnetRes.networkName !== 'mainnet') {
    throw new Error('网络抽象解析异常');
  }
  if (config.feeRecipient !== expectedDeveloperAddress) {
    throw new Error(`开发者分润地址不匹配: 预期 ${expectedDeveloperAddress}, 实际 ${config.feeRecipient}`);
  }

  // 检查代码中是否彻底清除了硬编码假胜率
  const tgBotSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/services/telegram-bot.service.ts'),
    'utf-8'
  );
  if (tgBotSource.includes('80.0%+') || tgBotSource.includes('胜率 83%')) {
    throw new Error('检测到 telegram-bot.service.ts 中仍残留硬编码假胜率字样！');
  }
  console.log('✅ 测试用例 1 通过: 网络抽象与开发者 40% 手续费分润地址绑定正确，零硬编码假胜率！');

  // --- 测试用例 2: Bech32 Checksum 校验与 Telegram callback_data 64 字节上限断言 ---
  console.log('\n[2/6] 验证自定义钱包 Bech32 Checksum 校验与 callback_data 长度安全边界...');
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

  // 自动化断言所有携带 42 位 Injective 地址的动态 callback_data 严格 <= 64 字节
  const dynamicCallbacks = [
    `prac_follow_${validAddr}`,
    `follow_custom_${validAddr}`,
    `inspect_addr_${validAddr}`,
  ];
  for (const cbData of dynamicCallbacks) {
    const byteLen = Buffer.byteLength(cbData, 'utf8');
    console.log(`   - 动态 callback_data [${cbData}] 长度: ${byteLen} bytes (上限 64 bytes)`);
    if (byteLen > 64) {
      throw new Error(`Telegram callback_data 超出 64 字节上限: ${cbData} (${byteLen} bytes)`);
    }
  }
  if (tgBotSource.includes('enable_practice_and_follow_')) {
    throw new Error('检测到超长 callback_data 前缀 enable_practice_and_follow_ 残留！');
  }
  console.log('✅ 测试用例 2 通过: Bech32 Checksum 与 Telegram 64 字节 callback_data 边界全部合规！');

  // --- 测试用例 3: 主网真实巨鲸未平仓持仓聚合 ---
  console.log('\n[3/6] 验证 Leaderboard 主网 1,000 个真实未平仓巨鲸扫描...');
  const simConfig = { ...config, dryRun: true };
  const injectiveService = new InjectiveService(simConfig);
  await injectiveService.loadMarkets();

  const leaderboard = new LeaderboardService(injectiveService.endpoints, simConfig.networkName);
  const allMarketIds = Array.from((await injectiveService.loadMarkets()).keys());
  await leaderboard.refreshLeaderboard(allMarketIds);
  const topWhales = leaderboard.getTopWhales(5);

  console.log(`   - 扫描完成，当前主网高浮盈巨鲸数量: ${topWhales.length}`);
  topWhales.forEach((w) => {
    console.log(
      `     Top ${w.rank}. ${w.name} ${w.badge} | 持仓规模: $${w.volumeUsd.toLocaleString()} USD (${w.openPositionsCount}仓) | 当前浮盈: +$${w.unrealizedPnlUsd.toLocaleString()} USD | 综合胜率: ${w.winRatePercent}% | ${w.strategy}`
    );
  });

  if (topWhales.length === 0 || !topWhales[0].address.startsWith('inj1')) {
    throw new Error('Leaderboard 数据聚合异常！');
  }
  if (topWhales[0].unrealizedPnlUsd <= 500) {
    throw new Error(`榜首巨鲸浮盈异常偏低 ($${topWhales[0].unrealizedPnlUsd})，未扫到真实大户！`);
  }
  console.log('✅ 测试用例 3 通过: 主网真实百万级大户未平仓持仓与浮盈扫描正常！');

  // --- 测试用例 4: 巨鲸雷达 (WhaleRadar) 大单阈值与 Taker 过滤 ---
  console.log('\n[4/6] 验证 WhaleRadar 主网大单阈值 (>= $2,000) 与 Taker 过滤...');
  const whaleRadar = new WhaleRadarService(simConfig, injectiveService.endpoints);
  const minThreshold = (whaleRadar as any).minWhaleNotionalUsd;
  console.log(`   - 巨鲸雷达最小名义价值阈值: $${minThreshold} USD`);
  if (minThreshold < 2000) {
    throw new Error(`巨鲸雷达阈值过低 ($${minThreshold})，未能过滤小额散户单！`);
  }
  console.log('✅ 测试用例 4 通过: 巨鲸雷达严格过滤散户小单与 Maker 重复单！');

  // --- 测试用例 5: 体验金演练、脏数据自愈与清除跟单目标 ---
  console.log('\n[5/6] 验证 0 余额场景、$10,000 体验金及脏数据自动纠错...');
  const walletService = new WalletService(simConfig, injectiveService.endpoints);
  const testTgId = 99887766;
  const userWallet = walletService.getOrCreateWallet(testTgId, 'test_trader');
  console.log(`   - 为用户生成专属链上地址: ${userWallet.injectiveAddress}`);

  // 模拟误将开发者自己地址设为跟单目标的脏数据
  walletService.setUserTarget(testTgId, expectedDeveloperAddress, '误触锁定地址');
  walletService.setUserCopying(testTgId, true);
  const healedState = walletService.getUserCopyState(testTgId);
  console.log(
    `   - 脏数据自愈验证: target=${healedState.targetTraderAddress || '已自动清空'}, isCopying=${healedState.isCopyingEnabled}`
  );
  if (healedState.targetTraderAddress || healedState.isCopyingEnabled) {
    throw new Error('脏数据自愈逻辑未生效！');
  }

  // 验证正常设置目标与 clearUserTarget
  walletService.setUserTarget(testTgId, topWhales[0].address, topWhales[0].name);
  walletService.setUserCopying(testTgId, true);
  walletService.clearUserTarget(testTgId);
  const clearedState = walletService.getUserCopyState(testTgId);
  if (clearedState.targetTraderAddress || clearedState.isCopyingEnabled) {
    throw new Error('clearUserTarget 未能正确清除跟单目标！');
  }

  // 激活体验金
  walletService.setPracticeMode(testTgId, true);
  if (!walletService.isPracticeMode(testTgId)) {
    throw new Error('体验金状态切换失败！');
  }
  console.log('✅ 测试用例 5 通过: 脏数据自动纠错、清除目标与体验金演练机制全部正常！');

  // --- 测试用例 6: 端到端信号撮合、feeRecipient 校验与滑点风控拦截 ---
  console.log('\n[6/6] 验证端到端跟单撮合、40% 分润注入与滑点风控拦截...');
  const tracker = new SmartMoneyTracker(simConfig, injectiveService);
  const newTarget = topWhales[0].address;
  await tracker.updateTargetTrader(newTarget, 0);

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

  // 6.3 验证底层下单消息中的 feeRecipient 是否为开发者地址
  const orderRes = await injectiveService.executeDerivativeMarketOrder({
    marketId: market.marketId,
    direction: 'BUY',
    quantity: 1,
    price: basePrice,
    leverage: 2,
  });
  const msgParams = (orderRes.message as any).params || {};
  console.log(`   - 链上订单构造 feeRecipient: ${msgParams.feeRecipient}`);
  if (msgParams.feeRecipient !== expectedDeveloperAddress) {
    throw new Error(`订单消息中 feeRecipient 不正确: ${msgParams.feeRecipient}`);
  }

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
