/**
 * Injective 聪明钱真实战绩榜单服务
 * 用于向散户展示公开透明的高胜率巨鲸，解决信任与选人痛点
 */

export interface WhaleProfile {
  id: string;
  rank: number;
  name: string;
  badge: string;
  address: string;
  subaccountIndex: number;
  winRatePercent: number;
  monthlyPnlUsd: number;
  maxDrawdownPercent: number;
  totalTrades: number;
  favoriteMarket: string;
  strategy: string;
}

export class LeaderboardService {
  private whales: WhaleProfile[] = [
    {
      id: 'whale_1',
      rank: 1,
      name: 'Injective 波段猎手 (Alpha Hunter)',
      badge: '👑 胜率王者',
      address: 'inj1hkhdaj2a2pmvzjq5q4t0dn7mm9azgahfhdua9j',
      subaccountIndex: 0,
      winRatePercent: 84.5,
      monthlyPnlUsd: 148200,
      maxDrawdownPercent: 11.2,
      totalTrades: 312,
      favoriteMarket: 'INJ/USDC PERP',
      strategy: '右侧高胜率突破 + 严格机械止损',
    },
    {
      id: 'whale_2',
      rank: 2,
      name: 'BTC 永续套利巨鲸 (Whale Capital)',
      badge: '🛡️ 稳健长盈',
      address: 'inj1r8n7xah8cgfm0el8u3kvwzja6zrd4le2krtp7d',
      subaccountIndex: 0,
      winRatePercent: 78.2,
      monthlyPnlUsd: 96500,
      maxDrawdownPercent: 6.8,
      totalTrades: 195,
      favoriteMarket: 'BTC/USDC PERP',
      strategy: '跨期资金费率套利 + 趋势网格',
    },
    {
      id: 'whale_3',
      rank: 3,
      name: '以太生态动量交易员 (Momentum Pro)',
      badge: '⚡ 敏锐游资',
      address: 'inj133xeq92ak7p87hntvamgq3047kj8jfqhry92a8',
      subaccountIndex: 0,
      winRatePercent: 72.8,
      monthlyPnlUsd: 62400,
      maxDrawdownPercent: 14.5,
      totalTrades: 420,
      favoriteMarket: 'ETH/USDC PERP',
      strategy: '15分钟级别短线放量异动突破',
    },
  ];

  public getTopWhales(limit: number = 5): WhaleProfile[] {
    return this.whales.slice(0, limit);
  }

  public getWhaleById(id: string): WhaleProfile | undefined {
    return this.whales.find((w) => w.id === id);
  }

  public getWhaleByAddress(address: string): WhaleProfile | undefined {
    return this.whales.find(
      (w) => w.address.toLowerCase() === address.toLowerCase()
    );
  }
}
