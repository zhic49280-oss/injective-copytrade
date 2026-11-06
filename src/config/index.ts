import dotenv from 'dotenv';
import { Network } from '@injectivelabs/networks';
import { CopyMode } from '../types/index.js';

dotenv.config();

export interface AppConfig {
  network: Network;
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
}

const networkStr = (process.env.NETWORK || 'testnet').toLowerCase();
const network = networkStr === 'mainnet' ? Network.Mainnet : Network.Testnet;

export const config: AppConfig = {
  network,
  followerPrivateKey: process.env.FOLLOWER_PRIVATE_KEY || '',
  followerSubaccountIndex: parseInt(process.env.FOLLOWER_SUBACCOUNT_INDEX || '0', 10),
  targetTraderAddress: process.env.TARGET_TRADER_ADDRESS || '',
  targetSubaccountIndex: parseInt(process.env.TARGET_SUBACCOUNT_INDEX || '0', 10),
  copyMode: (process.env.COPY_MODE?.toUpperCase() === 'RATIO' ? 'RATIO' : 'FIXED_AMOUNT') as CopyMode,
  fixedUsdtAmount: parseFloat(process.env.FIXED_USDT_AMOUNT || '50'),
  copyRatio: parseFloat(process.env.COPY_RATIO || '0.1'),
  maxSlippagePercent: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '1.5'),
  maxNotionalPerOrder: parseFloat(process.env.MAX_NOTIONAL_PER_ORDER || '200'),
  maxLeverage: parseFloat(process.env.MAX_LEVERAGE || '5'),
  dryRun: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  feeRecipient: process.env.FEE_RECIPIENT,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBroadcastChatId: process.env.TELEGRAM_BROADCAST_CHAT_ID || '',
  referralRewardPercent: parseFloat(process.env.REFERRAL_REWARD_PERCENT || '25'),
};

export function validateConfig(cfg: AppConfig = config) {
  const errors: string[] = [];

  if (!cfg.targetTraderAddress) {
    errors.push('TARGET_TRADER_ADDRESS 不能为空，请在 .env 中设置要监听的聪明钱地址。');
  }

  if (!cfg.dryRun && (!cfg.followerPrivateKey || cfg.followerPrivateKey === 'your_private_key_here')) {
    errors.push('真实跟单模式需要配置 FOLLOWER_PRIVATE_KEY。若仅用于监听或模拟测试，可设置 DRY_RUN=true。');
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
