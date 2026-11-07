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
  customEndpoints?: {
    indexer?: string;
    grpc?: string;
    rest?: string;
    rpc?: string;
  };
}

export function parseNetwork(netStr?: string): { network: Network; networkName: 'mainnet' | 'testnet' } {
  const clean = (netStr || process.env.NETWORK || 'testnet').trim().toLowerCase();
  if (clean === 'mainnet' || clean === 'main' || clean === 'mainnet-k8s') {
    return { network: Network.Mainnet, networkName: 'mainnet' };
  }
  return { network: Network.Testnet, networkName: 'testnet' };
}

const resolvedNetwork = parseNetwork(process.env.NETWORK);

// 默认已验证活跃聪明钱地址 (Testnet 与 Mainnet)
const DEFAULT_TARGET_ADDRESS =
  resolvedNetwork.networkName === 'mainnet'
    ? 'inj1xah26mtc37j3rt5rd3u8heg07rhvhjr64l9u5g'
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

  if (!cfg.dryRun && (!cfg.followerPrivateKey || cfg.followerPrivateKey === 'your_private_key_here')) {
    errors.push('真实跟单模式需配置 FOLLOWER_PRIVATE_KEY。未配置时系统支持体验金演练或 DRY_RUN 模拟。');
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
