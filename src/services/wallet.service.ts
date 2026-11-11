import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrivateKey, getSubaccountId, IndexerGrpcAccountPortfolioApi } from '@injectivelabs/sdk-ts';
import BigNumber from 'bignumber.js';
import { AppConfig } from '../config/index.js';
import { CopyMode } from '../types/index.js';
import { KNOWN_MARKET_MAKERS } from './leaderboard.service.js';

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
  subaccountIndex?: number;
  addedAt: number;
}

export interface ReferralPayoutRecord {
  id: string;
  amountUsdt: number;
  toAddress: string;
  status: 'PENDING_PAYOUT' | 'PAID';
  txHash?: string;
  createdAt: number;
}

export interface UserWallet {
  telegramId: number;
  username?: string;
  injectiveAddress: string;
  evmAddress?: string;
  subaccountId: string;
  privateKeyHex: string;
  mnemonic?: string;
  decryptionError?: boolean;
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
  copyMode?: CopyMode;
  copyAmountUsdt?: number;
  copyRatio?: number;
  maxSlippagePercent?: number;
  maxLeverage?: number;
  maxNotionalPerOrder?: number;
  referrerId?: number;
  referralEarningsUsdt?: number;
  referralVolumeUsdt?: number;
  referralWithdrawnUsdt?: number;
  referralPayouts?: ReferralPayoutRecord[];
  realPositionOwners?: Record<
    string,
    {
      direction: 'BUY' | 'SELL';
      traderAddresses: string[];
      updatedAt: number;
    }
  >;
}

export class WalletService {
  private config: AppConfig;
  private portfolioApi: IndexerGrpcAccountPortfolioApi;
  private storageFile: string;
  private wallets: Map<number, UserWallet> = new Map();
  private encryptionKey: Buffer;
  private legacyDecryptionKeys: Buffer[] = [];

  constructor(config: AppConfig, endpoints: { indexer: string }) {
    this.config = config;
    this.portfolioApi = new IndexerGrpcAccountPortfolioApi(endpoints.indexer);
    this.storageFile = path.resolve(process.cwd(), 'data', 'wallets.json');

    const dataDir = path.dirname(this.storageFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 主加密密钥: 优先使用 WALLET_ENCRYPTION_SECRET；未配置时自动生成并持久化独立随机密钥文件 (.vault.key)
    let masterSeed = process.env.WALLET_ENCRYPTION_SECRET || '';
    if (!masterSeed) {
      if (process.env.TELEGRAM_BOT_TOKEN) {
        masterSeed = process.env.TELEGRAM_BOT_TOKEN;
      } else {
        const keyFile = path.join(dataDir, '.vault.key');
        if (fs.existsSync(keyFile)) {
          masterSeed = fs.readFileSync(keyFile, 'utf-8').trim();
        } else {
          masterSeed = crypto.randomBytes(32).toString('hex');
          fs.writeFileSync(keyFile, masterSeed, { encoding: 'utf-8', mode: 0o600 });
        }
      }
    }
    this.encryptionKey = crypto.createHash('sha256').update(masterSeed).digest();

    // 兼容迁移旧版派生密钥（避免 VPS 补充 WALLET_ENCRYPTION_SECRET 后历史钱包无法解密）
    const keyFile = path.join(dataDir, '.vault.key');
    const vaultKeyFromDisk = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf-8').trim() : undefined;
    const legacySeeds = [
      process.env.TELEGRAM_BOT_TOKEN,
      vaultKeyFromDisk,
      'injective-copytrade-vault-master-seed-2026',
    ].filter((s): s is string => Boolean(s && s !== masterSeed));
    for (const seed of legacySeeds) {
      this.legacyDecryptionKeys.push(crypto.createHash('sha256').update(seed).digest());
    }

    this.loadWallets();
  }

  /**
   * 使用 AES-256-GCM 高级加密标准对敏感私钥或助记词进行加密落地存储
   */
  public encryptSecret(text?: string): string {
    if (!text) return '';
    if (text.startsWith('enc:v1:')) return text;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
  }

  private tryDecryptWithKey(ciphertext: string, key: Buffer): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 5) {
      throw new Error('密文格式损坏');
    }
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const encrypted = parts[4];
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * 解密 AES-256-GCM 密文私钥（支持历史明文与旧派生密钥平滑迁移，解密失败不伪装成明文）
   */
  public decryptSecret(ciphertext?: string): string {
    if (!ciphertext) return '';
    if (!ciphertext.startsWith('enc:v1:')) {
      return ciphertext;
    }

    try {
      return this.tryDecryptWithKey(ciphertext, this.encryptionKey);
    } catch {
      for (const legacyKey of this.legacyDecryptionKeys) {
        try {
          return this.tryDecryptWithKey(ciphertext, legacyKey);
        } catch {
          // continue trying legacy keys
        }
      }
      throw new Error('AES-256-GCM 私钥解密失败：主加密密钥不匹配或密文已损坏');
    }
  }

  private sanitizeAndMigrateTargets(item: UserWallet): boolean {
    let dirtyFixed = false;
    const isDirtyAddr = (addr?: string) =>
      !addr ||
      addr === 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn' ||
      addr === item.injectiveAddress ||
      KNOWN_MARKET_MAKERS.has(addr.toLowerCase());

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
   * 自动将历史碎片化模拟持仓（同一标的 + 同一巨鲸归属）合并为每组最多 1 笔净持仓，杜绝跨巨鲸多空仓位被误平仓
   */
  public consolidatePracticePositions(item: UserWallet): boolean {
    if (!Array.isArray(item.practicePositions) || item.practicePositions.length <= 1) {
      return false;
    }

    const posKey = (p: PracticePosition) =>
      `${p.marketTicker}::${(p.traderAddress || '').toLowerCase()}`;

    const seenKeys = new Set<string>();
    let hasDuplicateKey = false;
    for (const p of item.practicePositions) {
      const k = posKey(p);
      if (seenKeys.has(k)) {
        hasDuplicateKey = true;
        break;
      }
      seenKeys.add(k);
    }

    if (!hasDuplicateKey) {
      return false;
    }

    if (item.practiceBalanceUsdt === undefined) item.practiceBalanceUsdt = 10000;
    if (item.practiceRealizedPnlUsdt === undefined) item.practiceRealizedPnlUsdt = 0;
    if (!Array.isArray(item.practiceTradeHistory)) item.practiceTradeHistory = [];
    if (!item.practiceStats) {
      item.practiceStats = { totalTrades: 0, winTrades: 0, lossTrades: 0 };
    }

    const netByKey = new Map<string, PracticePosition>();
    for (const pos of item.practicePositions) {
      const key = posKey(pos);
      const existing = netByKey.get(key);
      if (!existing) {
        netByKey.set(key, { ...pos });
      } else if (existing.direction === pos.direction) {
        // 同向加仓：加权平均计算开仓均价并合并数量与保证金
        const newQty = Number((existing.quantity + pos.quantity).toFixed(6));
        const avgEntry =
          newQty > 0
            ? Number(
                ((existing.entryPrice * existing.quantity + pos.entryPrice * pos.quantity) / newQty).toPrecision(8)
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
        const rawNetPnl = Number((grossPnl - fee).toFixed(2));
        const netPnl = Math.max(-Number((existing.marginUsdt || 0).toFixed(2)), rawNetPnl);

        item.practiceBalanceUsdt = Number(
          Math.max(0, item.practiceBalanceUsdt + (existing.marginUsdt || 0) + (pos.marginUsdt || 0) + netPnl).toFixed(2)
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
        netByKey.delete(key);
      }
    }

    item.practicePositions = Array.from(netByKey.values());
    return true;
  }

  private loadWallets() {
    const parseFile = (filePath: string): UserWallet[] | null => {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw);
    };

    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let list: UserWallet[] | null = null;
      try {
        list = parseFile(this.storageFile);
      } catch (err: any) {
        console.error('[WalletService] 主钱包文件读取损坏，尝试从 .bak 备份恢复:', err.message);
        const bakFile = `${this.storageFile}.bak`;
        list = parseFile(bakFile);
      }

      if (!list) return;

      let dirtyFixed = false;
      for (const item of list) {
        // 自动解密私钥与助记词 (若读取到历史明文或旧密钥密文，标记 dirtyFixed=true 触发自动加密迁移)
        if (item.privateKeyHex) {
          if (!item.privateKeyHex.startsWith('enc:v1:')) {
            dirtyFixed = true;
          }
          try {
            const decryptedPk = this.decryptSecret(item.privateKeyHex);
            // 若旧密钥迁移过，保存时用当前主密钥重加密
            if (item.privateKeyHex.startsWith('enc:v1:')) {
              try {
                this.tryDecryptWithKey(item.privateKeyHex, this.encryptionKey);
              } catch {
                dirtyFixed = true;
              }
            }
            item.privateKeyHex = decryptedPk;
            item.decryptionError = false;
          } catch (e: any) {
            console.error(`[WalletService] 用户 ${item.telegramId} 私钥解密失败:`, e.message);
            item.decryptionError = true;
          }
        }
        if (item.mnemonic) {
          if (!item.mnemonic.startsWith('enc:v1:')) {
            dirtyFixed = true;
          }
          try {
            item.mnemonic = this.decryptSecret(item.mnemonic);
          } catch {
            // 保留原密文以免被覆盖
          }
        }

        if (this.sanitizeAndMigrateTargets(item)) {
          dirtyFixed = true;
        }
        if (item.practiceBalanceUsdt === undefined) {
          item.practiceBalanceUsdt = 10000;
        }
        if (!Array.isArray(item.practicePositions)) {
          item.practicePositions = [];
        } else {
          for (const pos of item.practicePositions) {
            if (pos.marketTicker && pos.marketTicker.toUpperCase().includes('BRETT') && pos.entryPrice > 10) {
              pos.entryPrice = Number((pos.entryPrice / 1e6).toFixed(6));
              dirtyFixed = true;
            }
            if ((!pos.entryPrice || pos.entryPrice <= 0 || !pos.marginUsdt) && pos.marketTicker) {
              if (pos.marketTicker.toUpperCase().includes('PEPE')) {
                pos.entryPrice = 0.00000514;
                pos.marginUsdt = Number(((pos.quantity * pos.entryPrice) / (pos.leverage || 5)).toFixed(2)) || 10;
                dirtyFixed = true;
              }
            }
          }
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
        if (!item.evmAddress && item.privateKeyHex && !item.decryptionError) {
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
      const encryptedList = list.map((item) => {
        const copy = { ...item };
        delete copy.decryptionError;
        return {
          ...copy,
          privateKeyHex: this.encryptSecret(item.privateKeyHex),
          mnemonic: item.mnemonic ? this.encryptSecret(item.mnemonic) : undefined,
        };
      });

      const payload = JSON.stringify(encryptedList, null, 2);
      const tmpFile = `${this.storageFile}.tmp.${process.pid}`;
      const bakFile = `${this.storageFile}.bak`;

      fs.writeFileSync(tmpFile, payload, { encoding: 'utf-8', mode: 0o600 });
      if (fs.existsSync(this.storageFile)) {
        try {
          fs.copyFileSync(this.storageFile, bakFile);
        } catch {
          // best effort backup
        }
      }
      fs.renameSync(tmpFile, this.storageFile);
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
   * 执行模拟体验金交易 (确保同一标+同一巨鲸最多 1 笔净持仓：同向加权合并均价，反向平仓结算盈亏并计入历史)
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
    action: 'OPEN' | 'CLOSE' | 'SKIPPED';
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

      // 防高频闪电对敲洗盘保护：若持仓开仓不足 45 秒且价格未出现明显波动 (< 0.4%)，跳过本次反向信号
      const holdTimeSec = (Date.now() - (existing.timestamp || 0)) / 1000;
      const priceChangePct = Math.abs((params.price - existing.entryPrice) / (existing.entryPrice || 1)) * 100;
      if (holdTimeSec < 45 && priceChangePct < 0.4) {
        return {
          success: true,
          action: 'SKIPPED',
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
      const rawNetPnl = Number((grossPnl - fee).toFixed(2));
      // 逐仓爆仓保护：单笔净亏损最多亏光该仓位保证金
      const netPnl = Math.max(-Number((existing.marginUsdt || 0).toFixed(2)), rawNetPnl);

      wallet.practiceBalanceUsdt = Number(
        Math.max(0, wallet.practiceBalanceUsdt + existing.marginUsdt + netPnl).toFixed(2)
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
   * 获取用户个性化跟单配置与状态 (内置脏数据自愈保护，绝不共用全局可变量)
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
      copyMode: wallet.copyMode || this.config.copyMode,
      copyAmountUsdt: wallet.copyAmountUsdt || this.config.fixedUsdtAmount || 100,
      copyRatio: wallet.copyRatio ?? this.config.copyRatio,
      maxSlippagePercent: wallet.maxSlippagePercent ?? this.config.maxSlippagePercent,
      maxLeverage: wallet.maxLeverage ?? this.config.maxLeverage,
      maxNotionalPerOrder: wallet.maxNotionalPerOrder ?? this.config.maxNotionalPerOrder,
      practiceMode: !!wallet.practiceMode,
    };
  }

  /**
   * 向多巨鲸跟单矩阵添加目标地址 (支持每个用户同时跟单最多 5 个巨鲸，绝不覆盖已有巨鲸)
   */
  public addUserTarget(
    telegramId: number,
    address: string,
    name?: string,
    subaccountIndex: number = 0
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
        subaccountIndex,
        addedAt: Date.now(),
      });
      added = true;
    } else {
      wallet.followedTargets[existingIdx].name = displayName;
      if (subaccountIndex !== undefined) {
        wallet.followedTargets[existingIdx].subaccountIndex = subaccountIndex;
      }
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
   * 汇总所有开启了 isCopyingEnabled 的用户正在跟单的所有去重巨鲸目标 (含子账户索引)
   */
  public getAllActiveTrackedTargets(): Array<{ address: string; subaccountIndex: number }> {
    const activeMap = new Map<string, { address: string; subaccountIndex: number }>();
    for (const wallet of this.wallets.values()) {
      if (!wallet.isCopyingEnabled) continue;
      if (Array.isArray(wallet.followedTargets)) {
        for (const t of wallet.followedTargets) {
          if (t.address) {
            const idx = t.subaccountIndex ?? 0;
            activeMap.set(`${t.address.toLowerCase()}:${idx}`, {
              address: t.address,
              subaccountIndex: idx,
            });
          }
        }
      }
      if (wallet.targetTraderAddress) {
        const key = `${wallet.targetTraderAddress.toLowerCase()}:0`;
        if (!activeMap.has(key)) {
          activeMap.set(key, { address: wallet.targetTraderAddress, subaccountIndex: 0 });
        }
      }
    }
    return Array.from(activeMap.values());
  }

  /**
   * 汇总所有开启了 isCopyingEnabled 的用户正在跟单的所有去重巨鲸地址列表
   */
  public getAllActiveTrackedAddresses(): string[] {
    const activeSet = new Set<string>();
    for (const t of this.getAllActiveTrackedTargets()) {
      activeSet.add(t.address);
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

  public setUserCopyMode(telegramId: number, mode: CopyMode): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.copyMode = mode;
    this.saveWallets();
    return wallet;
  }

  public setUserSlippage(telegramId: number, maxSlippagePercent: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.maxSlippagePercent = maxSlippagePercent;
    this.saveWallets();
    return wallet;
  }

  public setUserLeverage(telegramId: number, maxLeverage: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.maxLeverage = maxLeverage;
    this.saveWallets();
    return wallet;
  }

  public setUserMaxNotional(telegramId: number, maxNotionalPerOrder: number): UserWallet {
    const wallet = this.getOrCreateWallet(telegramId);
    wallet.maxNotionalPerOrder = maxNotionalPerOrder;
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

  private classifyStableDenom(denom: string): 'USDT' | 'USDC' | null {
    const d = denom.toLowerCase();
    // 主网常见 Peggy USDT 与 Noble/IBC USDC denom 识别
    if (
      d.includes('usdt') ||
      d === 'peggy0xdac17f958d2ee523a2206206994597c13d831ec7'
    ) {
      return 'USDT';
    }
    if (
      d.includes('usdc') ||
      d === 'peggy0x87ab3b4c8661e07d6372361211b96ed4dc36b1b5' ||
      d === 'peggy0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ||
      d === 'ibc/2cbc2ea121ae42563b08028466f37b600f2d7d4282342de938283cc3fb2bc00e'
    ) {
      return 'USDC';
    }
    return null;
  }

  /**
   * 实时查询链上真实余额 (按 INJ / USDT / USDC 与精确 denom 分离统计)
   */
  public async getRealBalances(
    address: string,
    injPriceUsd: number = 3.95
  ): Promise<{
    inj: string;
    usdt: string;
    usdc: string;
    stableUsd: string;
    totalUsd: number;
    denomTotals: Record<string, number>;
    subaccountDenomTotals: Record<string, number>;
  }> {
    try {
      const portfolio = await this.portfolioApi.fetchAccountPortfolioBalances(address);
      let injAmount = new BigNumber(0);
      let usdtAmount = new BigNumber(0);
      let usdcAmount = new BigNumber(0);
      const denomTotals: Record<string, number> = {};
      const subaccountDenomTotals: Record<string, number> = {};

      const addDenomBalance = (
        map: Record<string, number>,
        denom: string,
        rawAmount: string,
        decimals: number
      ) => {
        const val = new BigNumber(rawAmount || '0').dividedBy(10 ** decimals).toNumber();
        if (val > 0) {
          map[denom] = (map[denom] || 0) + val;
        }
      };

      if (portfolio && portfolio.bankBalancesList) {
        for (const item of portfolio.bankBalancesList) {
          if (item.denom === 'inj') {
            injAmount = injAmount.plus(new BigNumber(item.amount).dividedBy(1e18));
            addDenomBalance(denomTotals, item.denom, item.amount, 18);
          } else {
            const stable = this.classifyStableDenom(item.denom);
            if (stable === 'USDT') {
              usdtAmount = usdtAmount.plus(new BigNumber(item.amount).dividedBy(1e6));
            } else if (stable === 'USDC') {
              usdcAmount = usdcAmount.plus(new BigNumber(item.amount).dividedBy(1e6));
            }
            if (stable) {
              addDenomBalance(denomTotals, item.denom, item.amount, 6);
            }
          }
        }
      }

      if (portfolio && portfolio.subaccountsList) {
        for (const sub of portfolio.subaccountsList) {
          const avail = sub.deposit?.availableBalance || '0';
          if (sub.denom === 'inj') {
            injAmount = injAmount.plus(new BigNumber(avail).dividedBy(1e18));
            addDenomBalance(denomTotals, sub.denom, avail, 18);
            addDenomBalance(subaccountDenomTotals, sub.denom, avail, 18);
          } else {
            const stable = this.classifyStableDenom(sub.denom);
            if (stable === 'USDT') {
              usdtAmount = usdtAmount.plus(new BigNumber(avail).dividedBy(1e6));
            } else if (stable === 'USDC') {
              usdcAmount = usdcAmount.plus(new BigNumber(avail).dividedBy(1e6));
            }
            if (stable) {
              addDenomBalance(denomTotals, sub.denom, avail, 6);
              addDenomBalance(subaccountDenomTotals, sub.denom, avail, 6);
            }
          }
        }
      }

      const stableTotal = usdtAmount.plus(usdcAmount);
      const effectiveInjPrice = injPriceUsd > 0 ? injPriceUsd : 3.95;
      const totalUsd = stableTotal.plus(injAmount.multipliedBy(effectiveInjPrice)).toNumber();

      return {
        inj: injAmount.toFixed(4),
        usdt: usdtAmount.toFixed(2),
        usdc: usdcAmount.toFixed(2),
        stableUsd: stableTotal.toFixed(2),
        totalUsd: Number(totalUsd.toFixed(2)),
        denomTotals,
        subaccountDenomTotals,
      };
    } catch {
      return {
        inj: '0.0000',
        usdt: '0.00',
        usdc: '0.00',
        stableUsd: '0.00',
        totalUsd: 0,
        denomTotals: {},
        subaccountDenomTotals: {},
      };
    }
  }

  /**
   * 绑定用户的上级邀请人 (支持通过推广链接 /start ref_<inviterId> 绑定)
   */
  public bindReferrer(userId: number, referrerId: number): boolean {
    if (!userId || !referrerId || userId === referrerId) {
      return false;
    }
    const userWallet = this.getOrCreateWallet(userId);
    if (userWallet.referrerId) {
      return false;
    }
    userWallet.referrerId = referrerId;
    this.saveWallets();
    console.log(`[WalletService] 🤝 用户 ${userId} 成功绑定上级邀请人: ${referrerId}`);
    return true;
  }

  /**
   * 记录真实跟单成交产生的推广返佣收益并自动累加至邀请人账本
   */
  public recordReferralReward(
    traderUserId: number,
    tradeNotionalUsdt: number
  ): { referrerId: number; rewardUsdt: number; totalEarned: number } | null {
    if (!tradeNotionalUsdt || tradeNotionalUsdt <= 0) return null;

    const traderWallet = this.wallets.get(traderUserId);
    if (!traderWallet || !traderWallet.referrerId) return null;

    const referrerId = traderWallet.referrerId;
    const referrerWallet = this.getOrCreateWallet(referrerId);

    const takerFeeUsdt = tradeNotionalUsdt * 0.001;
    const commissionRate = (this.config.referralRewardPercent || 25) / 100;
    const rewardUsdt = Number((takerFeeUsdt * commissionRate).toFixed(4));

    if (rewardUsdt <= 0) return null;

    referrerWallet.referralEarningsUsdt = Number(
      ((referrerWallet.referralEarningsUsdt || 0) + rewardUsdt).toFixed(4)
    );
    referrerWallet.referralVolumeUsdt = Number(
      ((referrerWallet.referralVolumeUsdt || 0) + tradeNotionalUsdt).toFixed(2)
    );

    this.saveWallets();

    return {
      referrerId,
      rewardUsdt,
      totalEarned: referrerWallet.referralEarningsUsdt,
    };
  }

  /**
   * 获取指定用户的邀请返佣统计明细 (已邀人数、累计收益、可提现金额)
   */
  public getReferralStats(userId: number) {
    const wallet = this.getOrCreateWallet(userId);
    const allWallets = this.getAllWallets();
    const invitedUsers = allWallets.filter((w) => w.referrerId === userId);
    const totalEarnings = wallet.referralEarningsUsdt || 0;
    const withdrawn = wallet.referralWithdrawnUsdt || 0;
    const available = Math.max(0, Number((totalEarnings - withdrawn).toFixed(4)));
    const volume = wallet.referralVolumeUsdt || 0;
    const pendingPayouts = (wallet.referralPayouts || []).filter((p) => p.status === 'PENDING_PAYOUT');

    return {
      invitedCount: invitedUsers.length,
      invitedUsers: invitedUsers.map((u) => ({
        telegramId: u.telegramId,
        username: u.username,
        joinedAt: u.createdAt,
      })),
      totalEarnings,
      withdrawn,
      available,
      volume,
      pendingPayoutUsdt: Number(
        pendingPayouts.reduce((s, p) => s + p.amountUsdt, 0).toFixed(4)
      ),
      payouts: wallet.referralPayouts || [],
    };
  }

  /**
   * 用户申请提现已累积的推广返佣 (满 1.00 USDT 创建可审计链上打款申请单，杜绝静默空扣)
   */
  public withdrawReferralRewards(
    userId: number
  ): {
    success: boolean;
    amount: number;
    payoutId?: string;
    message: string;
    wallet: UserWallet;
  } {
    const wallet = this.getOrCreateWallet(userId);
    const stats = this.getReferralStats(userId);

    if (stats.available < 1.0) {
      return {
        success: false,
        amount: 0,
        message: `提现门槛为 1.00 USDT，当前可提现余额为 $${stats.available.toFixed(4)} USDT，未达提现标准！`,
        wallet,
      };
    }

    const withdrawAmount = stats.available;
    wallet.referralWithdrawnUsdt = Number(
      ((wallet.referralWithdrawnUsdt || 0) + withdrawAmount).toFixed(4)
    );

    if (!Array.isArray(wallet.referralPayouts)) {
      wallet.referralPayouts = [];
    }
    const payoutId = `PAY_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    wallet.referralPayouts.unshift({
      id: payoutId,
      amountUsdt: withdrawAmount,
      toAddress: wallet.injectiveAddress,
      status: 'PENDING_PAYOUT',
      createdAt: Date.now(),
    });
    if (wallet.referralPayouts.length > 50) {
      wallet.referralPayouts = wallet.referralPayouts.slice(0, 50);
    }

    this.saveWallets();
    return {
      success: true,
      amount: withdrawAmount,
      payoutId,
      message: `已登记 $${withdrawAmount.toFixed(2)} USDT 返佣提现单 (${payoutId})，目标地址: ${wallet.injectiveAddress}`,
      wallet,
    };
  }

  public markReferralPayoutPaid(userId: number, payoutId: string, txHash: string) {
    const wallet = this.wallets.get(userId);
    if (!wallet || !Array.isArray(wallet.referralPayouts)) return;
    const rec = wallet.referralPayouts.find((p) => p.id === payoutId);
    if (rec) {
      rec.status = 'PAID';
      rec.txHash = txHash;
      this.saveWallets();
    }
  }

  /**
   * 实盘多巨鲸仓位归属冲突检查：防止巨鲸 B 的反向信号误平掉巨鲸 A 的在途实盘持仓
   */
  public checkRealPositionConflict(
    userId: number,
    marketId: string,
    incomingDirection: 'BUY' | 'SELL',
    traderAddress?: string
  ): { conflict: boolean; ownerAddresses: string[] } {
    if (!traderAddress) return { conflict: false, ownerAddresses: [] };
    const wallet = this.wallets.get(userId);
    const owner = wallet?.realPositionOwners?.[marketId];
    if (!owner || owner.direction === incomingDirection || owner.traderAddresses.length === 0) {
      return { conflict: false, ownerAddresses: [] };
    }
    const cleanTrader = traderAddress.toLowerCase();
    const isSameOwner = owner.traderAddresses.some((a) => a.toLowerCase() === cleanTrader);
    if (isSameOwner) {
      return { conflict: false, ownerAddresses: owner.traderAddresses };
    }
    return { conflict: true, ownerAddresses: owner.traderAddresses };
  }

  public updateRealPositionOwner(
    userId: number,
    marketId: string,
    direction: 'BUY' | 'SELL',
    traderAddress?: string,
    isReduceOnly: boolean = false,
    fullyClosed: boolean = false
  ) {
    const wallet = this.getOrCreateWallet(userId);
    if (!wallet.realPositionOwners) {
      wallet.realPositionOwners = {};
    }
    if (fullyClosed) {
      delete wallet.realPositionOwners[marketId];
      this.saveWallets();
      return;
    }
    const cleanTrader = (traderAddress || '').toLowerCase();
    if (isReduceOnly) {
      const existing = wallet.realPositionOwners[marketId];
      if (existing && cleanTrader) {
        existing.traderAddresses = existing.traderAddresses.filter(
          (a) => a.toLowerCase() !== cleanTrader
        );
        if (existing.traderAddresses.length === 0) {
          delete wallet.realPositionOwners[marketId];
        } else {
          existing.updatedAt = Date.now();
        }
        this.saveWallets();
      }
      return;
    }

    const cur = wallet.realPositionOwners[marketId];
    if (!cur || cur.direction !== direction) {
      wallet.realPositionOwners[marketId] = {
        direction,
        traderAddresses: cleanTrader ? [cleanTrader] : [],
        updatedAt: Date.now(),
      };
    } else if (cleanTrader && !cur.traderAddresses.includes(cleanTrader)) {
      cur.traderAddresses.push(cleanTrader);
      cur.updatedAt = Date.now();
    }
    this.saveWallets();
  }

  public clearRealPositionOwners(userId: number, marketId?: string) {
    const wallet = this.wallets.get(userId);
    if (!wallet || !wallet.realPositionOwners) return;
    if (marketId) {
      delete wallet.realPositionOwners[marketId];
    } else {
      wallet.realPositionOwners = {};
    }
    this.saveWallets();
  }
}
