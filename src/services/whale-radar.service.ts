import { Bot, InlineKeyboard } from 'grammy';
import { IndexerGrpcDerivativesApi, getInjectiveAddressFromSubaccountId } from '@injectivelabs/sdk-ts';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';
import { AppConfig } from '../config/index.js';

export interface WhaleAlert {
  id: string;
  orderHash: string;
  marketTicker: string;
  marketId: string;
  direction: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  notionalUsd: number;
  traderAddress: string;
  subaccountId: string;
  timestamp: number;
}

export class WhaleRadarService {
  private config: AppConfig;
  private mainnetApi: IndexerGrpcDerivativesApi;
  public bot?: Bot;
  private isRunning: boolean = false;
  private timer?: NodeJS.Timeout;
  private processedTradeIds: Set<string> = new Set();
  private processedOrderKeys: Set<string> = new Set();
  private subscriberChatIds: Set<number> = new Set();
  private marketIdToTicker: Map<string, string> = new Map();
  private majorMarketIds: string[] = [];
  // 巨鲸雷达最小播报门槛：至少 $2,000 USD 以上的大额主動吃单才配叫巨鲸异动！
  private minWhaleNotionalUsd: number = 2000;

  constructor(config: AppConfig, _endpoints: { indexer: string }, bot?: Bot) {
    this.config = config;
    // 始终扫描 Injective 主网 (MainnetSentry) 真实大额撮合成交
    this.mainnetApi = new IndexerGrpcDerivativesApi(
      getNetworkEndpoints(Network.MainnetSentry).indexer
    );
    this.bot = bot;
  }

  public setBot(bot: Bot) {
    this.bot = bot;
  }

  public addSubscriber(chatId: number) {
    this.subscriberChatIds.add(chatId);
  }

  public removeSubscriber(chatId: number) {
    this.subscriberChatIds.delete(chatId);
  }

  public setMonitoredMarkets(_marketIds: string[]) {
    // 内部自动初始化主网高流动性衍生品市场
  }

  /**
   * 启动链上聪明钱大单开仓/加仓雷达
   */
  public async start(pollIntervalMs: number = 10000) {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const markets = await this.mainnetApi.fetchMarkets({ marketStatus: 'active' });
      for (const m of markets) {
        this.marketIdToTicker.set(m.marketId, m.ticker);
      }
      const priorityTickers = [
        'BTC/USDC PERP',
        'ETH/USDC PERP',
        'SOL/USDC PERP',
        'INJ/USDC PERP',
        'HYPE/USDC PERP',
        'XRP/USDC PERP',
        'DOGE/USDC PERP',
        'SUI/USDC PERP',
        'NVDA/USDC PERP',
        'TSLA/USDC PERP',
      ];
      this.majorMarketIds = markets
        .filter((m) => priorityTickers.includes(m.ticker))
        .map((m) => m.marketId);

      if (this.majorMarketIds.length === 0) {
        this.majorMarketIds = markets.slice(0, 8).map((m) => m.marketId);
      }
    } catch (e) {
      // ignore init error
    }

    console.log(
      `[WhaleRadar] 📡 主网巨鲸大单雷达已启动 (过滤阈值: >= $${this.minWhaleNotionalUsd.toLocaleString()} USD, 仅播报主动吃单 Taker)`
    );

    // 预载入历史成交 ID 防止启动瞬间刷屏
    await this.scanRecentTrades(true);

    this.timer = setInterval(() => {
      this.scanRecentTrades(false);
    }, pollIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 扫描主网最新大额巨鲸成交 (严格过滤散户小单与对手方重复单)
   */
  private async scanRecentTrades(isSeeding: boolean = false) {
    if (!this.isRunning && !isSeeding) return;
    if (this.majorMarketIds.length === 0) return;

    try {
      const res = await this.mainnetApi.fetchTrades({
        marketIds: this.majorMarketIds.slice(0, 8),
        pagination: { limit: 30 },
      });

      if (!res || !res.trades) return;

      for (const trade of res.trades) {
        const tradeId = trade.tradeId || trade.orderHash;
        if (!tradeId || this.processedTradeIds.has(tradeId)) continue;
        this.processedTradeIds.add(tradeId);

        if (isSeeding) continue;

        // 1. 只播报主动吃单方 (taker)，彻底避免同一笔撮合的 Maker 和 Taker 重复推送两条相反消息！
        if (trade.executionSide !== 'taker') continue;

        // 2. 同一笔大单被拆分成多个小 fill 时，按 orderHash 去重，只播报一次
        const baseTradeMatchKey = (trade.tradeId || '').split('_')[0] || trade.orderHash;
        if (baseTradeMatchKey && this.processedOrderKeys.has(baseTradeMatchKey)) continue;

        const rawPrice = parseFloat(trade.executionPrice || '0');
        const price = rawPrice / 1e6;
        const qty = parseFloat(trade.executionQuantity || '0');
        const notional = price * qty;

        // 3. 严格过滤小散户：单笔金额小于 $2,000 USD 的绝不打扰用户！
        if (notional < this.minWhaleNotionalUsd) continue;

        if (baseTradeMatchKey) {
          this.processedOrderKeys.add(baseTradeMatchKey);
        }

        let traderAddress = '';
        try {
          traderAddress = getInjectiveAddressFromSubaccountId(trade.subaccountId);
        } catch {
          continue;
        }

        const isBuy = (trade.tradeDirection || '').toLowerCase().includes('buy');
        const ticker = this.marketIdToTicker.get(trade.marketId) || 'INJ/USDC PERP';

        const alert: WhaleAlert = {
          id: tradeId,
          orderHash: trade.orderHash,
          marketTicker: ticker,
          marketId: trade.marketId,
          direction: isBuy ? 'BUY' : 'SELL',
          price: Number(price.toFixed(4)),
          quantity: qty,
          notionalUsd: Math.round(notional),
          traderAddress,
          subaccountId: trade.subaccountId,
          timestamp: trade.executedAt || Date.now(),
        };

        await this.broadcastWhaleAlert(alert);
      }
    } catch {
      // 网络瞬时抖动静默忽略
    }
  }

  /**
   * 向订阅用户推送真正的大额巨鲸异动提醒
   */
  public async broadcastWhaleAlert(alert: WhaleAlert) {
    if (!this.bot) return;

    const isBuy = alert.direction === 'BUY';
    const text = `
🚨 <b>【Injective 主网巨鲸大单异动提醒】</b>

• <b>交易合约</b>: <code>${alert.marketTicker}</code>
• <b>异动方向</b>: ${isBuy ? '🟢 巨鲸主动买入做多 (LONG)' : '🔴 巨鲸主动卖出做空 (SHORT)'}
• <b>成交均价</b>: <b>$${alert.price.toLocaleString()}</b>
• <b>仓位价值</b>: <b>$${alert.notionalUsd.toLocaleString()} USD</b> (${alert.quantity} 张)
• <b>巨鲸地址</b>: <code>${alert.traderAddress}</code>
----------------------------------------
⚡ <i>主网实盘大额异动，点击下方按钮可一键跟随该巨鲸！</i>
    `.trim();

    const keyboard = new InlineKeyboard()
      .text(`⚡ 一键跟单此巨鲸 (${isBuy ? '做多' : '做空'})`, `follow_custom_${alert.traderAddress}`)
      .row()
      .text('🏆 查看聪明钱排行榜', 'view_leaderboard')
      .text('👛 我的钱包', 'view_wallet');

    for (const chatId of this.subscriberChatIds) {
      try {
        await this.bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch {
        // ignore blocked user
      }
    }
  }
}
