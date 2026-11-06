# Injective 链上聪明钱一键跟单系统 (Injective CopyTrade)

专为 **Injective (INJ)** 生态打造的高性能去中心化交易跟单平台与 Telegram 交易机器人。

## 🎯 项目核心目标与商业闭环
1. **聪明钱监听 (Smart Money Tracker)**：实时订阅 Injective 链上交易订单簿事件，识别高胜率、高 PnL 大户钱包。
2. **毫秒级跟单引擎 (Execution Engine)**：利用 Injective 亚秒级确认特性，散户授权子账户（Subaccount）实现超低延迟、低滑点自动跟单。
3. **协议手续费分成变现 (Monetization)**：所有跟单发起的链上交易，自动捕获 Injective 官方底层 **40% 的交易手续费分成**。
4. **全端触达 (Telegram Bot & Web)**：以 TG Bot 作为高频交互入口，以 Web 排行榜展示大户盈亏战绩吸引外部流量。

---

## 📂 核心文档
- 详见设计蓝图与架构说明：[`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## 🚀 开发路线规划
- [x] **Phase 1: 最小可用原型 (MVP)**
  - 接入 Injective 测试网 (`testnet`)
  - 使用 `@injectivelabs/sdk-ts` 与 `@injectivelabs/networks` 实现指定钱包开仓/平仓的实时监听与轮询双保底机制
  - 完备的风控引擎：滑点限制保护、单笔最大开仓上限、最大杠杆限制、市场最小精度 Tick 对齐
  - 支持固定金额模式 (`FIXED_AMOUNT`) 与比例复制模式 (`RATIO`)
  - 自动注入 Fee Recipient，捕获官方 40% 手续费分成
  - 端到端仿真测试脚本 (`npm run simulate`)
- [x] **Phase 2: Telegram 交易与获客机器人 (TG Bot)**
  - 手机端免电脑操作控制台，内置菜单与交互按钮
  - 聪明钱公开广播频道（Alpha Radar）捕获免费流量
  - 链上巨鲸高胜率排行榜（Leaderboard）公开透明战绩
  - 裂变返佣系统（Referral）：邀请好友享受 25% 终身手续费现金分红
  - 手机秒级推送跟单成交与风控拦截提醒
- [ ] **Phase 3: Web 聪明钱看板与风控后台**
  - 胜率、盈亏比、回撤排行
  - 止损与最大仓位保护

---

## 🛠️ 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
复制环境变量模版并按需配置：
```bash
cp .env.example .env
```

主要配置项说明：
```ini
# 网络: testnet 或 mainnet
NETWORK=testnet

# 跟单钱包私钥 (支持 0x 开头的十六进制私钥)
FOLLOWER_PRIVATE_KEY=your_private_key_here

# 目标聪明钱钱包地址 (inj 开头)
TARGET_TRADER_ADDRESS=inj1...

# 跟单模式: FIXED_AMOUNT (固定名义本金) 或 RATIO (按目标交易比例)
COPY_MODE=FIXED_AMOUNT
FIXED_USDT_AMOUNT=50

# 风控参数
MAX_SLIPPAGE_PERCENT=1.5
MAX_NOTIONAL_PER_ORDER=200
MAX_LEVERAGE=5

# ----------------- Telegram 手机端配置 -----------------
# Telegram Bot Token (在 Telegram 搜索 @BotFather 10秒免费创建)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# 邀请好友返佣百分比 (默认 25%)
REFERRAL_REWARD_PERCENT=25
```

### 3. 一键执行端到端仿真测试
在不消耗任何代币的情况下，从 Injective 测试网拉取真实深度和盘口，测试正常做多跟单与滑点超标风控拦截全流程：
```bash
npm run simulate
```

### 4. 启动完整系统 (云端跟单引擎 + Telegram 手机端)
```bash
# 开发模式
npm run dev

# 生产模式
npm run build
npm start
```
此时只要在手机 Telegram 中向您的机器人发送 `/start`，即可在手机上单手操作跟单、切换巨鲸目标与修改跟单金额！
