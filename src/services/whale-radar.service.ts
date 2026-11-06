import { Bot, InlineKeyboard } from 'grammy';
import { IndexerGrpcDerivativesApi } from '@injectivelabs/sdk-ts';
import { getInjectiveAddressFromSubaccountId } from '@injectivelabs/sdk-ts';
import { AppConfig } from '../config/index.js';

export interface WhaleAlert {
  id: string;
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
  private derivativesApi: IndexerGrpcDerivativesApi;
  public bot?: Bot;
  private isRunning: boolean = false;
  private timer?: NodeJS.Timeout;
  private processedTradeIds: Set<string> = new Set();
  private subscriberChatIds: Set<number> = new Set();
  private monitoredMarketIds: string[] = [];

  constructor(config: AppConfig, endpoints: { indexer: string }, bot?: Bot) {
    this.config = config;
    this.derivativesApi = new IndexerGrpcDerivativesApi(endpoints.indexer);
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

  public setMonitoredMarkets(marketIds: string[]) {
    this.monitoredMarketIds = marketIds;
  }

  /**
   * 启动链上聪明钱开仓加仓雷达
   */
  public async start(pollIntervalMs: number = 5000) {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[WhaleRadar] 📡 聪明钱开仓/加仓异动雷达已启动，实时监听全网巨鲸异动...`);

    // 预载入一次去重
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
   * 扫描全市场最新大额成交
   */
  private async scanRecentTrades(isSeeding: boolean = false) {
    if (!this.isRunning && !isSeeding) return;
    if (this.monitoredMarketIds.length === 0) return;

    try {
      const res = await this.derivativesApi.fetchTrades({
        marketIds: this.monitoredMarketIds.slice(0, 10),
        pagination: { limit: 15 },
      });

      if (!res || !res.trades) return;

      for (const trade of res.trades) {
        const tradeId = trade.tradeId || trade.orderHash;
        if (!tradeId || this.processedTradeIds.has(tradeId)) continue;
        this.processedTradeIds.add(tradeId);

        if (isSeeding) continue;

        // 解析真实地址
        let traderAddress = '0x...';
        try {
          traderAddress = getInjectiveAddressFromSubaccountId(trade.subaccountId);
        } catch (e) {
          traderAddress = trade.subaccountId ? trade.subaccountId.substring(0, 10) + '...' : 'Unknown';
        }

        const rawPrice = parseFloat(trade.executionPrice || '0');
        const price = rawPrice > 10000 ? rawPrice / 1e6 : rawPrice;
        const qty = parseFloat(trade.executionQuantity || '0');
        const notional = price * qty;

        const isBuy = (trade.tradeDirection || '').toLowerCase().includes('buy');

        const alert: WhaleAlert = {
          id: tradeId,
          marketTicker: 'INJ/USDC PERP',
          marketId: trade.marketId,
          direction: isBuy ? 'BUY' : 'SELL',
          price: Number(price.toFixed(4)),
          quantity: qty,
          notionalUsd: Number(notional.toFixed(2)),
          traderAddress,
          subaccountId: trade.subaccountId,
          timestamp: trade.executedAt || Date.now(),
        };

        // 触发自动推送
        await this.broadcastWhaleAlert(alert);
      }
    } catch (e) {
      // 避免抖动报错中断
    }
  }

  /**
   * 向所有用户群发巨鲸异动警报卡片
   */
  public async broadcastWhaleAlert(alert: WhaleAlert) {
    if (!this.bot) return;

    const isBuy = alert.direction === 'BUY';
    const text = `
🚨 <b>【Injective 链上聪明钱开仓/加仓提醒】</b>

• <b>交易资产</b>: <code>${alert.marketTicker}</code>
• <b>异动方向</b>: ${isBuy ? '🟢 巨鲸买入做多 (LONG)' : '🔴 巨鲸卖出做空 (SHORT)'}
• <b>成交价格</b>: <b>$${alert.price}</b>
• <b>开仓规模</b>: <b>${alert.quantity} 币 (约 $${alert.notionalUsd.toLocaleString()} USD)</b>
• <b>巨鲸地址</b>: <code>${alert.traderAddress}</code>
• <b>撮合类型</b>: 链上真实撮合成交 (On-Chain)
----------------------------------------
⚡ <i>发现新的投资机会，点击下方按钮立即自动复制仓位！</i>
    `;

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
      } catch (err) {
        // 用户可能封禁了机器人
      }
    }
  }
}
