import { EventEmitter } from 'events';
import { getSubaccountId, getInjectiveAddressFromSubaccountId } from '@injectivelabs/sdk-ts';
import { AppConfig } from '../config/index.js';
import { InjectiveService } from './injective.service.js';
import { SmartMoneyTradeEvent, TradeDirection } from '../types/index.js';
import { KNOWN_MARKET_MAKERS } from './leaderboard.service.js';

export class SmartMoneyTracker extends EventEmitter {
  private config: AppConfig;
  private injectiveService: InjectiveService;
  private isRunning: boolean = false;
  private isPolling: boolean = false;
  private pollTimer?: NodeJS.Timeout;
  private processedTradeIds: Set<string> = new Set();
  private processedOrderHashes: Set<string> = new Set();
  private readonly maxProcessedCacheSize: number = 10_000;
  private streamSubscriptions: Map<string, any> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private lastSignalMeta: Map<
    string,
    { time: number; direction: string; recentNotionals?: Array<{ ts: number; notional: number }> }
  > = new Map();
  public trackedAddresses: Set<string> = new Set();
  public trackedSubaccounts: Map<string, string> = new Map();

  constructor(config: AppConfig, injectiveService: InjectiveService) {
    super();
    this.config = config;
    this.injectiveService = injectiveService;
    if (this.config.targetTraderAddress) {
      this.registerLocalTarget(this.config.targetTraderAddress, this.config.targetSubaccountIndex || 0);
    }
  }

  private rememberBounded(set: Set<string>, key: string) {
    if (!key || set.has(key)) return;
    set.add(key);
    while (set.size > this.maxProcessedCacheSize) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  private rememberTradeId(tradeId: string) {
    this.rememberBounded(this.processedTradeIds, tradeId);
  }

  private registerLocalTarget(address: string, subaccountIndex: number = 0): string {
    let subId = '';
    if (address.startsWith('0x') && address.length === 66) {
      subId = address.toLowerCase();
      try {
        const bech32 = getInjectiveAddressFromSubaccountId(subId);
        this.trackedAddresses.add(bech32);
        this.trackedSubaccounts.set(subId, bech32);
      } catch {
        this.trackedAddresses.add(address);
        this.trackedSubaccounts.set(subId, address);
      }
      return subId;
    }

    try {
      subId = getSubaccountId(address, subaccountIndex);
    } catch {
      if (address.startsWith('0x')) {
        subId = address;
      }
    }
    if (subId) {
      this.trackedAddresses.add(address);
      this.trackedSubaccounts.set(subId.toLowerCase(), address);
    }
    return subId;
  }

  /**
   * 启动聪明钱监听器 (支持多巨鲸并发监听矩阵)
   */
  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const targetSubaccount = this.injectiveService.targetSubaccountId;
    console.log(`[SmartMoneyTracker] 🚀 启动多巨鲸并发监听引擎...`);
    console.log(`[SmartMoneyTracker] 当前监听矩阵巨鲸数: ${this.trackedAddresses.size}`);
    if (targetSubaccount) {
      console.log(`[SmartMoneyTracker] 主目标子账户: ${targetSubaccount}`);
    }

    // 1. 为矩阵内所有巨鲸建立 WebSocket / gRPC 实时流
    this.startRealtimeStream();

    // 2. 启动多巨鲸并发轮询引擎 (定期拉取所有 trackedSubaccounts 最新成交)
    this.startPolling();
  }

  /**
   * 停止监听
   */
  public stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const sub of this.streamSubscriptions.values()) {
      if (sub && typeof sub.unsubscribe === 'function') {
        try {
          sub.unsubscribe();
        } catch {
          // ignore
        }
      }
    }
    this.streamSubscriptions.clear();
    console.log(`[SmartMoneyTracker] ⏹️ 聪明钱监听器已停止。`);
  }

  /**
   * 向多巨鲸监听矩阵新增一个目标聪明钱地址并即刻启动监听 (绝不覆盖已有监听目标)
   */
  public async addTrackedTrader(address: string, subaccountIndex: number = 0): Promise<string> {
    this.injectiveService.setTargetTrader(address, subaccountIndex);
    const subId = this.registerLocalTarget(address, subaccountIndex);
    console.log(
      `[SmartMoneyTracker] 🎯 已将巨鲸加入并发监控矩阵: ${address} (子账户 #${subaccountIndex}, 当前共监听 ${this.trackedAddresses.size} 位巨鲸)`
    );

    if (subId) {
      await this.seedInitialTrades(subId);
    }

    if (this.isRunning) {
      this.startRealtimeStream();
      if (!this.pollTimer) {
        this.startPolling();
      }
    }

    return subId || '';
  }

  /**
   * 从多巨鲸监听矩阵移除指定巨鲸地址 (支持完整地址或末尾短后缀)
   */
  public removeTrackedTrader(addressOrSuffix: string) {
    const cleanKey = addressOrSuffix.toLowerCase();
    for (const addr of Array.from(this.trackedAddresses)) {
      if (addr.toLowerCase() === cleanKey || addr.toLowerCase().endsWith(cleanKey)) {
        this.trackedAddresses.delete(addr);
      }
    }
    for (const [subId, addr] of Array.from(this.trackedSubaccounts.entries())) {
      if (addr.toLowerCase() === cleanKey || addr.toLowerCase().endsWith(cleanKey)) {
        this.trackedSubaccounts.delete(subId);
        const timer = this.reconnectTimers.get(subId);
        if (timer) {
          clearTimeout(timer);
          this.reconnectTimers.delete(subId);
        }
        this.reconnectAttempts.delete(subId);
        const subStream = this.streamSubscriptions.get(subId);
        if (subStream && typeof subStream.unsubscribe === 'function') {
          try {
            subStream.unsubscribe();
          } catch {
            // ignore
          }
        }
        this.streamSubscriptions.delete(subId);
      }
    }
    console.log(
      `[SmartMoneyTracker] 🗑️ 已从监控矩阵移除目标 (${addressOrSuffix})，剩余监听巨鲸数: ${this.trackedAddresses.size}`
    );
  }

  public getTrackedAddresses(): string[] {
    return Array.from(this.trackedAddresses);
  }

  /**
   * 动态切换/添加监听的目标聪明钱地址 (向后兼容方法，内部调用 addTrackedTrader)
   */
  public async updateTargetTrader(address: string, subaccountIndex: number = 0): Promise<string> {
    return this.addTrackedTrader(address, subaccountIndex);
  }

  public getTargetTrader(): { address: string; subaccountId?: string; trackedCount: number } {
    return {
      address: this.config.targetTraderAddress,
      subaccountId: this.injectiveService.targetSubaccountId,
      trackedCount: this.trackedAddresses.size,
    };
  }

  private scheduleStreamReconnect(subaccountId: string, traderAddress: string) {
    if (!this.isRunning || !this.trackedSubaccounts.has(subaccountId)) return;
    if (this.reconnectTimers.has(subaccountId)) return;

    const existing = this.streamSubscriptions.get(subaccountId);
    if (existing && typeof existing.unsubscribe === 'function') {
      try {
        existing.unsubscribe();
      } catch {
        // ignore
      }
    }
    this.streamSubscriptions.delete(subaccountId);

    const attempts = (this.reconnectAttempts.get(subaccountId) || 0) + 1;
    this.reconnectAttempts.set(subaccountId, attempts);
    const delayMs = Math.min(15_000, 1000 * Math.min(attempts, 10));

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(subaccountId);
      if (this.isRunning && this.trackedSubaccounts.has(subaccountId)) {
        this.subscribeSubaccountStream(subaccountId, traderAddress);
      }
    }, delayMs);
    this.reconnectTimers.set(subaccountId, timer);
  }

  private subscribeSubaccountStream(subaccountId: string, traderAddress: string) {
    if (!this.isRunning || this.streamSubscriptions.has(subaccountId)) return;
    try {
      const sub = this.injectiveService.derivativesStream.streamTrades({
        subaccountId,
        callback: (tradeResponse: any) => {
          if (!this.isRunning) return;
          this.reconnectAttempts.set(subaccountId, 0);
          // @injectivelabs/sdk-ts streamTrades 回调返回 { trade, operation, timestamp }
          const rawTrade = tradeResponse?.trade ? tradeResponse.trade : tradeResponse;
          if (rawTrade) {
            this.handleRawTrade(rawTrade, traderAddress);
          }
        },
        onEndCallback: () => {
          this.scheduleStreamReconnect(subaccountId, traderAddress);
        },
        onStatusCallback: (status) => {
          // Envoy 对空闲连接定期超时关闭时，主动清理句柄并无缝重连，避免流永久失效
          if (status && status.code !== 0) {
            this.scheduleStreamReconnect(subaccountId, traderAddress);
          }
        },
      });
      this.streamSubscriptions.set(subaccountId, sub);
    } catch (err: any) {
      console.warn(`[SmartMoneyTracker] ⚠️ 实时 Stream 启动告警（将使用轮询兜底并尝试重连）:`, err.message);
      this.scheduleStreamReconnect(subaccountId, traderAddress);
    }
  }

  /**
   * 为多巨鲸监控矩阵中的所有子账户建立 gRPC 实时流订阅
   */
  private startRealtimeStream() {
    for (const [subaccountId, traderAddress] of this.trackedSubaccounts.entries()) {
      this.subscribeSubaccountStream(subaccountId, traderAddress);
    }
    if (this.streamSubscriptions.size > 0) {
      console.log(
        `[SmartMoneyTracker] ✅ 多巨鲸实时 gRPC Trade Stream 已就绪 (活跃流数: ${this.streamSubscriptions.size})`
      );
    }
  }

  /**
   * 启动多巨鲸并发轮询机制 (同时监听 trackedSubaccounts 中的所有巨鲸)
   */
  private startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    const poll = async () => {
      if (!this.isRunning || this.isPolling || this.trackedSubaccounts.size === 0) return;
      this.isPolling = true;
      try {
        const entries = Array.from(this.trackedSubaccounts.entries());
        await Promise.all(
          entries.map(async ([subaccountId, traderAddress]) => {
            try {
              const response = await this.injectiveService.derivativesApi.fetchTrades({
                subaccountId,
                pagination: { limit: 10 },
              });

              if (response && response.trades && response.trades.length > 0) {
                for (const trade of response.trades) {
                  this.handleRawTrade(trade, traderAddress);
                }
              }
            } catch {
              // 忽略单节点瞬时网络抖动，不中断轮询
            }
          })
        );
      } finally {
        this.isPolling = false;
      }
    };

    const initialSeeds = Array.from(this.trackedSubaccounts.keys()).map((subId) =>
      this.seedInitialTrades(subId)
    );
    Promise.all(initialSeeds).finally(() => {
      if (this.isRunning && !this.pollTimer) {
        this.pollTimer = setInterval(poll, this.config.pollIntervalMs);
      }
    });
  }

  /**
   * 启动时预载入历史成交，打上已读标记 (同时去重 tradeId 与 orderHash 并预热冷却时间)
   */
  private async seedInitialTrades(subaccountId: string) {
    try {
      const response = await this.injectiveService.derivativesApi.fetchTrades({
        subaccountId,
        pagination: { limit: 50 },
      });
      if (response && response.trades) {
        const nowMs = Date.now();
        for (const t of response.trades) {
          const id = t.tradeId || t.orderHash;
          if (id) {
            this.rememberTradeId(id);
          }
          if (t.orderHash) {
            this.rememberBounded(this.processedOrderHashes, t.orderHash);
          }
          const rawTs = Number(t.executedAt || 0);
          const ts = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
          const execSide = (t.executionSide || '').toLowerCase();
          if (execSide === 'taker' && ts > 0 && nowMs - ts < 600_000) {
            const key = `${subaccountId.toLowerCase()}_${t.marketId}`;
            if (!this.lastSignalMeta.has(key)) {
              const rawDir = (t.tradeDirection || '').toLowerCase();
              this.lastSignalMeta.set(key, {
                time: ts,
                direction: rawDir.includes('buy') ? 'BUY' : 'SELL',
              });
            }
          }
        }
        console.log(`[SmartMoneyTracker] 初始历史交易已去重，过滤历史条目数: ${this.processedTradeIds.size}`);
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * 处理解析单条成交数据并触发事件 (支持 orderHash 严格去重、陈旧成交过滤、TWAP 拆单防刷屏与多巨鲸还原)
   */
  public handleRawTrade(rawTrade: any, fallbackTraderAddress?: string) {
    if (!rawTrade) return;

    const tradeId = rawTrade.tradeId || rawTrade.orderHash;
    if (!tradeId || this.processedTradeIds.has(tradeId)) {
      return;
    }
    this.rememberTradeId(tradeId);

    const orderHash = rawTrade.orderHash || '';
    if (orderHash) {
      if (this.processedOrderHashes.has(orderHash)) {
        return;
      }
      this.rememberBounded(this.processedOrderHashes, orderHash);
    }

    // 过滤陈旧历史成交 (> 2 分钟前)，杜绝重启或重连回放旧单
    const rawTs = Number(rawTrade.executedAt || 0);
    const tradeTs = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
    const nowMs = Date.now();
    if (tradeTs > 0 && nowMs - tradeTs > 120_000) {
      return;
    }

    // 0. 做市商黑名单防御：若来自已知做市商/套利机器人地址，直接丢弃信号
    if (fallbackTraderAddress && KNOWN_MARKET_MAKERS.has(fallbackTraderAddress.toLowerCase())) {
      return;
    }

    // 1. 过滤被动挂单 (Maker) 成交，仅跟随主动吃单 (Taker) 趋势信号
    const execSide = (rawTrade.executionSide || '').toLowerCase();
    if (execSide && execSide !== 'taker') {
      return;
    }

    // 解析市场信息
    const market = this.injectiveService.getMarket(rawTrade.marketId);
    const ticker = market ? market.ticker : rawTrade.marketId;
    const decimals = market?.quoteTokenDecimals || 6;
    const divisor = 10 ** decimals;

    const rawDir = (rawTrade.tradeDirection || rawTrade.orderSide || '').toLowerCase();
    const direction: TradeDirection = rawDir.includes('buy') ? 'BUY' : 'SELL';

    const price = rawTrade.executionPrice
      ? parseFloat(rawTrade.executionPrice) / divisor
      : parseFloat(rawTrade.price || '0');
    const quantity = parseFloat(rawTrade.executionQuantity || rawTrade.quantity || '0');
    const notionalUsd = price * quantity;

    // 2. 过滤碎单与小额 TWAP 定投拆单 (默认 >= $150)
    const minNotional = this.config.minSignalNotionalUsd ?? 150;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0 || notionalUsd < minNotional) {
      return;
    }

    const subId = (rawTrade.subaccountId || this.injectiveService.targetSubaccountId || '').toLowerCase();

    // 3. 子账户 + 市场级冷却、TWAP 重复拆单限流与 HFT 高频双向刷单过滤
    const signalKey = `${subId}_${rawTrade.marketId}`;
    const cooldownMs = this.config.signalCooldownMs ?? 180_000;
    const prevMeta = this.lastSignalMeta.get(signalKey);
    let recentNotionals = prevMeta?.recentNotionals ? [...prevMeta.recentNotionals] : [];
    recentNotionals = recentNotionals.filter((x) => nowMs - x.ts <= 15 * 60_000);

    if (prevMeta) {
      const elapsedMs = nowMs - prevMeta.time;
      // 同方向默认 3 分钟冷却，防止 TWAP / 拆分大单高频重复触发
      if (prevMeta.direction === direction && elapsedMs < cooldownMs) {
        return;
      }
      // 实时 TWAP 拆单拦截：15 分钟内连续 >= 3 笔同向小单 (< $400) 且金额高度接近 (最大/最小 <= 1.2)，30 分钟内抑制重复
      if (prevMeta.direction === direction && notionalUsd < 400 && recentNotionals.length >= 3) {
        const last3 = recentNotionals.slice(-3).map((x) => x.notional);
        const allNums = [...last3, notionalUsd];
        const minN = Math.min(...allNums);
        const maxN = Math.max(...allNums);
        if (minN > 0 && maxN / minN <= 1.2 && elapsedMs < 30 * 60_000) {
          return;
        }
      }
      // 45 秒内反向翻转 (BUY <-> SELL) 且单笔规模 < $5,000，判定为 HFT 网格高频刷单并跳过
      if (prevMeta.direction !== direction && elapsedMs < 45_000 && notionalUsd < 5000) {
        return;
      }
    }
    recentNotionals.push({ ts: nowMs, notional: notionalUsd });
    if (recentNotionals.length > 6) recentNotionals = recentNotionals.slice(-6);
    this.lastSignalMeta.set(signalKey, { time: nowMs, direction, recentNotionals });
    if (this.lastSignalMeta.size > 5000) {
      for (const [k, v] of this.lastSignalMeta.entries()) {
        if (nowMs - v.time > 1800_000) {
          this.lastSignalMeta.delete(k);
        }
      }
    }

    let resolvedTrader =
      this.trackedSubaccounts.get(subId) ||
      fallbackTraderAddress ||
      '';
    if (!resolvedTrader && subId.startsWith('0x')) {
      try {
        resolvedTrader = getInjectiveAddressFromSubaccountId(subId);
      } catch {
        // ignore
      }
    }
    if (!resolvedTrader) {
      resolvedTrader = this.config.targetTraderAddress;
    }

    const event: SmartMoneyTradeEvent = {
      id: tradeId,
      txHash: rawTrade.orderHash || rawTrade.txHash,
      traderAddress: resolvedTrader,
      subaccountId: rawTrade.subaccountId || this.injectiveService.targetSubaccountId || '',
      marketId: rawTrade.marketId,
      marketTicker: ticker,
      direction,
      price,
      quantity,
      notionalUsd,
      orderType: rawTrade.tradeExecutionType || 'market',
      timestamp: rawTrade.executedAt || Date.now(),
      rawEvent: rawTrade,
    };

    console.log(`\n---------------------------------------------------------`);
    console.log(`[SmartMoneyTracker] 🚨 捕获到聪明钱交易信号！`);
    console.log(`  - 触发巨鲸: ${event.traderAddress}`);
    console.log(`  - 市场: ${event.marketTicker}`);
    console.log(`  - 方向: ${event.direction === 'BUY' ? '🟢 做多 (BUY)' : '🔴 做空 (SELL)'}`);
    console.log(`  - 价格: $${event.price} | 数量: ${event.quantity} (约 $${event.notionalUsd.toFixed(2)})`);
    console.log(`  - 交易 ID: ${event.id}`);
    console.log(`---------------------------------------------------------`);

    this.emit('trade', event);
  }

  /**
   * 手动触发模拟事件（测试与仿真）
   */
  public emitManualEvent(event: SmartMoneyTradeEvent) {
    console.log(`[SmartMoneyTracker] 🧪 注入模拟交易事件: ${event.marketTicker} ${event.direction}`);
    this.emit('trade', event);
  }
}
