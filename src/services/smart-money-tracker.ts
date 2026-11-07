import { EventEmitter } from 'events';
import { AppConfig } from '../config/index.js';
import { InjectiveService } from './injective.service.js';
import { SmartMoneyTradeEvent, TradeDirection } from '../types/index.js';

export class SmartMoneyTracker extends EventEmitter {
  private config: AppConfig;
  private injectiveService: InjectiveService;
  private isRunning: boolean = false;
  private pollTimer?: NodeJS.Timeout;
  private processedTradeIds: Set<string> = new Set();
  private streamSubscription?: any;

  constructor(config: AppConfig, injectiveService: InjectiveService) {
    super();
    this.config = config;
    this.injectiveService = injectiveService;
  }

  /**
   * 启动聪明钱监听器
   */
  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const targetSubaccount = this.injectiveService.targetSubaccountId;
    console.log(`[SmartMoneyTracker] 🚀 启动聪明钱监听引擎...`);
    console.log(`[SmartMoneyTracker] 目标钱包地址: ${this.config.targetTraderAddress}`);
    console.log(`[SmartMoneyTracker] 目标子账户: ${targetSubaccount || '未指定或格式不匹配'}`);

    // 1. 尝试建立 WebSocket / gRPC 实时流
    this.startRealtimeStream();

    // 2. 启动 Fallback 轮询保底器 (定期拉取目标子账户最新成交)
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
    if (this.streamSubscription && typeof this.streamSubscription.unsubscribe === 'function') {
      try {
        this.streamSubscription.unsubscribe();
      } catch (e) {
        // ignore
      }
      this.streamSubscription = undefined;
    }
    console.log(`[SmartMoneyTracker] ⏹️ 聪明钱监听器已停止。`);
  }

  /**
   * 动态切换监听的目标聪明钱地址并即刻启动监听
   */
  public async updateTargetTrader(address: string, subaccountIndex: number = 0): Promise<string> {
    console.log(`[SmartMoneyTracker] 🎯 正在切换监控目标钱包至: ${address} (Subaccount: ${subaccountIndex})`);
    this.injectiveService.setTargetTrader(address, subaccountIndex);
    const newSubaccount = this.injectiveService.targetSubaccountId;

    if (this.isRunning) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      if (this.streamSubscription && typeof this.streamSubscription.unsubscribe === 'function') {
        try {
          this.streamSubscription.unsubscribe();
        } catch (e) {
          // ignore
        }
        this.streamSubscription = undefined;
      }

      if (newSubaccount) {
        await this.seedInitialTrades(newSubaccount);
        this.startRealtimeStream();
        this.startPolling();
      }
    }

    return newSubaccount || '';
  }

  public getTargetTrader(): { address: string; subaccountId?: string } {
    return {
      address: this.config.targetTraderAddress,
      subaccountId: this.injectiveService.targetSubaccountId,
    };
  }

  /**
   * 建立 gRPC 实时流订阅
   */
  private startRealtimeStream() {
    const targetSubaccount = this.injectiveService.targetSubaccountId;
    if (!targetSubaccount) return;

    try {
      this.streamSubscription = this.injectiveService.derivativesStream.streamTrades({
        subaccountId: targetSubaccount,
        callback: (tradeResponse) => {
          if (!this.isRunning) return;
          this.handleRawTrade(tradeResponse);
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
      console.log(`[SmartMoneyTracker] ✅ 实时 gRPC Trade Stream 已就绪`);
    } catch (err: any) {
      console.warn(`[SmartMoneyTracker] ⚠️ 实时 Stream 启动告警（将使用轮询机制兜底）:`, err.message);
    }
  }

  /**
   * 启动轮询兜底机制
   */
  private startPolling() {
    const targetSubaccount = this.injectiveService.targetSubaccountId;
    if (!targetSubaccount) {
      console.warn(`[SmartMoneyTracker] ⚠️ 未提供有效的 targetSubaccount，轮询跳过。`);
      return;
    }

    const poll = async () => {
      if (!this.isRunning) return;

      try {
        const response = await this.injectiveService.derivativesApi.fetchTrades({
          subaccountId: targetSubaccount,
          pagination: { limit: 10 },
        });

        if (response && response.trades && response.trades.length > 0) {
          for (const trade of response.trades) {
            this.handleRawTrade(trade);
          }
        }
      } catch (err: any) {
        // 若测试网网络瞬时抖动，记录 debug 信息不中断循环
      }
    };

    // 立即执行一次记录初始交易 ID (避免启动瞬间误把历史旧交易当成新交易跟单)
    this.seedInitialTrades(targetSubaccount).then(() => {
      this.pollTimer = setInterval(poll, this.config.pollIntervalMs);
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
   * 处理解析单条成交数据并触发事件
   */
  public handleRawTrade(rawTrade: any) {
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

    const event: SmartMoneyTradeEvent = {
      id: tradeId,
      txHash: rawTrade.orderHash || rawTrade.txHash,
      traderAddress: this.config.targetTraderAddress,
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
