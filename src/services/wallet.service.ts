import fs from 'fs';
import path from 'path';
import { PrivateKey, getSubaccountId, IndexerGrpcAccountPortfolioApi } from '@injectivelabs/sdk-ts';
import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';

export interface PracticePosition {
  marketId?: string;
  marketTicker: string;
  traderAddress?: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  marginUsdt: number;
  leverage: number;
  timestamp: number;
}

export interface PracticeTradeHistoryItem {
  marketTicker: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  netPnlUsdt: number;
  closedAt: number;
}

export interface PracticeStats {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
}

export interface FollowedTarget {
  address: string;
  name: string;
  addedAt: number;
}

export interface UserWallet {
  telegramId: number;
  username?: string;
  injectiveAddress: string;
  evmAddress?: string;
  subaccountId: string;
  privateKeyHex: string;
  mnemonic?: string;
  createdAt: number;
  practiceMode?: boolean;
  practiceBalanceUsdt?: number;
  practicePositions?: PracticePosition[];
  practiceRealizedPnlUsdt?: number;
  practiceTradeHistory?: PracticeTradeHistoryItem[];
  practiceStats?: PracticeStats;
  isCopyingEnabled?: boolean;
  targetTraderAddress?: string;
  targetTraderName?: string;
  followedTargets?: FollowedTarget[];
  copyAmountUsdt?: number;
}

export class WalletService {
  private config: AppConfig;
  private portfolioApi: IndexerGrpcAccountPortfolioApi;
  private storageFile: string;
  private wallets: Map<number, UserWallet> = new Map();

  constructor(config: AppConfig, endpoints: { indexer: string }) {
    this.config = config;
    this.portfolioApi = new IndexerGrpcAccountPortfolioApi(endpoints.indexer);
    this.storageFile = path.resolve(process.cwd(), 'data', 'wallets.json');
    this.loadWallets();
  }

  private sanitizeAndMigrateTargets(item: UserWallet): boolean {
    let dirtyFixed = false;
    const isDirtyAddr = (addr?: string) =>
      !addr ||
      addr === 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn' ||
      addr === item.injectiveAddress;

    if (!Array.isArray(item.followedTargets)) {
      item.followedTargets = [];
    }

    const beforeLen = item.followedTargets.length;
    item.followedTargets = item.followedTargets.filter((t) => !isDirtyAddr(t.address));
    if (item.followedTargets.length !== beforeLen) {
      dirtyFixed = true;
    }

    if (item.targetTraderAddress) {
      if (isDirtyAddr(item.targetTraderAddress)) {
        item.targetTraderAddress = undefined;
        item.targetTraderName = undefined;
        if (item.followedTargets.length === 0) {
          item.isCopyingEnabled = false;
        }
        dirtyFixed = true;
      } else {
        // 向后兼容迁移：若已有旧版单目标且不在 followedTargets 中，自动迁入
        const exists = item.followedTargets.some(
          (t) => t.address.toLowerCase() === item.targetTraderAddress!.toLowerCase()
        );
        if (!exists) {
          item.followedTargets.push({
            address: item.targetTraderAddress,
            name: item.targetTraderName || `巨鲸 0x${item.targetTraderAddress.slice(-4)}`,
            addedAt: Date.now(),
          });
          dirtyFixed = true;
        }
      }
    }

    if (item.followedTargets.length > 0 && !item.targetTraderAddress) {
      const latest = item.followedTargets[item.followedTargets.length - 1];
      item.targetTraderAddress = latest.address;
      item.targetTraderName = latest.name;
      dirtyFixed = true;
    }

    return dirtyFixed;
  }

  /**
   * 自动将历史碎片化模拟持仓（如同一标的上百笔拆分持仓）合并为每个 marketTicker 最多 1 笔净持仓
   */
  public consolidatePracticePositions(item: UserWallet): boolean {
    if (!Array.isArray(item.practicePositions) || item.practicePositions.length <= 1) {
      return false;
    }

    const seenTickers = new Set<string>();
    let hasDuplicateTicker = false;
    for (const p of item.practicePositions) {
      if (seenTickers.has(p.marketTicker)) {
        hasDuplicateTicker = true;
        break;
      }
      seenTickers.add(p.marketTicker);
    }

    if (!hasDuplicateTicker) {
      return false;
    }

    if (item.practiceBalanceUsdt === undefined) item.practiceBalanceUsdt = 10000;
    if (item.practiceRealizedPnlUsdt === undefined) item.practiceRealizedPnlUsdt = 0;
    if (!Array.isArray(item.practiceTradeHistory)) item.practiceTradeHistory = [];
    if (!item.practiceStats) {
      item.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    }

    const netByTicker = new Map<string, PracticePosition>();
    for (const pos of item.practicePositions) {
      const existing = netByTicker.get(pos.marketTicker);
      if (!existing) {
        netByTicker.set(pos.marketTicker, { ...pos });
      } else if (existing.direction === pos.direction) {
        // 同向加仓：加权平均计算开仓均价并合并数量与保证金
        const newQty = Number((existing.quantity + pos.quantity).toFixed(6));
        const avgEntry =
          newQty > 0
            ? Number(
                ((existing.entryPrice * existing.quantity + pos.entryPrice * pos.quantity) / newQty).toFixed(6)
              )
            : existing.entryPrice;
        existing.quantity = newQty;
        existing.entryPrice = avgEntry;
        existing.marginUsdt = Number((existing.marginUsdt + (pos.marginUsdt || 0)).toFixed(2));
        existing.timestamp = Math.max(existing.timestamp || 0, pos.timestamp || 0);
        if (pos.marketId && !existing.marketId) existing.marketId = pos.marketId;
      } else {
        // 反向对冲平仓：释放双向占用保证金并结算净盈亏
        const grossPnl =
          existing.direction === 'BUY'
            ? (pos.entryPrice - existing.entryPrice) * existing.quantity
            : (existing.entryPrice - pos.entryPrice) * existing.quantity;
        const fee = pos.entryPrice * existing.quantity * 0.001;
        const netPnl = Number((grossPnl - fee).toFixed(2));

        item.practiceBalanceUsdt = Number(
          (item.practiceBalanceUsdt + (existing.marginUsdt || 0) + (pos.marginUsdt || 0) + netPnl).toFixed(2)
        );
        item.practiceRealizedPnlUsdt = Number((item.practiceRealizedPnlUsdt + netPnl).toFixed(2));
        item.practiceStats.totalTrades += 1;
        if (netPnl >= 0) item.practiceStats.winTrades += 1;
        else item.practiceStats.lossTrades += 1;

        item.practiceTradeHistory.unshift({
          marketTicker: existing.marketTicker,
          direction: existing.direction,
          entryPrice: existing.entryPrice,
          exitPrice: pos.entryPrice,
          quantity: existing.quantity,
          netPnlUsdt: netPnl,
          closedAt: pos.timestamp || Date.now(),
        });
        if (item.practiceTradeHistory.length > 20) {
          item.practiceTradeHistory = item.practiceTradeHistory.slice(0, 20);
        }
        netByTicker.delete(pos.marketTicker);
      }
    }

    item.practicePositions = Array.from(netByTicker.values());
    return true;
  }

  private loadWallets() {
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf-8');
        const list: UserWallet[] = JSON.parse(raw);
        let dirtyFixed = false;
        for (const item of list) {
          if (this.sanitizeAndMigrateTargets(item)) {
            dirtyFixed = true;
          }
          if (item.practiceBalanceUsdt === undefined) {
            item.practiceBalanceUsdt = 10000;
          }
          if (!Array.isArray(item.practicePositions)) {
            item.practicePositions = [];
          } else {
            // 自动检测并修复历史异常开仓价（如早期未除以精度的小市值代币如 BRETT 等）
            for (const pos of item.practicePositions) {
              if (pos.marketTicker && pos.marketTicker.toUpperCase().includes('BRETT') && pos.entryPrice > 10) {
                pos.entryPrice = Number((pos.entryPrice / 1e6).toFixed(6));
                dirtyFixed = true;
              }
              // 自动修复历史开仓价为 0 或保证金为 0 的异常代币 (如早期 PEPE)
              if ((!pos.entryPrice || pos.entryPrice <= 0 || !pos.marginUsdt) && pos.marketTicker) {
                if (pos.marketTicker.toUpperCase().includes('PEPE')) {
                  pos.entryPrice = 0.00000514;
                  pos.marginUsdt = Number(((pos.quantity * pos.entryPrice) / (pos.leverage || 5)).toFixed(2)) || 10;
                  dirtyFixed = true;
                }
              }
            }
            // 剔除任何依然无法解析真实价格 (entryPrice <= 0) 的脏数据持仓
            const beforeLen = item.practicePositions.length;
            item.practicePositions = item.practicePositions.filter((p) => p.entryPrice > 0 && p.quantity > 0);
            if (item.practicePositions.length !== beforeLen) {
              dirtyFixed = true;
            }
          }
          if (item.practiceRealizedPnlUsdt === undefined) {
            item.practiceRealizedPnlUsdt = 0;
          }
          if (!Array.isArray(item.practiceTradeHistory)) {
            item.practiceTradeHistory = [];
          } else {
            for (const th of item.practiceTradeHistory) {
              if (th.marketTicker && th.marketTicker.toUpperCase().includes('BRETT') && th.entryPrice > 10) {
                th.entryPrice = Number((th.entryPrice / 1e6).toFixed(6));
                dirtyFixed = true;
              }
            }
          }
          if (!item.practiceStats) {
            item.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
          }
          if (!item.evmAddress && item.privateKeyHex) {
            try {
              const cleanPk = item.privateKeyHex.startsWith('0x') ? item.privateKeyHex : `0x${item.privateKeyHex}`;
              item.evmAddress = PrivateKey.fromHex(cleanPk).toAddress().toHex();
              dirtyFixed = true;
            } catch {
              // ignore
            }
          }
          if (this.consolidatePracticePositions(item)) {
            dirtyFixed = true;
          }
          this.wallets.set(item.telegramId, item);
        }
        if (dirtyFixed) {
          this.saveWallets();
        }
      }
    } catch (e: any) {
      console.warn('[WalletService] 钱包载入警告:', e.message);
    }
  }

  private saveWallets() {
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const list = Array.from(this.wallets.values());
      fs.writeFileSync(this.storageFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e: any) {
      console.error('[WalletService] 钱包持久化失败:', e.message);
    }
  }

  /**
   * 获取所有已注册用户的钱包列表
   */
  public getAllWallets(): UserWallet[] {
    return Array.from(this.wallets.values());
  }

  /**
   * 获取或自动为用户创建专属 Injective 真实链上钱包 (保存 12 位 BIP39 助记词与私钥)
   */
  public getOrCreateWallet(telegramId: number, username?: string): UserWallet {
    let wallet = this.wallets.get(telegramId);
    if (!wallet) {
      // 链上生成标准 BIP39 12位助记词、真实私钥与地址
      const pkObj = PrivateKey.generate();
      const pk = pkObj.privateKey;
      const injectiveAddress = pk.toBech32();
      const evmAddress = pk.toAddress().toHex();
      const subaccountId = getSubaccountId(injectiveAddress, 0);

      wallet = {
        telegramId,
        username,
        injectiveAddress,
        evmAddress,
        subaccountId,
        privateKeyHex: pk.toPrivateKeyHex(),
        mnemonic: pkObj.mnemonic,
        createdAt: Date.now(),
        practiceMode: false,
        practiceBalanceUsdt: 10000,
        practicePositions: [],
        practiceRealizedPnlUsdt: 0,
        practiceTradeHistory: [],
        practiceStats: { totalTrades: 0, winTrades: 0, lossTrades: 0 },
        followedTargets: [],
      };

      this.wallets.set(telegramId, wallet);
      this.saveWallets();
      console.log(`[WalletService] 🆕 为用户 @${username || telegramId} 生成真实 Injective 钱包: ${injectiveAddress}`);
    } else {
      if (wallet.practiceBalanceUsdt === undefined) wallet.practiceBalanceUsdt = 10000;
      if (!Array.isArray(wallet.practicePositions)) wallet.practicePositions = [];
      if (wallet.practiceRealizedPnlUsdt === undefined) wallet.practiceRealizedPnlUsdt = 0;
      if (!Array.isArray(wallet.practiceTradeHistory)) wallet.practiceTradeHistory = [];
      if (!wallet.practiceStats) wallet.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
      if (!Array.isArray(wallet.followedTargets)) wallet.followedTargets = [];
    }
    return wallet;
  }

  /**
   * 设置体验金模式状态
   */
  public setPracticeMode(telegramId: number, enabled: boolean): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.practiceMode = enabled;
    if (enabled && (wallet.practiceBalanceUsdt === undefined || wallet.practiceBalanceUsdt <= 0)) {
      wallet.practiceBalanceUsdt = 10000;
      wallet.practicePositions = [];
      wallet.practiceRealizedPnlUsdt = 0;
      wallet.practiceTradeHistory = [];
      wallet.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    }
    this.saveWallets();
    return wallet;
  }

  public isPracticeMode(telegramId: number): boolean {
    const wallet = this.wallets.get(telegramId);
    return wallet ? !!wallet.practiceMode : false;
  }

  /**
   * 执行模拟体验金交易 (确保每个 marketTicker 最多 1 笔净持仓：同向加权合并均价，反向平仓结算盈亏并计入历史)
   */
  public executePracticeTrade(
    telegramId: number,
    paramsOrTicker:
      | {
          marketId?: string;
          marketTicker: string;
          traderAddress?: string;
          direction: 'BUY' | 'SELL';
          price: number;
          quantity: number;
          marginUsdt?: number;
          leverage: number;
        }
      | string,
    directionArg?: 'BUY' | 'SELL',
    priceArg?: number,
    quantityArg?: number,
    leverageArg?: number,
    marketIdArg?: string,
    traderAddressArg?: string
  ): {
    success: boolean;
    action: 'OPEN' | 'CLOSE';
    wallet: UserWallet;
    realizedPnlDelta: number;
    closedPosition?: PracticeTradeHistoryItem;
    error?: string;
  } {
    const wallet = this.getOrCreateWallet(telegramId);
    if (wallet.practiceBalanceUsdt === undefined) wallet.practiceBalanceUsdt = 10000;
    if (!Array.isArray(wallet.practicePositions)) wallet.practicePositions = [];
    if (wallet.practiceRealizedPnlUsdt === undefined) wallet.practiceRealizedPnlUsdt = 0;
    if (!Array.isArray(wallet.practiceTradeHistory)) wallet.practiceTradeHistory = [];
    if (!wallet.practiceStats) {
      wallet.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    }

    const params =
      typeof paramsOrTicker === 'string'
        ? {
            marketTicker: paramsOrTicker,
            direction: directionArg!,
            price: priceArg!,
            quantity: quantityArg!,
            leverage: leverageArg || 5,
            marginUsdt: ((priceArg || 0) * (quantityArg || 0)) / (leverageArg || 5),
            marketId: marketIdArg,
            traderAddress: traderAddressArg,
          }
        : {
            ...paramsOrTicker,
            marginUsdt:
              paramsOrTicker.marginUsdt !== undefined
                ? paramsOrTicker.marginUsdt
                : (paramsOrTicker.price * paramsOrTicker.quantity) / (paramsOrTicker.leverage || 5),
          };

    // 优先匹配同巨鲸归属的同标的持仓，杜绝多巨鲸跟单时“巨鲸A做多被巨鲸B反手误平仓”的冲突！
    const existingIdx = wallet.practicePositions.findIndex((p) => {
      if (p.marketTicker !== params.marketTicker) return false;
      if (params.traderAddress && p.traderAddress) {
        return p.traderAddress.toLowerCase() === params.traderAddress.toLowerCase();
      }
      return true;
    });

    // 情况 1: 已存在同标的持仓且方向相反 -> 执行平仓结算 (释放原保证金 + 结算净盈亏 - 0.1% 手续费)
    if (existingIdx !== -1 && wallet.practicePositions[existingIdx].direction !== params.direction) {
      const existing = wallet.practicePositions[existingIdx];

      // 防高频闪电对敲洗盘保护：若持仓开仓不足 45 秒且价格未出现明显波动 (< 0.4%)，避免被高频做市商秒翻转反复摩擦手续费
      const holdTimeSec = (Date.now() - (existing.timestamp || 0)) / 1000;
      const priceChangePct = Math.abs((params.price - existing.entryPrice) / (existing.entryPrice || 1)) * 100;
      if (holdTimeSec < 45 && priceChangePct < 0.4) {
        return {
          success: true,
          action: 'OPEN',
          wallet,
          realizedPnlDelta: 0,
        };
      }

      const priceDiff =
        existing.direction === 'BUY'
          ? params.price - existing.entryPrice
          : existing.entryPrice - params.price;
      let grossPnl = priceDiff * existing.quantity;
      const maxPnlCap = Math.max(100, (existing.marginUsdt || 20) * (existing.leverage || 5) * 3);
      if (Math.abs(grossPnl) > maxPnlCap) {
        grossPnl = grossPnl > 0 ? maxPnlCap : -maxPnlCap;
      }
      const fee = params.price * existing.quantity * 0.001;
      const netPnl = Number((grossPnl - fee).toFixed(2));

      wallet.practiceBalanceUsdt = Number(
        (wallet.practiceBalanceUsdt + existing.marginUsdt + netPnl).toFixed(2)
      );
      wallet.practiceRealizedPnlUsdt = Number((wallet.practiceRealizedPnlUsdt + netPnl).toFixed(2));

      wallet.practiceStats.totalTrades += 1;
      if (netPnl >= 0) {
        wallet.practiceStats.winTrades += 1;
      } else {
        wallet.practiceStats.lossTrades += 1;
      }

      const closedRecord: PracticeTradeHistoryItem = {
        marketTicker: existing.marketTicker,
        direction: existing.direction,
        entryPrice: existing.entryPrice,
        exitPrice: params.price,
        quantity: existing.quantity,
        netPnlUsdt: netPnl,
        closedAt: Date.now(),
      };
      wallet.practiceTradeHistory.unshift(closedRecord);
      if (wallet.practiceTradeHistory.length > 20) {
        wallet.practiceTradeHistory = wallet.practiceTradeHistory.slice(0, 20);
      }

      wallet.practicePositions.splice(existingIdx, 1);
      this.saveWallets();

      return {
        success: true,
        action: 'CLOSE',
        wallet,
        realizedPnlDelta: netPnl,
        closedPosition: closedRecord,
      };
    }

    const marginToDeduct = Number((params.marginUsdt || 0).toFixed(2));
    if (wallet.practiceBalanceUsdt < marginToDeduct) {
      return {
        success: false,
        action: 'OPEN',
        wallet,
        realizedPnlDelta: 0,
        error: `模拟体验金可用余额不足 ($${wallet.practiceBalanceUsdt.toFixed(2)} < $${marginToDeduct.toFixed(2)})`,
      };
    }

    wallet.practiceBalanceUsdt = Number((wallet.practiceBalanceUsdt - marginToDeduct).toFixed(2));

    // 情况 2: 已存在同标的同向持仓 -> 合并为单笔净持仓并加权更新开仓均价 (保留有效数字精度)
    if (existingIdx !== -1) {
      const existing = wallet.practicePositions[existingIdx];
      const newQty = Number((existing.quantity + params.quantity).toFixed(6));
      existing.entryPrice = Number(
        ((existing.entryPrice * existing.quantity + params.price * params.quantity) / newQty).toPrecision(8)
      );
      existing.quantity = newQty;
      existing.marginUsdt = Number((existing.marginUsdt + marginToDeduct).toFixed(2));
      existing.leverage = params.leverage || existing.leverage;
      if (params.marketId) existing.marketId = params.marketId;
      if (params.traderAddress) existing.traderAddress = params.traderAddress;
      existing.timestamp = Date.now();
    } else {
      // 情况 3: 无该标的持仓 -> 新建 1 笔持仓
      wallet.practicePositions.push({
        marketId: params.marketId,
        marketTicker: params.marketTicker,
        traderAddress: params.traderAddress,
        direction: params.direction,
        entryPrice: params.price,
        quantity: params.quantity,
        marginUsdt: marginToDeduct,
        leverage: params.leverage,
        timestamp: Date.now(),
      });
    }

    this.saveWallets();
    return { success: true, action: 'OPEN', wallet, realizedPnlDelta: 0 };
  }

  /**
   * 一键重置 $10,000 模拟账户
   */
  public resetPracticeAccount(telegramUserId: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramUserId);
    wallet.practiceBalanceUsdt = 10000;
    wallet.practiceRealizedPnlUsdt = 0;
    wallet.practicePositions = [];
    wallet.practiceTradeHistory = [];
    wallet.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    this.saveWallets();
    return wallet;
  }

  /**
   * 一键市价全平所有模拟持仓
   */
  public closeAllPracticePositions(
    telegramUserId: number,
    markPrices: Map<string, number>
  ): { closedCount: number; totalNetPnlUsdt: number; wallet: UserWallet } {
    const wallet = this.getOrCreateWallet(telegramUserId);
    const positions = wallet.practicePositions || [];
    if (positions.length === 0) {
      return { closedCount: 0, totalNetPnlUsdt: 0, wallet };
    }

    if (wallet.practiceBalanceUsdt === undefined) wallet.practiceBalanceUsdt = 10000;
    if (wallet.practiceRealizedPnlUsdt === undefined) wallet.practiceRealizedPnlUsdt = 0;
    if (!Array.isArray(wallet.practiceTradeHistory)) wallet.practiceTradeHistory = [];
    if (!wallet.practiceStats) {
      wallet.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    }

    let totalNetPnlUsdt = 0;
    const closedCount = positions.length;

    for (const pos of positions) {
      const markPrice =
        markPrices.get(pos.marketTicker) ||
        (pos.marketId ? markPrices.get(pos.marketId) : undefined) ||
        pos.entryPrice;

      const priceDiff =
        pos.direction === 'BUY' ? markPrice - pos.entryPrice : pos.entryPrice - markPrice;
      let grossPnl = priceDiff * pos.quantity;
      // 风控防御保护：平仓盈亏单笔不可超过 保证金 * 杠杆 * 3
      const maxPnlCap = Math.max(100, (pos.marginUsdt || 20) * (pos.leverage || 5) * 3);
      if (Math.abs(grossPnl) > maxPnlCap) {
        grossPnl = grossPnl > 0 ? maxPnlCap : -maxPnlCap;
      }
      const fee = markPrice * pos.quantity * 0.001;
      const netPnl = Number((grossPnl - fee).toFixed(2));

      totalNetPnlUsdt = Number((totalNetPnlUsdt + netPnl).toFixed(2));
      wallet.practiceBalanceUsdt = Number((wallet.practiceBalanceUsdt + pos.marginUsdt + netPnl).toFixed(2));
      wallet.practiceRealizedPnlUsdt = Number((wallet.practiceRealizedPnlUsdt + netPnl).toFixed(2));

      wallet.practiceStats.totalTrades += 1;
      if (netPnl >= 0) {
        wallet.practiceStats.winTrades += 1;
      } else {
        wallet.practiceStats.lossTrades += 1;
      }

      wallet.practiceTradeHistory.unshift({
        marketTicker: pos.marketTicker,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: markPrice,
        quantity: pos.quantity,
        netPnlUsdt: netPnl,
        closedAt: Date.now(),
      });
    }

    if (wallet.practiceTradeHistory.length > 20) {
      wallet.practiceTradeHistory = wallet.practiceTradeHistory.slice(0, 20);
    }
    wallet.practicePositions = [];
    this.saveWallets();

    return { closedCount, totalNetPnlUsdt, wallet };
  }

  /**
   * 一键平仓所有当前处于亏损状态的模拟持仓
   */
  public closeLosingPracticePositions(
    telegramUserId: number,
    markPrices: Map<string, number>
  ): { closedCount: number; totalNetPnlUsdt: number; remainingCount: number; wallet: UserWallet } {
    const wallet = this.getOrCreateWallet(telegramUserId);
    const positions = wallet.practicePositions || [];
    if (positions.length === 0) {
      return { closedCount: 0, totalNetPnlUsdt: 0, remainingCount: 0, wallet };
    }

    if (wallet.practiceBalanceUsdt === undefined) wallet.practiceBalanceUsdt = 10000;
    if (wallet.practiceRealizedPnlUsdt === undefined) wallet.practiceRealizedPnlUsdt = 0;
    if (!Array.isArray(wallet.practiceTradeHistory)) wallet.practiceTradeHistory = [];
    if (!wallet.practiceStats) {
      wallet.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    }

    let totalNetPnlUsdt = 0;
    let closedCount = 0;
    const remainingPositions: PracticePosition[] = [];

    for (const pos of positions) {
      const markPrice =
        markPrices.get(pos.marketTicker) ||
        (pos.marketId ? markPrices.get(pos.marketId) : undefined) ||
        pos.entryPrice;

      const priceDiff =
        pos.direction === 'BUY' ? markPrice - pos.entryPrice : pos.entryPrice - markPrice;
      let grossPnl = priceDiff * pos.quantity;
      const maxPnlCap = Math.max(100, (pos.marginUsdt || 20) * (pos.leverage || 5) * 3);
      if (Math.abs(grossPnl) > maxPnlCap) {
        grossPnl = grossPnl > 0 ? maxPnlCap : -maxPnlCap;
      }
      const fee = markPrice * pos.quantity * 0.001;
      const netPnl = Number((grossPnl - fee).toFixed(2));

      if (netPnl < 0) {
        closedCount += 1;
        totalNetPnlUsdt = Number((totalNetPnlUsdt + netPnl).toFixed(2));
        wallet.practiceBalanceUsdt = Number((wallet.practiceBalanceUsdt + pos.marginUsdt + netPnl).toFixed(2));
        wallet.practiceRealizedPnlUsdt = Number((wallet.practiceRealizedPnlUsdt + netPnl).toFixed(2));

        wallet.practiceStats.totalTrades += 1;
        wallet.practiceStats.lossTrades += 1;

        wallet.practiceTradeHistory.unshift({
          marketTicker: pos.marketTicker,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice: markPrice,
          quantity: pos.quantity,
          netPnlUsdt: netPnl,
          closedAt: Date.now(),
        });
      } else {
        remainingPositions.push(pos);
      }
    }

    if (wallet.practiceTradeHistory.length > 20) {
      wallet.practiceTradeHistory = wallet.practiceTradeHistory.slice(0, 20);
    }
    wallet.practicePositions = remainingPositions;
    this.saveWallets();

    return { closedCount, totalNetPnlUsdt, remainingCount: remainingPositions.length, wallet };
  }

  /**
   * 重新生成带 12 位标准 BIP39 助记词的新钱包（保留用户的模拟盘余额、持仓与跟单配置）
   */
  public regenerateWalletWithMnemonic(telegramUserId: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramUserId);
    const pkObj = PrivateKey.generate();
    const pk = pkObj.privateKey;
    const injectiveAddress = pk.toBech32();
    const evmAddress = pk.toAddress().toHex();
    const subaccountId = getSubaccountId(injectiveAddress, 0);

    wallet.injectiveAddress = injectiveAddress;
    wallet.evmAddress = evmAddress;
    wallet.subaccountId = subaccountId;
    wallet.privateKeyHex = pk.toPrivateKeyHex();
    wallet.mnemonic = pkObj.mnemonic;

    this.saveWallets();
    return wallet;
  }

  /**
   * 导入外部 12/24 位 BIP39 助记词或 64 位 Hex 私钥（保留用户的模拟盘余额與跟单目标）
   */
  public importWallet(telegramUserId: number, secretInput: string, username?: string): UserWallet {
    const wallet = this.getOrCreateWallet(telegramUserId, username);
    const trimmed = secretInput.trim().replace(/\s+/g, ' ');
    const words = trimmed.split(' ');

    let pk: PrivateKey;
    let savedMnemonic: string | undefined;

    if (words.length === 12 || words.length === 24) {
      pk = PrivateKey.fromMnemonic(trimmed);
      savedMnemonic = trimmed;
    } else {
      const cleanHex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(cleanHex)) {
        throw new Error('请输入有效的 12/24 位英文助记词（空格分隔）或 64 位十六进制私钥');
      }
      pk = PrivateKey.fromHex(cleanHex);
      savedMnemonic = undefined;
    }

    const injectiveAddress = pk.toBech32();
    const evmAddress = pk.toAddress().toHex();
    const subaccountId = getSubaccountId(injectiveAddress, 0);

    wallet.injectiveAddress = injectiveAddress;
    wallet.evmAddress = evmAddress;
    wallet.subaccountId = subaccountId;
    wallet.privateKeyHex = pk.toPrivateKeyHex();
    wallet.mnemonic = savedMnemonic;

    this.saveWallets();
    return wallet;
  }

  /**
   * 获取用户个性化跟单配置与状态 (内置脏数据自愈保护)
   */
  public getUserCopyState(telegramId: number) {
    const wallet = this.getOrCreateWallet(telegramId);
    if (this.sanitizeAndMigrateTargets(wallet)) {
      this.saveWallets();
    }
    return {
      isCopyingEnabled: !!wallet.isCopyingEnabled,
      targetTraderAddress: wallet.targetTraderAddress,
      targetTraderName: wallet.targetTraderName,
      followedTargets: wallet.followedTargets || [],
      copyAmountUsdt: wallet.copyAmountUsdt || 100,
      practiceMode: !!wallet.practiceMode,
    };
  }

  /**
   * 向多巨鲸跟单矩阵添加目标地址 (支持每个用户同时跟单最多 5 个巨鲸，绝不覆盖已有巨鲸)
   */
  public addUserTarget(
    telegramId: number,
    address: string,
    name?: string
  ): { added: boolean; targets: FollowedTarget[] } {
    const wallet = this.getOrCreateWallet(telegramId);
    if (!Array.isArray(wallet.followedTargets)) {
      wallet.followedTargets = [];
    }

    const displayName = name || `巨鲸 0x${address.slice(-4)}`;
    const existingIdx = wallet.followedTargets.findIndex(
      (t) => t.address.toLowerCase() === address.toLowerCase()
    );

    let added = false;
    if (existingIdx === -1) {
      if (wallet.followedTargets.length >= 5) {
        wallet.followedTargets.shift();
      }
      wallet.followedTargets.push({
        address,
        name: displayName,
        addedAt: Date.now(),
      });
      added = true;
    } else {
      wallet.followedTargets[existingIdx].name = displayName;
    }

    wallet.targetTraderAddress = address;
    wallet.targetTraderName = displayName;
    this.saveWallets();

    return { added, targets: [...wallet.followedTargets] };
  }

  /**
   * 从多巨鲸跟单矩阵单独移除某个目标地址 (支持完整地址或末尾 8 位短后缀匹配)
   */
  public removeUserTarget(telegramId: number, addressOrSuffix: string): FollowedTarget[] {
    const wallet = this.getOrCreateWallet(telegramId);
    if (!Array.isArray(wallet.followedTargets)) {
      wallet.followedTargets = [];
    }

    const cleanKey = addressOrSuffix.toLowerCase();
    wallet.followedTargets = wallet.followedTargets.filter(
      (t) =>
        t.address.toLowerCase() !== cleanKey &&
        !t.address.toLowerCase().endsWith(cleanKey)
    );

    if (wallet.followedTargets.length > 0) {
      const latest = wallet.followedTargets[wallet.followedTargets.length - 1];
      wallet.targetTraderAddress = latest.address;
      wallet.targetTraderName = latest.name;
    } else {
      wallet.targetTraderAddress = undefined;
      wallet.targetTraderName = undefined;
      wallet.isCopyingEnabled = false;
    }

    this.saveWallets();
    return [...wallet.followedTargets];
  }

  /**
   * 获取用户当前同时跟单的所有巨鲸列表
   */
  public getUserTargets(telegramId: number): FollowedTarget[] {
    const wallet = this.getOrCreateWallet(telegramId);
    if (this.sanitizeAndMigrateTargets(wallet)) {
      this.saveWallets();
    }
    return [...(wallet.followedTargets || [])];
  }

  /**
   * 汇总所有开启了 isCopyingEnabled 的用户正在跟单的所有去重巨鲸地址列表
   */
  public getAllActiveTrackedAddresses(): string[] {
    const activeSet = new Set<string>();
    for (const wallet of this.wallets.values()) {
      if (!wallet.isCopyingEnabled) continue;
      if (Array.isArray(wallet.followedTargets)) {
        for (const t of wallet.followedTargets) {
          if (t.address) activeSet.add(t.address);
        }
      }
      if (wallet.targetTraderAddress) {
        activeSet.add(wallet.targetTraderAddress);
      }
    }
    return Array.from(activeSet);
  }

  /**
   * 设置用户的跟单目标 (兼容单目标调用，同时同步至多巨鲸列表)
   */
  public setUserTarget(telegramId: number, targetAddress: string, targetName?: string): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.targetTraderAddress = targetAddress;
    wallet.targetTraderName = targetName;
    if (
      targetAddress &&
      targetAddress !== 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn' &&
      targetAddress !== wallet.injectiveAddress
    ) {
      this.addUserTarget(telegramId, targetAddress, targetName);
    } else {
      this.saveWallets();
    }
    return wallet;
  }

  /**
   * 启动或停止用户的自动跟单
   */
  public setUserCopying(telegramId: number, enabled: boolean): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.isCopyingEnabled = enabled;
    this.saveWallets();
    return wallet;
  }

  /**
   * 设置用户单笔跟单金额
   */
  public setUserAmount(telegramId: number, amount: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.copyAmountUsdt = amount;
    this.saveWallets();
    return wallet;
  }

  /**
   * 清除全部跟单目标
   */
  public clearUserTarget(telegramId: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.targetTraderAddress = undefined;
    wallet.targetTraderName = undefined;
    wallet.followedTargets = [];
    wallet.isCopyingEnabled = false;
    this.saveWallets();
    return wallet;
  }

  /**
   * 导入已有私钥 (向后兼容，内部调用 importWallet)
   */
  public importPrivateKey(telegramId: number, privateKeyHex: string, username?: string): UserWallet {
    return this.importWallet(telegramId, privateKeyHex, username);
  }

  /**
   * 实时查询链上真实余额 (INJ 与 USDT/USDC)
   */
  public async getRealBalances(address: string): Promise<{ inj: string; usdt: string; totalUsd: number }> {
    try {
      const portfolio = await this.portfolioApi.fetchAccountPortfolioBalances(address);
      let injAmount = new BigNumber(0);
      let usdtAmount = new BigNumber(0);

      if (portfolio && portfolio.bankBalancesList) {
        for (const item of portfolio.bankBalancesList) {
          if (item.denom === 'inj') {
            injAmount = injAmount.plus(new BigNumber(item.amount).dividedBy(1e18));
          } else if (item.denom.toLowerCase().includes('usdt') || item.denom.toLowerCase().includes('usdc') || item.denom.includes('peggy0x87aB3B4C8661e07D6372361211B96ed4Dc36B1B5')) {
            usdtAmount = usdtAmount.plus(new BigNumber(item.amount).dividedBy(1e6));
          }
        }
      }

      // 计算子账户内部的保证金余额
      if (portfolio && portfolio.subaccountsList) {
        for (const sub of portfolio.subaccountsList) {
          const avail = sub.deposit?.availableBalance || '0';
          if (sub.denom === 'inj') {
            injAmount = injAmount.plus(new BigNumber(avail).dividedBy(1e18));
          } else if (sub.denom.toLowerCase().includes('usdt') || sub.denom.toLowerCase().includes('usdc')) {
            usdtAmount = usdtAmount.plus(new BigNumber(avail).dividedBy(1e6));
          }
        }
      }

      const totalUsd = usdtAmount.plus(injAmount.multipliedBy(3.95)).toNumber();

      return {
        inj: injAmount.toFixed(4),
        usdt: usdtAmount.toFixed(2),
        totalUsd: Number(totalUsd.toFixed(2)),
      };
    } catch (e: any) {
      return { inj: '0.0000', usdt: '0.00', totalUsd: 0 };
    }
  }
}
