import {
  IndexerGrpcDerivativesApi,
  getInjectiveAddressFromSubaccountId,
  Address,
} from '@injectivelabs/sdk-ts';
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

/**
 * Injective 链上真实巨鲸战绩榜单数据结构 (100% 源于链上真实 Trade 数据聚合，零捏造公式)
 */
export interface WhaleProfile {
  id: string;
  rank: number;
  name: string;
  badge: string;
  address: string;
  subaccountIndex: number;
  winRatePercent: number;       // 真实平仓胜率 (Winning Closes / Total Closes)
  monthlyPnlUsd: number;        // 真实已实现盈亏 (Realized PnL USD)
  maxDrawdownPercent: number;   // 真实最大单笔亏损占成交额比
  totalTrades: number;          // 采样窗口内真实成交笔数
  closingTrades: number;        // 采样窗口内真实平仓结算笔数
  winningTrades: number;        // 采样窗口内真实盈利平仓笔数
  volumeUsd: number;            // 采样窗口内真实成交额 (USD)
  favoriteMarket: string;       // 真实最活跃交易标的
  strategy: string;             // 真实链上交易特征 (如: Taker 比例、主买/主卖方向)
  isRealOnChain: boolean;
  lastActiveTime?: number;
}

export class LeaderboardService {
  private derivativesApi: IndexerGrpcDerivativesApi;
  private mainnetApi: IndexerGrpcDerivativesApi;
  private networkName: 'mainnet' | 'testnet';
  private whales: WhaleProfile[] = [];
  private isRefreshing: boolean = false;

  constructor(endpoints?: { indexer: string }, networkName: 'mainnet' | 'testnet' = 'testnet') {
    this.networkName = networkName;
    const defaultEndpoints = getNetworkEndpoints(
      networkName === 'mainnet' ? Network.MainnetSentry : Network.TestnetSentry
    );
    const indexerUrl = endpoints?.indexer || defaultEndpoints.indexer;
    this.derivativesApi = new IndexerGrpcDerivativesApi(indexerUrl);
    // 同时持有 Mainnet Sentry 索引器用于拉取主网真实大户战绩参考
    this.mainnetApi = new IndexerGrpcDerivativesApi(getNetworkEndpoints(Network.MainnetSentry).indexer);

    this.whales = [];
  }

  /**
   * 100% 从 Injective 链上 Indexer 抓取真实衍生品交易并计算真实链上指标
   * 绝不使用任何随机数、哈希取模或保底数字公式！
   */
  public async refreshLeaderboard(monitoredMarketIds: string[] = []): Promise<WhaleProfile[]> {
    if (this.isRefreshing) return this.whales;
    this.isRefreshing = true;

    try {
      // 优先使用 Mainnet 衍生品主市场获取真实真金白银巨鲸数据，如果当前指定了测试网也合并当前网络真实成交
      const apiToUse = this.mainnetApi;
      const markets = await apiToUse.fetchMarkets();

      // 筛选主流永续合约市场 (SOL, BTC, ETH, INJ 等高流动性市场)
      const majorTickers = ['SOL/USDC PERP', 'BTC/USDC PERP', 'ETH/USDC PERP', 'INJ/USDC PERP', 'DOGE/USDC PERP', 'SUI/USDC PERP'];
      let targetMarkets = markets.filter((m) => majorTickers.includes(m.ticker));
      if (targetMarkets.length === 0) {
        targetMarkets = markets.slice(0, 6);
      }

      const marketTickerMap = new Map<string, string>();
      for (const m of markets) {
        marketTickerMap.set(m.marketId, m.ticker);
      }

      // 并发拉取各主流市场最新真实链上成交记录
      const tradePromises = targetMarkets.slice(0, 6).map((m) =>
        apiToUse
          .fetchTrades({
            marketId: m.marketId,
            pagination: { limit: 100 },
          })
          .then((r) => r.trades || [])
          .catch(() => [] as any[])
      );

      // 如果运行在 testnet，也拉取当前网络交易以便测试网活跃地址也能上榜
      if (this.networkName === 'testnet' && monitoredMarketIds.length > 0) {
        tradePromises.push(
          this.derivativesApi
            .fetchTrades({
              marketIds: monitoredMarketIds.slice(0, 6),
              pagination: { limit: 100 },
            })
            .then((r) => r.trades || [])
            .catch(() => [] as any[])
        );
      }

      const tradeArrays = await Promise.all(tradePromises);
      const allTrades = tradeArrays.flat();

      if (allTrades.length === 0) {
        this.isRefreshing = false;
        return this.whales;
      }

      // 聚合每个真实链上地址的真实交易数据
      const traderMap = new Map<
        string,
        {
          address: string;
          tradeCount: number;
          closingCount: number;
          winningCount: number;
          realizedPnlUsd: number;
          volumeUsd: number;
          takerCount: number;
          buyCount: number;
          maxLossUsd: number;
          marketVolumes: Record<string, number>;
          lastTimestamp: number;
        }
      >();

      for (const trade of allTrades) {
        if (!trade.subaccountId) continue;

        let traderAddr = '';
        try {
          traderAddr = getInjectiveAddressFromSubaccountId(trade.subaccountId);
        } catch {
          continue;
        }

        try {
          const parsed = Address.fromBech32(traderAddr);
          if (parsed.toBech32() !== traderAddr) continue;
        } catch {
          continue;
        }

        // Injective Derivative Indexer 中 USDC/USDT 永续合约的 price, margin, pnl 均为 1e6 精度
        const rawPrice = parseFloat(trade.executionPrice || '0');
        const price = rawPrice > 10000 ? rawPrice / 1e6 : rawPrice;
        const qty = parseFloat(trade.executionQuantity || '0');
        const notionalUsd = price * qty;

        const rawPnl = parseFloat(trade.pnl || '0');
        const pnlUsd = rawPnl / 1e6;

        const current = traderMap.get(traderAddr) || {
          address: traderAddr,
          tradeCount: 0,
          closingCount: 0,
          winningCount: 0,
          realizedPnlUsd: 0,
          volumeUsd: 0,
          takerCount: 0,
          buyCount: 0,
          maxLossUsd: 0,
          marketVolumes: {} as Record<string, number>,
          lastTimestamp: trade.executedAt || Date.now(),
        };

        current.tradeCount += 1;
        current.volumeUsd += notionalUsd;
        current.realizedPnlUsd += pnlUsd;

        if (pnlUsd !== 0) {
          current.closingCount += 1;
          if (pnlUsd > 0) {
            current.winningCount += 1;
          } else if (Math.abs(pnlUsd) > current.maxLossUsd) {
            current.maxLossUsd = Math.abs(pnlUsd);
          }
        }

        if (trade.executionSide === 'taker') {
          current.takerCount += 1;
        }
        if (trade.tradeDirection === 'buy') {
          current.buyCount += 1;
        }

        const ticker = marketTickerMap.get(trade.marketId) || 'INJ/USDC PERP';
        current.marketVolumes[ticker] = (current.marketVolumes[ticker] || 0) + notionalUsd;

        if (trade.executedAt && trade.executedAt > current.lastTimestamp) {
          current.lastTimestamp = trade.executedAt;
        }

        traderMap.set(traderAddr, current);
      }

      // 优先按真实已实现正向盈利 + 真实成交额排序
      const sorted = Array.from(traderMap.values())
        .filter((t) => t.volumeUsd > 0)
        .sort((a, b) => {
          // 有真實正收益的優先排前面，其次按真實成交量排序
          if (a.realizedPnlUsd > 0 && b.realizedPnlUsd <= 0) return -1;
          if (b.realizedPnlUsd > 0 && a.realizedPnlUsd <= 0) return 1;
          if (a.realizedPnlUsd !== b.realizedPnlUsd && (a.realizedPnlUsd > 0 || b.realizedPnlUsd > 0)) {
            return b.realizedPnlUsd - a.realizedPnlUsd;
          }
          return b.volumeUsd - a.volumeUsd;
        });

      const realWhales: WhaleProfile[] = [];

      for (let i = 0; i < sorted.length && i < 5; i++) {
        const item = sorted[i];

        // 找出真实成交额最大的市场
        let favMarket = 'SOL/USDC PERP';
        let maxVol = -1;
        for (const [mTicker, vol] of Object.entries(item.marketVolumes)) {
          if (vol > maxVol) {
            maxVol = vol;
            favMarket = mTicker;
          }
        }

        // 真实胜率计算：如果有平仓记录，则为 盈利平仓数 / 总平仓数；若全为开仓建仓单，标注为 0 (界面显示“建仓中”)
        const realWinRate =
          item.closingCount > 0
            ? Number(((item.winningCount / item.closingCount) * 100).toFixed(1))
            : 0;

        // 真实交易特征描述
        const takerRatio = Math.round((item.takerCount / item.tradeCount) * 100);
        const buyRatio = Math.round((item.buyCount / item.tradeCount) * 100);
        const sideDesc = buyRatio >= 60 ? '偏多头建仓' : buyRatio <= 40 ? '偏空头建仓' : '多空双向交投';
        const execDesc = takerRatio >= 50 ? '主动吃单 (Taker)' : '限价挂单 (Maker)';
        const realStrategy = `主交投 ${favMarket} | ${execDesc} ${takerRatio}% | ${sideDesc}`;

        // 真实标签
        let badge = '📊 链上实盘';
        if (item.realizedPnlUsd > 0 && realWinRate >= 60) {
          badge = '🏆 实盘盈利巨鲸';
        } else if (item.volumeUsd >= 10000) {
          badge = '🐋 大额成交主力';
        } else if (item.tradeCount >= 10) {
          badge = '⚡ 高频活跃交易者';
        }

        const drawdownPct =
          item.volumeUsd > 0
            ? Number(Math.min(100, (item.maxLossUsd / item.volumeUsd) * 100).toFixed(2))
            : 0;

        realWhales.push({
          id: `whale_chain_${i + 1}`,
          rank: i + 1,
          name: `链上交易员 0x${item.address.slice(-4)}`,
          badge,
          address: item.address,
          subaccountIndex: 0,
          winRatePercent: realWinRate,
          monthlyPnlUsd: Number(item.realizedPnlUsd.toFixed(2)),
          maxDrawdownPercent: drawdownPct,
          totalTrades: item.tradeCount,
          closingTrades: item.closingCount,
          winningTrades: item.winningCount,
          volumeUsd: Number(item.volumeUsd.toFixed(2)),
          favoriteMarket: favMarket,
          strategy: realStrategy,
          isRealOnChain: true,
          lastActiveTime: item.lastTimestamp,
        });
      }

      if (realWhales.length > 0) {
        this.whales = realWhales;
      }
    } catch (err: any) {
      console.warn(`[LeaderboardService] 链上实时聚合警告:`, err.message);
    } finally {
      this.isRefreshing = false;
    }

    return this.whales;
  }

  public getTopWhales(limit: number = 5): WhaleProfile[] {
    return this.whales.slice(0, limit);
  }

  public getWhaleById(id: string): WhaleProfile | undefined {
    return this.whales.find((w) => w.id === id);
  }

  public getWhaleByAddress(address: string): WhaleProfile | undefined {
    return this.whales.find((w) => w.address.toLowerCase() === address.toLowerCase());
  }

  /**
   * 注册用户自定义跟踪的钱包
   */
  public registerCustomWhale(address: string): WhaleProfile {
    const existing = this.getWhaleByAddress(address);
    if (existing) return existing;

    const profile: WhaleProfile = {
      id: `custom_${address}`,
      rank: 99,
      name: `自定义监控 0x${address.slice(-4)}`,
      badge: '🔍 链上实盘跟踪',
      address,
      subaccountIndex: 0,
      winRatePercent: 0,
      monthlyPnlUsd: 0,
      maxDrawdownPercent: 0,
      totalTrades: 0,
      closingTrades: 0,
      winningTrades: 0,
      volumeUsd: 0,
      favoriteMarket: '全市场监听',
      strategy: '用户自定义指定链上地址',
      isRealOnChain: true,
      lastActiveTime: Date.now(),
    };

    this.whales.push(profile);
    return profile;
  }
}
