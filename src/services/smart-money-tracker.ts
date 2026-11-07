import { EventEmitter } from 'events';
import { getSubaccountId, getInjectiveAddressFromSubaccountId } from '@injectivelabs/sdk-ts';
import { AppConfig } from '../config/index.js';
import { InjectiveService } from './injective.service.js';
import { SmartMoneyTradeEvent, TradeDirection } from '../types/index.js';

export class SmartMoneyTracker extends EventEmitter {
  private config: AppConfig;
  private injectiveService: InjectiveService;
  private isRunning: boolean = false;
  private pollTimer?: NodeJS.Timeout;
  private processedTradeIds: Set<string> = new Set();
  private streamSubscriptions: Map<string, any> = new Map();
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

  private registerLocalTarget(address: string, subaccountIndex: number = 0): string {
    let subId = '';
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
      `[SmartMoneyTracker] 🎯 已将巨鲸加入并发监控矩阵: ${address} (当前共监听 ${this.trackedAddresses.size} 位巨鲸)`
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

  /**
   * 为多巨鲸监控矩阵中的所有子账户建立 gRPC 实时流订阅
   */
  private startRealtimeStream() {
    for (const [subaccountId, traderAddress] of this.trackedSubaccounts.entries()) {
      if (this.streamSubscriptions.has(subaccountId)) continue;

      try {
        const sub = this.injectiveService.derivativesStream.streamTrades({
          subaccountId,
          callback: (tradeResponse) => {
            if (!this.isRunning) return;
            this.handleRawTrade(tradeResponse, traderAddress);
          },
          onStatusCallback: (status) => {
            // Injective gRPC Envoy 会对无交易空闲连接进行周期性重置 (DEADLINE_EXCEEDED / Gateway Timeout)
            // 这是 HTTP/2 长连接心跳正常机制，底层与轮询兜底会自动无缝续期，静默过滤避免刷屏
            if (
              status?.code === 2 ||
              status?.code === 1 ||
              status?.details === 'Gateway Timeout' ||
              (typeof (status as any)?.details === 'string' && (status as any).details.includes('Timeout'))
            ) {
              return;
            }
            if (status && status.code !== 0 && status.details) {
              console.log(`[SmartMoneyTracker] gRPC Stream 状态更新: ${status.details}`);
            }
          },
        });
        this.streamSubscriptions.set(subaccountId, sub);
      } catch (err: any) {
        console.warn(`[SmartMoneyTracker] ⚠️ 实时 Stream 启动告警（将使用轮询机制兜底）:`, err.message);
      }
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
      if (!this.isRunning || this.trackedSubaccounts.size === 0) return;

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
   * 启动时预载入历史成交，打上已读标记
   */
  private async seedInitialTrades(subaccountId: string) {
    try {
      const response = await this.injectiveService.derivativesApi.fetchTrades({
        subaccountId,
        pagination: { limit: 20 },
      });
      if (response && response.trades) {
        for (const t of response.trades) {
          const id = t.tradeId || t.orderHash;
          if (id) {
            this.processedTradeIds.add(id);
          }
        }
        console.log(`[SmartMoneyTracker] 初始历史交易已去重，过滤历史条目数: ${this.processedTradeIds.size}`);
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * 处理解析单条成交数据并触发事件 (支持精确还原多巨鲸中的具体触发者地址)
   */
  public handleRawTrade(rawTrade: any, fallbackTraderAddress?: string) {
    if (!rawTrade) return;

    const tradeId = rawTrade.tradeId || rawTrade.orderHash;
    if (!tradeId || this.processedTradeIds.has(tradeId)) {
      return;
    }

    this.processedTradeIds.add(tradeId);

    // 解析市场信息
    const market = this.injectiveService.getMarket(rawTrade.marketId);
    const ticker = market ? market.ticker : rawTrade.marketId;
    const decimals = market?.quoteTokenDecimals || 6;
    const divisor = 10 ** decimals;

    const rawDir = (rawTrade.tradeDirection || rawTrade.orderSide || '').toLowerCase();
    const direction: TradeDirection = rawDir.includes('buy') ? 'BUY' : 'SELL';

    const rawPrice = parseFloat(rawTrade.executionPrice || rawTrade.price || '0');
    // 若原始价格大于 1000 且 decimals 为 6，通常是带精度的整数值，转换为真实单价
    const price = rawPrice > 10000 ? rawPrice / divisor : rawPrice;
    const quantity = parseFloat(rawTrade.executionQuantity || rawTrade.quantity || '0');
    const notionalUsd = price * quantity;

    const subId = (rawTrade.subaccountId || this.injectiveService.targetSubaccountId || '').toLowerCase();
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
