import { Bot, InlineKeyboard } from 'grammy';
import { IndexerGrpcDerivativesApi, getInjectiveAddressFromSubaccountId } from '@injectivelabs/sdk-ts';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';
import { AppConfig } from '../config/index.js';
import { KNOWN_MARKET_MAKERS, isMarketMakerOrHftBot } from './leaderboard.service.js';

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
  private isScanning: boolean = false;
  private timer?: NodeJS.Timeout;
  private processedTradeIds: Set<string> = new Set();
  private processedOrderKeys: Set<string> = new Set();
  private readonly maxCacheSize: number = 10_000;
  private subscriberChatIds: Set<number> = new Set();
  private marketIdToTicker: Map<string, string> = new Map();
  private marketIdToDecimals: Map<string, number> = new Map();
  private recentBroadcastCooldowns: Map<string, number> = new Map();
  private recentTraderSide: Map<string, { direction: 'BUY' | 'SELL'; ts: number }> = new Map();
  private mmAuditCache: Map<string, { isMm: boolean; expiresAt: number }> = new Map();
  private majorMarketIds: string[] = [];
  private otherMarketIds: string[] = [];
  private otherScanCursor: number = 0;
  // 巨鲸雷达最小播报门槛：至少 $2,000 USD 以上的大额主动吃单才配叫巨鲸异动！
  private minWhaleNotionalUsd: number = 2000;

  constructor(config: AppConfig, _endpoints: { indexer: string }, bot?: Bot) {
    this.config = config;
    this.minWhaleNotionalUsd = Math.max(2000, config.whaleRadarMinNotionalUsd || 2000);
    // 始终扫描 Injective 主网 (MainnetSentry) 真实大额撮合成交
    this.mainnetApi = new IndexerGrpcDerivativesApi(
      getNetworkEndpoints(Network.MainnetSentry).indexer
    );
    this.bot = bot;
  }

  private rememberBounded(set: Set<string>, key: string) {
    if (set.has(key)) return;
    set.add(key);
    while (set.size > this.maxCacheSize) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
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
        this.marketIdToDecimals.set(m.marketId, m.quoteToken?.decimals ?? 6);
      }
      const priorityTickers = [
        'BTC/USDC PERP',
        'ETH/USDC PERP',
        'SOL/USDC PERP',
        'INJ/USDC PERP',
        'XRP/USDC PERP',
        'DOGE/USDC PERP',
        'SUI/USDC PERP',
        'BNB/USDC PERP',
        'AVAX/USDC PERP',
        'TON/USDC PERP',
      ];
      const majorSet = new Set<string>();
      for (const m of markets) {
        if (priorityTickers.includes(m.ticker)) {
          majorSet.add(m.marketId);
        }
      }
      this.majorMarketIds = Array.from(majorSet);
      this.otherMarketIds = markets
        .filter((m) => !majorSet.has(m.marketId))
        .map((m) => m.marketId);

      if (this.majorMarketIds.length === 0) {
        this.majorMarketIds = markets.slice(0, 8).map((m) => m.marketId);
        this.otherMarketIds = markets.slice(8).map((m) => m.marketId);
      }
    } catch (e) {
      // ignore init error
    }

    console.log(
      `[WhaleRadar] 📡 全市场巨鲸大单雷达已启动 (核心独立监控 ${this.majorMarketIds.length} 市场 + 轮巡其余 ${this.otherMarketIds.length} 市场，阈值 >= $${this.minWhaleNotionalUsd.toLocaleString()} USD)`
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
   * 审计地址是否为做市商或高频刷量机器人 (带 30 分钟缓存)
   */
  private async isAddressFilteredAsBot(traderAddress: string, subaccountId: string): Promise<boolean> {
    const lowerAddr = traderAddress.toLowerCase();
    if (KNOWN_MARKET_MAKERS.has(lowerAddr)) return true;

    const nowMs = Date.now();
    const cached = this.mmAuditCache.get(lowerAddr);
    if (cached && cached.expiresAt > nowMs) {
      return cached.isMm;
    }

    let isMm = false;
    try {
      const res = await this.mainnetApi.fetchTrades({
        subaccountId,
        pagination: { limit: 30 },
      });
      const trades = res?.trades || [];
      if (trades.length >= 2) {
        const audit = isMarketMakerOrHftBot({
          address: traderAddress,
          trades,
          marketDecimalsMap: this.marketIdToDecimals,
        });
        isMm = audit.isMarketMaker;
      }
    } catch {
      // 网络失败时不误杀真实巨鲸
    }

    this.mmAuditCache.set(lowerAddr, { isMm, expiresAt: nowMs + 1_800_000 });
    if (this.mmAuditCache.size > 2000) {
      for (const [k, v] of this.mmAuditCache.entries()) {
        if (v.expiresAt <= nowMs) this.mmAuditCache.delete(k);
      }
    }
    return isMm;
  }

  /**
   * 解析并播报单批 taker 成交
   */
  private async processFetchedTrades(trades: any[], isSeeding: boolean) {
    const orderedTrades = [...trades].sort(
      (a, b) => Number(a.executedAt || 0) - Number(b.executedAt || 0)
    );
    for (const trade of orderedTrades) {
      const tradeId = trade.tradeId || trade.orderHash;
      if (!tradeId || this.processedTradeIds.has(tradeId)) continue;
      this.rememberBounded(this.processedTradeIds, tradeId);

      if (isSeeding) {
        const seedOrderKey = trade.orderHash || (trade.tradeId || '').split('_')[0];
        if (seedOrderKey) this.rememberBounded(this.processedOrderKeys, seedOrderKey);
        continue;
      }

      // 过滤陈旧成交 (> 2 分钟前)
      const rawTs = Number(trade.executedAt || 0);
      const tradeTs = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
      const nowMs = Date.now();
      if (tradeTs > 0 && nowMs - tradeTs > 120_000) continue;

      // 1. 只播报主动吃单方 (taker)，彻底避免同一笔撮合的 Maker 和 Taker 重复推送两条相反消息！
      if (trade.executionSide !== 'taker') continue;

      // 2. 同一笔大单被拆分成多个小 fill 时，按 orderHash / 主单号去重，只播报一次
      const baseTradeMatchKey = trade.orderHash || (trade.tradeId || '').split('_')[0];
      if (baseTradeMatchKey && this.processedOrderKeys.has(baseTradeMatchKey)) continue;

      const decimals = this.marketIdToDecimals.get(trade.marketId) ?? 6;
      const divisor = 10 ** decimals;
      const rawPrice = parseFloat(trade.executionPrice || '0');
      const price = rawPrice / divisor;
      const qty = parseFloat(trade.executionQuantity || '0');
      const notional = price * qty;

      // 3. 严格过滤小散户：单笔金额小于 $2,000 USD 的绝不打扰用户！
      if (!Number.isFinite(notional) || notional < this.minWhaleNotionalUsd) continue;

      if (baseTradeMatchKey) {
        this.rememberBounded(this.processedOrderKeys, baseTradeMatchKey);
      }

      let traderAddress = '';
      try {
        traderAddress = getInjectiveAddressFromSubaccountId(trade.subaccountId);
      } catch {
        continue;
      }

      if (KNOWN_MARKET_MAKERS.has(traderAddress.toLowerCase())) continue;

      const isBuy = (trade.tradeDirection || '').toLowerCase().includes('buy');
      const direction: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';

      // 4. 过滤 120 秒内同地址同合约反手对倒/刷量 (如 18 秒内先卖后买同额)
      const sideKey = `${traderAddress.toLowerCase()}_${trade.marketId}`;
      const prevSide = this.recentTraderSide.get(sideKey);
      this.recentTraderSide.set(sideKey, { direction, ts: nowMs });
      if (this.recentTraderSide.size > 2000) {
        for (const [k, v] of this.recentTraderSide.entries()) {
          if (nowMs - v.ts > 300_000) this.recentTraderSide.delete(k);
        }
      }
      if (prevSide && prevSide.direction !== direction && nowMs - prevSide.ts < 120_000) {
        continue;
      }

      // 5. 同一巨鲸 + 同一合约 + 同一方向 5 分钟内只播报一次，防止拆分大单刷屏
      const cooldownKey = `${traderAddress.toLowerCase()}_${trade.marketId}_${direction}`;
      const lastAlertTime = this.recentBroadcastCooldowns.get(cooldownKey) || 0;
      if (nowMs - lastAlertTime < 300_000) continue;

      // 6. 审计地址近期成交，过滤做市商 / 高频刷量 / TWAP 机器人
      if (await this.isAddressFilteredAsBot(traderAddress, trade.subaccountId)) {
        continue;
      }

      this.recentBroadcastCooldowns.set(cooldownKey, nowMs);
      if (this.recentBroadcastCooldowns.size > 2000) {
        for (const [k, ts] of this.recentBroadcastCooldowns.entries()) {
          if (nowMs - ts > 600_000) this.recentBroadcastCooldowns.delete(k);
        }
      }

      const ticker = this.marketIdToTicker.get(trade.marketId) || 'INJ/USDC PERP';

      const cleanPrice =
        price >= 100
          ? Number(price.toFixed(2))
          : price >= 1
          ? Number(price.toFixed(4))
          : price >= 0.001
          ? Number(price.toFixed(6))
          : Number(price.toPrecision(6));

      const alert: WhaleAlert = {
        id: tradeId,
        orderHash: trade.orderHash,
        marketTicker: ticker,
        marketId: trade.marketId,
        direction,
        price: cleanPrice,
        quantity: qty,
        notionalUsd: Math.round(notional),
        traderAddress,
        subaccountId: trade.subaccountId,
        timestamp: tradeTs || nowMs,
      };

      await this.broadcastWhaleAlert(alert);
    }
  }

  /**
   * 扫描主网最新大额巨鲸成交 (核心主流市场独立扫描 + 其余全部活跃市场轮询全覆盖)
   */
  private async scanRecentTrades(isSeeding: boolean = false) {
    if (!this.isRunning && !isSeeding) return;
    if ((this.majorMarketIds.length === 0 && this.otherMarketIds.length === 0) || this.isScanning) return;

    this.isScanning = true;
    try {
      // 1. 独立扫描核心主流市场 (BTC/ETH/SOL/INJ 等)，彻底防止冷门/美股 $1 机器人刷爆共享分页窗口
      const majorResults = await Promise.allSettled(
        this.majorMarketIds.map((marketId) =>
          this.mainnetApi.fetchTrades({
            marketId,
            executionSide: 'taker',
            pagination: { limit: 15 },
          })
        )
      );
      for (const r of majorResults) {
        if (r.status === 'fulfilled' && r.value?.trades?.length) {
          await this.processFetchedTrades(r.value.trades, isSeeding);
        }
      }

      // 2. 分批扫描其余全部活跃衍生品市场 (覆盖 300+ 个全链合约，每轮最多 3 批 x 35 个合约 ≈ 18 秒全量扫一遍)
      if (this.otherMarketIds.length > 0) {
        const batchSize = 35;
        const batches: string[][] = [];

        if (isSeeding) {
          for (let i = 0; i < this.otherMarketIds.length; i += batchSize) {
            batches.push(this.otherMarketIds.slice(i, i + batchSize));
          }
        } else {
          const batchesPerCycle = 3;
          for (let b = 0; b < batchesPerCycle; b++) {
            if (this.otherScanCursor >= this.otherMarketIds.length) {
              this.otherScanCursor = 0;
            }
            const slice = this.otherMarketIds.slice(
              this.otherScanCursor,
              this.otherScanCursor + batchSize
            );
            this.otherScanCursor += batchSize;
            if (slice.length > 0) {
              batches.push(slice);
            }
            if (this.otherScanCursor >= this.otherMarketIds.length) {
              this.otherScanCursor = 0;
              break;
            }
          }
        }

        const otherResults = await Promise.allSettled(
          batches.map((marketIds) =>
            this.mainnetApi.fetchTrades({
              marketIds,
              executionSide: 'taker',
              pagination: { limit: 40 },
            })
          )
        );
        for (const r of otherResults) {
          if (r.status === 'fulfilled' && r.value?.trades?.length) {
            await this.processFetchedTrades(r.value.trades, isSeeding);
          }
        }
      }
    } catch {
      // 网络瞬时抖动静默忽略
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * 向订阅用户及广播频道推送真正的大额巨鲸异动提醒 (分批并发推送 + 自动清理已拉黑用户，防止阻塞与 429 限流)
   */
  public async broadcastWhaleAlert(alert: WhaleAlert) {
    if (!this.bot) return;
    if (this.subscriberChatIds.size === 0 && !this.config.telegramBroadcastChatId) return;

    const isBuy = alert.direction === 'BUY';
    const text = `
🚨 <b>【Injective 主网巨鲸大单异动提醒】</b>

• <b>交易合约</b>: <code>${alert.marketTicker}</code>
• <b>异动方向</b>: ${isBuy ? '🟢 巨鲸主动买入做多 (LONG)' : '🔴 巨鲸主动卖出做空 (SHORT)'}
• <b>成交均价</b>: <b>$${alert.price.toLocaleString('en-US', { maximumSignificantDigits: 6 })}</b>
• <b>仓位价值</b>: <b>$${alert.notionalUsd.toLocaleString()} USD</b> (${alert.quantity} 张)
• <b>巨鲸地址</b>: <code>${alert.traderAddress}</code>
----------------------------------------
⚡ <i>主网实盘大额异动，点击下方按钮可一键跟随该巨鲸！</i>
    `.trim();

    // 广播频道/群聊使用深链 ?start=follow_<addr>，点击直接跳入私聊锁定该巨鲸
    if (this.config.telegramBroadcastChatId) {
      const botUsername = this.bot.botInfo?.username;
      const channelKb = botUsername
        ? new InlineKeyboard().url(
            `⚡ 一键跟单此巨鲸 (${isBuy ? '做多' : '做空'})`,
            `https://t.me/${botUsername}?start=follow_${alert.traderAddress}`
          )
        : undefined;
      await this.bot.api
        .sendMessage(this.config.telegramBroadcastChatId, text, {
          parse_mode: 'HTML',
          reply_markup: channelKb,
        })
        .catch(() => {});
    }

    if (this.subscriberChatIds.size === 0) return;

    const keyboard = new InlineKeyboard()
      .text(`⚡ 一键跟单此巨鲸 (${isBuy ? '做多' : '做空'})`, `follow_custom_${alert.traderAddress}`)
      .row()
      .text('🏆 查看聪明钱排行榜', 'view_leaderboard')
      .text('👛 我的钱包', 'view_wallet');

    const chatIds = Array.from(this.subscriberChatIds);
    const batchSize = 15;
    for (let i = 0; i < chatIds.length; i += batchSize) {
      const batch = chatIds.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (chatId) => {
          try {
            await this.bot!.api.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
            });
          } catch (err: any) {
            const msg = String(err?.description || err?.message || '');
            if (msg.includes('blocked') || msg.includes('chat not found') || err?.error_code === 403) {
              this.subscriberChatIds.delete(chatId);
            }
          }
        })
      );
      if (i + batchSize < chatIds.length) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
}
