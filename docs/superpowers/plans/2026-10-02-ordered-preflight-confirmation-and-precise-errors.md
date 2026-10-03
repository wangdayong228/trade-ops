# 有序预检、确认复检与精确错误实施计划

> 执行代理：使用 `subagent-driven-development` 逐项实施。用户已授权完成本计划并实施，过程自动确认；按 TDD 和任务审查连续推进。

**状态：已批准（2026-10-02，用户授权自动确认计划及实施）**

**目标：** 落实同日已批准 spec 的有序预检、同步确认复检及安全精确错误，在现有对账与 schema v2 基础上交付完整 HTTP/UI 行为。

**架构：** 新增小型可信错误模块与确认服务；预检仍是唯一业务检查入口；SQLite 仓储负责条件事务及 v3 迁移。保留协调器、对账、监控的执行职责，通过现有策略操作锁串行化确认与执行。

**技术栈：** TypeScript、Node.js ≥20、Fastify 5、CCXT 4.5.68、decimal.js、better-sqlite3、node:test；不新增运行时依赖。

## 依据与全局约束

- 唯一实现依据：`docs/superpowers/specs/2026-10-02-ordered-preflight-confirmation-and-precise-errors-design.md`；旧有序流程分支及旧计划不作为实现来源。
- 遵守 `docs/standards/code-rules.md`；首次检查失败后不发起后续读取。
- `HedgeReconciliation` 保持执行终态与 GTC 授权的唯一写入者；保留 `failure_code`、`submission_disposition` 和现有恢复逻辑。
- 不读取真实 `.env` 或凭证、不使用真实业务 SQLite、不调用任何真实交易所 API；只使用 fake、内存或临时数据库和显式临时环境。
- 同时最多一个代理修改 source/tests。每个任务先由 `test_designer` 建立风险矩阵及 RED 证据，再由 `implementer` 实现，之后进行只读任务审查。
- 自动确认不替代测试或审查。必要的设计补充只能为落实 spec，须先更新文档和验证边界。
- 工作目录：`.worktrees/ordered-preflight-confirmation`；隔离基线提交 `4e8086c` 包含开始时已有的用户改动，新增功能的 diff 从该提交计算。
- 由主代理在检查通过后创建本地任务提交；子代理不提交、不推送、不再委派。

## 风险矩阵与公共合同

| 风险 | 必须证明 |
| --- | --- |
| 并发确认/重复下单 | 读策略前取得共享锁；竞争请求 409 且不读取；提交后释放锁再执行；监控恢复不重复提交 |
| 规则缓存与精度 | CCXT 强制刷新、失败不回退；两腿身份/精度/乘数/范围变化失效；精确十进制比较，不转 Number |
| SQLite 迁移/事务 | v2 数据、订单、事件、资金费率表保持；状态与错误原子提交；条件失败不覆盖；未知存储结果不伪称成功 |
| 错误/权限 | 字段与中文消息一致；原始第三方错误及请求头不透传；Host/Origin 失败不观察 body；日志失败不改业务 |
| 生命周期 | 恢复监控先于监听、资金费率晚于监听；失败关闭资源；重启可读失效详情并恢复 EXECUTING |

公共接口在产生它们的任务中固定；必要的内部辅助类型由该任务定义，后续任务不得各自实现另一套错误或预检逻辑。

### Task 1：可信精确错误契约

**文件：** 新建 `src/errors/trade-ops-error.ts`、`tests/errors/trade-ops-error.test.ts`。

**输出接口：**

```ts
type ErrorPhase = 'startup' | 'request' | 'preflight' | 'confirmation' | 'storage';
type SafeDiagnosticValue = string | number | boolean | null | readonly string[];
interface ErrorInput {
  code: ErrorCode; phase: ErrorPhase; subject: ErrorSubject;
  expected: SafeDiagnosticValue; actual: SafeDiagnosticValue; occurredAt?: string;
}
interface ErrorDetail extends Omit<ErrorInput, 'occurredAt'> {
  readonly message: string; readonly occurredAt: string;
}
class TradeOpsError extends Error { readonly detail: ErrorDetail; }
function createTradeOpsError(input: ErrorInput, secrets?: readonly string[]): TradeOpsError;
function withErrorPhase(error: TradeOpsError, phase: ErrorPhase): TradeOpsError;
function parseErrorDetail(value: unknown): ErrorDetail;
function safeFailureCategory(error: unknown): string;
```

`ErrorCode` 为 spec 第 6 节所列闭合联合；`ErrorSubject` 为 configuration/request/exchange/market/account/strategy/database 闭合变体。标识、标量字符串、列表及项数有固定上限；工厂拒绝非有限数字、额外属性、访问器及任意对象。输入只允许已投影的安全值，凭证字段实际值仅为 spec 两种类别。中文消息由 code、subject、expected、actual 唯一生成；持久化读取重新校验并验证消息与字段一致。未知异常只按受控类别转换，不信任任意 `name`/`message`/`code`；原始 cause 不进入 detail。

Subject 字段：configuration/request 使用 `field`；exchange 使用 `exchangeId, operation`；market 使用 `exchangeId, symbol, kind, field?`；account 使用 `exchangeId, symbol, field`；strategy 使用 `strategyId, field?`；database 使用 `path?, table?, recordId?, field?, operation?`。标识上限 128 字符、symbol 64、path 512；诊断字符串上限 2000，列表上限 16 项且每项上限 2000。字段只允许相应变体所列成员。

- [x] RED：安全字段与中文文案一致、不可变快照、阶段转换保留时间与证据、所有码均有工厂文案；恶意 getter/proxy/未知抛出值、额外字段、超界值、NaN、凭证、伪造持久化消息均有拒绝或安全类别测试。新模块未存在时先用动态 import 验证缺少能力，再以实际行为断言覆盖。
- [x] GREEN：实现上述契约；直接秘密替换只处理调用方显式提供的测试值/运行时注入值，不在模块导入时读取环境。
- [x] 验证与审查：`npm run build`；`node --test dist/tests/errors/trade-ops-error.test.js`；主代理审核并提交。

### Task 2：有序预检与市场刷新

**文件：** 修改 `src/strategy/preflight-service.ts`、`src/exchanges/exchange-gateway.ts`、`src/exchanges/ccxt-exchange-gateway.ts`、`src/exchanges/profiles/okx-profile.ts`、按需修改 `bitget-profile.ts` 与 `exchange-registry.ts`；对应 `tests/strategy/preflight-service.test.ts`、`tests/exchanges/ccxt-gateway.test.ts`、`tests/support/fake-exchange-gateway.ts`。精确数量错误及已证明的固定精度截断问题需要修改 `src/domain/quantity-normalizer.ts` 及其测试；保持共同步长、向下取整和上限裁剪的业务公式，计算必须精确。

**输入：** Task 1 的错误工厂。

Task 2 审查修复提前在错误模块及其测试加入已批准的 `REQUEST_OPERATION_FAILED`，用于预检请求处理中的未知内部失败；不能把有效请求上的内部故障标成 `REQUEST_FIELD_INVALID`。Task 5 复用该码，只再补路由缺失码，不重复实现。

**输出接口：**

```ts
interface MarketLoadOptions { readonly reload?: boolean; }
type MarketIdentity = Pick<MarketRules,
  'exchangeId' | 'symbol' | 'marketId' | 'kind' | 'base' | 'quote' | 'active'>;
type MarketQuantityRules = Pick<MarketRules,
  'amountStep' | 'contractSize' | 'minBaseAmount' | 'maxBaseAmount' | 'priceStep'>;
type MarketNotionalRules = Pick<MarketRules, 'minQuoteNotional' | 'maxQuoteNotional'>;
interface LoadedMarketSnapshot {
  readonly identity: Readonly<MarketIdentity>;
  quantityRules(): Readonly<MarketQuantityRules>;
  notionalRules(): Readonly<MarketNotionalRules>;
  fetchAccountSettings(): Promise<AccountSettings>;
  fetchLastPrice(): Promise<string>;
}
// ExchangeGateway 与 fake/CCXT 实现同步扩展；快照读取绑定同轮 exchange symbol。
loadMarketSnapshot(symbol: string, kind: MarketKind, options?: MarketLoadOptions): Promise<LoadedMarketSnapshot>;
// 普通执行调用保留严格完整校验的 wrapper，不改变下单和恢复语义。
loadMarket(symbol: string, kind: MarketKind, options?: MarketLoadOptions): Promise<MarketRules>;
// CCXT 绑定接口：loadMarkets(reload?: boolean): Promise<Record<string, CcxtMarket>>。
// 原有 run(input) 调用不破坏，复检通过可选参数使用 confirmation 阶段。
run(input: PreflightInput, phase?: 'preflight' | 'confirmation'): Promise<PreflightResult>;
```

分阶段快照在加载时捕获 identity、precision mode 及所需规则标量；解析方法不得读可变 CCXT 缓存或重新 I/O。第 9 步组合两腿 quantityRules 后归一数量；第 10、11 步各读取价格并解析本腿 notionalRules。账户/价格方法直接使用捕获的交易所 symbol。此补充替代仅增加 reload 参数的旧接口方案，因为完整 MarketRules 会过早校验后续规则。对外错误始终由 Task 1 工厂构造并由 run 统一阶段；第三方原始数据只投影字段类型或受控数值。

- [ ] RED：按 spec 13 步记录调用轨迹，并对每个失败点断言后续读取为零；请求格式在所有网关读取前失败；现货失败不加载合约；模式失败不查价格/余额，保证金失败先于杠杆错误。
- [ ] RED：真实 CCXT 适配器接 fake exchange，覆盖 one-way 与坏 contractSize 同时出现、非法数量与坏名义金额规则同时出现、两腿名义金额规则都坏的首错；账户/价格不能重入完整规则解析，快照捕获后修改原市场对象不影响该轮规则。
- [ ] RED：fake CCXT 缓存旧规则后改变上游规则，`reload=true` 才可见；刷新拒绝时不得回退；OKX `hedged=false`/未知时不调用 `fetchPositions`，`hedged=true` 才解析空头设置。
- [ ] RED：共同数量在超过 40 位有效数字时仍精确（已复现：请求 `12345678901234567890123456789012345678901.9`、两腿步长 `0.1`、乘数 `1`，期望原值，旧实现返回 `12345678901234567890123456789012345678900`）；使用手算十进制/整数关系作为独立依据。
- [ ] RED：两腿价格分别计算名义金额；数量与名义金额上下限边界、零余额、无效价、非 1 合约乘数、十进制等价值；精确错误含对象/期望/实际且未知读取异常不透传。
- [ ] GREEN：顺序 await，并在每次读取后立即完成对应检查；规则字段逐项诊断，保留共同数量归一算法及 Bitget 零最小量例外；确认复检每轮两腿各强制刷新一次。解析阶段必须保持失败优先级，不能用笼统包装掩盖已知失败。
- [ ] 验证与审查：`npm run build`；`node --test dist/tests/strategy/preflight-service.test.js dist/tests/exchanges/ccxt-gateway.test.js dist/tests/exchanges/exchange-gateway.test.js dist/tests/domain/quantity-normalizer.test.js`；主代理审核并提交。

### Task 3：schema v3 与确认条件事务

**文件：** 修改 `src/domain/types.ts`、`src/storage/schema.ts`、`src/storage/strategy-repository.ts`、`src/storage/sqlite-strategy-repository.ts`、`tests/storage/sqlite-repository.test.ts`；为结构化记录新增字段而必须更新的测试 fixture 一并在此完成。

**输入：** Task 1 的 ErrorDetail 与严格解析器；原有 PreflightResult。

**输出接口：**

```ts
// StrategyState 新增 'PREFLIGHT_INVALIDATED'。
// StrategyRecord 新增 readonly preflightFailure: ErrorDetail | null。
// strategies 新增 preflight_failure_json；schema metadata 版本为 3。
confirmPreflight(expected: Readonly<StrategyRecord>): void;
invalidatePreflight(expected: Readonly<StrategyRecord>, failure: ErrorDetail): void;
```

两方法成功只在事务提交后返回；拒绝在既有外部事务内调用，避免仅释放 savepoint 就报告已提交。失败抛出可信存储错误。事务验证保存的身份、preflight 快照、状态、两类 failure 和订单为空，再执行带条件的 CAS；零更新是完整性异常。保留原执行入口 `claimForExecution`，但不能借它绕过新 HTTP 确认服务。通用 `transition` 不得制造或复活失效状态；订单规划入口拒绝 `PENDING_CONFIRMATION` 和 `PREFLIGHT_INVALIDATED`，相应旧测试夹具先合法认领再规划。`preflight_failure_json` 仅失效状态非空，`failure_code` 保持原有终态约束；失效策略不得有订单，读取也验证。

- [ ] RED：v2→v3 迁移保留所有状态、订单、提交结论、order_events、资金费率表；原有 v1→v2 路径继续升级到 v3；未知/损坏 schema 拒绝，迁移失败回滚，不修改原业务数据。
- [ ] RED：成功认领、原子失效、重开数据库读回完整失败；错误结构损坏、异常状态/订单/失败/快照、CAS 零更新、SQL trigger 故障、回滚/回读不可用；无部分状态或失败落库，错误证据不包含原始行 JSON。事务结果无法确认后，该仓储实例对所有后续策略读写与恢复 fail-closed，防止未提交 EXECUTING 被监控续跑；单测在临时数据库上替换确认事务包装器模拟事务仍打开且回滚不可用，并断言无订单及恢复动作。
- [ ] GREEN：迁移严格校验已知 schema，按需在事务内重建 strategies/metadata 并维护现有索引和外键；恢复外键设置且检查完整性。现有订单表、事件及资金费率结构不重建。v1→v2→v3 在同一外层事务内完成；保留独立且严格的 v2/v3 校验器，不让现有 v1 迁移误用新版 schema 常量。新确认写入不改变对账写入权。
- [ ] 验证与审查：`npm run build`；`node --test dist/tests/storage/sqlite-repository.test.js dist/tests/storage/sqlite-funding-rate-repository.test.js dist/tests/strategy/hedge-reconciliation.test.js`；主代理审核并提交。

### Task 4：同步确认服务

**文件：** 新建 `src/strategy/confirmation-service.ts`、`tests/strategy/confirmation-service.test.ts`；按需补 `tests/strategy/order-monitor.test.ts` 与 `tests/acceptance/hedge-opening.test.ts`。

**输入：** Task 2 的 PreflightService；Task 3 的确认仓储方法及记录。

**输出接口：**

```ts
class ConfirmationService {
  constructor(repository: StrategyRepository, preflight: Pick<PreflightService, 'run'>);
  confirm(strategyId: string): Promise<void>;
}
```

服务只复检及提交状态，不排队、不下单。取得现有策略操作锁后才读库，并在 finally 释放。锁忙抛 `STRATEGY_OPERATION_BUSY`；状态非 pending 抛状态冲突；初始 pending 带订单/失败抛记录异常。复检后逐字段比较身份、市场规则、共同数量与账户设置，数值用精确十进制等价比较，可选规则的缺失与存在不同。行情/余额可变化但必须重新满足预检。

- [ ] RED：不存在/非 pending/带订单；延迟控制首个请求成功、业务失败、读取失败时的竞争请求完全无读取；字段漂移与有效价格变化；两个市场规则和杠杆的数值等价；未知复检异常安全转换。
- [ ] RED：失败详情阶段为 confirmation，失效提交后保留原具体错误；持久化失败以存储错误优先；认领异常不得转成业务失效；所有路径释放锁；提交后调度前中断仍可由现有监控恢复，无重复订单。
- [ ] GREEN：隔离复检 catch 与持久化 catch；失效必须成功提交才报告失效；完整性错误不当成普通竞争；确认成功不在服务内调用协调器。
- [ ] 验证与审查：`npm run build`；`node --test dist/tests/strategy/confirmation-service.test.js dist/tests/strategy/order-monitor.test.js dist/tests/acceptance/hedge-opening.test.js`；主代理审核并提交。

### Task 5：HTTP、安全错误投影与界面

**文件：** 修改 `src/http/server.ts`、`src/http/public-error.ts`、`public/app.js`、`public/index.html`、按需 `public/styles.css`；更新 `tests/http/server.test.ts`、`tests/http/public-error.test.ts`。为明确 HTTP 兜底边界，在 `src/errors/trade-ops-error.ts` 及其测试补充 `REQUEST_ROUTE_NOT_FOUND`，复用 Task 2 审查修复提前加入的 `REQUEST_OPERATION_FAILED`；其余 Task 1 合同不变。复用 server.test.ts 已有 VM/fake DOM harness 验证真实 UI 代码，避免另建重复 harness。

**输入：** Task 1 错误契约、Task 3 `preflightFailure`、Task 4 确认服务。

**输出接口：** `BuildServerDependencies` 必须接收 `confirmationService: Pick<ConfirmationService, 'confirm'>`；生产及所有测试装配同步更新，不保留绕过同步复检的 fallback。

- [ ] RED：精确 `{ requestId, error }` 响应无旧顶层 code/message；400 请求/AJV字段、403 Host/Origin、404 策略/路由/静态资源不存在、409 锁忙/非 pending/已失效、422 首次业务预检、500 安全内部/存储错误。
- [ ] RED：确认完成前 HTTP 不返回，失败不入队；成功事务和释放锁后才允许后台执行；EXECUTING 再确认 409；失效状态接口在重启后返回同一 detail；Host/Origin 拒绝后不缓存/解析 body，日志仍含安全 method/path/query/body。
- [ ] RED：恶意第三方消息、cause/stack、任意属性、配置秘密及请求头均不出现在 HTTP/SQLite/UI；错误投影和日志抛异常不改变业务结果；UI 真实代码通过 textContent 展示中文标签，失效为终态并要求重新预检。
- [ ] GREEN：统一 HTTP 边界映射；路由/静态资源缺失用 REQUEST_ROUTE_NOT_FOUND，未知请求内部异常用 REQUEST_OPERATION_FAILED，不用启动错误或状态码猜测业务原因；已知 detail 保持具体性。AJV 仅提取受控 schema 信息与安全实际类型；保留请求日志旁路及安全响应头。确认失效详情通过明确定义的 `strategy.preflightFailure` 字段投影；旧对账 failureCode 继续展示原含义。
- [ ] 验证与审查：`npm run build`；`node --test dist/tests/http/*.test.js dist/tests/logging/*.test.js`；以 fake 注入覆盖界面交互，不启动会访问交易所的服务；主代理审核并提交。

### Task 6：启动边界、文档与总体验证

**文件：** 修改 `src/main.ts`、`src/config/exchange-credentials.ts`、`src/config/funding-rate-config.ts`、`src/config/environment-loader.ts`、按需 `src/storage/sqlite-process-owner.ts`；更新 `tests/main.test.ts`、`tests/config/*.test.ts`、按需所有权测试；更新 `README.md` 和 `docs/usage/operator-guide.md`。

- [ ] RED：配置固定检查顺序及具体字段证据，凭证只报告 missing/present-but-invalid；目录、开库、所有权、schema、组件和监听每个失败点均报告精确错误且没有后续动作；dotenv 读取失败安全转换。
- [ ] RED：装配注入新确认服务；保持“恢复监控 → 监听 → 资金费率启动”；监听失败不启资金费率，幂等 cleanup 等待恢复后关闭数据库，cleanup 错误不覆盖原启动错误；运行检查只用临时环境、临时文件或 fake。
- [ ] GREEN：为每个启动边界转换异常，保留已有可信 detail，不以 SERVICE_COMPONENT_FAILED 覆盖具体配置/schema/所有权错误；不更改资金费率业务逻辑；入口日志只保留安全详情，日志异常不影响退出状态或清理。
- [ ] 文档：README 与操作员指南同步确认/失效状态、错误响应例子、schema v3 自动迁移、操作员重新预检步骤；修正指南中 EXECUTING 可重复确认的旧说明，保留单进程数据库及监控恢复说明。
- [ ] 集成验证：`npm test`；`git diff --check`；确认所有预检/确认路径与源码调用方类型一致，未引入真实网络测试。
- [ ] 最终审查：按 affected-path review 要求对六任务 diff 及受影响调用链做资金/安全审查；修复所有重要发现并运行相关回归。若 skill 文件不可用，明确记录并用同范围只读风险审查完成工作。
- [ ] 完成核对：`verification-before-completion` → `consistency-check` → `post-verification-check`；逐项勾选计划并记录实际命令、exit status、结果。主代理给出 worktree/branch、测试结果与剩余限制。

## 验证记录

- 隔离基线：`npm test`，exit 0，1124 passed / 0 failed；完整日志 `.superpowers/sdd/baseline.log`。
- 任务 RED/GREEN、审查及最终命令结果追加到 `.superpowers/sdd/progress.md`；每任务简报、报告与 diff 存同目录，不读取会话日志或真实业务数据。
