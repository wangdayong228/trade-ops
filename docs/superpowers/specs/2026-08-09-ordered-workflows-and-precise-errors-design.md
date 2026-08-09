# 有序业务流程与精确错误系统设计

日期：2026-08-09

状态：已批准

## 1. 目标

依据 `docs/standards/code-rules.md` 升级整个服务的业务入口和错误系统：入口按固定顺序 fail-fast，所有必要条件通过后才能推进执行状态或发生外部副作用；检查失败后仍允许原子记录对应的失败终态。错误必须包含安全的对象、期望值和实际值，并向操作员提供中文消息。

本设计覆盖启动、HTTP 请求、预检、确认、下单、恢复、SQLite、日志和浏览器 UI。新实现不兼容旧 HTTP 错误格式、旧持久化失败结构或旧 SQLite schema，不为兼容增加分支、适配层或迁移代码。

## 2. 全局约束

- 面向操作员的错误消息使用中文；稳定错误码、阶段名和结构字段使用英文。
- 检查严格串行执行，首个失败立即停止。业务要求的并发下单保持并发。
- 只读恢复观察可以并发，但必须在所有观察完成后按固定顺序校验和选择错误，且在校验完成前不得写状态或创建订单。
- 不新增第三方依赖，不建立通用工作流框架。
- 不读取真实 `.env`、真实凭证或真实业务 SQLite，不访问任何真实交易所接口。测试只使用临时环境值、fake gateway 和临时或内存 SQLite。
- 旧数据库不迁移、不清空、不覆盖。检测到旧 schema 时精确拒绝启动。

## 3. 统一错误契约

系统使用一种可信业务错误 `TradeOpsError`。第三方异常、SQLite 异常和未知抛出值必须在所属边界转换后，才能进入业务状态、HTTP 响应、持久化数据或安全日志。

```ts
interface ErrorDetail {
  readonly code: ErrorCode;
  readonly phase: ErrorPhase;
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
  readonly message: string;
  readonly occurredAt: string;
}

class TradeOpsError extends Error {
  readonly detail: ErrorDetail;
}
```

`ErrorSubject` 是受控的对象标识，只能表示配置项、HTTP 字段、交易所、市场、账户设置、策略、订单或数据库对象。`SafeDiagnosticValue` 只允许有界的安全标量或安全字符串列表，不允许任意对象。

`ErrorPhase` 是闭合联合类型：`startup`、`request`、`preflight`、`confirmation`、`execution`、`recovery`、`storage`。

`ErrorSubject` 使用以下受控变体，标识字段均有固定长度上限：

- `configuration`：配置字段名。
- `request`：HTTP 字段路径。
- `exchange`：交易所和操作名。
- `market`：交易所、symbol、市场类型和可选字段名。
- `account`：交易所、symbol 和账户设置字段名。
- `strategy`：策略 ID 和可选字段名。
- `order`：策略 ID、可用的订单 ID、订单角色、交易所、symbol 和可选字段名。
- `database`：安全数据库路径、表名、可用的记录 ID 和可选字段名。

`SafeDiagnosticValue` 仅允许 `string | number | boolean | null | readonly string[]`。凭证字段的实际值只能表示为 `missing` 或 `present-but-invalid`，不得把原值传给错误工厂。

中文 `message` 由错误工厂依据错误码和结构字段生成，调用方不得自由拼接结构化业务错误。这样可避免消息与 `subject`、`expected` 或 `actual` 矛盾。

原始 `cause` 只能在内存中短暂保留。它不得写入 SQLite、返回 HTTP 或进入交易事件。未知异常在模块边界转换成精确操作失败，例如：`OKX BTC/USDT 账户设置读取失败：期望成功读取，实际为 NetworkError`，不得透传任意第三方消息或属性。

下单错误在 `ErrorDetail` 之外携带控制流所需的提交确定性：

- `NOT_SUBMITTED`：确定外部下单调用没有发生。
- `UNKNOWN`：外部调用可能已经发生，只能按 client order ID 查询，禁止重新提交。

提交确定性是类型化控制信息，不从错误文案或第三方错误类型猜测。

## 4. 状态模型

策略使用以下状态：

- `PENDING_CONFIRMATION`
- `PREFLIGHT_INVALIDATED`
- `EXECUTING`
- `WAITING_HEDGE`
- `HEDGED`
- `HEDGE_INCOMPLETE`
- `FAILED`

新增的 `PREFLIGHT_INVALIDATED` 是终态，表示确认复检失败、没有创建任何订单，操作员必须重新预检。

状态转换为：

```text
PENDING_CONFIRMATION
  -> PREFLIGHT_INVALIDATED
  -> EXECUTING

EXECUTING
  -> WAITING_HEDGE
  -> HEDGED
  -> HEDGE_INCOMPLETE
  -> FAILED

WAITING_HEDGE
  -> HEDGED
  -> HEDGE_INCOMPLETE
```

状态不变量：

- `PREFLIGHT_INVALIDATED`、`FAILED` 和 `HEDGE_INCOMPLETE` 必须保存结构化 `failure`。
- `FAILED` 仅在能够排除本策略持仓敞口时使用。
- 无法排除敞口时必须保持可恢复状态，或进入 `HEDGE_INCOMPLETE`。
- `HEDGED` 不得携带失败。
- `PENDING_CONFIRMATION` 不得有订单。
- `EXECUTING` 和 `WAITING_HEDGE` 可以在订单上保存最近一次提交或查询问题，但不得伪造终态策略失败。
- 订单取得合法快照或一次后续查询成功时，必须原子清除已经解决的 `issue`；未解决的提交不确定或查询失败保留最近一次 `issue`，不追加错误历史。

## 5. 启动流程

启动入口严格按以下顺序检查：

1. 解析环境来源。
2. 检查 `TRADING_EXCHANGES` 存在且集合恰好为 Bitget 与 OKX。
3. 按 Bitget、OKX 的固定顺序检查所需凭证字段是否存在；错误只报告字段缺失或安全类别，不报告值。
4. 检查数据库路径。
5. 检查 `HOST`。
6. 检查 `PORT`。
7. 打开数据库并检查 schema 版本。
8. 构造仓储、交易所网关、服务和日志边界。
9. 启动恢复监控。
10. 绑定 HTTP 监听地址。

前一步失败后不得执行后续步骤。数据库版本失败时不得启动恢复或 HTTP 服务。

## 6. HTTP 请求边界

HTTP 请求依次经过：

1. 原始 Host 检查。
2. 状态变更请求的 Origin 和 `Sec-Fetch-Site` 检查。
3. body 大小与解析检查。
4. route schema 检查。
5. route 业务语义检查。

Host 或 Origin 失败后不得读取、缓存或解析请求 body。Fastify/AJV 错误必须转换为 `TradeOpsError`，指出字段路径、期望结构和安全的实际类型或值，不向客户端返回原始 validation 对象。

只读状态接口只执行能够提高错误准确性的本地身份、持久化结构和响应不变量检查，不增加交易所请求。

## 7. 预检流程

预检严格按以下顺序执行：

1. 检查执行模式、交易所不同、symbol 格式和请求数量格式。
2. 检查现货及合约交易所已经配置。
3. 加载并检查现货市场存在、身份正确且可交易。
4. 加载并检查合约市场存在、身份正确且可交易。
5. 检查两个市场基础资产相同且均以 USDT 计价。
6. 检查合约持仓模式；实际不是 `hedged` 时立即返回。
7. 检查保证金模式可确认为 `isolated` 或 `cross`。
8. 检查空头杠杆为有限正数。
9. 计算共同有效数量，并检查数量精度、合约乘数及最小/最大数量。
10. 读取现货参考价并检查现货名义金额范围。
11. 读取合约参考价并检查合约名义金额范围。
12. 读取并检查现货 USDT 余额。
13. 读取并检查合约保证金。

所有步骤串行执行。失败预检不创建策略、不写 SQLite。

OKX 账户检查先读取持仓模式。实际为 `one-way` 时立即返回 `{ positionMode: 'one-way' }` 所需的失败证据，不再读取持仓列表、保证金模式或杠杆。仅在 `hedged` 时继续读取持仓并解析保证金模式与空头杠杆。

## 8. 确认流程

确认接口同步执行：

1. 检查策略存在。
2. 检查状态为 `PENDING_CONFIRMATION`。
3. 检查策略没有任何订单。
4. 重新执行第 7 节的完整有序预检。
5. 比较市场身份、市场规则、共同有效数量、持仓模式、保证金模式和杠杆是否仍与预检快照一致。
6. 使用最新参考价重新计算资金要求，并确认最新余额仍然充足。
7. 所有检查通过后，原子转换为 `EXECUTING`。
8. 返回 `202`，随后调度后台执行。

价格和余额不要求与旧快照相等，但最新值必须证明订单仍满足市场和资金条件。完成策略存在、状态和无订单检查后，任何复检条件失败都原子转换为 `PREFLIGHT_INVALIDATED`，保存精确失败，不创建订单，并要求操作员重新预检。

读取失败或未知值同样使预检失效。若写入 `PREFLIGHT_INVALIDATED` 的事务本身失败，则返回存储错误并保留原状态；不得声称已经失效。确认失败不得先认领策略、规划订单或返回已受理。

## 9. 新订单检查与提交

每个真正的新订单依次经过：

1. 检查策略仍处于允许创建该角色的状态。
2. 检查现有订单拓扑和确定性角色唯一性。
3. 重新检查当前合约账户设置。
4. 检查数量、价格、方向、仓位方向和保证金模式。
5. 检查当前目标市场、精度、数量范围和名义金额范围。
6. 检查该腿当前余额或保证金。
7. 生成不可变的已验证提交参数。
8. 持久化确定性订单意图和 client order ID。
9. 调用真实交易所提交。

交易所网关拆分为无副作用的准备阶段和真实提交阶段。所有本地及只读远程检查在订单意图持久化前完成；订单意图仍必须先于真实外部提交，以维持崩溃恢复和防重复提交能力。

顺序模式保持现有业务语义：第一腿达到可靠终态后，使用实际成交量和可靠均价生成第二腿。第二腿检查失败时，因为第一腿可能已经形成敞口，策略进入 `HEDGE_INCOMPLETE` 并保存精确原因。

并发模式先严格串行完成两腿的全部检查，再原子持久化两个订单意图，最后并发调用两次真实提交。不得为了固定检查顺序把业务要求的并发下单改为串行。

## 10. 提交结果处理

`NOT_SUBMITTED` 表示外部调用确定未发生。协调器根据既有成交证据决定 `FAILED` 或 `HEDGE_INCOMPLETE`。

`UNKNOWN` 表示提交结果不确定。系统持久化订单 `issue`，随后只使用确定性 client order ID 查询；不得创建替代订单或再次提交相同角色。

合法快照按状态继续。非法快照必须指出快照对象以及具体不变量的期望和实际，包括交易所、订单 ID、client order ID、symbol、市场类型、方向、委托量、成交量、剩余量、平均价、状态或更新时间。

快照身份、数量守恒或状态转换非法时，系统按可能存在敞口处理，不能因为本地解析失败而推断订单不存在。

## 11. 恢复流程

恢复仅加载 `EXECUTING` 和 `WAITING_HEDGE`。单个策略依次执行：

1. 检查持久化策略结构与状态。
2. 检查订单角色、请求和拓扑符合执行模式。
3. 并行观察本轮需要查询的订单。
4. 按固定订单角色顺序验证所有查询结果。
5. 检查观察期间策略和订单版本没有变化。
6. 按固定顺序持久化合法新快照。
7. 根据完整证据分类策略状态。
8. 仅在需要创建新对冲角色时，重新执行第 9 节的全部检查。

恢复的错误优先级固定为：持久化或外部数据不一致、已知取消/拒单、提交不确定、查询不可用。某个查询失败不得掩盖其他订单的可靠成交证据。

临时查询失败允许策略保持可恢复状态，并在订单 `issue` 中保存安全原因。可靠证据表明对冲无法自动完成时进入 `HEDGE_INCOMPLETE`。

## 12. SQLite schema

新 schema 增加：

- 明确的 schema 版本；
- 策略 `failure` 结构化 JSON；
- 订单 `issue` 结构化 JSON；
- 状态与错误非空关系约束；
- 现有订单角色、client order ID、状态转换和快照事务约束。

没有 trade-ops 业务表的空数据库创建新 schema 并写入当前版本。若数据库已有 trade-ops 业务表但版本与当前版本不一致，启动失败，错误包含数据库路径、期望版本和实际版本；现有业务表且没有版本元数据时，实际版本报告为 `unversioned`。不得执行 `DROP`、自动迁移或覆盖。

读取损坏数据时，错误指出表、策略或订单标识、字段、期望类型或不变量，以及安全的实际类别。不得输出完整损坏 JSON、原始 SQLite 异常属性或其他行数据。

## 13. HTTP、状态 API 与 UI

HTTP 错误使用以下新格式：

```json
{
  "requestId": "req-1",
  "error": {
    "code": "ACCOUNT_POSITION_MODE_MISMATCH",
    "phase": "confirmation",
    "subject": {
      "type": "account",
      "exchangeId": "okx",
      "symbol": "BTC/USDT"
    },
    "expected": "hedged",
    "actual": "one-way",
    "message": "OKX BTC/USDT 持仓模式检查失败：期望 hedged，实际为 one-way",
    "occurredAt": "2026-08-09T00:00:00.000Z"
  }
}
```

状态接口返回 `strategy.failure` 和每个订单的 `issue`。UI 使用中文标签展示消息、阶段、对象、期望和实际，并继续只通过 `textContent` 写入服务端内容。

HTTP 状态映射为：

- `400`：请求语法或字段格式错误。
- `403`：Host/Origin 安全边界失败。
- `404`：策略不存在。
- `409`：策略状态冲突或预检已经失效。
- `422`：业务预检条件不满足。
- `500`：已安全转换的内部失败。

## 14. 错误码

`ErrorCode` 是以下闭合联合类型：

- 配置与启动：`CONFIG_FIELD_MISSING`、`CONFIG_FIELD_INVALID`、`DATABASE_OPEN_FAILED`、`DATABASE_SCHEMA_VERSION_MISMATCH`、`SERVICE_COMPONENT_FAILED`、`SERVICE_LISTEN_FAILED`。
- HTTP：`REQUEST_FORBIDDEN`、`REQUEST_BODY_INVALID`、`REQUEST_FIELD_INVALID`、`STRATEGY_NOT_FOUND`、`STRATEGY_STATE_MISMATCH`。
- 预检与确认：`EXCHANGE_NOT_CONFIGURED`、`MARKET_UNAVAILABLE`、`MARKET_IDENTITY_MISMATCH`、`MARKET_INACTIVE`、`MARKET_RULE_INVALID`、`ACCOUNT_SETTINGS_UNAVAILABLE`、`ACCOUNT_SETTINGS_CONFLICT`、`ACCOUNT_POSITION_MODE_MISMATCH`、`ACCOUNT_MARGIN_MODE_MISMATCH`、`ACCOUNT_LEVERAGE_MISMATCH`、`QUANTITY_INVALID`、`QUANTITY_NOT_REPRESENTABLE`、`QUANTITY_OUT_OF_RANGE`、`PRICE_UNAVAILABLE`、`PRICE_INVALID`、`NOTIONAL_OUT_OF_RANGE`、`BALANCE_UNAVAILABLE`、`BALANCE_INSUFFICIENT`、`PREFLIGHT_INVALIDATED`。
- 执行：`ORDER_TOPOLOGY_MISMATCH`、`ORDER_INTENT_MISMATCH`、`ORDER_NOT_SUBMITTED`、`ORDER_SUBMISSION_UNKNOWN`、`ORDER_SNAPSHOT_MISMATCH`、`ORDER_STATUS_MISMATCH`、`ORDER_NOT_FOUND`、`ORDER_AVERAGE_PRICE_UNAVAILABLE`、`HEDGE_ORDER_REJECTED`、`HEDGE_ORDER_CANCELED`。
- 恢复：`RECOVERY_QUERY_FAILED`、`RECOVERY_STATE_MISMATCH`。
- 存储：`STORAGE_OPERATION_FAILED`、`STORAGE_RECORD_INVALID`、`STORAGE_TRANSITION_REJECTED`。

每个错误码只有一个工厂负责消息和字段要求。不得用同一个泛化错误码代替能够区分的对象或失败条件。

## 15. 脱敏和日志

安全诊断值在错误创建时按白名单构造，再使用现有配置敏感值替换作为第二道防线。字段长度和列表长度必须有固定上限。

以下内容不得进入 `ErrorDetail`、HTTP、SQLite、交易事件或 UI：

- API key、secret、password；
- 完整环境变量；
- Authorization、Cookie 或其他请求头；
- CCXT 原始请求、响应和任意异常属性；
- SQLite 原始损坏载荷；
- cause 链和 stack。

内部 stdout 日志可以记录脱敏后的错误类型与 stack。日志记录仍为旁路行为；日志构造或写入失败不得改变 HTTP、SQLite、策略状态、恢复或下单行为。

## 16. 组件边界

- `errors`：错误码、结构类型、受控错误工厂和安全投影。
- `preflight-service`：唯一的有序预检实现，供首次预检和确认复检复用。
- `confirmation-service`：策略检查、复检、失效或原子认领。
- `exchange-gateway`：无副作用准备与真实提交分离。
- `hedge-coordinator`：编排已经通过检查的订单与状态。
- `order-monitor`：只读观察、确定性验证、分类和恢复继续。
- `strategy-repository`：持久化状态、策略失败和订单问题。
- HTTP 与 UI：边界映射和展示，不重新解释或重新拼接业务错误。

## 17. 实施分解

实现按以下有序单元推进，每个单元单独使用 TDD 并能独立验收：

1. 统一错误契约、新 SQLite schema 和仓储不变量。
2. 有序预检、确认复检与 `PREFLIGHT_INVALIDATED`。
3. 网关准备/提交分离、协调器和恢复流程。
4. 启动、HTTP、日志、状态 API、UI 和文档收口。

前一单元提供的类型和持久化接口必须在后一单元开始前通过测试。不得由多个写代理同时修改源代码或测试。

## 18. 测试与验收

测试必须覆盖：

- 每个入口的精确调用顺序和首错停止。
- one-way 模式后没有额外账户、价格或余额读取。
- 确认失败不认领策略、不规划订单、不提交订单。
- `PREFLIGHT_INVALIDATED` 的原子状态转换和完整失败对象。
- 每个业务错误包含对象、期望、实际和中文消息。
- 敏感信息不出现在 HTTP、SQLite、日志、交易事件或 UI。
- `NOT_SUBMITTED` 与 `UNKNOWN` 不会导致重复订单。
- `CONCURRENT` 保持并发提交，且提交前检查全部完成。
- 顺序第二腿和恢复新对冲单执行完整检查。
- 恢复错误选择确定，且不会丢失可靠成交证据。
- 旧库精确拒绝，空库正确初始化。
- 状态、失败、订单问题和 HTTP/UI 展示在重启前后保持一致。

所有自动化检查使用 fake gateway、临时 SQLite 和临时环境变量。测试不得读取真实 `.env`、访问真实交易所、提交或取消订单、修改账户模式或杠杆。

## 19. 完成标准

- 全部入口符合固定顺序 fail-fast。
- 任何状态变更或外部提交前，当前阶段的必要条件全部通过。
- 所有可预期失败均使用闭合错误码和 `ErrorDetail`。
- 同步和异步失败在 HTTP、SQLite、日志和 UI 中具有一致、安全、精确的语义。
- 旧错误格式和旧 schema 无兼容实现。
- 全部自动化测试通过，且验证过程没有跨越交易安全边界。
