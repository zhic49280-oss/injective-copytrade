# Injective CopyTrade (`@InjcopyTrade_bot`)

A real-time Telegram smart-money radar, anti-market-maker analytics engine, and automated perpetuals copy-trading terminal built natively on **Injective's Exchange module** (`@injectivelabs/sdk-ts` + `MainnetSentry` / `TestnetSentry` gRPC).

- **Live Telegram Bot:** [https://t.me/InjcopyTrade_bot](https://t.me/InjcopyTrade_bot)
- **Architecture Notes:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## Core Capabilities

1. **Full-Market Mainnet Whale Radar ([`WhaleRadarService`](./src/services/whale-radar.service.ts))**
   - Independently scans high-liquidity core markets (`BTC`, `ETH`, `SOL`, `INJ`, `XRP`, `DOGE`, `SUI`, `BNB`, `AVAX`, `TON`) so high-frequency `$1` micro-trades never crowd out real directional taker orders, while continuously rotating through all remaining active derivative markets (~308+ active perpetuals).
   - Filters for genuine directional `taker` executions above `$2,000` USD notional, deduplicates partial fills by `orderHash`, suppresses 120s rapid opposite-side wash flips, and audits addresses against known/detected market makers before broadcasting to subscribed Telegram channels with one-click deep-link copy triggers.

2. **Anti-Market-Maker & Wash-Trade Filtering ([`LeaderboardService`](./src/services/leaderboard.service.ts))**
   - Paginates across all active mainnet open positions (`fetchPositionsV2`), rather than truncating at the first 1,000 rows, and audits recent trade history per subaccount (`isMarketMakerOrHftBot`).
   - Automatically excludes market makers, high-frequency two-sided scalpers, TWAP micro-order bots, `$1–$5` spam scripts, and stale `>14d` inactive positions, deduplicating by primary `inj1...` address.

3. **Concurrent Multi-Whale gRPC Stream Engine ([`SmartMoneyTracker`](./src/services/smart-money-tracker.service.ts))**
   - Subscribes to live Injective Indexer `streamTrades` with automatic stream-end/error reconnection and fallback polling.
   - Tracks arbitrary subaccount indices (`parseSubaccountIndex`), filters stale trades (`>2m`), enforces per-trader cooldowns and rolling TWAP anti-spam checks, and protects memory via bounded FIFO caches.

4. **Per-User Isolated Risk Engine & Mainnet Execution ([`RiskManager`](./src/services/risk-manager.service.ts), [`CopyEngine`](./src/services/copy-engine.ts), [`InjectiveService`](./src/services/injective.service.ts))**
   - Live orderbook depth verification, `BigNumber` price-tick & quantity-step alignment, initial-margin/min-notional checks, slippage protection, and per-user copy mode (`FIXED_AMOUNT` or `RATIO`) & leverage limits.
   - Real-mode orders route natively through `MsgCreateDerivativeMarketOrder` (with reduce-only support and relayer `feeRecipient` attribution via cached `MsgBroadcasterWithPk`).

5. **Encrypted Per-User Vault & Practice Sandbox ([`WalletService`](./src/services/wallet.service.ts), [`TelegramBotService`](./src/services/telegram-bot.service.ts))**
   - Self-hosted per-user `inj1...` subaccount wallets encrypted at rest using **AES-256-GCM** (`WALLET_ENCRYPTION_SECRET`, atomic writes + backup retention, key export, mnemonic/private-key import).
   - Multi-whale concurrent copy matrix with opposite-direction conflict guards, `$10,000` practice sandbox for zero-balance onboarding, and referral commission tracking with admin withdrawal alerts.

---

## Project Structure

```text
src/
├── index.ts                          # Bootstrap, mainnet/testnet startup & graceful shutdown
├── config/index.ts                   # Typed environment config & validation
├── types/index.ts                    # Shared market, signal, risk, and execution interfaces
├── simulate.ts                       # End-to-end simulation & regression smoke checks
└── services/
    ├── injective.service.ts          # Injective SDK client, markets, orderbook & real order execution
    ├── smart-money-tracker.ts        # Concurrent gRPC trade stream + polling fallback
    ├── whale-radar.service.ts        # Full-market mainnet whale alert scanner
    ├── leaderboard.service.ts        # Active open-position aggregator & anti-MM audit
    ├── copy-engine.ts                # Risk evaluation & order execution orchestrator
    ├── risk-manager.ts               # Slippage, tick-size, leverage & notional guards
    ├── wallet.service.ts             # AES-256-GCM vault, practice engine & referral accounting
    └── telegram-bot.service.ts       # grammY Telegram UI, deep links & channel broadcasts
```

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```

Key environment variables (see [`.env.example`](./.env.example) for full documentation):

| Variable | Description |
| :--- | :--- |
| `NETWORK` | `mainnet` (default) or `testnet` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from `@BotFather` |
| `WALLET_ENCRYPTION_SECRET` | Strong 32+ char hex/string key for AES-256-GCM wallet vault |
| `DRY_RUN` | `true` for dry-run / practice mode, `false` for live mainnet execution |
| `FEE_RECIPIENT` | Injective `inj1...` relayer fee recipient address |
| `TELEGRAM_BROADCAST_CHAT_ID` | Optional channel/group ID for live whale alerts |
| `ADMIN_TELEGRAM_IDS` | Comma-separated Telegram IDs for admin notifications |

### 3. Build & Run
```bash
# Type-check & compile TypeScript
npm run build

# Start production service
npm start
```

Development & smoke verification:
```bash
npm run dev
npm run simulate
```

---

## Roadmap

- **Phase 1 (Completed):** Native Exchange module integration, tick/step precision risk engine, gRPC trade streaming, and mainnet `MsgCreateDerivativeMarketOrder` execution.
- **Phase 2 (Completed):** Telegram trading terminal (`@InjcopyTrade_bot`), AES-256-GCM wallet vault, full-market 308-perp Whale Radar, anti-MM/wash-trade filtering, `$10,000` practice sandbox, and referral accounting.
- **Phase 3 (Planned):** Telegram Mini App web dashboard, non-custodial AuthZ grant execution via Keplr/Leap, and multi-language (`EN` / `ZH`) interface support.

---

## License

MIT — see [`LICENSE`](./LICENSE).
