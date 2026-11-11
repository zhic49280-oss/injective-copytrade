import { getNetworkEndpoints } from '@injectivelabs/networks';
import {
  IndexerGrpcDerivativesApi,
  IndexerGrpcDerivativesStream,
  MsgBroadcasterWithPk,
  PrivateKey,
  getSubaccountId,
  MsgCreateDerivativeMarketOrder,
  MsgSend,
  OrderTypeMap,
  derivativePriceToChainPriceToFixed,
  derivativeQuantityToChainQuantityToFixed,
  derivativeMarginToChainMarginToFixed,
} from '@injectivelabs/sdk-ts';
import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';
import { MarketInfo, TradeDirection } from '../types/index.js';
import { RiskManager } from './risk-manager.js';

export interface OnChainPosition {
  marketId: string;
  ticker: string;
  subaccountId: string;
  direction: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  margin: number;
  unrealizedPnl: number;
  denom: string;
}

export class InjectiveService {
  private config: AppConfig;
  public endpoints: ReturnType<typeof getNetworkEndpoints>;
  public derivativesApi: IndexerGrpcDerivativesApi;
  public derivativesStream: IndexerGrpcDerivativesStream;
  public broadcaster?: MsgBroadcasterWithPk;
  public followerPrivateKey?: PrivateKey;
  public followerAddress?: string;
  public followerSubaccountId?: string;
  public targetSubaccountId?: string;

  // 市场缓存与用户广播器缓存
  private marketCache: Map<string, MarketInfo> = new Map();
  private tickerToMarketId: Map<string, string> = new Map();
  private userBroadcasters: Map<string, MsgBroadcasterWithPk> = new Map();

  constructor(config: AppConfig) {
    this.config = config;
    this.endpoints = getNetworkEndpoints(config.network);
    if (config.customEndpoints) {
      if (config.customEndpoints.indexer) this.endpoints.indexer = config.customEndpoints.indexer;
      if (config.customEndpoints.grpc) this.endpoints.grpc = config.customEndpoints.grpc;
      if (config.customEndpoints.rest) this.endpoints.rest = config.customEndpoints.rest;
      if (config.customEndpoints.rpc) this.endpoints.rpc = config.customEndpoints.rpc;
    }
    this.derivativesApi = new IndexerGrpcDerivativesApi(this.endpoints.indexer);
    this.derivativesStream = new IndexerGrpcDerivativesStream(this.endpoints.indexer);

    this.initFollowerWallet();
    this.initTargetSubaccount();
  }

  /**
   * 动态更新目标监听钱包地址与子账户
   */
  public setTargetTrader(address: string, subaccountIndex: number = 0) {
    this.config.targetTraderAddress = address;
    this.config.targetSubaccountIndex = subaccountIndex;
    try {
      this.targetSubaccountId = getSubaccountId(address, subaccountIndex);
    } catch {
      if (address.startsWith('0x')) {
        this.targetSubaccountId = address;
      }
    }
  }

  /**
   * 初始化跟单者钱包及广播器
   */
  private initFollowerWallet() {
    const rawPk = this.config.followerPrivateKey.trim();
    if (!rawPk || rawPk === 'your_private_key_here') {
      // 未配置真实私钥时，如果开启了 DRY_RUN，生成一个随机临时钱包用于地址计算与演示
      if (this.config.dryRun) {
        this.followerPrivateKey = PrivateKey.generate().privateKey;
      } else {
        return;
      }
    } else {
      const formattedPk = rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`;
      this.followerPrivateKey = PrivateKey.fromHex(formattedPk);
    }

    if (this.followerPrivateKey) {
      this.followerAddress = this.followerPrivateKey.toBech32();
      this.followerSubaccountId = getSubaccountId(
        this.followerAddress,
        this.config.followerSubaccountIndex
      );

      if (!this.config.dryRun) {
        this.broadcaster = new MsgBroadcasterWithPk({
          privateKey: this.followerPrivateKey,
          network: this.config.network,
          endpoints: {
            indexer: this.endpoints.indexer,
            grpc: this.endpoints.grpc,
            rest: this.endpoints.rest,
          },
        });
      }
    }
  }

  /**
   * 初始化聪明钱目标子账户
   */
  private initTargetSubaccount() {
    if (this.config.targetTraderAddress) {
      try {
        this.targetSubaccountId = getSubaccountId(
          this.config.targetTraderAddress,
          this.config.targetSubaccountIndex
        );
      } catch (err: any) {
        // 允许以 0x 开头的原始子账户 ID
        if (this.config.targetTraderAddress.startsWith('0x')) {
          this.targetSubaccountId = this.config.targetTraderAddress;
        }
      }
    }
  }

  /**
   * 刷新并缓存永续合约市场信息
   */
  public async loadMarkets(): Promise<Map<string, MarketInfo>> {
    const markets = await this.derivativesApi.fetchMarkets();
    this.marketCache.clear();
    this.tickerToMarketId.clear();

    for (const m of markets) {
      const info: MarketInfo = {
        marketId: m.marketId,
        ticker: m.ticker,
        oracleBase: (m as any).oracleBase || '',
        oracleQuote: (m as any).oracleQuote || '',
        quoteDenom: (m as any).quoteDenom || '',
        quoteTokenDecimals: m.quoteToken?.decimals ?? 6,
        minPriceTickSize: Number(m.minPriceTickSize || '1000'),
        minQuantityTickSize: Number(m.minQuantityTickSize || '0.001'),
        minNotional: Number((m as any).minNotional || '0'),
        initialMarginRatio: Number((m as any).initialMarginRatio || '0.05'),
        maintenanceMarginRatio: Number((m as any).maintenanceMarginRatio || '0.025'),
        makerFeeRate: m.makerFeeRate || '-0.0001',
        takerFeeRate: m.takerFeeRate || '0.001',
      };
      this.marketCache.set(m.marketId, info);
      this.tickerToMarketId.set(m.ticker.toUpperCase(), m.marketId);
    }

    return this.marketCache;
  }

  public getMarket(marketId: string): MarketInfo | undefined {
    return this.marketCache.get(marketId);
  }

  public getMarketByTicker(ticker: string): MarketInfo | undefined {
    const marketId = this.tickerToMarketId.get(ticker.toUpperCase());
    return marketId ? this.marketCache.get(marketId) : undefined;
  }

  public getMarketDecimalsMap(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [id, info] of this.marketCache.entries()) {
      map.set(id, info.quoteTokenDecimals);
    }
    return map;
  }

  /**
   * 获取指定子账户的真实链上永续合约持仓
   */
  public async getSubaccountPositions(subaccountId: string): Promise<OnChainPosition[]> {
    const res = await this.derivativesApi.fetchPositionsV2({ subaccountId });
    const rawList = res?.positions || [];
    const results: OnChainPosition[] = [];

    for (const pos of rawList) {
      const market = this.getMarket(pos.marketId);
      const decimals = market?.quoteTokenDecimals ?? 6;
      const divisor = 10 ** decimals;

      const quantity = parseFloat(pos.quantity || '0');
      if (quantity <= 0) continue;

      const entryPrice = parseFloat(pos.entryPrice || '0') / divisor;
      const markPrice = parseFloat(pos.markPrice || '0') / divisor;
      const liquidationPrice = parseFloat(pos.liquidationPrice || '0') / divisor;
      const margin = parseFloat(pos.margin || '0') / divisor;
      const direction = (pos.direction || '').toLowerCase() === 'short' ? 'short' : 'long';
      const rawUpnl = pos.upnl !== undefined ? parseFloat(pos.upnl) / divisor : NaN;
      const unrealizedPnl = Number.isFinite(rawUpnl)
        ? rawUpnl
        : direction === 'long'
        ? (markPrice - entryPrice) * quantity
        : (entryPrice - markPrice) * quantity;

      results.push({
        marketId: pos.marketId,
        ticker: pos.ticker || market?.ticker || pos.marketId,
        subaccountId: pos.subaccountId,
        direction,
        quantity,
        entryPrice,
        markPrice,
        liquidationPrice,
        margin,
        unrealizedPnl,
        denom: pos.denom || market?.quoteDenom || '',
      });
    }

    return results;
  }

  /**
   * 获取市场当前最佳买卖价格 (支持传入 marketId 或 marketTicker)
   */
  public async getOrderbook(
    marketIdOrTicker: string,
    fallbackTicker?: string
  ): Promise<{ bestBid: number; bestAsk: number; midPrice: number }> {
    let targetMarketId = marketIdOrTicker;
    if (!targetMarketId.startsWith('0x')) {
      const byTicker = this.getMarketByTicker(targetMarketId) || (fallbackTicker ? this.getMarketByTicker(fallbackTicker) : undefined);
      if (byTicker) {
        targetMarketId = byTicker.marketId;
      }
    }
    return this.getOrderbookPrices(targetMarketId);
  }

  /**
   * 获取市场当前最佳买卖价格
   */
  public async getOrderbookPrices(marketId: string): Promise<{ bestBid: number; bestAsk: number; midPrice: number }> {
    const ob = await this.derivativesApi.fetchOrderbookV2(marketId);
    const market = this.getMarket(marketId);
    const divisor = 10 ** (market?.quoteTokenDecimals || 6);

    const rawBid = ob.buys.length > 0 ? parseFloat(ob.buys[0].price) : 0;
    const rawAsk = ob.sells.length > 0 ? parseFloat(ob.sells[0].price) : 0;

    const bestBid = rawBid > 0 ? rawBid / divisor : 0;
    const bestAsk = rawAsk > 0 ? rawAsk / divisor : 0;

    const midPrice =
      bestBid > 0 && bestAsk > 0
        ? (bestBid + bestAsk) / 2
        : bestBid > 0
        ? bestBid
        : bestAsk;

    return { bestBid, bestAsk, midPrice };
  }

  /**
   * 构造符合 Injective 链上精度与最小步长要求的 MsgCreateDerivativeMarketOrder
   */
  public buildDerivativeMarketOrderMsg(params: {
    injectiveAddress: string;
    subaccountId: string;
    marketId: string;
    direction: TradeDirection;
    quantity: number;
    price: number;
    fillPrice?: number;
    leverage: number;
    isReduceOnly?: boolean;
  }): MsgCreateDerivativeMarketOrder {
    const market = this.getMarket(params.marketId);
    if (!market) {
      throw new Error(`找不到市场详情: ${params.marketId}`);
    }

    const isBuy = params.direction === 'BUY';
    const orderType = isBuy ? OrderTypeMap.BUY : OrderTypeMap.SELL;
    const decimals = market.quoteTokenDecimals || 6;

    // 1. 严格按市场 minPriceTickSize 与 minQuantityTickSize 对齐，避免链上步长校验报错
    const alignedPrice = RiskManager.alignPriceToTick(params.price, market, isBuy ? 'UP' : 'DOWN');
    if (alignedPrice <= 0) {
      throw new Error(`无效订单价格: ${params.price}`);
    }

    const qtyTickBn = new BigNumber(market.minQuantityTickSize || 0.001);
    const alignedQtyBn = new BigNumber(params.quantity)
      .dividedBy(qtyTickBn)
      .integerValue(BigNumber.ROUND_FLOOR)
      .multipliedBy(qtyTickBn);

    if (alignedQtyBn.lt(qtyTickBn) || alignedQtyBn.lte(0)) {
      throw new Error(`下单数量 ${params.quantity} 低于市场最小单位 ${qtyTickBn.toFixed()}`);
    }

    // 注意: derivativePriceToChainPriceToFixed 必须传 quoteDecimals 而非 tensMultiplier!
    const chainPrice = derivativePriceToChainPriceToFixed({
      value: alignedPrice,
      quoteDecimals: decimals,
    });
    const chainQuantity = derivativeQuantityToChainQuantityToFixed({
      value: alignedQtyBn.toFixed(),
    });

    // 2. 保证金核算: 平仓单 (isReduceOnly) 传 '0'；开仓单保证覆盖 initialMarginRatio
    let chainMargin = '0';
    if (!params.isReduceOnly) {
      const maxMarketLev =
        market.initialMarginRatio > 0 ? Math.max(1, Math.floor(1 / market.initialMarginRatio)) : 20;
      const safeLeverage = Math.max(1, Math.min(params.leverage || 1, maxMarketLev));
      const marginRefPrice = isBuy
        ? alignedPrice
        : Math.max(alignedPrice, params.fillPrice || alignedPrice);
      const notional = new BigNumber(marginRefPrice).multipliedBy(alignedQtyBn);
      const minRequiredMargin = notional.multipliedBy(market.initialMarginRatio || 0.05);
      const targetMargin = notional.dividedBy(safeLeverage);
      const finalMargin = BigNumber.maximum(targetMargin, minRequiredMargin);

      chainMargin = derivativeMarginToChainMarginToFixed({
        value: finalMargin.toFixed(decimals, BigNumber.ROUND_CEIL),
        quoteDecimals: decimals,
      });
    }

    const feeRecipient = this.config.feeRecipient || params.injectiveAddress;

    return MsgCreateDerivativeMarketOrder.fromJSON({
      injectiveAddress: params.injectiveAddress,
      subaccountId: params.subaccountId,
      marketId: params.marketId,
      orderType,
      price: chainPrice,
      quantity: chainQuantity,
      margin: chainMargin,
      feeRecipient,
    });
  }

  private getUserBroadcaster(injectiveAddress: string, cleanPk: string): MsgBroadcasterWithPk {
    let bc = this.userBroadcasters.get(injectiveAddress);
    if (!bc) {
      bc = new MsgBroadcasterWithPk({
        privateKey: cleanPk,
        network: this.config.network,
        endpoints: {
          indexer: this.endpoints.indexer,
          grpc: this.endpoints.grpc,
          rest: this.endpoints.rest,
        },
      });
      if (this.userBroadcasters.size > 500) {
        const firstKey = this.userBroadcasters.keys().next().value;
        if (firstKey) this.userBroadcasters.delete(firstKey);
      }
      this.userBroadcasters.set(injectiveAddress, bc);
    }
    return bc;
  }

  /**
   * 构建并广播衍生品市价单 (跟单核心下单接口)
   *
   * @param params 下单参数
   */
  public async executeDerivativeMarketOrder(params: {
    marketId: string;
    direction: TradeDirection;
    quantity: number;
    price: number;
    fillPrice?: number;
    leverage: number;
    isReduceOnly?: boolean;
  }): Promise<{ txHash?: string; message: any }> {
    if (!this.followerAddress || !this.followerSubaccountId) {
      throw new Error('未配置跟单钱包，无法执行链上下单。');
    }

    const orderMsg = this.buildDerivativeMarketOrderMsg({
      injectiveAddress: this.followerAddress,
      subaccountId: this.followerSubaccountId,
      marketId: params.marketId,
      direction: params.direction,
      quantity: params.quantity,
      price: params.price,
      fillPrice: params.fillPrice,
      leverage: params.leverage,
      isReduceOnly: params.isReduceOnly,
    });

    if (this.config.dryRun) {
      return {
        txHash: `simulated_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        message: orderMsg,
      };
    }

    if (!this.broadcaster) {
      throw new Error('交易广播器未就绪，请检查 FOLLOWER_PRIVATE_KEY 是否正确。');
    }

    const response = await this.broadcaster.broadcast({
      msgs: [orderMsg],
    });

    return {
      txHash: response.txHash,
      message: orderMsg,
    };
  }

  /**
   * 使用用户自己在机器人中生成的专属钱包私钥 (userPrivateKeyHex) 签名并向 Injective 主网真实广播市价单
   */
  public async executeUserRealMarketOrder(
    userPrivateKeyHex: string,
    params: {
      marketId: string;
      direction: TradeDirection;
      quantity: number;
      price: number;
      fillPrice?: number;
      leverage: number;
      isReduceOnly?: boolean;
      simulateOnly?: boolean;
    }
  ): Promise<{ txHash: string; message: any; injectiveAddress: string; subaccountId: string }> {
    const cleanPk = userPrivateKeyHex.trim().startsWith('0x')
      ? userPrivateKeyHex.trim()
      : `0x${userPrivateKeyHex.trim()}`;
    const pk = PrivateKey.fromHex(cleanPk);
    const injectiveAddress = pk.toBech32();
    const subaccountId = getSubaccountId(injectiveAddress, 0);

    const orderMsg = this.buildDerivativeMarketOrderMsg({
      injectiveAddress,
      subaccountId,
      marketId: params.marketId,
      direction: params.direction,
      quantity: params.quantity,
      price: params.price,
      fillPrice: params.fillPrice,
      leverage: params.leverage,
      isReduceOnly: params.isReduceOnly,
    });

    if (params.simulateOnly) {
      return {
        txHash: '',
        message: orderMsg,
        injectiveAddress,
        subaccountId,
      };
    }

    const userBroadcaster = this.getUserBroadcaster(injectiveAddress, cleanPk);
    const response = await userBroadcaster.broadcast({
      msgs: [orderMsg],
    });

    return {
      txHash: response.txHash,
      message: orderMsg,
      injectiveAddress,
      subaccountId,
    };
  }

  /**
   * 发送链上代币转账 (用于返佣自动结算发放)
   */
  public async sendBankToken(
    senderPrivateKeyHex: string,
    dstInjectiveAddress: string,
    denom: string,
    amountHuman: number,
    decimals: number = 6
  ): Promise<string> {
    const cleanPk = senderPrivateKeyHex.trim().startsWith('0x')
      ? senderPrivateKeyHex.trim()
      : `0x${senderPrivateKeyHex.trim()}`;
    const pk = PrivateKey.fromHex(cleanPk);
    const srcInjectiveAddress = pk.toBech32();
    const chainAmount = new BigNumber(amountHuman)
      .shiftedBy(decimals)
      .integerValue(BigNumber.ROUND_FLOOR)
      .toFixed();

    if (new BigNumber(chainAmount).lte(0)) {
      throw new Error('转账金额过小');
    }

    const msg = MsgSend.fromJSON({
      srcInjectiveAddress,
      dstInjectiveAddress,
      amount: {
        denom,
        amount: chainAmount,
      },
    });

    const bc = this.getUserBroadcaster(srcInjectiveAddress, cleanPk);
    const resp = await bc.broadcast({ msgs: [msg] });
    return resp.txHash;
  }
}
