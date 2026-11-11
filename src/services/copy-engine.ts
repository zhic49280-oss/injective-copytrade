import { AppConfig } from '../config/index.js';
import { InjectiveService } from './injective.service.js';
import { RiskManager } from './risk-manager.js';
import {
  CopyOrderResult,
  SmartMoneyTradeEvent,
} from '../types/index.js';

export class CopyEngine {
  private config: AppConfig;
  private injectiveService: InjectiveService;
  private riskManager: RiskManager;
  private totalOrdersCount: number = 0;
  private successfulOrdersCount: number = 0;

  constructor(
    config: AppConfig,
    injectiveService: InjectiveService,
    riskManager: RiskManager
  ) {
    this.config = config;
    this.injectiveService = injectiveService;
    this.riskManager = riskManager;
  }

  /**
   * 处理聪明钱交易事件并执行自动复制下单
   */
  public async handleSignal(event: SmartMoneyTradeEvent): Promise<CopyOrderResult> {
    const startTime = Date.now();
    this.totalOrdersCount++;

    console.log(`[CopyEngine] ⚡ 开始处理跟单信号 #${this.totalOrdersCount} (信号来源: ${event.id})`);

    // 1. 查询市场信息
    const market = this.injectiveService.getMarket(event.marketId);
    if (!market) {
      const err = `未找到市场信息: ${event.marketId} (${event.marketTicker})，忽略跟单。`;
      console.error(`[CopyEngine] ❌ ${err}`);
      return {
        success: false,
        sourceEventId: event.id,
        marketTicker: event.marketTicker,
        direction: event.direction,
        executedQuantity: 0,
        executionPrice: 0,
        margin: 0,
        leverage: 1,
        executionTimeMs: Date.now() - startTime,
        error: err,
      };
    }

    // 2. 获取当前实时盘口价格
    let currentMidPrice = event.price;
    let currentAsk = event.price;
    let currentBid = event.price;
    try {
      const obPrices = await this.injectiveService.getOrderbookPrices(event.marketId);
      if (obPrices.midPrice > 0) {
        currentMidPrice = obPrices.midPrice;
      }
      if (obPrices.bestAsk > 0) {
        currentAsk = obPrices.bestAsk;
      }
      if (obPrices.bestBid > 0) {
        currentBid = obPrices.bestBid;
      }
    } catch (e: any) {
      console.warn(`[CopyEngine] ⚠️ 获取盘口实时价失败，降级使用大户成交价作为基准:`, e.message);
    }

    // 3. 风控审查与仓位折算
    const riskResult = this.riskManager.evaluate({
      event,
      market,
      currentMidPrice,
      currentAsk,
      currentBid,
    });

    const realFillPrice = riskResult.fillPrice || riskResult.adjustedPrice;
    const baseResult: CopyOrderResult = {
      success: riskResult.passed,
      sourceEventId: event.id,
      marketId: event.marketId,
      marketTicker: event.marketTicker,
      direction: event.direction,
      executedQuantity: riskResult.adjustedQuantity,
      executionPrice: realFillPrice || currentMidPrice || event.price,
      protectionPrice: riskResult.adjustedPrice,
      currentMidPrice,
      currentAsk,
      currentBid,
      margin: riskResult.calculatedMargin,
      leverage: riskResult.leverage,
      executionTimeMs: Date.now() - startTime,
      error: riskResult.passed ? undefined : riskResult.reason,
    };

    if (!riskResult.passed) {
      console.warn(`[CopyEngine] 🛑 全局基准风控拦截: ${riskResult.reason}`);
      return baseResult;
    }

    console.log(`[CopyEngine] ✅ 风控审查通过:`);
    console.log(`  - 跟单方向: ${event.direction}`);
    console.log(`  - 折算数量: ${riskResult.adjustedQuantity}`);
    console.log(`  - 真实盘口成交价 (fillPrice): $${realFillPrice}`);
    console.log(`  - 链上保护上限价 (adjustedPrice): $${riskResult.adjustedPrice}`);
    console.log(`  - 所需保证金: $${riskResult.calculatedMargin} (${riskResult.leverage}x 杠杆)`);
    console.log(`  - 运行模式: ${this.config.dryRun ? '🧪 DRY_RUN (模拟)' : '🔴 LIVE (真实上链)'}`);

    // 4. 多用户独立钱包模式或 TG 模式下跳过非目标的全局私钥下单，交由下游按各用户独立钱包与风控参数执行
    const hasGlobalFollower = Boolean(this.injectiveService.followerAddress);
    const isGlobalTarget =
      !this.config.telegramBotToken ||
      process.env.GLOBAL_FOLLOWER_COPY_ALL === 'true' ||
      (this.config.targetTraderAddress &&
        event.traderAddress.toLowerCase() === this.config.targetTraderAddress.toLowerCase());

    if ((!hasGlobalFollower || !isGlobalTarget) && !this.config.dryRun) {
      const latency = Date.now() - startTime;
      this.successfulOrdersCount++;

      console.log(`\n=========================================================`);
      console.log(`[CopyEngine] 🎯 风控核算通过 (多用户独立钱包路由模式)！`);
      console.log(`  - 真实成交价: $${realFillPrice} (保护上限: $${riskResult.adjustedPrice}) | 基准数量: ${riskResult.adjustedQuantity}`);
      console.log(`  - 核算耗时: ${latency} ms`);
      console.log(`  - 累计放行单数: ${this.successfulOrdersCount} / ${this.totalOrdersCount}`);
      console.log(`=========================================================\n`);

      return {
        ...baseResult,
        success: true,
        txHash: undefined,
        executionTimeMs: latency,
      };
    }

    try {
      const orderResp = await this.injectiveService.executeDerivativeMarketOrder({
        marketId: event.marketId,
        direction: event.direction,
        quantity: riskResult.adjustedQuantity,
        price: riskResult.adjustedPrice,
        fillPrice: realFillPrice,
        leverage: riskResult.leverage,
      });

      const latency = Date.now() - startTime;
      this.successfulOrdersCount++;

      console.log(`\n=========================================================`);
      console.log(`[CopyEngine] 🎯 跟单执行成功！`);
      console.log(`  - 交易哈希: ${orderResp.txHash}`);
      console.log(`  - 执行耗时: ${latency} ms`);
      console.log(`  - 开发者 40% 手续费返佣地址: ${this.config.feeRecipient || this.injectiveService.followerAddress}`);
      console.log(`  - 累计成功单数: ${this.successfulOrdersCount} / ${this.totalOrdersCount}`);
      console.log(`=========================================================\n`);

      return {
        ...baseResult,
        success: true,
        txHash: orderResp.txHash,
        executionTimeMs: latency,
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      console.error(`[CopyEngine] ❌ 订单广播执行失败:`, err.message || err);

      return {
        ...baseResult,
        success: false,
        executionTimeMs: latency,
        error: err.message || String(err),
      };
    }
  }

  public getRiskManager(): RiskManager {
    return this.riskManager;
  }

  public getInjectiveService(): InjectiveService {
    return this.injectiveService;
  }

  public getStats() {
    return {
      total: this.totalOrdersCount,
      success: this.successfulOrdersCount,
    };
  }
}
