import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';
import {
  MarketInfo,
  RiskCheckInput,
  RiskCheckResult,
} from '../types/index.js';

export class RiskManager {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * 按市场最小价格步长对齐价格（保证发送至 Injective 链上时满足 minPriceTickSize 整除约束）
   */
  public static alignPriceToTick(
    price: number,
    market: MarketInfo,
    rounding: 'UP' | 'DOWN'
  ): number {
    if (!price || !Number.isFinite(price) || price <= 0) return 0;
    const decimals = market.quoteTokenDecimals || 6;
    const rawTick = market.minPriceTickSize || 0;
    if (rawTick <= 0 || !Number.isFinite(rawTick)) {
      return price;
    }

    const humanTick = new BigNumber(rawTick).shiftedBy(-decimals);
    if (humanTick.lte(0)) return price;

    const bnPrice = new BigNumber(price);
    const steps = bnPrice
      .dividedBy(humanTick)
      .integerValue(rounding === 'UP' ? BigNumber.ROUND_CEIL : BigNumber.ROUND_FLOOR);
    const aligned = steps.multipliedBy(humanTick);
    const finalBn = aligned.gt(0) ? aligned : humanTick;
    return finalBn.toNumber();
  }

  /**
   * 执行完整的跟单前风控检查与仓位折算 (支持按用户专属参数覆盖全局默认配置)
   */
  public evaluate(input: RiskCheckInput): RiskCheckResult {
    const { event, market, currentMidPrice, currentAsk, currentBid, userRiskConfig } = input;
    const isBuy = event.direction === 'BUY';

    const effectiveCopyMode = userRiskConfig?.copyMode ?? this.config.copyMode;
    const effectiveFixedAmount = userRiskConfig?.fixedUsdtAmount ?? this.config.fixedUsdtAmount;
    const effectiveCopyRatio = userRiskConfig?.copyRatio ?? this.config.copyRatio;
    const effectiveMaxSlippage = userRiskConfig?.maxSlippagePercent ?? this.config.maxSlippagePercent;
    const effectiveMaxNotional = userRiskConfig?.maxNotionalPerOrder ?? this.config.maxNotionalPerOrder;
    const effectiveMaxLeverage = userRiskConfig?.maxLeverage ?? this.config.maxLeverage;

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

    if (!rawFillPrice || rawFillPrice <= 0 || !event.price || event.price <= 0) {
      return {
        passed: false,
        reason: '无效的市场价格或信号价格，跳过跟单',
        adjustedQuantity: 0,
        adjustedPrice: 0,
        fillPrice: 0,
        calculatedMargin: 0,
        leverage: 1,
      };
    }

    // 1. 滑点保护检查
    const priceDeviation = (Math.abs(rawFillPrice - event.price) / event.price) * 100;
    if (priceDeviation > effectiveMaxSlippage) {
      const isAdverse = isBuy ? rawFillPrice > event.price : rawFillPrice < event.price;
      if (isAdverse) {
        return {
          passed: false,
          reason: `触发滑点保护: 当前市场价 ${rawFillPrice} 偏离聪明钱成交价 ${event.price} 达到 ${priceDeviation.toFixed(2)}%，超过允许最大滑点 ${effectiveMaxSlippage}%`,
          adjustedQuantity: 0,
          adjustedPrice: 0,
          fillPrice: 0,
          calculatedMargin: 0,
          leverage: 1,
        };
      }
    }

    // 2. 计算基准跟单名义价值 (Notional)
    let targetNotional =
      effectiveCopyMode === 'RATIO'
        ? event.notionalUsd * effectiveCopyRatio
        : effectiveFixedAmount;

    // 3. 单笔最大名义金额上限熔断保护
    if (effectiveMaxNotional > 0 && targetNotional > effectiveMaxNotional) {
      targetNotional = effectiveMaxNotional;
    }

    // 4. 杠杆保护 (同时不超过市场 initialMarginRatio 允许的最大杠杆)
    const maxMarketLeverage =
      market.initialMarginRatio && market.initialMarginRatio > 0
        ? Math.max(1, Math.floor(1 / market.initialMarginRatio))
        : 20;
    const safeLeverage = Math.max(1, Math.min(effectiveMaxLeverage, maxMarketLeverage, 20));

    // 5. 市价单最差滑点保护上限价 (adjustedPrice 用于链上 MsgCreateDerivativeMarketOrder 限价保护 cap，按最小价格刻度对齐)
    const slippageMultiplier = isBuy
      ? 1 + effectiveMaxSlippage / 100
      : Math.max(0.01, 1 - effectiveMaxSlippage / 100);
    const rawProtectionPrice = rawFillPrice * slippageMultiplier;
    const alignedProtectionPrice = RiskManager.alignPriceToTick(
      rawProtectionPrice,
      market,
      isBuy ? 'UP' : 'DOWN'
    );

    // 6. 折算数量并按 minQuantityTickSize 使用 BigNumber 精确向下取整对齐
    const rawQuantityBn = new BigNumber(targetNotional).dividedBy(rawFillPrice);
    const tickBn = new BigNumber(market.minQuantityTickSize || 0.001);
    const stepsBn = rawQuantityBn.dividedBy(tickBn).integerValue(BigNumber.ROUND_FLOOR);
    const adjustedQuantityBn = stepsBn.multipliedBy(tickBn);
    const adjustedQuantity = adjustedQuantityBn.toNumber();

    if (adjustedQuantityBn.lt(tickBn) || adjustedQuantity <= 0) {
      return {
        passed: false,
        reason: `折算后仓位数量 ${adjustedQuantity} 低于市场最小下单单位 ${tickBn.toFixed()} (当前设置金额 $${targetNotional.toFixed(2)} 不足以买 1 最小单位)`,
        adjustedQuantity: 0,
        adjustedPrice: 0,
        fillPrice: 0,
        calculatedMargin: 0,
        leverage: safeLeverage,
      };
    }

    // 检查市场最小名义价值限制 (minNotional)
    const actualNotionalBn = new BigNumber(rawFillPrice).multipliedBy(adjustedQuantityBn);
    if (market.minNotional && market.minNotional > 0 && actualNotionalBn.lt(market.minNotional)) {
      return {
        passed: false,
        reason: `折算后订单名义价值 $${actualNotionalBn.toFixed(2)} 低于市场最小限制 $${market.minNotional}`,
        adjustedQuantity: 0,
        adjustedPrice: 0,
        fillPrice: 0,
        calculatedMargin: 0,
        leverage: safeLeverage,
      };
    }

    // 7. 计算所需保证金 (按真实成交价核算)
    const calculatedMargin = actualNotionalBn.dividedBy(safeLeverage).toNumber();

    const cleanPrice = (p: number) => {
      if (!p || isNaN(p)) return 0;
      if (p >= 100) return Number(p.toFixed(2));
      if (p >= 1) return Number(p.toFixed(4));
      if (p >= 0.001) return Number(p.toFixed(6));
      return Number(p.toPrecision(7));
    };

    return {
      passed: true,
      adjustedQuantity: Number(adjustedQuantityBn.toFixed()),
      adjustedPrice: alignedProtectionPrice > 0 ? alignedProtectionPrice : cleanPrice(rawProtectionPrice),
      fillPrice: cleanPrice(rawFillPrice),
      calculatedMargin: Number(calculatedMargin.toFixed(2)),
      leverage: safeLeverage,
    };
  }
}
