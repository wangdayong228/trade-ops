# 对冲对账模块设计

日期：2026-09-05

状态：待审阅

## 1. 目标

把对账抽成独立最后关卡。凡会推进对冲任务状态的路径，在进入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE`，或决定补 GTC 之前，必须先跑完对账。对账未完成时，不得宣称对冲完成，也不得结束任务。

本模块落实 [对冲完全对账原则](2026-09-05-complete-hedge-reconciliation-design.md) 与 `docs/standards/code-rules.md` 第 4 条。原则文档只约束规则，不包含本次实现。

## 2. 范围

### 2.1 本期包含

- 新增 `HedgeReconciliation`，唯一入口 `run(strategyId)`。
- `run` 按本任务已持久化订单向交易所查回、校验、落库，独立加总两腿成交并唯一解释残差。
- 只有本模块能写入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE`、`WAITING_HEDGE`。
- 只有本模块返回的当次 `need_gtc` 能授权协调器挂一张差额 GTC。
- 删除协调器 `finishHedge`，以及协调器、监控器里直接写上述状态或自行决定补 GTC 的路径。
- 用测试锁住：对账未完成不能终态，残差只能落到已对冲 / 需补 GTC / 明确失败之一。

### 2.2 本期不包含

- 核对交易所现货余额或合约持仓。
- 对账模块下单、撤单、改价、回滚或平仓。
- 修改 HTTP/UI、状态枚举、订单角色、预检或账户设置自动修复。
- 资金费率之外的对冲形状（合约–合约价差）或平仓作业。
- 扩大已批准原则 spec 的「只改 code-rules」范围。

## 3. 模块

### 3.1 位置与入口

- 文件：`src/strategy/hedge-reconciliation.ts`
- 类：`HedgeReconciliation`
- 入口：`run(strategyId: string): Promise<ReconciliationResult>`
- 依赖：`ExchangeRegistry`、`StrategyRepository`、可选对账结论日志。不依赖协调器。
- 不下单：不调用 `createOrder`。

### 3.2 结果

`run` 至多做一种状态写入，并返回恰好一种结果：

| `kind` | 含义 | 是否写库状态 |
| --- | --- | --- |
| `written` | 已写入 `HEDGED` / `FAILED` / `HEDGE_INCOMPLETE` / `WAITING_HEDGE` | 是 |
| `pending` | 对账未完成 | 否，保持 `EXECUTING` |
| `awaiting_market_submission` | 尚无市价腿，等待协调器按模式提交市价 | 否 |
| `need_gtc` | 残差唯一解释为需补 GTC | 否 |

`need_gtc` 只包含：

- `role`：`SPOT_HEDGE_GTC` 或 `CONTRACT_HEDGE_GTC`
- `baseQuantity`：残差基础币数量（精确小数串）
- `referencePrice`：大侧实际正均价（尚未按目标所规则量化）

限价量化与 `submit` 仍在协调器。

### 3.3 锁

`run` 不调用 `tryAcquireStrategyOperation`。调用方必须已经持有该锁。监控器与协调器不得在未持锁时调用 `run`。

### 3.4 查所与落库

对每笔已持久化订单：

1. 尚无 `exchangeOrderId` 时用 `findOrderByClientId`。
2. 已有 `exchangeOrderId` 时用 `fetchOrder`；失败再 `findOrderByClientId`。
3. 校验通过后由本模块调用 `attachOrderSnapshot`，不把快照交回协调器代写。
4. 部分成功：成功的快照先落库；任一笔未查回或校验失败则整次 `pending`。
5. `planned` 且所上找不到：`pending`，不当失败。

查所失败、找不到或三方（任务状态、本地订单、交易所快照）在角色、数量、状态上不一致，都属于对账未完成。

`run` 可以记录对账结论（过关 / `pending` / `need_gtc` / 终态码）。逐笔 `order_*` 生命周期事件仍由现有提交与监控路径记录，不在 `run` 里重放下单事件。

## 4. 残差唯一解释

数字只来自本任务订单、查所并落库后的实际成交，忽略手续费。现货量 = 现货买单 `filledBaseQuantity` 之和；合约量 = 合约空单 `filledBaseQuantity` 之和；残差 = 两者之差的绝对值。大侧提供 `referencePrice`。

市价可靠终态：`closed`，或 `canceled`（`canceled` 的正成交仍计入，与现网规则一致）。

本模式要求的市价角色：

- `CONTRACT_FIRST`：`CONTRACT_MARKET`
- `SPOT_FIRST`：`SPOT_MARKET`
- `CONCURRENT`：`SPOT_MARKET` 与 `CONTRACT_MARKET`

顺序模式的第二腿是 GTC，缺它不算出市价角色未齐。

按固定顺序只落一种结论。

### 4.1 尚无市价腿

要求的市价角色一个都没有（含尚无 `planned`）时，返回 `awaiting_market_submission`。不得 `need_gtc`，不得写 `HEDGED`。

### 4.2 对账未完成 → `pending`

任一已持久化订单未按 client/exchange order ID 查回并落库，查所失败，或三方不一致。不写终态，不返回 `need_gtc`。

### 4.3 市价腿未齐或未到可靠终态 → `pending`

要求的市价角色缺少任一角色，或已有市价腿仍为 `open` / `unknown`。不补 GTC。因此 `CONCURRENT` 只到齐一条市价腿时不得 `need_gtc`。

### 4.4 已有 GTC

不论执行模式，只评估已存在的那张 GTC，不再返回 `need_gtc`：

| 所上状态 | 结论 |
| --- | --- |
| `open` | 写 `WAITING_HEDGE` |
| `closed`，成交 = 委托 = 补上前残差，剩余 `0`，补上后两腿相等且都 `> 0` | 写 `HEDGED` |
| `rejected` | 写 `HEDGE_INCOMPLETE`，`HEDGE_ORDER_REJECTED` |
| `canceled` 且未按委托完全成交 | 写 `HEDGE_INCOMPLETE`，`HEDGE_ORDER_CANCELED` |
| 委托量与当前残差不一致，或其他对不上 | 写 `HEDGE_INCOMPLETE`，`INCONSISTENT_ORDER_STATE` |

GTC 只许一张，且必须来自某次 `need_gtc` 之后的协调器提交。

### 4.5 无 GTC，要求的市价角色均已存在且均已可靠终态

| 条件 | 结论 |
| --- | --- |
| 两边成交 `> 0` 且相等 | 写 `HEDGED` |
| 两边都是 `0` | 写 `FAILED`，`NO_FILL` |
| 一边 `> 0`、一边 `0`，或两边都 `> 0` 但不相等，且大侧有可用正均价 | `need_gtc`（小侧角色、残差、大侧均价） |
| 需要补腿但大侧没有可用正均价 | 写 `HEDGE_INCOMPLETE`，`MISSING_AVERAGE_PRICE` |
| 市价 `rejected` 且无成交 | 写 `FAILED`，`ORDER_SUBMISSION_FAILED` |
| 其余畸形（数量守恒坏了、身份对不上） | 有正成交则 `HEDGE_INCOMPLETE`，否则 `FAILED`；码为 `INCONSISTENT_ORDER_STATE` |

`CONTRACT_FIRST` / `SPOT_FIRST` 走同一张表：第一腿未终态是 4.3；第一腿有成交后残差即第一腿成交量，4.5 对第二腿出 `need_gtc`。

协调器与监控器不再解释残差。

## 5. 协调器与监控器

监控器仍只调用 `confirmAndExecute`。它不再自己 `transition` 到 `HEDGED` / `FAILED` / `HEDGE_INCOMPLETE` / `WAITING_HEDGE`，也不再为了补第二腿在对账之外直接续跑下单逻辑。

`confirmAndExecute` 在已持锁且任务为 `EXECUTING`（或刚从 `PENDING_CONFIRMATION` 领取）时：

1. 调用 `run()`。
2. `need_gtc`：只提交这一张授权 GTC（先做现有账户设置守卫与限价量化），再 `run()`。
3. `pending` 或 `written`：返回。
4. `awaiting_market_submission`：按模式提交市价腿，再 `run()`。

任何 GTC 必须来自当次 `run()` 的 `need_gtc`。禁止使用 `submit` 返回的 snapshot 标终态。删除 `finishHedge`。

账户设置漂移只阻断新订单，不授权协调器写终态。`NoOrderSubmittedError` 也不得由协调器写 `FAILED`；立即再 `run()`。若订单仍为 `planned` 且所上找不到，结果是 `pending`（对账未完成）。这是相对现网「确定未提交即 `FAILED`」的收紧，服从原则第 4 条。

## 6. 测试

新文件：`tests/strategy/hedge-reconciliation.test.ts`。只用 fake 网关和临时或内存 SQLite，不读真实凭证、不访问真所。先写预期失败的测试，再实现 `run`。

至少覆盖：

- 查所失败 / 只查回一部分 → `pending`，成功快照已落库，不写终态、不 `need_gtc`
- `planned` 且所上没有 → `pending`
- 尚无市价腿 → `awaiting_market_submission`，不是 `HEDGED` / `need_gtc`
- 市价仍 `open` → `pending`
- 两腿正成交相等 → 只有 `run` 能写成 `HEDGED`；协调器持有过期本地 snapshot 也不能自己标完成
- 现货 `1`、合约 `0.6` → `need_gtc` 合约腿 `0.4` 且带大侧均价；未 `run` 不得 `submit` GTC
- 已有 GTC 且仍 `open` → `WAITING_HEDGE`，不再 `need_gtc`
- GTC 被拒 / 被撤且未完全成交 → `HEDGE_INCOMPLETE`
- 双零成交 → `FAILED` / `NO_FILL`
- 缺均价要补腿 → `HEDGE_INCOMPLETE` / `MISSING_AVERAGE_PRICE`

现有协调器、监控器测试改为断言：未经过 `run` 不能终态或补 GTC。不断言它们自己 `transition` 到 `HEDGED`。

## 7. 对后续工作的约束

缺少对账的终态、跳过查回的失败、未解释残差的 `HEDGED`，或未经当次 `need_gtc` 的 GTC，都视为违反本设计与原则第 4 条。
