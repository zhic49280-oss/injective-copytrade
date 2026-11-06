import { Network, getNetworkEndpoints } from '@injectivelabs/networks';
import {
  IndexerGrpcDerivativesApi,
  IndexerGrpcDerivativesStream,
  MsgBroadcasterWithPk,
  PrivateKey,
  getSubaccountId,
  getDefaultSubaccountId,
  MsgCreateDerivativeMarketOrder,
  OrderTypeMap,
  derivativePriceToChainPriceToFixed,
  derivativeQuantityToChainQuantityToFixed,
  derivativeMarginToChainMarginToFixed,
} from '@injectivelabs/sdk-ts';
import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';
import { MarketInfo, TradeDirection } from '../types/index.js';

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

  // 市场缓存
  private marketCache: Map<string, MarketInfo> = new Map();
  private tickerToMarketId: Map<string, string> = new Map();

  constructor(config: AppConfig) {
    this.config = config;
    this.endpoints = getNetworkEndpoints(config.network);
    this.derivativesApi = new IndexerGrpcDerivativesApi(this.endpoints.indexer);
    this.derivativesStream = new IndexerGrpcDerivativesStream(this.endpoints.indexer);

    this.initFollowerWallet();
    this.initTargetSubaccount();
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
        quoteTokenDecimals: m.quoteToken?.decimals || 6,
        minPriceTickSize: Number(m.minPriceTickSize || '1000'),
        minQuantityTickSize: Number(m.minQuantityTickSize || '0.001'),
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
   * 构建并广播衍生品市价单 (跟单核心下单接口)
   *
   * @param params 下单参数
   */
  public async executeDerivativeMarketOrder(params: {
    marketId: string;
    direction: TradeDirection;
    quantity: number;
    price: number;
    leverage: number;
  }): Promise<{ txHash?: string; message: any }> {
    if (!this.followerAddress || !this.followerSubaccountId) {
      throw new Error('未配置跟单钱包，无法执行链上下单。');
    }

    const market = this.getMarket(params.marketId);
    if (!market) {
      throw new Error(`找不到市场详情: ${params.marketId}`);
    }

    const isBuy = params.direction === 'BUY';
    const orderType = isBuy ? OrderTypeMap.BUY : OrderTypeMap.SELL;

    // 格式化价格与数量
    const decimals = market.quoteTokenDecimals;
    const chainPrice = derivativePriceToChainPriceToFixed({
      value: params.price,
      tensMultiplier: decimals,
    });
    const chainQuantity = derivativeQuantityToChainQuantityToFixed({
      value: params.quantity,
    });

    // 计算保证金 Margin = (Price * Quantity) / Leverage
    const notional = new BigNumber(params.price).multipliedBy(params.quantity);
    const marginAmount = notional.dividedBy(params.leverage).toNumber();
    const chainMargin = derivativeMarginToChainMarginToFixed({
      value: marginAmount,
      tensMultiplier: decimals,
    });

    // 手续费接收者: 优先使用设置的 feeRecipient, 其次跟单钱包本身 (捕获 Injective 40% 手续费分成)
    const feeRecipient = this.config.feeRecipient || this.followerAddress;

    // 构造 MsgCreateDerivativeMarketOrder
    const orderMsg = MsgCreateDerivativeMarketOrder.fromJSON({
      injectiveAddress: this.followerAddress,
      subaccountId: this.followerSubaccountId,
      marketId: params.marketId,
      orderType,
      price: chainPrice,
      quantity: chainQuantity,
      margin: chainMargin,
      feeRecipient,
    });

    // 如果为 DRY_RUN 模拟模式，则不实际广播上链
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
}
