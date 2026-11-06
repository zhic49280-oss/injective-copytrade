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
    const { event, market, currentMidPrice } = input;
    const isBuy = event.direction === 'BUY';

    // 1. 滑点保护检查
    const priceDeviation = Math.abs(currentMidPrice - event.price) / event.price * 100;
    if (priceDeviation > this.config.maxSlippagePercent) {
      // 进一步区分是不利滑点还是有利滑点
      const isAdverse = isBuy ? currentMidPrice > event.price : currentMidPrice < event.price;
      if (isAdverse) {
        return {
          passed: false,
          reason: `触发滑点保护: 当前市场价 ${currentMidPrice} 偏离聪明钱成交价 ${event.price} 达到 ${priceDeviation.toFixed(2)}%，超过允许最大滑点 ${this.config.maxSlippagePercent}%`,
          adjustedQuantity: 0,
          adjustedPrice: 0,
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

    // 5. 市价保护价计算 (根据滑点容忍度微调市价单限价缓冲)
    const slippageMultiplier = isBuy
      ? 1 + this.config.maxSlippagePercent / 100
      : 1 - this.config.maxSlippagePercent / 100;
    const executionPrice = currentMidPrice * slippageMultiplier;

    // 6. 折算数量并按 minQuantityTickSize 对齐
    const rawQuantity = targetNotional / currentMidPrice;
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
        calculatedMargin: 0,
        leverage: safeLeverage,
      };
    }

    // 7. 计算所需保证金
    const calculatedMargin = new BigNumber(executionPrice)
      .multipliedBy(adjustedQuantity)
      .dividedBy(safeLeverage)
      .toNumber();

    return {
      passed: true,
      adjustedQuantity: Number(adjustedQuantity.toFixed(6)),
      adjustedPrice: Number(executionPrice.toFixed(4)),
      calculatedMargin: Number(calculatedMargin.toFixed(4)),
      leverage: safeLeverage,
    };
  }
}
