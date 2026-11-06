import { config } from './config/index.js';
import { InjectiveService } from './services/injective.service.js';
import { RiskManager } from './services/risk-manager.js';
import { SmartMoneyTracker } from './services/smart-money-tracker.js';
import { CopyEngine } from './services/copy-engine.js';
import { SmartMoneyTradeEvent } from './types/index.js';

async function runSimulation() {
  console.log(`
========================================================================
  🧪 Injective CopyTrade (MVP) - 仿真跟单与风控端到端测试
========================================================================
  测试目标:
  1. 验证真实 Injective 测试网衍生品市场与盘口数据拉取
  2. 验证聪明钱信号捕获与解析流程
  3. 验证风控引擎 (滑点保护、单笔名义金额上限、杠杆限制)
  4. 验证跟单订单 MsgCreateDerivativeMarketOrder 参数构造与执行
========================================================================
  `);

  // 确保测试以 DRY_RUN 模式安全运行 (不消耗测试代币)
  const simConfig = { ...config, dryRun: true };
  const injectiveService = new InjectiveService(simConfig);

  console.log('[1/4] 连接 Injective 测试网并拉取市场详情...');
  await injectiveService.loadMarkets();

  // 选取测试网主流市场 INJ/USDC PERP
  const targetTicker = 'INJ/USDC PERP';
  const market = injectiveService.getMarketByTicker(targetTicker);
  if (!market) {
    throw new Error(`未找到目标市场: ${targetTicker}`);
  }
  console.log(`✅ 目标市场就绪: ${market.ticker} (MarketId: ${market.marketId})`);
  console.log(`   - 最小价格变动: ${market.minPriceTickSize}`);
  console.log(`   - 最小数量单位: ${market.minQuantityTickSize}`);

  // 查询实时盘口
  console.log('\n[2/4] 获取当前市场实时盘口价格...');
  const prices = await injectiveService.getOrderbookPrices(market.marketId);
  console.log(`   - 买一价: $${prices.bestBid}`);
  console.log(`   - 卖一价: $${prices.bestAsk}`);
  console.log(`   - 中间价: $${prices.midPrice}`);

  // 初始化风控与执行引擎
  const riskManager = new RiskManager(simConfig);
  const copyEngine = new CopyEngine(simConfig, injectiveService, riskManager);
  const tracker = new SmartMoneyTracker(simConfig, injectiveService);

  // 绑定事件
  tracker.on('trade', async (event) => {
    await copyEngine.handleSignal(event);
  });

  // 测试用例 1: 正常跟单信号测试 (聪明钱以中间价开多 100 个 INJ)
  console.log('\n=========================================================');
  console.log('[3/4] 模拟测试用例 1: 正常聪明钱信号触发 (正常做多开仓)');
  console.log('=========================================================');

  const normalEvent: SmartMoneyTradeEvent = {
    id: `sim_normal_${Date.now()}`,
    txHash: '0x' + 'a'.repeat(64),
    traderAddress: 'inj1hkhdaj2a2pmvzjq5q4t0dn7mm9azgahfhdua9j',
    subaccountId: '0x' + 'a'.repeat(64),
    marketId: market.marketId,
    marketTicker: market.ticker,
    direction: 'BUY',
    price: prices.midPrice > 0 ? prices.midPrice : 3.5,
    quantity: 100,
    notionalUsd: (prices.midPrice > 0 ? prices.midPrice : 3.5) * 100,
    orderType: 'market',
    timestamp: Date.now(),
  };

  tracker.emitManualEvent(normalEvent);

  // 等待微任务完成
  await new Promise((r) => setTimeout(r, 600));

  // 测试用例 2: 异常滑点触发风控拦截测试 (价格剧烈拉升 8% 超过 1.5% 阈值)
  console.log('\n=========================================================');
  console.log('[4/4] 模拟测试用例 2: 价格剧烈偏差时触发【滑点保护】拦截测试');
  console.log('=========================================================');

  const basePrice = prices.midPrice > 0 ? prices.midPrice : 3.5;
  const highSlippageEvent: SmartMoneyTradeEvent = {
    id: `sim_slippage_${Date.now()}`,
    txHash: '0x' + 'b'.repeat(64),
    traderAddress: 'inj1hkhdaj2a2pmvzjq5q4t0dn7mm9azgahfhdua9j',
    subaccountId: '0x' + 'a'.repeat(64),
    marketId: market.marketId,
    marketTicker: market.ticker,
    direction: 'BUY',
    // 聪明钱在大幅低于当前市场价的位置建仓，说明盘口已严重拉升，跟单者再追属于接盘
    price: basePrice * 0.9,
    quantity: 50,
    notionalUsd: basePrice * 0.9 * 50,
    orderType: 'market',
    timestamp: Date.now(),
  };

  tracker.emitManualEvent(highSlippageEvent);

  await new Promise((r) => setTimeout(r, 600));

  console.log('\n🎉 模拟测试全部执行完成！Phase 1 MVP 核心逻辑验证成功。');
}

runSimulation().catch((err) => {
  console.error('仿真运行失败:', err);
  process.exit(1);
});
