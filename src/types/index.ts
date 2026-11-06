/**
 * Injective 链上聪明钱一键跟单系统 - 类型定义
 */

export type TradeDirection = 'BUY' | 'SELL';

export type CopyMode = 'FIXED_AMOUNT' | 'RATIO';

export interface MarketInfo {
  marketId: string;
  ticker: string;
  oracleBase: string;
  oracleQuote: string;
  quoteTokenDecimals: number;
  minPriceTickSize: number;
  minQuantityTickSize: number;
  makerFeeRate: string;
  takerFeeRate: string;
}

/**
 * 聪明钱交易事件结构体
 */
export interface SmartMoneyTradeEvent {
  id: string;
  txHash?: string;
  traderAddress: string;
  subaccountId: string;
  marketId: string;
  marketTicker: string;
  direction: TradeDirection;
  price: number;
  quantity: number;
  notionalUsd: number;
  orderType: string;
  timestamp: number;
  rawEvent?: any;
}

/**
 * 风控检查输入与结果
 */
export interface RiskCheckInput {
  event: SmartMoneyTradeEvent;
  market: MarketInfo;
  currentMidPrice: number;
}

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  adjustedQuantity: number;
  adjustedPrice: number;
  calculatedMargin: number;
  leverage: number;
}

/**
 * 跟单执行结果
 */
export interface CopyOrderResult {
  success: boolean;
  sourceEventId: string;
  txHash?: string;
  marketTicker: string;
  direction: TradeDirection;
  executedQuantity: number;
  executionPrice: number;
  margin: number;
  leverage: number;
  executionTimeMs: number;
  error?: string;
}
