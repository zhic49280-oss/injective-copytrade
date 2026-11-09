import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';
import {
  MarketInfo,
  RiskCheckInput,
  RiskCheckResult,
  SmartMoneyTradeEvent,
} from '../types/index.js';

export class RiskManager {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * 执行完整的跟单前风控检查与仓位折算
   */
  public evaluate(input: RiskCheckInput): RiskCheckResult {
    const { event, market, currentMidPrice, currentAsk, currentBid } = input;
    const isBuy = event.direction === 'BUY';

    // 真实盘口对手价 (fillPrice): 做多取卖一价 (currentAsk)，做空取买一价 (currentBid)，若盘口为空则降级取 currentMidPrice 或大户成交价
    const rawFillPrice = isBuy
      ? currentAsk && currentAsk > 0
        ? currentAsk
        : currentMidPrice > 0
        ? currentMidPrice
        : event.price
      : currentBid && currentBid > 0
      ? currentBid
      : currentMidPrice > 0
      ? currentMidPrice
      : event.price;

    // 1. 滑点保护检查
    const priceDeviation = Math.abs(rawFillPrice - event.price) / event.price * 100;
    if (priceDeviation > this.config.maxSlippagePercent) {
      // 进一步区分是不利滑点还是有利滑点
      const isAdverse = isBuy ? rawFillPrice > event.price : rawFillPrice < event.price;
      if (isAdverse) {
        return {
          passed: false,
          reason: `触发滑点保护: 当前市场价 ${rawFillPrice} 偏离聪明钱成交价 ${event.price} 达到 ${priceDeviation.toFixed(2)}%，超过允许最大滑点 ${this.config.maxSlippagePercent}%`,
          adjustedQuantity: 0,
          adjustedPrice: 0,
          fillPrice: 0,
          calculatedMargin: 0,
          leverage: 1,
        };
      }
    }

    // 2. 计算基准跟单名义价值 (Notional)
    let targetNotional = 0;
    if (this.config.copyMode === 'FIXED_AMOUNT') {
      targetNotional = this.config.fixedUsdtAmount;
    } else {
      // RATIO 模式
      targetNotional = event.notionalUsd * this.config.copyRatio;
    }

    // 3. 单笔最大名义金额上限熔断保护
    if (targetNotional > this.config.maxNotionalPerOrder) {
      targetNotional = this.config.maxNotionalPerOrder;
    }

    // 4. 杠杆保护
    const safeLeverage = Math.min(this.config.maxLeverage, 20);

    // 5. 市价单最差滑点保护上限价 (adjustedPrice 仅用于链上 MsgCreateDerivativeMarketOrder 限价保护 cap)
    // 真实记账与模拟撮合使用真实盘口成交价 fillPrice，避免因加减滑点缓冲导致开平仓来回白白损耗 3%！
    const slippageMultiplier = isBuy
      ? 1 + this.config.maxSlippagePercent / 100
      : 1 - this.config.maxSlippagePercent / 100;
    const worstCaseProtectionPrice = rawFillPrice * slippageMultiplier;

    // 6. 折算数量并按 minQuantityTickSize 对齐 (基于真实成交价 rawFillPrice 折算)
    const rawQuantity = targetNotional / rawFillPrice;
    const tick = market.minQuantityTickSize || 0.001;

    // 向下取整到 tick 的整数倍
    const steps = Math.floor(rawQuantity / tick);
    const adjustedQuantity = steps * tick;

    if (adjustedQuantity < tick) {
      return {
        passed: false,
        reason: `折算后仓位数量 ${adjustedQuantity} 低于市场最小下单单位 ${tick}`,
        adjustedQuantity: 0,
        adjustedPrice: 0,
        fillPrice: 0,
        calculatedMargin: 0,
        leverage: safeLeverage,
      };
    }

    // 7. 计算所需保证金 (按真实成交价核算)
    const calculatedMargin = new BigNumber(rawFillPrice)
      .multipliedBy(adjustedQuantity)
      .dividedBy(safeLeverage)
      .toNumber();

    return {
      passed: true,
      adjustedQuantity: Number(adjustedQuantity.toFixed(6)),
      adjustedPrice: Number(worstCaseProtectionPrice.toFixed(4)),
      fillPrice: Number(rawFillPrice.toFixed(4)),
      calculatedMargin: Number(calculatedMargin.toFixed(4)),
      leverage: safeLeverage,
    };
  }
}
