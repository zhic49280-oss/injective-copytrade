import dotenv from 'dotenv';
import { Network } from '@injectivelabs/networks';
import { CopyMode } from '../types/index.js';

dotenv.config();

export interface AppConfig {
  network: Network;
  networkName: 'mainnet' | 'testnet';
  followerPrivateKey: string;
  followerSubaccountIndex: number;
  targetTraderAddress: string;
  targetSubaccountIndex: number;
  copyMode: CopyMode;
  fixedUsdtAmount: number;
  copyRatio: number;
  maxSlippagePercent: number;
  maxNotionalPerOrder: number;
  maxLeverage: number;
  dryRun: boolean;
  feeRecipient?: string;
  pollIntervalMs: number;
  telegramBotToken?: string;
  telegramBroadcastChatId?: string;
  referralRewardPercent: number;
  referralPayoutPrivateKey?: string;
  allowedTelegramIds?: number[];
  adminTelegramIds?: number[];
  minSignalNotionalUsd: number;
  channelMinNotionalUsd: number;
  signalCooldownMs: number;
  whaleRadarMinNotionalUsd: number;
  customEndpoints?: {
    indexer?: string;
    grpc?: string;
    rest?: string;
    rpc?: string;
  };
}

export function parseNetwork(netStr?: string): { network: Network; networkName: 'mainnet' | 'testnet' } {
  const clean = (netStr || 'mainnet').trim().toLowerCase();
  if (clean === 'testnet') {
    return { network: Network.TestnetSentry, networkName: 'testnet' };
  }
  return { network: Network.MainnetSentry, networkName: 'mainnet' };
}

function parseIdList(raw?: string): number[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const ids = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

// 优先响应 FORCE_TESTNET=true，其次读取 NETWORK 环境变量，默认主网 mainnet
const resolvedNetwork =
  process.env.FORCE_TESTNET === 'true'
    ? parseNetwork('testnet')
    : parseNetwork(process.env.NETWORK || 'mainnet');

// 默认已验证活跃聪明钱地址 (Mainnet 与 Testnet)
const DEFAULT_TARGET_ADDRESS =
  resolvedNetwork.networkName === 'mainnet'
    ? 'inj1nzy6v4umemnkvucy7wgprh6mlwskexzdgkppp4'
    : 'inj1zd8e0mh95hle4l5y2n8ts94pkkzq25vg8aj0xp';

export const config: AppConfig = {
  network: resolvedNetwork.network,
  networkName: resolvedNetwork.networkName,
  followerPrivateKey: process.env.FOLLOWER_PRIVATE_KEY || '',
  followerSubaccountIndex: parseInt(process.env.FOLLOWER_SUBACCOUNT_INDEX || '0', 10),
  targetTraderAddress: process.env.TARGET_TRADER_ADDRESS || DEFAULT_TARGET_ADDRESS,
  targetSubaccountIndex: parseInt(process.env.TARGET_SUBACCOUNT_INDEX || '0', 10),
  copyMode: (process.env.COPY_MODE?.toUpperCase() === 'RATIO' ? 'RATIO' : 'FIXED_AMOUNT') as CopyMode,
  fixedUsdtAmount: parseFloat(process.env.FIXED_USDT_AMOUNT || '50'),
  copyRatio: parseFloat(process.env.COPY_RATIO || '0.1'),
  maxSlippagePercent: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '1.5'),
  maxNotionalPerOrder: parseFloat(process.env.MAX_NOTIONAL_PER_ORDER || '200'),
  maxLeverage: parseFloat(process.env.MAX_LEVERAGE || '5'),
  dryRun: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  feeRecipient: process.env.FEE_RECIPIENT || 'inj10k7vw7thyltfjag0junlxfrd0nf4wjjc3grecn',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBroadcastChatId: process.env.TELEGRAM_BROADCAST_CHAT_ID || '',
  referralRewardPercent: parseFloat(process.env.REFERRAL_REWARD_PERCENT || '25'),
  referralPayoutPrivateKey: process.env.REFERRAL_PAYOUT_PRIVATE_KEY || '',
  allowedTelegramIds: parseIdList(process.env.ALLOWED_TELEGRAM_IDS),
  adminTelegramIds: parseIdList(process.env.ADMIN_TELEGRAM_IDS),
  minSignalNotionalUsd: parseFloat(process.env.MIN_SIGNAL_NOTIONAL_USD || '150'),
  channelMinNotionalUsd: parseFloat(process.env.CHANNEL_MIN_NOTIONAL_USD || '1000'),
  signalCooldownMs: parseInt(process.env.SIGNAL_COOLDOWN_MS || '180000', 10),
  whaleRadarMinNotionalUsd: parseFloat(process.env.WHALE_RADAR_MIN_NOTIONAL_USD || '2000'),
  customEndpoints: {
    indexer: process.env.INDEXER_ENDPOINT,
    grpc: process.env.GRPC_ENDPOINT,
    rest: process.env.REST_ENDPOINT,
    rpc: process.env.RPC_ENDPOINT,
  },
};

export function validateConfig(cfg: AppConfig = config) {
  const errors: string[] = [];

  if (!cfg.targetTraderAddress) {
    errors.push('未指定初始监听地址，将等待用户在 Telegram 输入或点击榜单锁定。');
  }

  if (!cfg.dryRun && !cfg.telegramBotToken && (!cfg.followerPrivateKey || cfg.followerPrivateKey === 'your_private_key_here')) {
    errors.push('单机实盘模式需配置 FOLLOWER_PRIVATE_KEY。未配置时系统将强制回退 DRY_RUN 模拟模式。');
  }

  if (!process.env.WALLET_ENCRYPTION_SECRET) {
    errors.push('强烈建议在 .env 中设置固定强随机 WALLET_ENCRYPTION_SECRET，防止更换 TELEGRAM_BOT_TOKEN 后历史用户钱包无法解密。');
  }

  if (cfg.maxLeverage <= 0 || cfg.maxLeverage > 50) {
    errors.push('MAX_LEVERAGE 杠杆倍数必须在 1 到 50 之间。');
  }

  if (cfg.maxSlippagePercent <= 0 || cfg.maxSlippagePercent > 20) {
    errors.push('MAX_SLIPPAGE_PERCENT 滑点百分比设置不合理 (应在 0.1% ~ 20% 之间)。');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
