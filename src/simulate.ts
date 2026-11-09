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
import { TelegramBotService, validateInjectiveAddress } from './services/telegram-bot.service.js';
import { SmartMoneyTradeEvent } from './types/index.js';

async function runSimulation() {
  console.log(`
========================================================================
  🧪 Injective CopyTrade & Smart Money System - 全链路生产级仿真测试
========================================================================
  测试目标:
  1. 验证网络抽象解析 (Mainnet vs Testnet) 与开发者 40% 分润地址绑定
  2. 验证 Bech32 校验与所有动态 callback_data (含 unfollow_ 后缀) <= 64 字节
  3. 验证 Leaderboard 剔除 70 天僵尸死仓，精选 24h 内高频活跃巨鲸 + lastActiveDesc
  4. 验证多巨鲸并发跟单矩阵 (Multi-Whale Copy Matrix): 同时跟单多个巨鲸不覆盖 + 单独移除
  5. 验证 0 余额处理、$10,000 模拟盘演练与【实盘私钥签名 vs 模拟盘流水号】显式分流
  6. 验证端到端多巨鲸信号捕获、用户专属钱包私钥签名构造与滑点风控拦截
  7. 验证 12 位 BIP39 助记词生成与导入、单币种持仓合并与真实盘口成交价
========================================================================
  `);

  // --- 测试用例 1: 网络抽象解析与开发者 40% 手续费返佣地址绑定 ---
  console.log('[1/7] 验证网络抽象解析与开发者 40% 手续费返佣地址...');
  const testnetRes = parseNetwork('testnet');
  const mainnetRes = parseNetwork('mainnet');
  const defaultRes = parseNetwork();
  const expectedDeveloperAddress = 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn';

  console.log(`   - Testnet 解析: ${testnetRes.networkName} (Network: ${testnetRes.network})`);
  console.log(`   - Mainnet 解析: ${mainnetRes.networkName} (Network: ${mainnetRes.network})`);
  console.log(`   - 默认生产网络: ${config.networkName} (Network: ${config.network})`);
  console.log(`   - 开发者 40% 分润地址 (feeRecipient): ${config.feeRecipient}`);

  if (
    testnetRes.networkName !== 'testnet' ||
    mainnetRes.networkName !== 'mainnet' ||
    defaultRes.networkName !== 'mainnet' ||
    config.networkName !== 'mainnet'
  ) {
    throw new Error('网络抽象解析异常或生产默认网络未指向 Mainnet');
  }
  if (config.feeRecipient !== expectedDeveloperAddress) {
    throw new Error(`开发者分润地址不匹配: 预期 ${expectedDeveloperAddress}, 实际 ${config.feeRecipient}`);
  }

  // 检查代码中是否彻底清除了硬编码假胜率以及面向用户的“开发者手续费分成/分润”字眼
  const tgBotSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/services/telegram-bot.service.ts'),
    'utf-8'
  );
  if (tgBotSource.includes('80.0%+') || tgBotSource.includes('胜率 83%')) {
    throw new Error('检测到 telegram-bot.service.ts 中仍残留硬编码假胜率字样！');
  }
  const forbiddenUiTerms = ['开发者手续费', '开发者分润', '协议手续费分成', 'feeRecipient'];
  for (const term of forbiddenUiTerms) {
    if (tgBotSource.includes(term)) {
      throw new Error(`检测到 telegram-bot.service.ts 面向用户的代码中违规暴露了内部抽成字样: "${term}"`);
    }
  }
  console.log('✅ 测试用例 1 通过: 后台开发者 40% 分润地址静默生效，前端 UI 零暴露内部抽成字眼、零硬编码假胜率！');

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

  // 自动化断言所有动态 callback_data 严格 <= 64 字节
  const dynamicCallbacks = [
    `prac_follow_${validAddr}`,
    `follow_custom_${validAddr}`,
    `inspect_addr_${validAddr}`,
    `unfollow_${validAddr.slice(-8)}`,
    'switch_mode_real',
    'switch_mode_practice',
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

  // --- 测试用例 3: 主网真实活跃巨鲸扫描 (剔除 70 天僵尸死仓 + lastActiveDesc 验证) ---
  console.log('\n[3/6] 验证 Leaderboard 剔除僵尸死仓与 24h 内活跃巨鲸扫描...');
  const simConfig = { ...config, dryRun: true };
  const injectiveService = new InjectiveService(simConfig);
  await injectiveService.loadMarkets();

  const leaderboard = new LeaderboardService(injectiveService.endpoints, simConfig.networkName);
  const allMarketIds = Array.from((await injectiveService.loadMarkets()).keys());
  await leaderboard.refreshLeaderboard(allMarketIds);
  const topWhales = leaderboard.getTopWhales(5);

  console.log(`   - 扫描完成，当前主网高浮盈活跃巨鲸数量: ${topWhales.length}`);
  topWhales.forEach((w) => {
    console.log(
      `     Top ${w.rank}. ${w.name} ${w.badge} | 活跃度: ${w.lastActiveDesc} (${w.lastTradeMinutesAgo}m ago) | 持仓: $${w.volumeUsd.toLocaleString()} USD (${w.openPositionsCount}仓) | 浮盈: +$${w.unrealizedPnlUsd.toLocaleString()} USD | 胜率: ${w.winRatePercent}%`
    );
  });

  if (topWhales.length < 2 || !topWhales[0].address.startsWith('inj1')) {
    throw new Error('Leaderboard 数据聚合异常！');
  }
  if (topWhales[0].unrealizedPnlUsd <= 500) {
    throw new Error(`榜首巨鲸浮盈异常偏低 ($${topWhales[0].unrealizedPnlUsd})，未扫到真实大户！`);
  }
  for (const w of topWhales) {
    if (!w.lastActiveDesc || typeof w.lastTradeMinutesAgo !== 'number') {
      throw new Error(`巨鲸 ${w.address} 缺少 lastActiveDesc 活跃度字段！`);
    }
    // 确保 70 天前 (100,800 分钟) 的僵尸死仓已被剔除
    if (w.lastTradeMinutesAgo > 10080) {
      throw new Error(`检测到僵尸死仓混入前五榜单: ${w.address} (${w.lastTradeMinutesAgo} 分钟未交易)`);
    }
  }
  console.log('✅ 测试用例 3 通过: 已成功剔除 70 天僵尸死仓，Top 5 均为近期真金白银高频活跃盈利巨鲸！');

  // --- 测试用例 4: 多巨鲸并发跟单矩阵 (Multi-Whale Copy Matrix) 与巨鲸雷达验证 ---
  console.log('\n[4/6] 验证多巨鲸并发跟单矩阵 (添加多个巨鲸不互相覆盖 + 单独移除)...');
  const whaleRadar = new WhaleRadarService(simConfig, injectiveService.endpoints);
  const minThreshold = (whaleRadar as any).minWhaleNotionalUsd;
  if (minThreshold < 2000) {
    throw new Error(`巨鲸雷达阈值过低 ($${minThreshold})，未能过滤小额散户单！`);
  }

  const walletService = new WalletService(simConfig, injectiveService.endpoints);
  const matrixUserTgId = 77665544;
  walletService.clearUserTarget(matrixUserTgId);

  const whaleA = topWhales[0];
  const whaleB = topWhales[1];

  const addRes1 = walletService.addUserTarget(matrixUserTgId, whaleA.address, whaleA.name);
  const addRes2 = walletService.addUserTarget(matrixUserTgId, whaleB.address, whaleB.name);
  const currentTargets = walletService.getUserTargets(matrixUserTgId);

  console.log(
    `   - 连续添加 2 位巨鲸后列表长度: ${currentTargets.length} (1: ${currentTargets[0]?.address.slice(0, 12)}..., 2: ${currentTargets[1]?.address.slice(0, 12)}...)`
  );
  if (!addRes1.added || !addRes2.added || currentTargets.length !== 2) {
    throw new Error(`多巨鲸跟单矩阵被覆盖或添加失败！当前长度: ${currentTargets.length}`);
  }

  // 测试单独移除巨鲸 A (使用末尾 8 位后缀，模拟 unfollow_<suffix> 按钮)
  const remainingAfterRemove = walletService.removeUserTarget(matrixUserTgId, whaleA.address.slice(-8));
  console.log(
    `   - 单独移除巨鲸 A 后剩余列表长度: ${remainingAfterRemove.length} (剩余: ${remainingAfterRemove[0]?.address})`
  );
  if (remainingAfterRemove.length !== 1 || remainingAfterRemove[0].address !== whaleB.address) {
    throw new Error('removeUserTarget 单独移除巨鲸异常！');
  }
  walletService.clearUserTarget(matrixUserTgId);
  console.log('✅ 测试用例 4 通过: 多巨鲸并发跟单矩阵支持同时跟单多位巨鲸且互不覆盖、支持单独移除！');

  // --- 测试用例 5: 模拟盘 vs 实盘链上显式分流、体验金扣减与脏数据自愈 ---
  console.log('\n[5/6] 验证【实盘链上模式 vs $10,000 模拟演练模式】显式分流与账本结算...');
  const testTgId = 99887766;
  const userWallet = walletService.getOrCreateWallet(testTgId, 'test_trader');
  console.log(`   - 为用户生成专属链上地址: ${userWallet.injectiveAddress}`);

  // 模拟误将开发者自己地址设为跟单目标的脏数据
  walletService.setUserTarget(testTgId, expectedDeveloperAddress, '误触锁定地址');
  walletService.setUserCopying(testTgId, true);
  const healedState = walletService.getUserCopyState(testTgId);
  if (healedState.targetTraderAddress || healedState.isCopyingEnabled || healedState.followedTargets.length > 0) {
    throw new Error('脏数据自愈逻辑未生效！');
  }

  // 激活体验金并重置初始 $10,000 状态进行真实账本扣减测试
  const freshPracticeUser = 88776655;
  walletService.setPracticeMode(freshPracticeUser, true);
  const wBefore = walletService.getOrCreateWallet(freshPracticeUser);
  wBefore.practiceBalanceUsdt = 10000;
  wBefore.practicePositions = [];
  wBefore.practiceRealizedPnlUsdt = 0;

  const tradeRes = walletService.executePracticeTrade(freshPracticeUser, {
    marketTicker: 'INJ/USDC PERP',
    direction: 'BUY',
    price: 25.0,
    quantity: 4,
    marginUsdt: 20,
    leverage: 5,
  });

  if (
    !tradeRes.success ||
    tradeRes.wallet.practiceBalanceUsdt !== 9980 ||
    (tradeRes.wallet.practicePositions?.length || 0) !== 1
  ) {
    throw new Error('体验金真实扣减或持仓记录异常！');
  }

  // 验证 TelegramBotService 的模拟盘 vs 实盘成交通知分流文案
  const riskManager = new RiskManager(simConfig);
  const copyEngine = new CopyEngine(simConfig, injectiveService, riskManager);
  const tracker = new SmartMoneyTracker(simConfig, injectiveService);
  const tgService = new TelegramBotService(
    { ...simConfig, telegramBotToken: '' },
    copyEngine,
    tracker,
    leaderboard,
    walletService,
    whaleRadar
  );

  const mockOrderResult = {
    success: true,
    sourceEventId: 'evt_1',
    txHash: 'simulated_tx_123',
    marketTicker: 'INJ/USDC PERP',
    direction: 'BUY' as const,
    executedQuantity: 4,
    executionPrice: 25,
    margin: 20,
    leverage: 5,
    executionTimeMs: 320,
  };

  // 5.1 模拟盘文案校验 (必须包含【模拟盘跟单成交】与 #PAPER_，绝不出现 simulated_tx)
  const paperMsg = tgService.formatTradeNotificationText(freshPracticeUser, mockOrderResult, {
    paperOrderId: '#PAPER_888999',
  });
  console.log(`   - 模拟盘通知标题校验: ${paperMsg.split('\n')[0]}`);
  if (!paperMsg.includes('模拟盘跟单成交') || !paperMsg.includes('#PAPER_888999') || paperMsg.includes('simulated_tx')) {
    throw new Error('模拟盘成交通知未与实盘严格区分或仍包含假 simulated_tx 哈希！');
  }

  // 5.2 实盘文案与零余额防虚报校验 (切换为实盘模式后，有真实 txHash 才报成功，无余额或无哈希绝不谎报成功)
  walletService.setPracticeMode(freshPracticeUser, false);
  const noBalanceWarnMsg = tgService.formatTradeNotificationText(freshPracticeUser, mockOrderResult, {
    insufficientRealBalance: { inj: '0.0000', usdt: '0.00', requiredMargin: 20, userAmountUsdt: 100 },
  });
  console.log(`   - 实盘零余额防谎报校验: ${noBalanceWarnMsg.split('\n')[0]}`);
  if (!noBalanceWarnMsg.includes('实盘跟单未执行') || noBalanceWarnMsg.includes('实盘链上跟单成功')) {
    throw new Error('实盘零余额场景下未能正确拦截虚报成功！');
  }

  const fakeRealTxHash = 'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';
  const realMsg = tgService.formatTradeNotificationText(freshPracticeUser, mockOrderResult, {
    realTxHash: fakeRealTxHash,
  });
  console.log(`   - 实盘链上真实成交标题校验: ${realMsg.split('\n')[0]}`);
  if (
    !realMsg.includes('实盘链上跟单成功') ||
    !realMsg.includes(`https://injscan.com/transaction/${fakeRealTxHash}`)
  ) {
    throw new Error('实盘成交通知未包含 Mainnet 标题或 injscan.com 区块浏览器链接！');
  }
  console.log('✅ 测试用例 5 通过: 模拟盘与实盘链上模式显式切换、零余额防谎报及成交通知 100% 清晰分流！');

  // --- 测试用例 6: DRY_RUN=false 无全局私钥路由 + 按用户专属 copyAmountUsdt 扣减 + 精准目标过滤 ---
  console.log('\n[6/6] 验证 DRY_RUN=false 多用户独立钱包路由、用户专属金额折算与精准目标过滤...');
  await tracker.addTrackedTrader(whaleA.address, 0);
  await tracker.addTrackedTrader(whaleB.address, 0);
  const trackedList = tracker.getTrackedAddresses();
  console.log(`   - Tracker 当前并发监听巨鲸数量: ${trackedList.length}`);
  if (!trackedList.includes(whaleA.address) || !trackedList.includes(whaleB.address)) {
    throw new Error('SmartMoneyTracker 未能同时维护多个巨鲸监听地址！');
  }

  const targetTicker = 'INJ/USDC PERP';
  const market = injectiveService.getMarketByTicker(targetTicker);
  if (!market) {
    throw new Error(`未找到目标市场: ${targetTicker}`);
  }

  const prices = await injectiveService.getOrderbookPrices(market.marketId);
  const basePrice = prices.midPrice > 0 ? prices.midPrice : 3.5;

  // 验证在 DRY_RUN=false 且未配置全局 FOLLOWER_PRIVATE_KEY 的多用户生产场景下，CopyEngine 不会抛错拦截
  const liveMultiUserConfig = { ...config, dryRun: false, followerPrivateKey: '' };
  const liveInjService = new InjectiveService(liveMultiUserConfig);
  await liveInjService.loadMarkets();
  const liveCopyEngine = new CopyEngine(liveMultiUserConfig, liveInjService, new RiskManager(liveMultiUserConfig));

  const liveSignalEvent: SmartMoneyTradeEvent = {
    id: `sim_live_multi_${Date.now()}`,
    traderAddress: whaleA.address,
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

  const liveEngineRes = await liveCopyEngine.handleSignal(liveSignalEvent);
  console.log(
    `   - DRY_RUN=false 无全局私钥场景 CopyEngine 放行验证: success=${liveEngineRes.success}, txHash=${liveEngineRes.txHash ?? '交由下游各用户独立钱包执行'}`
  );
  if (!liveEngineRes.success) {
    throw new Error(`DRY_RUN=false 无全局私钥场景下 CopyEngine 错误抛错拦截: ${liveEngineRes.error}`);
  }

  // 验证按跟单关系精准过滤 + 按用户各自 copyAmountUsdt 精确折算扣减保证金：
  // 用户 1 (freshPracticeUser) 仅跟单 whaleA，设置单笔跟单金额为 $200 USDT (5x 杠杆 -> 约 $40 保证金)
  walletService.clearUserTarget(freshPracticeUser);
  walletService.addUserTarget(freshPracticeUser, whaleA.address, whaleA.name);
  walletService.setUserAmount(freshPracticeUser, 200);
  walletService.setPracticeMode(freshPracticeUser, true);
  walletService.setUserCopying(freshPracticeUser, true);
  const u1Wallet = walletService.getOrCreateWallet(freshPracticeUser);
  u1Wallet.practiceBalanceUsdt = 10000;
  u1Wallet.practicePositions = [];

  // 用户 2 (matrixUserTgId) 仅跟单 whaleB (未跟单 whaleA)，初始余额 $10,000
  walletService.clearUserTarget(matrixUserTgId);
  walletService.addUserTarget(matrixUserTgId, whaleB.address, whaleB.name);
  walletService.setPracticeMode(matrixUserTgId, true);
  walletService.setUserCopying(matrixUserTgId, true);
  const u2Wallet = walletService.getOrCreateWallet(matrixUserTgId);
  u2Wallet.practiceBalanceUsdt = 10000;
  u2Wallet.practicePositions = [];

  // 触发来自 whaleA 的成交通知路由
  await tgService.notifyCopyTradeResult(liveEngineRes, liveSignalEvent);

  const u1BalanceAfter = walletService.getOrCreateWallet(freshPracticeUser).practiceBalanceUsdt ?? 0;
  const u2BalanceAfter = walletService.getOrCreateWallet(matrixUserTgId).practiceBalanceUsdt ?? 0;
  const u1Deducted = Number((10000 - u1BalanceAfter).toFixed(2));
  console.log(
    `   - 精准路由与专属金额验证: 跟单 whaleA 的用户(设 $200/单, 5x) 扣减保证金 = $${u1Deducted} USDT (剩余 $${u1BalanceAfter}) | 仅跟单 whaleB 的用户剩余 = $${u2BalanceAfter} USDT (零误扣)`
  );
  if (u1Deducted < 39.5 || u1Deducted > 40.5 || u2BalanceAfter !== 10000) {
    throw new Error(
      `按用户专属金额折算或目标过滤异常: u1Deducted=${u1Deducted}, u2BalanceAfter=${u2BalanceAfter}`
    );
  }

  // 清理测试用户的跟单启用状态
  walletService.clearUserTarget(freshPracticeUser);
  walletService.clearUserTarget(matrixUserTgId);

  // 验证 executeUserRealMarketOrder 使用用户自己生成的私钥派生专属地址并构造链上消息
  const userOrderSim = await injectiveService.executeUserRealMarketOrder(userWallet.privateKeyHex, {
    marketId: market.marketId,
    direction: 'BUY',
    quantity: 1,
    price: basePrice,
    leverage: 2,
    simulateOnly: true,
  });
  const userMsgParams = (userOrderSim.message as any).params || {};
  console.log(
    `   - 用户专属私钥签名构造验证: sender=${userOrderSim.injectiveAddress}, feeRecipient=${userMsgParams.feeRecipient}`
  );
  if (
    userOrderSim.injectiveAddress !== userWallet.injectiveAddress ||
    userMsgParams.feeRecipient !== expectedDeveloperAddress
  ) {
    throw new Error('executeUserRealMarketOrder 用户私钥地址派生或 feeRecipient 绑定异常！');
  }

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
    traderAddress: whaleA.address,
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
  await new Promise((r) => setTimeout(r, 1200));

  // 6.2 异常滑点信号 (偏离 20%)
  const slippageEvent: SmartMoneyTradeEvent = {
    id: `sim_slip_${Date.now()}`,
    traderAddress: whaleB.address,
    subaccountId: '0x' + '2'.repeat(64),
    marketId: market.marketId,
    marketTicker: market.ticker,
    direction: 'BUY',
    price: basePrice * 0.8,
    quantity: 10,
    notionalUsd: basePrice * 0.8 * 10,
    orderType: 'market',
    timestamp: Date.now(),
  };

  tracker.emitManualEvent(slippageEvent);
  await new Promise((r) => setTimeout(r, 1200));

  console.log(`   - 正常跟单成功笔数: ${executionSuccessCount} (预期 1)`);
  console.log(`   - 风控拦截笔数:     ${riskBlockedCount} (预期 1)`);

  if (executionSuccessCount !== 1 || riskBlockedCount !== 1) {
    throw new Error('风控与跟单撮合结果不符合预期！');
  }

  // --- 测试用例 7: 验证 12 位 BIP39 助记词生成与导入、单币种持仓合并与防滑点虚扣 ---
  console.log('\n[7/7] 验证 12 位 BIP39 助记词生成与导入、单币种持仓合并与真实盘口成交价...');
  const testUserId = 88000000 + Math.floor(Math.random() * 100000);
  const testWallet = walletService.getOrCreateWallet(testUserId, 'test_trader');
  console.log(`   - 自动派生钱包地址: ${testWallet.injectiveAddress}`);
  console.log(`   - 自动生成 12 位助记词: ${testWallet.mnemonic ? '✅ ' + testWallet.mnemonic : '❌ 未生成'}`);
  if (!testWallet.mnemonic || testWallet.mnemonic.split(' ').length !== 12) {
    throw new Error('未成功生成标准 12 位 BIP39 助记词！');
  }

  // 验证重新生成助记词钱包
  const originalMnemonic = testWallet.mnemonic!;
  const originalAddress = testWallet.injectiveAddress;
  const regenWallet = walletService.regenerateWalletWithMnemonic(testUserId);
  if (!regenWallet.mnemonic || regenWallet.mnemonic === originalMnemonic) {
    throw new Error('重新生成助记词钱包异常！');
  }

  // 验证导入助记词并恢复原地址
  const importedWallet = walletService.importWallet(testUserId, originalMnemonic);
  if (importedWallet.injectiveAddress !== originalAddress) {
    throw new Error('导入助记词恢复的地址与原地址不一致！');
  }

  // 验证连续多次相同标的、同方向开仓：严格合并为 1 笔净持仓 (绝不允许堆积 142 笔仓位)
  walletService.resetPracticeAccount(testUserId);
  walletService.executePracticeTrade(testUserId, {
    marketTicker: 'QNT/USDC PERP',
    direction: 'BUY',
    price: 200.0,
    quantity: 1.0,
    marginUsdt: 40.0,
    leverage: 5,
  });

  walletService.executePracticeTrade(testUserId, {
    marketTicker: 'QNT/USDC PERP',
    direction: 'BUY',
    price: 204.0,
    quantity: 1.0,
    marginUsdt: 40.8,
    leverage: 5,
  });

  const mergedWallet = walletService.getOrCreateWallet(testUserId);
  const posCount = (mergedWallet.practicePositions || []).length;
  const mergedPos = mergedWallet.practicePositions![0];
  console.log(`   - 同向连续开仓合并验证: 持仓数=${posCount} (预期 1 笔), 均价=$${mergedPos.entryPrice} (预期 $202.0), 数量=${mergedPos.quantity} (预期 2.0)`);
  if (posCount !== 1 || mergedPos.entryPrice !== 202.0 || mergedPos.quantity !== 2.0) {
    throw new Error(`同向开仓未能正确合并为 1 笔净持仓: count=${posCount}, avgPrice=${mergedPos.entryPrice}`);
  }

  // 验证反向开仓触发平仓与历史交割记录
  const closeRes = walletService.executePracticeTrade(testUserId, {
    marketTicker: 'QNT/USDC PERP',
    direction: 'SELL',
    price: 205.0,
    quantity: 2.0,
    marginUsdt: 0,
    leverage: 5,
  });
  console.log(`   - 反向平仓结算验证: action=${closeRes.action}, realizedPnlDelta=+$${closeRes.realizedPnlDelta} USDT, 历史记录数=${mergedWallet.practiceTradeHistory?.length}`);
  if (closeRes.action !== 'CLOSE' || (closeRes.realizedPnlDelta ?? 0) <= 0 || (mergedWallet.practiceTradeHistory?.length ?? 0) !== 1) {
    throw new Error('反向平仓结算或交割历史记录异常！');
  }

  // 验证真实成交价 (fillPrice) 与最差滑点保护价 (adjustedPrice) 区分，杜绝来回损耗 3%
  const riskEval = new RiskManager(config).evaluate({
    event: { ...normalEvent, price: 100.0 },
    market,
    currentMidPrice: 100.0,
    currentAsk: 100.05,
    currentBid: 99.95,
  });
  console.log(`   - 风控撮合价格区分: fillPrice=$${riskEval.fillPrice} (盘口对手价) vs adjustedPrice=$${riskEval.adjustedPrice} (最差保护价)`);
  if (!riskEval.fillPrice || riskEval.fillPrice === riskEval.adjustedPrice || !riskEval.passed) {
    throw new Error('未能严格区分真实盘口成交价 (fillPrice) 与滑点保护价 (adjustedPrice)！');
  }

  console.log('\n========================================================================');
  console.log('🎉 全部 7 项生产级仿真与核心业务测试圆满通过！');
  console.log('========================================================================\n');
}

runSimulation().catch((err) => {
  console.error('仿真运行失败:', err);
  process.exit(1);
});
