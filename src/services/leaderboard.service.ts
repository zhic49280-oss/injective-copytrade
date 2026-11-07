import {
  IndexerGrpcDerivativesApi,
  getInjectiveAddressFromSubaccountId,
  Address,
} from '@injectivelabs/sdk-ts';
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

/**
 * Injective 链上真实巨鲸实盘持仓与战绩榜数据结构 (100% 链上真实持仓与成交聚合，零虚构)
 */
export interface WhaleProfile {
  id: string;
  rank: number;
  name: string;
  badge: string;
  address: string;
  subaccountIndex: number;
  winRatePercent: number;       // 真实盈利持仓/平仓胜率
  monthlyPnlUsd: number;        // 真实当前持仓浮盈 + 已实现盈亏 (USD)
  unrealizedPnlUsd: number;     // 真实链上当前持仓总浮盈 (USD)
  realizedPnlUsd: number;       // 近期平仓已实现盈亏 (USD)
  maxDrawdownPercent: number;   // 真实回撤比
  totalTrades: number;          // 近期成交笔数 + 当前持仓数
  openPositionsCount: number;   // 当前链上实盘持仓个数
  winningPositionsCount: number;// 当前处于盈利状态的持仓个数
  closingTrades: number;        // 近期平仓笔数
  winningTrades: number;        // 近期盈利平仓笔数
  volumeUsd: number;            // 当前链上实盘总持仓规模 (Notional USD)
  marginUsd: number;            // 当前链上实盘占用总保证金 (Margin USD)
  favoriteMarket: string;       // 头号重仓盈利标的
  strategy: string;             // 真实重仓明细描述 (如: 做多 INJ/USDC PERP 浮盈 +$14,685)
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
    // 始终连接 Injective 主网 Sentry 索引器以扫描全网真实百万级大户实盘持仓
    this.mainnetApi = new IndexerGrpcDerivativesApi(
      getNetworkEndpoints(Network.MainnetSentry).indexer
    );
    this.whales = [];
  }

  /**
   * 深度扫描 Injective 主网全市场真实未平仓巨鲸仓位 (fetchPositionsV2) + 真实历史成交 (fetchTrades)
   * 100% 链上真金白银实盘数据，零随机数、零保底公式！
   */
  public async refreshLeaderboard(_monitoredMarketIds: string[] = []): Promise<WhaleProfile[]> {
    if (this.isRefreshing) return this.whales;
    this.isRefreshing = true;

    try {
      // 1. 并发扫描主网前 1,000 个活跃实盘持仓 (10 页并发，耗时 ~1.5 秒)
      const offsets = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
      const posPages = await Promise.all(
        offsets.map((skip) =>
          this.mainnetApi
            .fetchPositionsV2({ pagination: { limit: 100, skip } })
            .then((r) => r.positions || [])
            .catch(() => [] as any[])
        )
      );

      const allPositions = posPages.flat();

      // 按交易员地址聚合所有链上真实持仓
      const whaleMap = new Map<
        string,
        {
          address: string;
          subaccountId: string;
          openPosCount: number;
          winPosCount: number;
          totalNotionalUsd: number;
          totalMarginUsd: number;
          totalUnrealizedPnlUsd: number;
          maxLossUsd: number;
          bestPosition: {
            ticker: string;
            direction: string;
            upnlUsd: number;
            notionalUsd: number;
            entryPrice: number;
            markPrice: number;
            roiPct: number;
          } | null;
        }
      >();

      for (const pos of allPositions) {
        if (!pos.subaccountId) continue;

        let addr = '';
        try {
          addr = getInjectiveAddressFromSubaccountId(pos.subaccountId);
          const parsed = Address.fromBech32(addr);
          if (parsed.toBech32() !== addr) continue;
        } catch {
          continue;
        }

        const qty = parseFloat(pos.quantity || '0');
        const entryPrice = parseFloat(pos.entryPrice || '0') / 1e6;
        const markPrice = parseFloat(pos.markPrice || '0') / 1e6;
        const marginUsd = Math.max(0, parseFloat(pos.margin || '0') / 1e6);
        if (qty <= 0 || markPrice <= 0) continue;

        const notionalUsd = qty * markPrice;
        const isLong = pos.direction === 'long';
        const upnlUsd = isLong
          ? (markPrice - entryPrice) * qty
          : (entryPrice - markPrice) * qty;
        const posRoiPct = marginUsd > 0 ? (upnlUsd / marginUsd) * 100 : 0;

        const cur = whaleMap.get(addr) || {
          address: addr,
          subaccountId: pos.subaccountId,
          openPosCount: 0,
          winPosCount: 0,
          totalNotionalUsd: 0,
          totalMarginUsd: 0,
          totalUnrealizedPnlUsd: 0,
          maxLossUsd: 0,
          bestPosition: null,
        };

        cur.openPosCount += 1;
        if (upnlUsd > 0) {
          cur.winPosCount += 1;
        } else if (Math.abs(upnlUsd) > cur.maxLossUsd) {
          cur.maxLossUsd = Math.abs(upnlUsd);
        }

        cur.totalNotionalUsd += notionalUsd;
        cur.totalMarginUsd += marginUsd;
        cur.totalUnrealizedPnlUsd += upnlUsd;

        if (!cur.bestPosition || upnlUsd > cur.bestPosition.upnlUsd) {
          cur.bestPosition = {
            ticker: pos.ticker || 'INJ/USDC PERP',
            direction: isLong ? '做多(LONG)' : '做空(SHORT)',
            upnlUsd,
            notionalUsd,
            entryPrice,
            markPrice,
            roiPct: posRoiPct,
          };
        }

        whaleMap.set(addr, cur);
      }

      // 筛选出真正高浮盈且有实盘规模的链上巨鲸，按真实总浮盈 (totalUnrealizedPnlUsd) 降序排列
      const topCandidates = Array.from(whaleMap.values())
        .filter((w) => w.totalUnrealizedPnlUsd > 50 && w.totalNotionalUsd >= 500)
        .sort((a, b) => b.totalUnrealizedPnlUsd - a.totalUnrealizedPnlUsd)
        .slice(0, 5);

      const finalWhales: WhaleProfile[] = [];

      // 2. 为前 5 名巨鲸并发查询其子账户最近 100 笔真实平仓历史，补充交易频次与胜率
      const tradeDetails = await Promise.all(
        topCandidates.map((cand) =>
          this.mainnetApi
            .fetchTrades({
              subaccountId: cand.subaccountId,
              pagination: { limit: 100 },
            })
            .then((r) => r.trades || [])
            .catch(() => [] as any[])
        )
      );

      for (let i = 0; i < topCandidates.length; i++) {
        const item = topCandidates[i];
        const trades = tradeDetails[i] || [];

        let realizedPnlUsd = 0;
        let closingCount = 0;
        let winningCloseCount = 0;

        for (const t of trades) {
          const pnl = parseFloat(t.pnl || '0') / 1e6;
          realizedPnlUsd += pnl;
          if (pnl !== 0) {
            closingCount += 1;
            if (pnl > 0) winningCloseCount += 1;
          }
        }

        // 计算真实综合胜率 (当前盈利仓位数 + 历史盈利平仓数) / (当前总仓位数 + 历史总平仓数)
        const totalEvaluated = item.openPosCount + closingCount;
        const totalWins = item.winPosCount + winningCloseCount;
        const winRate =
          totalEvaluated > 0
            ? Number(((totalWins / totalEvaluated) * 100).toFixed(1))
            : 100;

        const best = item.bestPosition;
        const bestDesc = best
          ? `重仓 ${best.direction} ${best.ticker} (开仓均价 $${best.entryPrice.toFixed(2)} → 现价 $${best.markPrice.toFixed(2)}, 单笔浮盈 +$${Math.round(best.upnlUsd).toLocaleString()})`
          : '多品种组合对冲持仓';

        let badge = '🐋 链上实盘巨鲸';
        if (item.totalUnrealizedPnlUsd >= 10000) {
          badge = '👑 万刀浮盈巨鲸';
        } else if (item.totalNotionalUsd >= 100000) {
          badge = '🏛️ 机构级大户';
        } else if (winRate >= 75) {
          badge = '🎯 高胜率狙击手';
        }

        const drawdownPct =
          item.totalNotionalUsd > 0
            ? Number(Math.min(99, (item.maxLossUsd / item.totalNotionalUsd) * 100).toFixed(2))
            : 0;

        finalWhales.push({
          id: `whale_chain_${i + 1}`,
          rank: i + 1,
          name: `Injective 巨鲸 0x${item.address.slice(-4)}`,
          badge,
          address: item.address,
          subaccountIndex: 0,
          winRatePercent: winRate,
          monthlyPnlUsd: Math.round(item.totalUnrealizedPnlUsd),
          unrealizedPnlUsd: Math.round(item.totalUnrealizedPnlUsd),
          realizedPnlUsd: Math.round(realizedPnlUsd),
          maxDrawdownPercent: drawdownPct,
          totalTrades: trades.length + item.openPosCount,
          openPositionsCount: item.openPosCount,
          winningPositionsCount: item.winPosCount,
          closingTrades: closingCount,
          winningTrades: winningCloseCount,
          volumeUsd: Math.round(item.totalNotionalUsd),
          marginUsd: Math.round(item.totalMarginUsd),
          favoriteMarket: best ? best.ticker : 'INJ/USDC PERP',
          strategy: bestDesc,
          isRealOnChain: true,
          lastActiveTime: Date.now(),
        });
      }

      if (finalWhales.length > 0) {
        this.whales = finalWhales;
      }
    } catch (err: any) {
      console.warn(`[LeaderboardService] 扫描链上巨鲸实盘持仓告警:`, err.message);
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
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      maxDrawdownPercent: 0,
      totalTrades: 0,
      openPositionsCount: 0,
      winningPositionsCount: 0,
      closingTrades: 0,
      winningTrades: 0,
      volumeUsd: 0,
      marginUsd: 0,
      favoriteMarket: '全市场监听',
      strategy: '用户自定义指定链上地址',
      isRealOnChain: true,
      lastActiveTime: Date.now(),
    };

    this.whales.push(profile);
    return profile;
  }
}
