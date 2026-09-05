# 对冲对账模块设计

日期：2026-09-05

状态：已批准

## 1. 目标

把对账实现为对冲任务的独立最后关卡。凡会推进对冲任务状态的路径，在进入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE`，或授权补一张差额 GTC 之前，必须完成本任务订单的完全对账。

本模块落实 [对冲完全对账原则](2026-09-05-complete-hedge-reconciliation-design.md) 与 `docs/standards/code-rules.md` 第 4 条，并补齐以下安全约束：

- 重启后从 `WAITING_HEDGE` 继续查回 GTC，不能把它卡在恢复入口之外。
- 非空但非法的订单角色拓扑不能被误判成“尚未提交”，因而不能授权新订单。
- GTC 委托量与补单前市场残差比较；GTC 剩余量与计入其成交后的当前残差比较。
- 精确残差不可交易时明确结束为未完成，不能舍入后制造不足或过度对冲。
- 查所快照、提交结论、状态 CAS 和生命周期事件都必须可恢复、幂等且可观察。
- 每个生产 SQLite 文件必须由单个服务进程独占，避免跨进程在“证据检查”和“状态写入或补单”之间形成竞争窗口。

## 2. 范围

### 2.1 本期包含

- 新增 `HedgeReconciliation`，唯一入口为 `run(strategyId)`。
- `run` 按本任务已持久化订单查所、校验、按需落库，独立加总两腿成交并唯一解释残差。
- 只有本模块可以写入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE`、`WAITING_HEDGE`。
- 只有本模块当次返回的 `need_gtc` 可以授权协调器挂一张差额 GTC。
- 删除协调器 `finishHedge`，以及协调器、监控器中直接写上述状态或自行解释残差的路径。
- 为本地订单持久化最小提交结论，使“确定未提交”可由对账模块复核；不新增策略状态或订单角色。
- 新增失败码 `HEDGE_RESIDUAL_NOT_TRADABLE`，表示精确残差不满足目标市场交易约束。
- 由实际落库查所快照的模块唯一记录该快照对应的状态变化和终态事件。
- 服务在初始化 schema、构造交易所网关、恢复订单或监听 HTTP 前取得 SQLite 跨进程独占所有权；取得失败则关闭连接并终止启动。
- README 说明单进程数据库约束、独占期间不可并行检查或备份，以及停止服务后才能由另一个进程接管。

### 2.2 本期不包含

- 核对交易所现货余额或合约持仓。
- 由对账模块下单、撤单、改价、回滚或平仓。
- 修改 HTTP/UI、策略状态枚举、订单角色、预检流程或账户设置自动修复。
- 资金费率之外的对冲形状，例如合约之间的价差或平仓作业。
- 自动修复非法本地订单拓扑或提交不确定的订单。
- 多进程 active-active、跨主机共享 SQLite、数据库租约、PID 文件或独立锁文件。
- 为支持多进程而新增订单证据 revision；本期由数据库文件独占消除跨进程竞争。
- 扩大已批准原则 spec 的“只修改 code-rules”实施范围；本设计是后续独立实现。

## 3. 模块合同

### 3.1 位置、依赖与锁

- 文件：`src/strategy/hedge-reconciliation.ts`
- 类：`HedgeReconciliation`
- 入口：`run(strategyId: string): Promise<ReconciliationResult>`
- 依赖：`ExchangeRegistry`、`StrategyRepository`、现有非抛错 `TradeEventSink` 与应用日志。
- 不依赖协调器，不调用 `createOrder`，不改变账户设置。
- `run` 不调用 `tryAcquireStrategyOperation`；调用方必须已经持有该锁。
- 正常可执行入口状态为 `EXECUTING` 和 `WAITING_HEDGE`。协调器从 `PENDING_CONFIRMATION` 成功领取到 `EXECUTING` 后才能调用。
- 首次读到终态时不查所、不写库，只返回 `observed_state`；首次读到其他状态属于调用合同错误。

监控器、协调器和重启恢复不得在未持锁时调用 `run`。锁只防止当前进程重复执行；所有状态写入仍必须使用仓储 CAS，不能把锁当成数据库写入成功的证明。

单库单进程是本设计的运行时硬约束，不是部署建议。新增 `src/storage/sqlite-process-owner.ts`，导出：

```ts
export type SqliteOwnershipFailureCode =
  | 'DATABASE_OWNERSHIP_BUSY'
  | 'DATABASE_OWNERSHIP_UNAVAILABLE';

export class SqliteOwnershipError extends Error {
  readonly name = 'SqliteOwnershipError';

  constructor(
    readonly code: SqliteOwnershipFailureCode,
    readonly databasePath: string
  ) {
    super(code === 'DATABASE_OWNERSHIP_BUSY'
      ? `SQLite database ownership is busy: ${databasePath}`
      : `SQLite database exclusive ownership is unavailable: ${databasePath}`);
  }
}

export function claimSqliteProcessOwnership(
  database: Database.Database,
  databasePath: string
): void;
```

`composeService` 的固定顺序为：完整校验配置；创建数据库父目录；用 `timeout: 0` 打开一个尚未执行任何 SQL 的连接；调用 `claimSqliteProcessOwnership`；初始化 WAL/schema 和仓储；再构造交易所网关及其余组件。取得所有权前不得调用任何 gateway 方法、恢复订单、启动监控或监听 HTTP。

`claimSqliteProcessOwnership` 必须按顺序执行：

1. 执行 `PRAGMA main.locking_mode = EXCLUSIVE`，并严格验证返回值为 `exclusive`；只设置 PRAGMA 不算取得所有权。
2. 执行 `BEGIN EXCLUSIVE; COMMIT`，只有整个调用成功返回才算实际取得所有权。
3. `SQLITE_BUSY` 或 `SQLITE_LOCKED` 转成 `DATABASE_OWNERSHIP_BUSY`；模式返回值异常或其他无法证明独占的结果转成 `DATABASE_OWNERSHIP_UNAVAILABLE`。错误消息只含固定描述和经过既有日志边界处理的数据库路径，不透传 SQLite 原始消息，也不声称竞争者一定是另一个 trade-ops 进程。
4. 成功后不提供提前释放 API。同一个连接供仓储使用并持有到服务停止；正常关闭和所有启动失败路径都只在最后调用一次 `database.close()` 释放所有权。

独占模式必须在首次 WAL 访问之前设置。SQLite 明确将“阻止其他进程访问数据库文件”列为 exclusive locking mode 的用途；连接第一次写入后会持有排他锁，直到连接关闭。在首次 WAL 访问前进入独占模式后，WAL 期间保持独占。实现依据为 [SQLite `locking_mode`](https://www.sqlite.org/pragma.html#pragma_locking_mode) 与 [WAL exclusive mode](https://www.sqlite.org/wal.html#use_of_wal_without_shared_memory)。

生产 `TRADING_DATABASE_PATH` 必须是支持 SQLite/VFS 文件锁的本地文件路径；配置校验拒绝 `:memory:` 和 `file:` URI，网络文件系统明确不受支持但不声称能从普通挂载路径可靠检测。`:memory:` 仍只允许测试通过 `databaseFactory` 注入；每个内存连接是独立数据库，不承担跨进程所有权证明。服务独占期间，其他读写工具也会收到锁错误；检查、备份或迁移必须先停止服务。进程异常退出后由操作系统释放文件锁，后继进程再通过同一抢锁流程接管并执行 SQLite 恢复，不维护可能残留的 PID 或锁文件。

### 3.2 返回结果

`run` 每次返回恰好一种结果：

| `kind` | 含义 | 是否写策略状态 |
| --- | --- | --- |
| `written` | 本次 CAS 确实写入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE` 或 `WAITING_HEDGE` | 是 |
| `observed_state` | 本次没有写入；首次读取或 CAS 后重读时已看到一个持久化状态 | 否 |
| `pending` | 本次证据不足，不能终态、不能补 GTC | 否，保持进入 `run` 时的状态 |
| `waiting_gtc` | GTC 已完全对账且仍有效 open，任务本来就处于 `WAITING_HEDGE` | 否 |
| `awaiting_market_submission` | `EXECUTING` 中订单集合为空，可以由协调器提交本模式的初始市价腿 | 否 |
| `need_gtc` | 完全对账后的精确残差可交易，可以由协调器提交指定的一张 GTC | 否 |

`written` 必须包含实际写入的 `state`，失败状态还要包含 `failureCode`。仓储 `transition` 返回 `false` 或抛错时，禁止返回 `written`：模块必须重读状态；已出现目标状态则返回 `observed_state`，仍是原状态或出现其他状态则返回 `pending / STATE_WRITE_CONFLICT`，并记录精确告警。

`need_gtc` 只包含：

- `role`：`SPOT_HEDGE_GTC` 或 `CONTRACT_HEDGE_GTC`
- `baseQuantity`：精确残差的基础币数量，使用规范化十进制字符串
- `referencePrice`：市场大侧的实际正均价，尚未按目标所规则量化

最终限价量化、账户设置守卫、订单意图持久化和 `submit` 仍由协调器负责。`need_gtc` 只证明生成该结果时数量与参考价满足第 7 节的授权条件，不替代提交边界的再次校验。

### 3.3 `pending` 诊断

`pending` 至少包含：

- 闭集 `reason`
- `strategyState`
- `exposureKnown`：本地或本次已验证快照中是否已有正成交
- 可定位时的 `strategyOrderId`、`clientOrderId`、`exchangeId`
- 经脱敏的 `expected` 与 `actual`；不得包含凭证、原始交易所响应或任意异常文本

`reason` 至少覆盖：

- `INVALID_LOCAL_TOPOLOGY`
- `ORDER_LOOKUP_FAILED`
- `ORDER_NOT_FOUND`
- `SUBMISSION_UNCERTAIN`
- `ORDER_SNAPSHOT_INVALID`
- `ORDER_EVIDENCE_MISMATCH`
- `SNAPSHOT_WRITE_CONFLICT`
- `MARKET_ORDER_ACTIVE`
- `GTC_STATUS_UNKNOWN`
- `STATE_WRITE_CONFLICT`

`pending` 不是静默分支。模块按 `(strategyId, reason, strategyOrderId, 当前订单修订)` 去重记录 warning；证据或原因改变后可以再次记录。

## 4. 持久化证据与快照所有权

### 4.1 订单提交结论

在 `strategy_orders` 增加订单级、非敏感的提交结论，不改变现有 `status`：

| 提交结论 | 含义 |
| --- | --- |
| `SUBMISSION_UNCERTAIN` | 已持久化意图，但没有足以排除外部副作用的证据；新计划与旧 `planned` 行均采用此值 |
| `DEFINITELY_NOT_SUBMITTED` | 网关在调用底层交易所 `createOrder` 前抛出 `NoOrderSubmittedError` |
| `REMOTE_OBSERVED` | 已按 exchange/client order ID 查到并成功落库交易所快照 |

同时保存可选的允许列表 `submissionFailureCode`，不得保存任意异常消息。仓储提供 CAS 方法记录 `DEFINITELY_NOT_SUBMITTED`；协调器只能写这份事实，不能据此直接写策略终态。该 CAS 只有返回 `true` 才算证据已持久化；返回 `false` 或抛错时必须重读订单，不能带着内存中的“确定未提交”结论继续终态化。

迁移规则：已有快照的旧订单回填为 `REMOTE_OBSERVED`；没有快照的旧 `planned` 订单回填为 `SUBMISSION_UNCERTAIN`，绝不能因迁移把旧意图当成“确定未提交”后重试。

对账时仍必须按 client order ID 查询 `DEFINITELY_NOT_SUBMITTED` 的订单：

- 查询为 `null`：远端不存在与本地确定未提交相互印证，该订单可作为零成交的明确失败证据。
- 反而查到订单：交易所快照优先落库为 `REMOTE_OBSERVED`，本次返回 `pending / ORDER_EVIDENCE_MISMATCH` 并告警；不得按旧结论终态或再次下单。
- 查询失败：仍为 `pending / ORDER_LOOKUP_FAILED`。

普通 `SUBMISSION_UNCERTAIN` 的 `planned` 订单查不到时保持 `pending`，不得失败、删除意图或重试 `createOrder`。

### 4.2 查所规则

对每笔通过本地拓扑预检的订单：

1. 没有 `exchangeOrderId` 时调用 `findOrderByClientId`。
2. 有 `exchangeOrderId` 时先调用 `fetchOrder`；失败后再调用 `findOrderByClientId`。
3. 使用已有订单请求校验快照的 exchange、client order ID、symbol、kind、type、side、委托量及合法状态推进。
4. 只有完整校验通过的快照才可以落库。
5. 部分成功时，已成功取得且发生语义变化的快照先落库；任何一笔仍未查回或校验失败，则整次返回 `pending`。

交易所快照的身份、请求和状态推进与本地记录不一致属于“对账未完成”，必须 `pending`。它与“所有快照均一致后，订单组合不能解释为合法对冲”的明确失败不同；后者才可以按第 7、8 节写 `HEDGE_INCOMPLETE` 或 `FAILED`。

### 4.3 幂等落库与事件

仓储提供“比较并附加”语义：在同一事务中比较当前快照并返回 `attached` 或 `unchanged`。比较字段包括身份、委托量、成交量、剩余量、均价和状态；仅 `updatedAt` 改变不算语义变化。

- `unchanged` 不新增 `order_events`，不更新订单行，不发新的生命周期事件。
- `attached` 才追加不可变 `order_events` 并更新订单行。
- 实际执行 `attached` 的对账模块负责记录一次 `order_status_changed`；从非终态首次进入 `closed / canceled / rejected` 时再记录一次 `order_terminal`。
- 协调器继续记录 `order_planned`、`order_submit_started`、`order_submit_succeeded`、`order_submit_uncertain`、`order_rejected_before_submit`，但不为查所快照重复记录状态事件。
- 日志与 `TradeEventSink` 失败不得改变对账结果。

## 5. 固定执行顺序

`run` 必须按以下顺序 fail-fast，后面的规则不能覆盖前面的 `pending`：

1. 读取策略与全部本地订单，确认入口状态。
2. 做第 6 节本地角色拓扑预检。只有订单集合为空才可能返回 `awaiting_market_submission`；任何非空非法拓扑立即 `pending`，且本次不调用任何交易所方法。
3. 按第 4.2 节查回并按需落库所有订单。查询、校验或写入冲突均 `pending`。
4. 重新读取策略与订单，确认使用的是刚落库后的证据；确认策略状态、本地请求和交易所快照三方一致。
5. 区分仍可能活动的订单与可靠终态；任何市价 `open / unknown`、GTC `unknown` 或不确定提交都 `pending`。
6. 先处理明确拒单或确定未提交，再处理第 7 节已有 GTC，最后处理第 8 节无 GTC 残差。
7. 需要写状态时执行一次 CAS，并按第 3.2 节处理 `true / false / throw`。

任何 `pending` 都不得被后续的零成交、拒单、数量畸形或缺均价规则覆盖。任何终态或 `need_gtc` 都要求所有相关订单已成为“有效远端快照”或“确定未提交且远端确认不存在”之一。

## 6. 本地订单角色拓扑

合法拓扑只允许下表中的集合；数据库每个角色仍至多一条订单：

| 模式 | 无 GTC 阶段 | 有 GTC 阶段 |
| --- | --- | --- |
| `CONTRACT_FIRST` | `{CONTRACT_MARKET}` | `{CONTRACT_MARKET, SPOT_HEDGE_GTC}` |
| `SPOT_FIRST` | `{SPOT_MARKET}` | `{SPOT_MARKET, CONTRACT_HEDGE_GTC}` |
| `CONCURRENT` | `{SPOT_MARKET, CONTRACT_MARKET}` | 两张市价单加且仅加一张 `SPOT_HEDGE_GTC` 或 `CONTRACT_HEDGE_GTC` |

额外规则：

- `EXECUTING` 且订单集合严格为空时返回 `awaiting_market_submission`。
- `WAITING_HEDGE` 订单集合为空，或没有 GTC，均为 `pending / INVALID_LOCAL_TOPOLOGY`。
- GTC-only、顺序模式出现错误市价角色、并发模式只剩一张市价角色、两张 GTC、GTC 出现在对应市场订单之前，均为非法拓扑。
- 非法拓扑不授权补齐缺失角色，不删除或改写既有订单，不调用 `createOrder`。
- 并发模式两张初始市价意图仍必须由协调器使用现有原子规划接口一次落库。

结构合法不代表 GTC 方向正确；方向必须在取得成交量后按第 7.1 节再次验证。

## 7. 精确残差与已有 GTC

### 7.1 两种残差

数字只来自本任务订单的已验证证据，忽略手续费。全部数量计算使用模块私有的 `Decimal.clone` 精确上下文，不读取或修改共享 `Decimal` 全局精度，不使用 JavaScript `number` 做数量、价格或名义金额运算。

先只加总市价单：

- `marketSpot` = `SPOT_MARKET.filledBaseQuantity`
- `marketContract` = `CONTRACT_MARKET.filledBaseQuantity`
- `marketDelta` = `marketSpot - marketContract`
- `preGtcResidual` = `abs(marketDelta)`

若已有 GTC：

- `marketDelta > 0` 时只允许 `CONTRACT_HEDGE_GTC`。
- `marketDelta < 0` 时只允许 `SPOT_HEDGE_GTC`。
- `marketDelta = 0` 时不允许存在 GTC。
- GTC 的请求基础币数量必须精确等于 `preGtcResidual`。
- `filledBaseQuantity + remainingBaseQuantity` 必须精确等于请求量，且 GTC 成交不得越过市场大侧。

再把 GTC 成交加到原本较小的一侧：

- `totalSpot` = 市价现货成交 + `SPOT_HEDGE_GTC` 成交
- `totalContract` = 市价合约成交 + `CONTRACT_HEDGE_GTC` 成交
- `currentResidual` = `abs(totalSpot - totalContract)`

合法 GTC 的 `remainingBaseQuantity` 必须精确等于 `currentResidual`。因此部分成交示例中，市场成交为现货 `1`、合约 `0.6`，GTC 请求 `0.4`、已成交 `0.1`、剩余 `0.3`：请求量与补单前残差 `0.4` 比较，剩余量与当前残差 `0.3` 比较，不能把请求量错误地与当前残差比较。

### 7.2 `need_gtc` 的可交易性

无已有 GTC 且产生正残差时，`run` 在返回 `need_gtc` 前必须验证精确残差，而不是对残差取整：

- 目标市场基础币步长为 `amountStep * contractSize`，残差必须是该步长的精确整数倍。
- swap 残差必须能精确转换成整数合约张数。
- 残差必须满足 `minBaseAmount` 与可选 `maxBaseAmount`。
- 使用现有 GTC 限价规则和目标 `priceStep` 得到的正候选价，验证可选 `minQuoteNotional / maxQuoteNotional`。
- 参考价、市场规则或精确运算无法安全验证时，不得返回 `need_gtc`。

残差在已验证规则下确定不满足上述约束时，已有正成交意味着存在暴露，写 `HEDGE_INCOMPLETE / HEDGE_RESIDUAL_NOT_TRADABLE`。市场规则读取失败、候选价量化失败或精确运算因资源上限无法得出可靠结论时，证据尚不充分，返回带具体上下文的 `pending`；不得把“不知道能否交易”写成“确定不可交易”。禁止向上或向下舍入残差后提交；也禁止让同一个确定不可交易的残差在 `need_gtc` 与 `planned-not-found` 之间永久循环。

协调器仍使用网关执行最终价格量化并在提交边界再次校验。若边界在调用底层 `createOrder` 前拒绝请求，按第 4.1 节持久化确定未提交证据，再调用 `run`；对账模块根据已持久化的精确 `submissionFailureCode` 终态化，而不是由协调器终态化。

### 7.3 已有 GTC 的互斥结论

进入本表前，市场腿必须已完全对账，GTC 已从远端查回或已证实确定未提交，且远端身份、请求与合法状态推进已通过三方一致性校验。GTC 相对市场残差的方向、请求量、数量守恒和状态语义由本表判定：

| 条件 | 唯一结论 |
| --- | --- |
| GTC 提交不确定，或远端仍无法确认 | `pending` |
| GTC 状态为 `unknown` | `pending / GTC_STATUS_UNKNOWN` |
| GTC 为 `open`、剩余量 `> 0` 且等于当前残差；策略为 `EXECUTING` | CAS 写 `WAITING_HEDGE` |
| 同一合法 open GTC；策略已为 `WAITING_HEDGE` | `waiting_gtc`，不做 `WAITING_HEDGE -> WAITING_HEDGE` |
| GTC 为 `closed`，或虽为 `canceled` 但已完全成交；成交等于请求、剩余为 `0`、两腿正成交相等 | 写 `HEDGED` |
| GTC 为 `rejected` 且零成交 | 写 `HEDGE_INCOMPLETE / HEDGE_ORDER_REJECTED` |
| GTC 为 `canceled` 且未完全成交 | 写 `HEDGE_INCOMPLETE / HEDGE_ORDER_CANCELED` |
| GTC 确定未提交且远端确认不存在 | 写 `HEDGE_INCOMPLETE / submissionFailureCode` |
| GTC 方向错误、请求量不等于补单前残差、成交越过大侧、`open` 却无正剩余、`closed` 未完成数量守恒、`rejected` 却有正成交，或其他已完全取证的语义畸形 | 写 `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE` |

身份、请求或合法状态推进与远端不一致不进入最后一行，而是在第 5 步提前 `pending / ORDER_EVIDENCE_MISMATCH`。已有任何 GTC 时绝不再次返回 `need_gtc`。

## 8. 无 GTC 的互斥结论

### 8.1 市价证据分类

- `open / unknown`：仍可能活动，返回 `pending`。
- `closed / canceled`：可作为残差计算的可靠终态；其中正成交继续计入。
- `rejected`：远端终态，但必须先走拒单分支，不能被普通残差分支转成 `need_gtc`。
- `DEFINITELY_NOT_SUBMITTED` 且远端确认不存在：零成交明确失败证据，也必须先于普通残差分支处理。

### 8.2 顺序模式

顺序模式只有第 6 节规定的第一张市价单：

| 条件 | 唯一结论 |
| --- | --- |
| `rejected` 或确定未提交，且为零成交 | 写 `FAILED / ORDER_SUBMISSION_FAILED` 或已持久化的精确提交失败码 |
| `rejected` 却有正成交 | 写 `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE`，不补 GTC |
| `closed / canceled` 且零成交 | 写 `FAILED / NO_FILL` |
| `closed / canceled` 且有正成交，但缺少正平均价 | 写 `HEDGE_INCOMPLETE / MISSING_AVERAGE_PRICE` |
| `closed / canceled` 且有正成交、正平均价、精确残差可交易 | 返回对应另一侧的 `need_gtc` |
| 有正成交但精确残差不可交易 | 写 `HEDGE_INCOMPLETE / HEDGE_RESIDUAL_NOT_TRADABLE` |

### 8.3 并发模式

两张市价单都必须存在且已取得可靠证据：

| 条件 | 唯一结论 |
| --- | --- |
| 两边都是零成交，且任一边 `rejected` 或确定未提交 | 写 `FAILED / ORDER_SUBMISSION_FAILED` 或更精确的已持久化提交失败码 |
| 任一边 `rejected` 或确定未提交，另一边已有正成交 | 写 `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE`，禁止自动补 GTC |
| 任一 `rejected` 快照自身有正成交 | 写 `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE` |
| 两边 `closed / canceled` 且都是零成交 | 写 `FAILED / NO_FILL` |
| 两边 `closed / canceled`、正成交且精确相等 | 写 `HEDGED`；不要求均价 |
| 两边 `closed / canceled` 有残差，大侧缺少正平均价 | 写 `HEDGE_INCOMPLETE / MISSING_AVERAGE_PRICE` |
| 两边 `closed / canceled` 有残差，大侧有正平均价且精确残差可交易 | 返回小侧对应角色的 `need_gtc` |
| 两边 `closed / canceled` 有残差，但精确残差不可交易 | 写 `HEDGE_INCOMPLETE / HEDGE_RESIDUAL_NOT_TRADABLE` |

数量守恒、订单身份或快照推进无法通过第 4、5 节时必须提前 `pending`，不能落入本表。只有三方已经一致、全部成交已知而组合语义仍不可能成立时，才写 `INCONSISTENT_ORDER_STATE`。

## 9. 协调器、监控器与恢复

监控器继续只调用 `confirmAndExecute`。它不再直接 `transition` 到 `HEDGED / FAILED / HEDGE_INCOMPLETE / WAITING_HEDGE`，不自行解释成交或残差，也不直接续跑差额下单。

`confirmAndExecute` 持锁后的流程：

1. `PENDING_CONFIRMATION` 先原子领取为 `EXECUTING`；`EXECUTING` 与 `WAITING_HEDGE` 直接继续，其他状态返回。
2. 先调用 `run`。恢复 `WAITING_HEDGE` 时不能先被账户设置守卫挡住，因为查回已有订单不产生新外部副作用。
3. `pending / written / observed_state / waiting_gtc`：返回。
4. `awaiting_market_submission`：执行现有新订单账户设置守卫；通过后按模式原子规划市价意图并提交，随后再次 `run`。
5. `need_gtc`：执行新订单账户设置守卫和最终限价量化；只规划并提交本次授权的角色、数量与参考价所对应的一张 GTC，随后再次 `run`。
6. `NoOrderSubmittedError`：只持久化 `DEFINITELY_NOT_SUBMITTED` 与允许列表失败码，然后再次 `run`；协调器不得写终态。
7. 不确定提交异常：保留 `SUBMISSION_UNCERTAIN`，再次 `run` 做 lookup-only 恢复；不得重试创建同一角色。

账户设置查回失败或确认漂移只阻断“将要发生的新提交”，保持当前策略状态并记录去重告警。它不能阻断已有订单查回，也不能授权协调器写终态。任何 GTC 必须能追溯到同一次持锁执行中的当次 `need_gtc`；禁止缓存旧授权跨轮次使用。

`listRecoverable()` 继续包含 `EXECUTING` 与 `WAITING_HEDGE`。恢复测试必须证明新仓储、新监控器实例能把已关闭的 GTC 从 `WAITING_HEDGE` 对账到正确终态，且不产生任何新订单。

## 10. 失败码与可观察性

新增 `StrategyFailureCode` 与 SQLite allowlist 值：

- `HEDGE_RESIDUAL_NOT_TRADABLE`：已完全对账且存在正暴露，但精确残差不满足目标市场数量、合约张数或名义金额约束。

保留现有失败码的语义：

- `ORDER_SUBMISSION_FAILED`：确定未提交，且没有更精确的允许列表码。
- `NO_FILL`：可靠终态且所有相关订单均为零成交，不含拒单或确定未提交优先分支。
- `MISSING_AVERAGE_PRICE`：确需补腿，但市场大侧没有可用正均价。
- `HEDGE_ORDER_REJECTED / HEDGE_ORDER_CANCELED`：已有 GTC 的明确远端结果。
- `INCONSISTENT_ORDER_STATE`：证据已齐全，但订单组合语义不可能成立；不能用来代替查所失败或三方不一致的 `pending`。

每个终态、`need_gtc` 和 `pending` 结论都记录结构化信息：`strategyId`、进入状态、结论、失败码或 pending reason、相关角色与安全订单标识、现货/合约成交、补单前残差、当前残差和 `exposureKnown`。错误必须包含期望与实际值并经过脱敏；不得记录凭证或原始响应。

## 11. 测试

新文件：`tests/strategy/hedge-reconciliation.test.ts`。只使用 fake 网关和临时或内存 SQLite，不读取真实凭证，不访问真实交易所。按 TDD 先写预期失败测试，再实现。

另新增 `tests/storage/sqlite-process-owner.test.ts` 与不被测试 glob 直接执行的子进程 fixture。所有权测试只使用临时 SQLite 文件和 fake gateway：

- 只设置 `locking_mode=EXCLUSIVE` 而未启动写事务时，竞争连接仍能读取，证明不能把 PRAGMA 返回值误当成已抢锁。
- owner 完成 `BEGIN EXCLUSIVE; COMMIT` 后，另一个真实子进程以 `timeout: 0` 抢同一文件必须得到类型化 `DATABASE_OWNERSHIP_BUSY`；它的 gateway 构造、恢复、`monitor.start` 与 `listen` 计数均为零。
- owner 正常 `close()` 后，新进程可以取得所有权；owner 被 `SIGKILL` 且子进程 `close` 事件已到达后，新进程也可以取得所有权，不使用固定 sleep。
- locking mode 返回异常、`SQLITE_BUSY`、其他所有权失败、schema 初始化失败和后续组件构造失败都验证错误分类及数据库只关闭一次。
- 保留“server close 失败仍关闭 SQLite”的测试，并在关闭后验证新连接可以接管。
- `:memory:` 只作为相互隔离的单元测试数据库；生产配置显式拒绝 `:memory:` 和 `file:` URI，且不构造 gateway 或数据库。网络文件系统限制只做文档与部署约束，因为普通路径不能被可靠分类。

### 11.1 查所与一致性

- 任一查询失败、找不到或只查回一部分：`pending`；成功且变化的快照已落库，不写终态、不 `need_gtc`。
- `planned + SUBMISSION_UNCERTAIN` 查不到：`pending`，不重试创建。
- 确定未提交查不到：按全部订单的暴露结论写精确失败；反而查到远端订单则落库并 `pending`。
- 本地请求与远端在身份、请求量、状态推进上不一致：`pending`，不是 `HEDGE_INCOMPLETE`。
- 相同快照重复 `run`：订单行、`order_events`、状态事件和终态事件均不增长。
- open 快照成交量变化，以及 open 首次变 closed：各自只追加一次正确快照与生命周期事件。

### 11.2 拓扑与授权

- `EXECUTING` 且订单集合为空：`awaiting_market_submission`。
- GTC-only、错误模式角色、并发只一张市价单、两张 GTC：`pending / INVALID_LOCAL_TOPOLOGY`，所有 fake `createOrder / fetchOrder / findOrderByClientId` 调用数为零。
- `WAITING_HEDGE` 缺 GTC：`pending`，不提交。
- 未经当次 `run -> need_gtc`，协调器不得提交 GTC；旧授权不得复用。

### 11.3 市价腿与残差

- 市价 `open / unknown`：`pending`。
- 两腿正成交精确相等：只有 `run` 能写 `HEDGED`；协调器持有过期 submit snapshot 也不能标完成。
- 现货 `1`、合约 `0.6`：返回 `CONTRACT_HEDGE_GTC / 0.4` 与现货大侧均价。
- 双零普通终态：`FAILED / NO_FILL`；拒单双零优先为 `ORDER_SUBMISSION_FAILED`。
- 并发一边正成交、另一边 `rejected` 零成交：`HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE`，不提交差额单。
- 需要补腿但缺正均价：`HEDGE_INCOMPLETE / MISSING_AVERAGE_PRICE`。

### 11.4 GTC 与恢复

- GTC 请求 `0.4`、成交 `0.1`、剩余 `0.3`：验证补单前残差 `0.4` 与当前残差 `0.3`，open 时进入或保持 `WAITING_HEDGE`。
- `EXECUTING + open GTC` 只写一次 `WAITING_HEDGE`；`WAITING_HEDGE + open GTC` 返回 `waiting_gtc`，不做非法自转换。
- GTC `unknown`：`pending`。
- GTC `closed` 完全成交，或 `canceled` 但完全成交且两腿相等：`HEDGED`。
- GTC 拒单、部分成交后撤单、方向错误、请求量错误或越过大侧：分别得到表中唯一结论，且不再 `need_gtc`。
- 新 repository 与 monitor 实例恢复 `WAITING_HEDGE`，查到 GTC closed 后写 `HEDGED`，不创建订单。

### 11.5 精度、提交证据与竞争

- 目标 swap 基础币步长为 `0.003`、残差为 `0.002`，或低于最小量/名义金额：`HEDGE_INCOMPLETE / HEDGE_RESIDUAL_NOT_TRADABLE`，不得舍入或调用 `createOrder`。
- 超长有效小数仍精确比较；测试前污染共享 `Decimal` 精度不改变结论。
- 紧凑极端指数在规范十进制展开超过固定资源上限时，及时返回 `pending / EXACT_ARITHMETIC_UNAVAILABLE`；不得调用会展开巨型字符串的 `toFixed()`，测试也不得构造对应的展开字符串或 `BigInt` expected。
- `NoOrderSubmittedError` 只写订单提交证据；再次 `run` 查证不存在后才由对账模块写终态。
- 不确定提交错误保持 `pending`，只做 lookup-only，不重复创建。
- 策略 CAS 返回 `false`、抛错或状态被竞争者改变：不得返回 `written`；必须重读并返回 `observed_state` 或精确 `pending`。

### 11.6 旧路径收口

- 协调器和监控器测试改为断言：未经过 `run` 不能写终态、`WAITING_HEDGE` 或补 GTC。
- 删除 `finishHedge` 后，没有其他生产代码直接解释两腿残差。
- 生产代码中上述四个状态的写入调用点只存在于对账模块；仓储自身状态机与测试辅助代码除外。

## 12. 完成条件

只有同时满足以下条件，后续实现才符合本设计：

- 所有状态推进与补 GTC 路径都经过同一个 `run` 关卡。
- `EXECUTING` 和 `WAITING_HEDGE` 都能恢复；任何恢复路径都不会重复创建已有角色。
- 非空非法拓扑、未查回订单、提交不确定和三方不一致都只能 `pending`。
- 任一终态或 `need_gtc` 都能从本任务订单证据精确重算，并落入一张互斥决策表。
- 精确残差不可交易时不会因舍入产生新的暴露，也不会永久落入无原因的 `planned` 等待。
- 快照与生命周期事件在重复轮询下幂等。
- 同一生产 SQLite 文件在任一时刻只有一个服务进程能进入 schema、恢复和交易组件初始化；正常关闭或进程崩溃后可以由新进程接管。
- 所有测试使用 fake 网关与临时数据库，绝不接触真实凭证、真实交易所或真实业务 SQLite。

缺少上述任一约束的终态、跳过查回的失败、未经当次授权的 GTC、未解释残差的 `HEDGED`，或未取得 SQLite 独占所有权便进入恢复和交易组件初始化，均违反本设计与完全对账原则。
