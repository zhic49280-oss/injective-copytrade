import fs from 'fs';
import path from 'path';
import { PrivateKey, getSubaccountId, IndexerGrpcAccountPortfolioApi } from '@injectivelabs/sdk-ts';
import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';

export interface PracticePosition {
  marketTicker: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  marginUsdt: number;
  leverage: number;
  timestamp: number;
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
  subaccountId: string;
  privateKeyHex: string;
  createdAt: number;
  practiceMode?: boolean;
  practiceBalanceUsdt?: number;
  practicePositions?: PracticePosition[];
  practiceRealizedPnlUsdt?: number;
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
          }
          if (item.practiceRealizedPnlUsdt === undefined) {
            item.practiceRealizedPnlUsdt = 0;
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
   * 获取或自动为用户创建专属 Injective 真实链上钱包
   */
  public getOrCreateWallet(telegramId: number, username?: string): UserWallet {
    let wallet = this.wallets.get(telegramId);
    if (!wallet) {
      // 链上生成真实私钥与地址
      const pkObj = PrivateKey.generate();
      const pk = pkObj.privateKey;
      const injectiveAddress = pk.toBech32();
      const subaccountId = getSubaccountId(injectiveAddress, 0);

      wallet = {
        telegramId,
        username,
        injectiveAddress,
        subaccountId,
        privateKeyHex: pk.toPrivateKeyHex(),
        createdAt: Date.now(),
        practiceMode: false,
        practiceBalanceUsdt: 10000,
        practicePositions: [],
        practiceRealizedPnlUsdt: 0,
        followedTargets: [],
      };

      this.wallets.set(telegramId, wallet);
      this.saveWallets();
      console.log(`[WalletService] 🆕 为用户 @${username || telegramId} 生成真实 Injective 钱包: ${injectiveAddress}`);
    } else {
      if (wallet.practiceBalanceUsdt === undefined) wallet.practiceBalanceUsdt = 10000;
      if (!Array.isArray(wallet.practicePositions)) wallet.practicePositions = [];
      if (wallet.practiceRealizedPnlUsdt === undefined) wallet.practiceRealizedPnlUsdt = 0;
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
    }
    this.saveWallets();
    return wallet;
  }

  public isPracticeMode(telegramId: number): boolean {
    const wallet = this.wallets.get(telegramId);
    return wallet ? !!wallet.practiceMode : false;
  }

  /**
   * 执行模拟体验金交易 (真实扣减可用体验金保证金、记录模拟持仓与反向平仓结算盈亏)
   */
  public executePracticeTrade(
    telegramId: number,
    params: {
      marketTicker: string;
      direction: 'BUY' | 'SELL';
      price: number;
      quantity: number;
      marginUsdt: number;
      leverage: number;
    }
  ): { success: boolean; wallet: UserWallet; realizedPnlDelta: number; error?: string } {
    const wallet = this.getOrCreateWallet(telegramId);
    if (wallet.practiceBalanceUsdt === undefined) wallet.practiceBalanceUsdt = 10000;
    if (!Array.isArray(wallet.practicePositions)) wallet.practicePositions = [];
    if (wallet.practiceRealizedPnlUsdt === undefined) wallet.practiceRealizedPnlUsdt = 0;

    let realizedPnlDelta = 0;
    const existingIdx = wallet.practicePositions.findIndex(
      (p) => p.marketTicker === params.marketTicker && p.direction !== params.direction
    );

    // 若存在反向持仓，先平仓结算盈亏并释放原占用保证金
    if (existingIdx !== -1) {
      const existing = wallet.practicePositions[existingIdx];
      const priceDiff =
        existing.direction === 'BUY'
          ? params.price - existing.entryPrice
          : existing.entryPrice - params.price;
      const pnl = Number((priceDiff * existing.quantity).toFixed(2));
      realizedPnlDelta = pnl;
      wallet.practiceBalanceUsdt = Number(
        (wallet.practiceBalanceUsdt + existing.marginUsdt + pnl).toFixed(2)
      );
      wallet.practiceRealizedPnlUsdt = Number((wallet.practiceRealizedPnlUsdt + pnl).toFixed(2));
      wallet.practicePositions.splice(existingIdx, 1);
    }

    const marginToDeduct = Number(params.marginUsdt.toFixed(2));
    if (wallet.practiceBalanceUsdt < marginToDeduct) {
      return {
        success: false,
        wallet,
        realizedPnlDelta,
        error: `模拟体验金可用余额不足 ($${wallet.practiceBalanceUsdt.toFixed(2)} < $${marginToDeduct.toFixed(2)})`,
      };
    }

    // 真实扣除体验金保证金并记录模拟持仓
    wallet.practiceBalanceUsdt = Number((wallet.practiceBalanceUsdt - marginToDeduct).toFixed(2));
    wallet.practicePositions.push({
      marketTicker: params.marketTicker,
      direction: params.direction,
      entryPrice: params.price,
      quantity: params.quantity,
      marginUsdt: marginToDeduct,
      leverage: params.leverage,
      timestamp: Date.now(),
    });

    this.saveWallets();
    return { success: true, wallet, realizedPnlDelta };
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
   * 导入已有私钥
   */
  public importPrivateKey(telegramId: number, privateKeyHex: string, username?: string): UserWallet {
    const cleanPk = privateKeyHex.trim().startsWith('0x') ? privateKeyHex.trim() : `0x${privateKeyHex.trim()}`;
    const pk = PrivateKey.fromHex(cleanPk);
    const injectiveAddress = pk.toBech32();
    const subaccountId = getSubaccountId(injectiveAddress, 0);

    const wallet: UserWallet = {
      telegramId,
      username,
      injectiveAddress,
      subaccountId,
      privateKeyHex: cleanPk,
      createdAt: Date.now(),
      practiceMode: false,
      practiceBalanceUsdt: 10000,
      practicePositions: [],
      practiceRealizedPnlUsdt: 0,
    };

    this.wallets.set(telegramId, wallet);
    this.saveWallets();
    return wallet;
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
