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
- [ ] **Phase 1: 最小可用原型 (MVP)**
  - 接入 Injective 测试网 (`testnet`)
  - 使用 `@injectivelabs/sdk-ts` 实现指定钱包开仓/平仓的实时监听
  - 自动执行按比例复制下单
- [ ] **Phase 2: Telegram 跟单机器人 (TG Bot)**
  - 绑定钱包与子账户
  - 接收聪明钱调仓通知与一键快捷跟单
- [ ] **Phase 3: Web 聪明钱看板与风控后台**
  - 胜率、盈亏比、回撤排行
  - 止损与最大仓位保护
