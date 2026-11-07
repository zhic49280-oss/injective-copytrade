import fs from 'fs';
import path from 'path';
import { PrivateKey, getSubaccountId, IndexerGrpcAccountPortfolioApi } from '@injectivelabs/sdk-ts';
import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';

export interface UserWallet {
  telegramId: number;
  username?: string;
  injectiveAddress: string;
  subaccountId: string;
  privateKeyHex: string;
  createdAt: number;
  practiceMode?: boolean;
  practiceBalanceUsdt?: number;
  isCopyingEnabled?: boolean;
  targetTraderAddress?: string;
  targetTraderName?: string;
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
          if (
            item.targetTraderAddress === 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn' ||
            item.targetTraderAddress === item.injectiveAddress
          ) {
            item.targetTraderAddress = undefined;
            item.targetTraderName = undefined;
            item.isCopyingEnabled = false;
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
      };

      this.wallets.set(telegramId, wallet);
      this.saveWallets();
      console.log(`[WalletService] 🆕 为用户 @${username || telegramId} 生成真实 Injective 钱包: ${injectiveAddress}`);
    }
    return wallet;
  }

  /**
   * 设置体验金模式状态
   */
  public setPracticeMode(telegramId: number, enabled: boolean): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.practiceMode = enabled;
    if (enabled && (!wallet.practiceBalanceUsdt || wallet.practiceBalanceUsdt <= 0)) {
      wallet.practiceBalanceUsdt = 10000;
    }
    this.saveWallets();
    return wallet;
  }

  public isPracticeMode(telegramId: number): boolean {
    const wallet = this.wallets.get(telegramId);
    return wallet ? !!wallet.practiceMode : false;
  }

  /**
   * 获取用户个性化跟单配置与状态 (内置脏数据自愈保护)
   */
  public getUserCopyState(telegramId: number) {
    const wallet = this.getOrCreateWallet(telegramId);
    if (
      wallet.targetTraderAddress === 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn' ||
      wallet.targetTraderAddress === wallet.injectiveAddress
    ) {
      wallet.targetTraderAddress = undefined;
      wallet.targetTraderName = undefined;
      wallet.isCopyingEnabled = false;
      this.saveWallets();
    }
    return {
      isCopyingEnabled: !!wallet.isCopyingEnabled,
      targetTraderAddress: wallet.targetTraderAddress,
      targetTraderName: wallet.targetTraderName,
      copyAmountUsdt: wallet.copyAmountUsdt || 100,
      practiceMode: !!wallet.practiceMode,
    };
  }

  /**
   * 设置用户的跟单目标
   */
  public setUserTarget(telegramId: number, targetAddress: string, targetName?: string): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.targetTraderAddress = targetAddress;
    wallet.targetTraderName = targetName;
    this.saveWallets();
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
   * 清除跟单目标
   */
  public clearUserTarget(telegramId: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.targetTraderAddress = undefined;
    wallet.targetTraderName = undefined;
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
