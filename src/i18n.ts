export type BotLang = 'zh' | 'en';

export function detectTelegramLang(languageCode?: string): BotLang {
  if (!languageCode) return 'en';
  const norm = languageCode.trim().toLowerCase();
  return norm.startsWith('zh') ? 'zh' : 'en';
}

export function tr(lang: BotLang, zh: string, en: string): string {
  return lang === 'en' ? en : zh;
}

export function formatActiveAgo(minutesAgo: number, lang: BotLang): string {
  if (minutesAgo <= 1) {
    return tr(lang, '🔥 刚刚交易 (1分钟前)', '🔥 Just now (1m ago)');
  }
  if (minutesAgo < 60) {
    return tr(lang, `🔥 ${minutesAgo}分钟前交易`, `🔥 ${minutesAgo}m ago`);
  }
  if (minutesAgo <= 1440) {
    const hours = Math.floor(minutesAgo / 60);
    const mins = minutesAgo % 60;
    return mins > 0
      ? tr(lang, `⚡ ${hours}小时${mins}分钟前交易`, `⚡ ${hours}h ${mins}m ago`)
      : tr(lang, `⚡ ${hours}小时前交易`, `⚡ ${hours}h ago`);
  }
  const days = Math.floor(minutesAgo / 1440);
  return tr(lang, `🕒 ${days}天前交易`, `🕒 ${days}d ago`);
}

export function localizeServiceMessage(msg: string | undefined, lang: BotLang): string {
  if (!msg || lang === 'zh') return msg || '';

  if (msg.includes('滑点保护')) {
    return 'Slippage protection triggered: live orderbook deviates too far from smart-money entry price.';
  }
  if (msg.includes('最小下单单位')) {
    return 'Calculated order quantity is below the market minimum tick size.';
  }
  if (msg.includes('最小名义价值')) {
    return 'Calculated order notional is below the market minimum notional requirement.';
  }
  if (msg.includes('黑名单') || msg.includes('做市商')) {
    return 'Identified as a high-frequency market maker / grid arbitrage bot (copying incurs taker fees & slippage decay).';
  }
  if (msg.includes('频繁反向开平仓')) {
    return 'Frequent opposite-side round-trip flips within 5 minutes (HFT grid/hedging bot).';
  }
  if (msg.includes('高频套利吃单')) {
    return 'Extreme single-market hourly fill frequency (HFT taker bot).';
  }
  if (msg.includes('TWAP')) {
    return 'Detected uniform sequential micro-orders (TWAP/DCA split bot).';
  }
  if (msg.includes('微额碎单') || msg.includes('铺网')) {
    return 'High ratio of micro-sized fills across multiple pairs (multi-market spam/MM bot).';
  }
  if (msg.includes('余额不足') || msg.includes('可用体验金不足')) {
    return 'Insufficient available practice margin balance.';
  }
  if (msg.includes('满 1.00 USDT')) {
    return 'Minimum withdrawal threshold is 1.00 USDT.';
  }
  if (msg.includes('钱包解密异常')) {
    return 'Wallet decryption error; please contact admin to check encryption key config.';
  }
  return msg;
}
