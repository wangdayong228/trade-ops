# Bitget 与 OKX 资金费率历史同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有单进程服务中，为 Bitget 与 OKX 所有明确 active 的 USDT 线性永续合约，安全回填公共接口当前可见的全部已结算资金费率，持久化到现有 SQLite 文件，并默认每小时增量同步。

**Architecture:** 新链路与交易 `ExchangeGateway` 完全隔离：两个专用无凭证 CCXT source 各用一条 generated raw 产品配置请求发现市场并直接解析 raw 历史响应，`SqliteFundingRateRepository` 用独立三表和 TEMP 扫描集合保存记录、修订与同步证据，`FundingRateMarketSync` 逐页执行交易所特定覆盖证明，两个 `FundingRateExchangeWorker` 分别串行处理发现、增量、回填和复核，`FundingRateSyncService` 只在 HTTP listen 成功后启动并在 SQLite 关闭前完整停止。

**Tech Stack:** TypeScript 7 ESM、Node.js >=20、CCXT 4.5.68、`decimal.js` 10.6、`better-sqlite3` 12.11、Node.js `node:test`、Pino 10。

## Global Constraints

- 唯一批准设计是 `docs/superpowers/specs/2026-09-06-funding-rate-history-sync-design.md`；初版为 `f905003`，OKX 短尾页恢复修正为 `4e272ba`，单请求 raw 市场发现修正为 `85d9b61`。
- 所有设计、实现和审查遵守 `docs/standards/code-rules.md`，正确性高于速度、便利和复杂度。
- 本功能处理可影响交易分析的钱款数据、精度、SQLite 事务与跨重启完整性，按 direct money risk 执行；实现前必须由 `test_designer` 产出风险矩阵和按预定原因失败的测试，测试确实变红后才允许 `implementer` 修改生产代码。
- 每个行为变更严格执行 RED -> GREEN -> refactor。一次只允许一个 agent 修改 source 或 tests；read-only review 可以并行。
- 不读取、打印或推断真实凭证，不读取仓库真实 `.env`，不调用任何真实交易所 API（包括公共市场接口），不打开 `data/**` 或其他真实业务 SQLite。
- 所有测试只使用 fake CCXT client、fake source、虚拟时钟、可控 sleeper、内存或临时 SQLite 和临时环境对象；绝不提交/取消订单或修改账户设置。
- 不使用 CCXT `loadMarkets/fetchMarkets/fetchCurrencies`、market cache、unified funding history、`paginate: true`、交易所 SDK 或自建 HTTP transport；市场发现和历史页面均锁定当前依赖中的 generated raw methods。
- Bitget 每轮发现只请求 `publicMixGetV2MixMarketContracts({ productType: 'USDT-FUTURES' })`，OKX 每轮只请求 `publicGetPublicInstruments({ instType: 'SWAP' })`；各自完整响应定义该轮 API 可见集合，不宣称不可观察的交易所绝对全集。
- 所有费率先按字符串验证并以 TEXT 保存；任何持久化路径不得经过 JavaScript `number`。
- 网络等待不进入 SQLite 事务；每页记录、revision、TEMP 集合和断点必须在同一短事务中提交。
- 覆盖完整性与增量健康度始终独立。任何错误、缺证或旧 generation 写入都 fail-closed。
- 不修改 `strategies`、`strategy_orders`、`order_events` 的 schema、数据合同或交易行为。
- 每个任务只暂存该任务列出的文件，不提交或改写用户已有的 `AGENTS.md`、`docs/standards/` 和其他未跟踪 superpowers 文档。
- 完成前依次使用 `high-stakes-implementation-testing`、`pre-verification-check`、`verification-before-completion`、`consistency-check` 和 `post-verification-check`；只有 main agent 可以宣布完成。

---

## 文件结构与职责

| 文件 | 责任 | 变更方式 |
| --- | --- | --- |
| `src/config/funding-rate-config.ts` | interval 默认值、规范整数和边界校验 | 新建 |
| `src/funding-rates/funding-rate-record.ts` | 领域类型、严格费率/时间、规范 JSON 和语义 hash | 新建 |
| `src/funding-rates/funding-rate-source.ts` | source、游标、页面、安全请求元数据、请求结果名义错误和 retry observer 窄接口 | 新建后在 Task 7 扩展 |
| `src/funding-rates/funding-market-discovery.ts` | 单次 raw 产品配置响应的精确映射、过滤与身份冲突检测 | 新建 |
| `src/funding-rates/bitget-funding-rate-source.ts` | Bitget Classic V2 单页 raw 适配器 | 新建 |
| `src/funding-rates/okx-funding-rate-source.ts` | OKX V5 单页 raw 适配器 | 新建 |
| `src/funding-rates/ccxt-funding-rate-source-factory.ts` | 只用公共配置构造两所 CCXT client | 新建 |
| `src/funding-rates/funding-rate-events.ts` | 资金费率事件闭集、字段白名单、脱敏与 non-throwing sink | 新建 |
| `src/storage/funding-rate-schema.ts` | 三张持久表及 revision 不可变 trigger | 新建 |
| `src/storage/funding-rate-repository.ts` | 状态、lease、原子页面和调度快照合同 | 新建 |
| `src/storage/sqlite-funding-rate-repository.ts` | 严格 SQLite 实现、generation fencing、TEMP 集合比较 | 新建 |
| `src/funding-rates/funding-rate-market-sync.ts` | Bitget/OKX 覆盖与增量逐页状态机 | 新建 |
| `src/funding-rates/funding-rate-exchange-worker.ts` | 单所串行、四类公平队列、限流、重试和取消 | 新建 |
| `src/funding-rates/funding-rate-sync-service.ts` | 两所 root worker、周期调度、启动恢复和完整停止 | 新建 |
| `tests/support/fake-funding-rate-source.ts` | 可脚本化页面、并发门、调用与请求记录 | 新建 |
| `tests/config/funding-rate-config.test.ts` | interval 配置测试 | 新建 |
| `tests/funding-rates/*.test.ts` | record、发现、两所适配器、日志、算法与调度测试 | 新建 |
| `tests/storage/sqlite-funding-rate-repository.test.ts` | schema、修订、状态、fencing 和原子性测试 | 新建 |
| `src/main.ts`、`tests/main.test.ts` | 依赖装配和 listen/shutdown 顺序 | 修改 |
| `.env.example` | funding interval 的无敏感示例值 | 修改 |
| `README.md` | 数据口径、配置、边界、状态与运维说明 | 修改 |

不修改 `src/storage/schema.ts` 或 `src/storage/sqlite-strategy-repository.ts`。资金费率 repository 在相同 `Database.Database` 连接上独立初始化自己的 schema。

## 锁定的领域与 source 合同

`src/funding-rates/funding-rate-record.ts` 必须导出：

```ts
export type FundingExchangeId = 'bitget' | 'okx';

export interface FundingMarketIdentity {
  readonly exchangeId: FundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
}

export interface FundingMarketObservation extends FundingMarketIdentity {
  readonly active: boolean;
}

export interface SettledFundingRate extends FundingMarketIdentity {
  readonly fundingTimestampMs: number;
  readonly fundingRate: string;
  readonly rawJson: string;
  readonly contentHash: string;
}

export function settledFundingRate(
  identity: FundingMarketIdentity,
  rawRate: unknown,
  rawTimestampMs: unknown,
  rawRecord: unknown
): SettledFundingRate;
```

严格规范化规则固定为：

1. `exchangeMarketId` 与 `symbol` 必须是非空、无首尾空白字符串。
2. rate 必须是字符串；去首尾空白后匹配 `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`，再由新建的 `Decimal` 实例证明有限；返回并保存去白后的原字符串。
3. timestamp 只接受规范非负十进制字符串，或已经是非负安全整数的 number；转换结果必须是 safe integer 且 `new Date(value)` 有效。
4. raw record 必须是无 getter/setter 的普通对象；递归只接受 null、boolean、string、finite number、数组和普通对象，拒绝 symbol key、循环引用、`undefined`、`bigint`、函数、非有限 number 和非普通 prototype。
5. `rawJson` 递归按 key 的 Unicode code-unit 升序生成确定性 JSON。语义 hash 对按相同规则规范化的对象 `{ exchangeId, exchangeMarketId, symbol, fundingTimestampMs, fundingRate, raw: parsedRawJson }` 计算 lowercase SHA-256。

`src/funding-rates/funding-rate-source.ts` 必须导出以下闭集：

```ts
export type FundingPageCursor =
  | { readonly exchangeId: 'bitget'; readonly pageNo: number }
  | { readonly exchangeId: 'okx'; readonly afterMs: number | null };

export interface FundingRequestMetadata {
  readonly method: 'GET';
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
  readonly body: null;
}

export interface FundingRatePage {
  readonly cursor: FundingPageCursor;
  readonly records: readonly SettledFundingRate[];
  readonly nextCursor: FundingPageCursor | null;
  readonly recoveryAnchorMs: number | null;
}

export interface FundingRateSource {
  readonly exchangeId: FundingExchangeId;
  readonly pageSize: 100 | 400;
  readonly minimumRequestSpacingMs: 100 | 250;
  discoveryRequest(): FundingRequestMetadata;
  discoverMarkets(): Promise<readonly FundingMarketObservation[]>;
  pageRequest(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): FundingRequestMetadata;
  fetchPage(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): Promise<FundingRatePage>;
}

export interface FundingRequestExecutor {
  execute<T>(
    request: FundingRequestMetadata,
    operation: () => Promise<T>,
    onRetry: FundingRequestRetryObserver
  ): Promise<T>;
}

export interface FundingRequestRetryNotice {
  readonly retryAttempt: number;
  readonly retryDelayMs: number;
  readonly error: unknown;
}

export type FundingRequestRetryObserver = (
  notice: FundingRequestRetryNotice
) => void;

export class FundingRequestCanceledError extends Error {
  constructor();
}

export class FundingRequestRetryExhaustedError extends Error {
  constructor();
}
```

两个名义错误的 message/name 固定，不接收 cause、raw response、headers、credentials 或其他参数，也不携带可变自定义字段。`onRetry` 是必填边界：executor 只给出当次 raw error 和受限重试元数据，coverage/incremental/discovery 调用方补齐任务上下文并立即交给 non-throwing allowlist event sink；不得把 raw error 保存到数据库。取消必须原样传播同一错误实例且零状态写入；重试耗尽必须映射到 `REQUEST_RETRY_EXHAUSTED`，其他 executor/source rejection 映射到 `SOURCE_RESPONSE_INVALID`，禁止按 message 或 `name` 字符串分类。

- Bitget 游标首页是 `{ exchangeId: 'bitget', pageNo: 1 }`，非空页的下一页号必须安全加一；空页返回 `nextCursor: null`。
- OKX 首页是 `{ exchangeId: 'okx', afterMs: null }`；非空页的 `nextCursor.afterMs` 是页内最小结算时间，`recoveryAnchorMs` 是页内最大结算时间；空页二者均为 null。
- 页面记录按 `fundingTimestampMs` 降序输出。同页相同自然键且全部规范字段相同只保留一条；同键不同内容整页失败。

## 锁定的仓储合同

`src/storage/funding-rate-repository.ts` 使用判别联合，不允许用可选字段表达互斥 checkpoint：

```ts
export type FundingCoverageStatus =
  | 'PENDING'
  | 'BACKFILLING'
  | 'CAUGHT_UP'
  | 'INCOMPLETE';
export type FundingIncrementalStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'INCOMPLETE';
export type FundingCoverageKind =
  | 'INITIAL'
  | 'PERIODIC'
  | 'INACTIVE_FINAL'
  | 'REACTIVATION';

interface CommonCoverageLease {
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly generation: number;
  readonly kind: FundingCoverageKind;
  readonly cutoffMs: number;
}

export type CoverageLease =
  | (CommonCoverageLease & {
      readonly exchangeId: 'bitget';
      readonly okxResumeAfterMs: null;
      readonly requiredBitgetBoundaryMs: number | null;
    })
  | (CommonCoverageLease & {
      readonly exchangeId: 'okx';
      readonly okxResumeAfterMs: number | null;
      readonly requiredBitgetBoundaryMs: null;
    });

export interface IncrementalLease extends FundingMarketIdentity {
  readonly generation: number;
  readonly frozenBoundaryMs: number | null;
}

export type CoveragePageCheckpoint =
  | {
      readonly exchangeId: 'bitget';
      readonly round: 1 | 2 | 3;
    }
  | {
      readonly exchangeId: 'okx';
      readonly recoveryAnchorMs: number;
    };

export interface FundingPageWriteResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly revised: number;
  readonly revisedKeys: readonly {
    readonly fundingTimestampMs: number;
    readonly previousContentHash: string;
    readonly currentContentHash: string;
  }[];
}

export type FundingTaskFailureCode =
  | 'COVERAGE_CANCELED_BY_MARKET_STATE'
  | 'REQUEST_RETRY_EXHAUSTED'
  | 'SOURCE_RESPONSE_INVALID'
  | 'CURSOR_NOT_ADVANCING'
  | 'BITGET_BOUNDARY_NOT_SEEN'
  | 'BITGET_SCAN_NOT_CONVERGED'
  | 'DATABASE_WRITE_FAILED';

export const MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES = 512;

export interface FundingTaskFailure {
  readonly code: FundingTaskFailureCode;
  readonly summary: string;
}

export function fundingTaskFailure(
  code: FundingTaskFailureCode
): FundingTaskFailure;

export type FundingExhaustionEvidence =
  | {
      readonly exchangeId: 'bitget';
      readonly generation: number;
      readonly cutoffMs: number;
      readonly matchingRounds: readonly [1, 2] | readonly [2, 3];
      readonly emptyPageNo: number;
    }
  | {
      readonly exchangeId: 'okx';
      readonly generation: number;
      readonly cutoffMs: number;
      readonly explicitEmpty: true;
      readonly finalRequestAfterMs: number | null;
    };

export interface FundingMarketState extends FundingMarketIdentity {
  readonly active: boolean;
  readonly activeObservedAt: string;
  readonly activeChangedAt: string;
  readonly reactivationRequired: boolean;
  readonly reactivationAfterGeneration: number | null;
  readonly inactiveFinalCaughtUpAt: string | null;
  readonly coverageStatus: FundingCoverageStatus;
  readonly coverageGeneration: number;
  readonly coverageTaskKind: FundingCoverageKind | null;
  readonly coverageCutoffMs: number | null;
  readonly lastCaughtUpGeneration: number | null;
  readonly lastCaughtUpCutoffMs: number | null;
  readonly lastExhaustedAt: string | null;
  readonly lastExhaustionEvidenceJson: string | null;
  readonly okxResumeAfterMs: number | null;
  readonly okxResumeGeneration: number | null;
  readonly oldestFundingTimestampMs: number | null;
  readonly latestFundingTimestampMs: number | null;
  readonly coverageStartedAt: string | null;
  readonly coverageEndedAt: string | null;
  readonly coverageLastSuccessAt: string | null;
  readonly coverageErrorCode: FundingTaskFailureCode | null;
  readonly coverageErrorSummary: string | null;
  readonly incrementalStatus: FundingIncrementalStatus;
  readonly incrementalGeneration: number;
  readonly incrementalStartedAt: string | null;
  readonly incrementalEndedAt: string | null;
  readonly incrementalLastSuccessAt: string | null;
  readonly incrementalErrorCode: FundingTaskFailureCode | null;
  readonly incrementalErrorSummary: string | null;
}

export interface FundingDiscoveryResult {
  readonly createdActiveMarketIds: readonly string[];
  readonly becameInactiveMarketIds: readonly string[];
  readonly reactivatedMarketIds: readonly string[];
  readonly observedActiveCount: number;
  readonly observedInactiveCount: number;
}
```

`fundingTaskFailure` 是唯一可用的持久失败 normalizer，不接收原始 exception、response、headers、cause、env 或任意自由文本。`summary` 由 code 映射为以下固定 ASCII 文本：

| code | summary |
| --- | --- |
| `COVERAGE_CANCELED_BY_MARKET_STATE` | `coverage canceled after market state changed` |
| `REQUEST_RETRY_EXHAUSTED` | `public funding request retries exhausted` |
| `SOURCE_RESPONSE_INVALID` | `public funding response failed validation` |
| `CURSOR_NOT_ADVANCING` | `funding history cursor did not advance` |
| `BITGET_BOUNDARY_NOT_SEEN` | `saved Bitget boundary was not observed` |
| `BITGET_SCAN_NOT_CONVERGED` | `Bitget scans did not converge` |
| `DATABASE_WRITE_FAILED` | `funding page transaction failed` |

repository 写入时必须重新计算 code 对应文本并要求完全相等，同时验证无 NUL/control character 且 UTF-8 长度为 `1..512` bytes；schema 用 `length(CAST(summary AS BLOB)) <= 512` 和基本字符约束二次保护。原始错误的 type/message/code/stack 只交给 `FundingRateEventSink` 做字段白名单、凭证替换和 UTF-8 截断，不落 SQLite。

repository 对外至少提供这些原子操作：

```ts
export interface FundingRateRepository {
  applyCompleteDiscovery(
    exchangeId: FundingExchangeId,
    observations: readonly FundingMarketObservation[],
    observedAt: Date
  ): FundingDiscoveryResult;
  listMarketStates(exchangeId: FundingExchangeId): FundingMarketState[];

  startCoverage(
    market: FundingMarketIdentity,
    kind: FundingCoverageKind,
    cutoffMs: number,
    startedAt: Date
  ): CoverageLease;
  resumeInterruptedCoverage(
    market: FundingMarketIdentity,
    resumedAt: Date
  ): CoverageLease;
  isCoverageLeaseCurrent(lease: CoverageLease): boolean;
  commitCoveragePage(
    lease: CoverageLease,
    records: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint,
    observedAt: Date
  ): FundingPageWriteResult;
  bitgetRoundsEqual(
    lease: CoverageLease,
    left: 1 | 2,
    right: 2 | 3
  ): boolean;
  completeCoverage(
    lease: CoverageLease,
    evidence: FundingExhaustionEvidence,
    completedAt: Date
  ): void;
  failCoverage(
    lease: CoverageLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void;

  startIncremental(
    market: FundingMarketIdentity,
    startedAt: Date
  ): IncrementalLease;
  restartInterruptedIncremental(
    market: FundingMarketIdentity,
    restartedAt: Date
  ): IncrementalLease;
  isIncrementalLeaseEligible(lease: IncrementalLease): boolean;
  commitIncrementalPage(
    lease: IncrementalLease,
    records: readonly SettledFundingRate[],
    observedAt: Date
  ): FundingPageWriteResult;
  completeIncremental(
    lease: IncrementalLease,
    completedAt: Date
  ): void;
  failIncremental(
    lease: IncrementalLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void;
  cancelIncremental(
    lease: IncrementalLease,
    canceledAt: Date
  ): void;
}
```

`coverage_generation` 和 `incremental_generation` 均为非负 safe integer fencing token。所有页面、失败和完成事务先读取并比较 token、状态、任务类型和 cutoff；任一不一致抛出 `StaleFundingTaskError`，且历史、revision、TEMP 和状态零写入。

## SQLite schema 锁定

只新增三张持久表：

- `funding_rate_history`：主键 `(exchange_id, exchange_market_id, funding_timestamp_ms)`，rate/raw/hash/first/last observed 全部 TEXT 或 INTEGER 精确字段。
- `funding_rate_revisions`：自增 `id`，保存被替换前的完整旧版本与 `replaced_at`；两个 BEFORE trigger 对 UPDATE/DELETE 执行 `RAISE(ABORT, 'funding rate revisions are immutable')`。
- `funding_rate_sync_state`：每个 exchange + raw market ID 一行。

`funding_rate_sync_state` 字段固定为：

```text
exchange_id, exchange_market_id, symbol,
active, active_observed_at, active_changed_at,
reactivation_required, reactivation_after_generation,
inactive_final_caught_up_at,
coverage_status, coverage_generation, coverage_task_kind,
coverage_cutoff_ms, last_caught_up_generation,
last_caught_up_cutoff_ms, last_exhausted_at,
last_exhaustion_evidence_json,
okx_resume_after_ms, okx_resume_generation,
oldest_funding_timestamp_ms, latest_funding_timestamp_ms,
coverage_started_at, coverage_ended_at, coverage_last_success_at,
coverage_error_code, coverage_error_summary,
incremental_status, incremental_generation,
incremental_started_at, incremental_ended_at,
incremental_last_success_at,
incremental_error_code, incremental_error_summary,
created_at, updated_at
```

约束必须同时证明：

- exchange、状态和 task kind 是闭集；所有 ID/symbol/rate/hash/JSON/UTC 字段具有类型和基本形态 CHECK。
- 毫秒时间均为 `0..8640000000000000`；generation 均为 `0..Number.MAX_SAFE_INTEGER`。
- oldest/latest 要么同时为空，要么 `oldest <= latest`。
- `BACKFILLING` 必有 kind、cutoff、started，且 ended/error 为空；`INCOMPLETE` 必有 ended/error；`CAUGHT_UP` 必有 success/exhaustion evidence，且当前 cutoff、last caught-up cutoff 相等，当前 generation、last caught-up generation 相等。
- 后续失败保留上一成功 generation、cutoff、success time 和 evidence，但不能把它们解释为当前成功。
- OKX 锚点两列同空同非空；非空只允许 exchange=okx、状态 BACKFILLING，且 anchor generation 等于当前 coverage generation。新 generation 和任一终态清空锚点。
- `reactivation_required=1` 只允许 active=1、阈值 generation 非空、inactive final 时间为空；清除时阈值同时清空。
- `inactive_final_caught_up_at` 只允许 active=0、状态 CAUGHT_UP。
- `RUNNING` 增量必须有 started 且 ended/error 为空；`INCOMPLETE` 必须有 ended/error；`IDLE` 不得携带当前错误。
- 应用读取层再次严格验证每一列；即使测试绕过 CHECK 注入损坏行，也不得返回部分可信对象。

连接级 TEMP 表 `funding_rate_bitget_scan` 的主键固定为 `(exchange_id, exchange_market_id, coverage_generation, scan_round, funding_timestamp_ms)`，保存 symbol、rate、raw JSON 和 hash。页面事务只把 `timestamp <= cutoff` 的记录写入对应 round；`bitgetRoundsEqual` 必须对所有规范字段执行双向 `EXCEPT`，不得只比较 count、边界或 hash。

## 直接资金数据风险矩阵

| 风险 | 阻断性测试 | 独立证据 |
| --- | --- | --- |
| OKX 误存预测费率 | raw `fundingRate` 与 `realizedRate` 故意不同，只断言后者进入 TEXT | 本地 CCXT 4.5.68 raw 方法和批准设计 |
| rate 经 number 丢精度或空值变零 | 40+ 位小数、极端有限指数、空白/number/NaN/Infinity 矩阵 | 直接读取 SQLite `typeof` 与原字符串 |
| Bitget 页码漂移漏记录却报完整 | 页间插入/删除/重排脚本，单轮集合不同不得 CAUGHT_UP | TEMP 双向 EXCEPT 与固定 cutoff |
| OKX 短尾恢复误判不推进 | 先提交 [78,77,76,75]，恢复 `after=78` 返回全重复 [77,76,75]，随后更旧页和空页 | 每个返回时间严格小于请求 after |
| 旧 OKX 锚点跨 generation 跳页 | 旧任务写锚点，新 generation 首页前中断，恢复请求必须无 after | generation/anchor CHECK 和调用记录 |
| stale task 部分写库 | 新 generation 后让旧 task 提交含新记录页面，历史/revision/state 计数均不变 | 单事务首条 fencing 查询 |
| revision 覆盖旧证据 | A -> B -> A，并尝试 UPDATE/DELETE revision | 不可变 trigger 与直接 SQL 读取 |
| 增量写入掩盖覆盖失败 | periodic 深页失败后 shallow incremental 成功 | 两组状态/错误列分别断言 |
| reactivation 过早恢复增量 | false -> true、重启、旧 generation 成功、专用任务失败矩阵 | 持久阈值 generation 和 public request 计数零 |
| 发现与页面并发或长回填饿死其他任务 | 两所并行、单所并发门、持续四类过载顺序 | worker 页面级 round-robin 调用轨迹 |
| shutdown 后访问已关闭 SQLite | discovery/backoff/request/transaction 四个 gate 中停止 | root Promise gate 与 repository after-stop spy |
| 资金链路影响交易 | source/funding repository 全部抛错 | strategy repository、coordinator、order calls 保持零变化 |

---

### Task 1: 锁定 interval、记录规范化和 source 基础类型

**Files:**
- Create: `src/config/funding-rate-config.ts`
- Create: `src/funding-rates/funding-rate-record.ts`
- Create: `src/funding-rates/funding-rate-source.ts`
- Create: `tests/config/funding-rate-config.test.ts`
- Create: `tests/funding-rates/funding-rate-record.test.ts`

- [x] **Step 1: 写配置和精确记录红测试**

配置测试覆盖：缺失默认 `3600000`；接受 `60000`、`3600000`、`86400000`；拒绝空白、首尾空白、`+1`、`-1`、`060000`、`1.0`、`1e6`、非数字、低于/高于边界和非 safe integer。

记录测试覆盖：正/零/负、40+ 位小数、科学计数原样保留；timestamp 的 string/安全 number；确定性 key 排序和稳定 SHA-256；同语义不同 key 顺序同 hash；所有非法 rate、时间、raw value/prototype/getter/cycle 精确拒绝。

- [x] **Step 2: 运行红测试并确认失败边界**

Run:

```bash
npm run build && node --test dist/tests/config/funding-rate-config.test.js dist/tests/funding-rates/funding-rate-record.test.js
```

Expected: exit 非 0，且只因新模块/行为尚不存在；若出现既有测试、环境或 native module 失败，先按 systematic-debugging 排除，不得把它当作 RED。

- [x] **Step 3: 实现最小纯函数**

`fundingRateSyncIntervalMs(raw)` 使用规范十进制正则、`Number.isSafeInteger` 和闭区间；`settledFundingRate` 按“锁定的领域合同”逐项先检查再计算。规范 JSON 不调用对象自定义 `toJSON`，读取前检查 property descriptor，hash 不含观察时间。

- [x] **Step 4: 运行聚焦测试并重构**

Run 同 Step 2。Expected: exit 0，所有 case pass。随后运行：

```bash
npm run build
```

Expected: exit 0，无宽化到 `any`、无非空断言绕过。

- [x] **Step 5: 提交本任务文件**

```bash
git add src/config/funding-rate-config.ts src/funding-rates/funding-rate-record.ts src/funding-rates/funding-rate-source.ts tests/config/funding-rate-config.test.ts tests/funding-rates/funding-rate-record.test.ts
git diff --cached --check
git commit -m "feat: define funding rate data contracts"
```

### Task 2: 实现严格市场发现与两所 raw 单页适配器

**Files:**
- Create: `src/funding-rates/funding-market-discovery.ts`
- Create: `src/funding-rates/bitget-funding-rate-source.ts`
- Create: `src/funding-rates/okx-funding-rate-source.ts`
- Create: `tests/funding-rates/funding-market-discovery.test.ts`
- Create: `tests/funding-rates/bitget-funding-rate-source.test.ts`
- Create: `tests/funding-rates/okx-funding-rate-source.test.ts`

- [x] **Step 1: 写 fake client 驱动的红测试**

Bitget 发现精确断言每轮只调用：

```ts
publicMixGetV2MixMarketContracts({ productType: 'USDT-FUTURES' });
```

完整 fake envelope 使用文档字段 `code/msg/requestTime/data`，data 覆盖 `symbol/baseCoin/quoteCoin/supportMarginCoins/symbolType/symbolStatus`。raw `symbol/baseCoin/quoteCoin` 和选出的 settle ID，以及 `safeCurrencyCode` 返回的 base/quote/settle 都必须是无首尾空白的非空字符串，symbol 必须由验证后的代码精确构造为 `${base}/${quote}:${settle}`。只有 `symbolType === 'perpetual'`、规范后的 quote 与 settle 都为 `USDT`、base 不等于 settle 且 `symbolStatus === 'normal'` 才是 active 目标；settle ID 按 CCXT 当前语义依次选择 support list 中的 base、quote、首项。`listed/maintain/limit_open/restrictedAPI/off` 映射 inactive；任一身份字段缺失/非字符串/空白、`safeCurrencyCode` 返回空值/非字符串/空白、状态缺失或未知、非法 support list、重复 raw ID、统一 symbol 身份冲突使整轮失败。

OKX 发现精确断言每轮只调用：

```ts
publicGetPublicInstruments({ instType: 'SWAP' });
```

完整 fake envelope 使用文档字段 `code/msg/data`，data 覆盖 `instType/instId/uly/settleCcy/ctType/state`。raw `instId/settleCcy` 必须是无首尾空白的非空字符串，`uly` 必须恰有两个同样合法的 raw code；`safeCurrencyCode` 返回的 base/quote/settle 也必须同样合法，symbol 必须精确构造为 `${base}/${quote}:${settle}`。只有 `instType === 'SWAP'`、`ctType === 'linear'`、raw quote ID 与 settle ID 相同、规范后的 quote 与 settle 都为 `USDT`、base 不等于 settle 且 `state === 'live'` 才是 active 目标。`suspend/rebase/post_only/preopen/test` 映射 inactive；任一身份字段缺失/非字符串/空白、`safeCurrencyCode` 返回空值/非字符串/空白、状态缺失或未知、重复 raw ID、统一 symbol 身份冲突使整轮失败。

两所币种代码只通过注入 client 的 `safeCurrencyCode` 规范化。测试证明不调用 `loadMarkets/fetchMarkets/fetchCurrencies`、不读取 market cache，单轮 discovery 只发生上述一个 raw 调用；目标集合只表示该不分页 endpoint 当前响应的 API 可见集合。

Bitget 测试精确断言调用：

```ts
publicMixGetV2MixMarketHistoryFundRate({
  symbol: 'BTCUSDT',
  productType: 'USDT-FUTURES',
  pageNo: 1,
  pageSize: 100
});
```

并验证 path `/api/v2/mix/market/history-fund-rate`、`code === '00000'`、`fundingRate`、market ID、page size、空页和安全页号递增。

OKX 测试精确断言调用：

```ts
publicGetPublicFundingRateHistory({
  instId: 'BTC-USDT-SWAP',
  after: '1700000000000',
  limit: 400
});
```

首页省略 `after`；验证 path `/api/v5/public/funding-rate-history`、`code === '0'`、只读 `realizedRate`、忽略预测 `fundingRate`、所有时间严格小于请求 after、next=min、anchor=max、短页仍给 next cursor、空页终止。

两所都覆盖非法 envelope、超 page size、错 market ID、同页相同/冲突重复、无 `paginate` 调用。

- [x] **Step 2: 运行并确认预期 RED**

```bash
npm run build && node --test dist/tests/funding-rates/funding-market-discovery.test.js dist/tests/funding-rates/bitget-funding-rate-source.test.js dist/tests/funding-rates/okx-funding-rate-source.test.js
```

Expected: exit 非 0，只因三个新实现缺失。

- [x] **Step 3: 实现窄 CCXT client 接口和适配器**

只为测试和生产实际调用声明 `safeCurrencyCode` 及各所两个 generated raw public methods；不把现有凭证型 `CcxtExchangeGateway` 注入这里。Bitget discovery method 为 `publicMixGetV2MixMarketContracts`，OKX discovery method 为 `publicGetPublicInstruments`；两者均无分页，每轮恰好调用一次并完整校验 envelope/data。不得调用 `loadMarkets/fetchMarkets/fetchCurrencies` 或访问 market cache。

每个 public 方法调用前可纯构造 `FundingRequestMetadata`，使抛错路径也有 method/path/query/body。discovery request 分别绑定 `GET /api/v2/mix/market/contracts?productType=USDT-FUTURES` 和 `GET /api/v5/public/instruments?instType=SWAP`；body 均为 null。历史适配器直接把单条 raw 对象交给 `settledFundingRate`，再按自然键去重和降序排序。

Bitget `minimumRequestSpacingMs=100`，OKX `minimumRequestSpacingMs=250`；两者均保守低于已批准设计绑定的官方限制。

- [x] **Step 4: 聚焦 GREEN**

Run 同 Step 2。Expected: exit 0。再运行 `npm run build`，Expected: exit 0。

- [x] **Step 5: 提交**

```bash
git add src/funding-rates/funding-market-discovery.ts src/funding-rates/bitget-funding-rate-source.ts src/funding-rates/okx-funding-rate-source.ts tests/funding-rates/funding-market-discovery.test.ts tests/funding-rates/bitget-funding-rate-source.test.ts tests/funding-rates/okx-funding-rate-source.test.ts
git diff --cached --check
git commit -m "feat: add settled funding rate sources"
```

### Task 3: 构造无凭证客户端并建立独立日志闭集

**Files:**
- Create: `src/funding-rates/ccxt-funding-rate-source-factory.ts`
- Create: `src/funding-rates/funding-rate-events.ts`
- Create: `tests/funding-rates/ccxt-funding-rate-source-factory.test.ts`
- Create: `tests/funding-rates/funding-rate-events.test.ts`

- [x] **Step 1: 写安全边界红测试**

factory 测试注入构造器并精确断言两所只收到：

```ts
{ enableRateLimit: true, timeout: 15_000 }
```

传入带 API key/secret/password 的环境对象和扩展属性也不得进入构造器；构造期间 discovery 与 history raw 方法调用数均为零。

事件测试覆盖以下闭集：

```text
funding_sync_started
funding_sync_stopped
funding_market_discovery_completed
funding_market_discovery_incomplete
funding_coverage_started
funding_page_committed
funding_coverage_completed
funding_incremental_completed
funding_incremental_blocked
funding_request_retry
funding_task_incomplete
funding_rate_revised
funding_sync_fatal
```

运行时附加 `apiKey/secret/headers/rawResponse/cause` 必须被双层 allowlist 丢弃；凭证值在 exchange/market/symbol/error/request 字段内必须替换为 `[Redacted]`；多字节错误字段按 UTF-8 安全边界截断；sink 抛错不能传播。持久化 `fundingTaskFailure` 合同及其测试留在创建 repository 合同的 Task 4，不允许 Task 3 提前创建 storage 模块。

- [x] **Step 2: 确认 RED**

```bash
npm run build && node --test dist/tests/funding-rates/ccxt-funding-rate-source-factory.test.js dist/tests/funding-rates/funding-rate-events.test.js
```

Expected: exit 非 0，新模块缺失。

- [x] **Step 3: 实现 factory 和事件 sink**

生产 factory 直接 `new bitget(options)` / `new okx(options)`，函数签名不接收 credentials 或 env。事件 sink 仿照 `src/logging/trade-events.ts`，但拥有自己的 `FundingRateEvent` 判别联合和 Pino child `component: 'funding-rates'`。

请求 query key 仅允许 `symbol/productType/pageNo/pageSize/instType/instId/after/limit`；每条 API 错误都包含 method、path、query、body=null。错误只从现有 `safeError` 结果挑选 type/message/string code/stack 并再次脱敏，绝不枚举原错误或 cause。

- [x] **Step 4: 聚焦 GREEN 并提交**

```bash
npm run build && node --test dist/tests/funding-rates/ccxt-funding-rate-source-factory.test.js dist/tests/funding-rates/funding-rate-events.test.js
git add src/funding-rates/ccxt-funding-rate-source-factory.ts src/funding-rates/funding-rate-events.ts tests/funding-rates/ccxt-funding-rate-source-factory.test.ts tests/funding-rates/funding-rate-events.test.ts
git diff --cached --check
git commit -m "feat: add safe funding clients and events"
```

Expected: tests/build exit 0；提交只含列出的四个文件。

### Task 4: 建立三表 schema、精确 upsert 与不可变 revision

**Files:**
- Create: `src/storage/funding-rate-schema.ts`
- Create: `src/storage/funding-rate-repository.ts`
- Create: `src/storage/sqlite-funding-rate-repository.ts`
- Create: `tests/storage/sqlite-funding-rate-repository.test.ts`

- [x] **Step 1: 写 schema、幂等、修订和回滚红测试**

使用 `new Database(':memory:')`，验证：

- 仅新增锁定的三张 persistent table，既有 strategy 三表内容/fingerprint 不变；
- rate 的 `typeof` 为 `text`，自然键跨 exchange/market 隔离；
- 首次插入、相同内容重复（只更新 `last_observed_at`）、A -> B -> A 修订；
- hash 相同但规范字段不同仍产生 revision；
- revision UPDATE/DELETE 被 trigger 拒绝；
- 同页第二行由测试 trigger 故障时，第一行、revision、state/checkpoint 全部回滚；
- `database.defaultSafeIntegers(true)` 下读写仍正确；
- 直接污染 rate/timestamp/JSON/hash 后读取产生含 exchange + market + field 的精确错误；
- 自由文本、凭证片段、NUL/control、超过 512 UTF-8 bytes 的多字节 summary 均不能写入；固定 normalizer 的 summary 可以写入且不含原始异常内容。
- `fundingTaskFailure` 对每个批准 code 只产生锁定的静态 summary；其函数签名不接受原始错误、response、headers、cause、env 或任意自由文本。

- [x] **Step 2: 确认 RED**

```bash
npm run build && node --test dist/tests/storage/sqlite-funding-rate-repository.test.js
```

Expected: exit 非 0，只因 funding repository 尚不存在。

- [x] **Step 3: 实现 schema 和历史事务内核**

构造器顺序固定为：检查不在外部 transaction -> `foreign_keys=ON` 并验证 -> 执行幂等 funding schema -> 创建 TEMP scan table -> prepare statements。不得切换现有连接 journal mode。

页面 upsert 对每条现有行比较 symbol、rate、raw JSON、hash 和自然键，不只信任 hash。完全相同的再次观察只更新当前版本 `last_observed_at`；内容变化时先把旧版本及其 first/last observed INSERT revision，再将主表更新为新版本并令 `first_observed_at=last_observed_at=当前观察时间`。统一 transaction 返回 `FundingPageWriteResult`，revision key 只在 commit 后交给日志层。

本 Task 同时实现驱动历史写入所需的最小生产路径 `applyCompleteDiscovery -> startCoverage -> commitCoveragePage`；测试只能经这条带 generation fencing 的路径写记录。`writeRecordsInCurrentTransaction` 保持 private，任何阶段都不得暴露无状态、无 fencing 的测试专用写入口。Task 5 再补齐完整状态转换矩阵。

- [x] **Step 4: GREEN、检查 schema 并提交**

```bash
npm run build && node --test dist/tests/storage/sqlite-funding-rate-repository.test.js
git diff --check
git add src/storage/funding-rate-schema.ts src/storage/funding-rate-repository.ts src/storage/sqlite-funding-rate-repository.ts tests/storage/sqlite-funding-rate-repository.test.ts
git diff --cached --check
git commit -m "feat: persist funding rate revisions"
```

Expected: exit 0；测试后所有数据库均为内存库且已关闭。

### Task 5: 完成 discovery、双状态、generation fencing 与 TEMP 精确集合

**Files:**
- Modify: `src/storage/funding-rate-repository.ts`
- Modify: `src/storage/sqlite-funding-rate-repository.ts`
- Modify: `tests/storage/sqlite-funding-rate-repository.test.ts`

- [x] **Step 1: 增加状态机红测试**

测试至少包含：

- 完整发现新增 active、忽略新 inactive、现有 true -> false、false -> true；已知 ID 缺失、symbol 冲突或重复时整个发现事务零写入；
- active 转换使在途 coverage generation 失效；已有成功覆盖也转为 INCOMPLETE 并保留旧成功证据；false -> true 持久化 `reactivation_required` 和阈值，清除 inactive final 时间并取消 RUNNING incremental，但不伪造增量成功；
- generation 最大值拒绝新任务且旧状态不变；
- start coverage 原子递增、固定 cutoff/kind、清旧 OKX anchor；合法 interrupted resume 不递增，缺字段/错 generation resume fail-closed；
- stale coverage/incremental lease 的页面、revision、失败和完成全部零写入；
- OKX 非空页的数据、min/max 和 max-time anchor 原子提交；终态清 anchor；
- Bitget 只 stage cutoff 内数据，不同 market/generation/round 隔离，双向字段级 EXCEPT；
- 覆盖与增量错误互不覆盖；增量成功不清 coverage INCOMPLETE；
- CAUGHT_UP/cutoff/evidence、inactive final 和 reactivation 清除的所有合法/非法组合；
- 绕过 CHECK 污染每个状态枚举、token、anchor、cutoff 关系后读取 fail-closed。

- [x] **Step 2: 运行 RED**

```bash
npm run build && node --test dist/tests/storage/sqlite-funding-rate-repository.test.js
```

Expected: exit 非 0，失败点对应未实现状态方法/约束，不是 Task 4 回归。

- [x] **Step 3: 实现原子状态合同**

`applyCompleteDiscovery` 先在同一 transaction 比较 repository 已知 ID 集合；只要一个已知 ID 缺失就抛 `IncompleteFundingDiscoveryError` 并零写入。active 转换总是安全递增相应 fencing token：除从未成功且仍为 PENDING 的新鲜状态可继续保持 PENDING 外，当前 coverage 一律转为带固定状态转换码的 INCOMPLETE，同时保留上一成功 generation/cutoff/time/evidence；若 incremental RUNNING，转 IDLE、记录结束但不更新成功时间。所有状态错误只接受 `fundingTaskFailure(code)` 的闭集结果；repository 对 code/summary 映射和 512-byte 上限二次验证。

`startCoverage`、`resumeInterruptedCoverage`、`commitCoveragePage`、`completeCoverage`、`failCoverage` 全部在 transaction 第一条业务判断验证 lease。reactivation 只有 kind=REACTIVATION、`lease.generation > reactivation_after_generation` 且成功时清标记。inactive final 只有当前 active=false 才能完成并写时间。

`startIncremental` 在一个 transaction 内复查资格、递增 `incremental_generation` 并冻结任务开始前 latest timestamp；`restartInterruptedIncremental` 只接受遗留 RUNNING 和当前仍满足资格的 market，原子递增 token、替换 started time、从当前持久 latest 重新冻结边界并保持 RUNNING，从而保证重启后从首页重新请求。commit/complete/fail/cancel 都比较 generation 和 RUNNING 状态。

- [x] **Step 4: GREEN 并提交**

```bash
npm run build && node --test dist/tests/storage/sqlite-funding-rate-repository.test.js
git add src/storage/funding-rate-repository.ts src/storage/sqlite-funding-rate-repository.ts tests/storage/sqlite-funding-rate-repository.test.ts
git diff --cached --check
git commit -m "feat: fence funding sync state"
```

Expected: exit 0，所有历史写入测试始终经带 fencing 的生产路径完成。

### Task 6: 实现 Bitget/OKX 全范围覆盖证明

**Files:**
- Modify: `src/storage/funding-rate-schema.ts`
- Modify: `src/storage/funding-rate-repository.ts`
- Modify: `src/storage/sqlite-funding-rate-repository.ts`
- Modify: `tests/storage/sqlite-funding-rate-repository.test.ts`
- Create: `src/funding-rates/funding-rate-market-sync.ts`
- Create: `tests/support/fake-funding-rate-source.ts`
- Create: `tests/funding-rates/funding-rate-market-sync.test.ts`

- [ ] **Step 1: 写覆盖算法红测试**

fake source 以每次调用的 cursor 返回脚本页面，并可在任意 request/parse/commit gate 暂停。覆盖矩阵：

- Bitget 从 page 1 到显式空页，空市场也必须连续两轮空首页；
- 两轮相同且空终点 pageNo 相同才 CAUGHT_UP；首两轮不同、第二三轮相同可成功；三轮不收敛 INCOMPLETE；
- cutoff 后记录照常入库但不进入 TEMP 对比，日志/evidence 只声明 cutoff；
- initial/recovered Bitget 的 required oldest boundary 未重现则 INCOMPLETE；跨进程恢复不使用页号，从 page 1 重扫；
- pageNo 无法安全递增、响应错误、解析错误、提交错误或非显式空均不能完成；
- OKX next after 严格变小并请求到显式空；短页不终止；
- OKX 提交 [78,77,76,75] 后模拟进程中断，恢复 `after=78` 返回全重复 [77,76,75]，仍继续更旧页和空页；
- OKX 新 generation 清旧 anchor，首页提交前中断后恢复请求无 `after`；
- generation 在两页之间变化时，下一请求前丢弃；在页面返回后变 stale 时 commit 零写入；
- 复制合法 lease 后伪造 Bitget task 启动必见边界或 OKX task 初始 `after` 时，`isCoverageLeaseCurrent`、所有 repository 写操作和 `createCoverageTask` 均 fail-closed；task 创建不发 started event，source/executor 请求数为零；
- `resumeInterruptedCoverage(market, resumedAt)` 使用注入时间原子验证旧 generation/锚点、递增 generation、保留 cutoff/任务类型、更新 `updated_at` 并重新固定 task 启动恢复字段；第二次 resume 会 fence 第一次返回的 lease，Bitget 旧 TEMP 轮次不能进入新 generation；
- 任一失败只影响该 market，传出的 failure code/summary 有限、定位精确。

- [ ] **Step 2: 确认 RED**

```bash
npm run build && node --test dist/tests/funding-rates/funding-rate-market-sync.test.js
```

Expected: exit 非 0，新逐页状态机缺失。

- [ ] **Step 3: 实现一次只推进一页的 coverage task**

`FundingRateMarketSync` 不拥有 timer 或并发循环。它创建可重排的 page task：

```ts
export interface FundingPageTask {
  readonly key: string;
  readonly category: 'backfill' | 'reconcile' | 'incremental';
  runNextPage(): Promise<'requeue' | 'done'>;
}
```

`FundingRateMarketSync` 构造时必须接收 `FundingRequestExecutor`；不得直接调用 source。`createCoverageTask` 在发 started event 或构造 task 前，先对 data-only lease 做快照并用 repository 权威状态验证完整 generation/kind/cutoff/task 启动恢复字段。每次 `runNextPage` 顺序固定：读持久 lease 资格 -> 用 `source.pageRequest(...)` 生成安全元数据 -> 经 executor 在 transaction 外请求/完整解析 -> 验证 cursor -> 原子 commit -> 只在 commit 成功后修改内存 cursor。Task 6 的测试 executor 只同步转发，Task 8 换成真实的单所串行 policy。

repository 状态新增 task 启动时不可变的 Bitget 必见边界和 OKX 初始 `after`。新 coverage 与中断恢复都在首次请求前递增 `coverage_generation`；恢复保留 cutoff/kind，先验证旧 OKX 锚点 generation，再把安全恢复值写成新 generation 的不可变 task 启动字段，并重绑可变 OKX 锚点。lease 删除未参与任何行为判断的 `recovered` 字段。`coverageStateMatchesLease` 比较所有这些字段，因此页面、完成和失败 repository 入口也拒绝伪造或旧 lease，而不只依赖 market-sync 入口检查。

Bitget task 在内存保存 round/pageNo/前一轮 empty pageNo；每个空页结束一轮，调用 repository 双向比较。只有相邻集合相同且 empty pageNo 相同才用包含 generation、cutoff、三轮内实际轮次和终点的规范 JSON evidence 完成。

OKX task 从 fresh null 或合法 resume anchor 开始。带 `after=A` 的响应每条时间和 next 都必须 `< A`；恢复页允许没有数据库新记录。只有 source 明确返回空页才完成。

- [ ] **Step 4: GREEN 并提交**

```bash
npm run build && node --test dist/tests/funding-rates/funding-rate-market-sync.test.js
git add src/storage/funding-rate-schema.ts src/storage/funding-rate-repository.ts src/storage/sqlite-funding-rate-repository.ts src/funding-rates/funding-rate-market-sync.ts tests/storage/sqlite-funding-rate-repository.test.ts tests/support/fake-funding-rate-source.ts tests/funding-rates/funding-rate-market-sync.test.ts
git diff --cached --check
git commit -m "feat: prove funding history coverage"
```

Expected: exit 0。

### Task 7: 补齐冻结边界增量算法

**Files:**
- Modify: `src/funding-rates/funding-rate-source.ts`
- Modify: `src/funding-rates/funding-rate-market-sync.ts`
- Modify: `tests/support/fake-funding-rate-source.ts`
- Modify: `tests/funding-rates/funding-rate-record.test.ts`
- Modify: `tests/funding-rates/funding-rate-market-sync.test.ts`

- [ ] **Step 1: 写增量红测试**

覆盖：

- task 启动 transaction 冻结 latest timestamp；首页写入更晚记录不会移动边界；
- 观察冻结边界后仍发出一次后续分页请求；后续非空页提交后完成，显式空也可证明接口已无更多 overlap；
- 本地空库或边界直到空页未出现时扫描至显式空，只恢复 incremental IDLE，不改变 coverage；
- 边界以前未知自然键和同键 revision 均保存；
- request/parse/cursor/DB 错误只写 incremental INCOMPLETE；
- coverage 已 INCOMPLETE 时增量成功仍保持 coverage error、旧 cutoff/evidence 不变；
- inactive/reactivation/generation 资格在下一页前失效时请求计数不增长并 cancel；返回后的 stale commit 零写入；
- 中断后新 task 从首页开始，不复用内存 cursor。
- source 合同导出固定、无 cause 的 `FundingRequestCanceledError` 与 `FundingRequestRetryExhaustedError`，并要求显式 retry observer；coverage 与 incremental 都原样传播取消且零状态/失败事件写入，重试耗尽分别只写对应任务的 `REQUEST_RETRY_EXHAUSTED`，其他 rejection 仍为 `SOURCE_RESPONSE_INVALID`；
- retry observer 在 coverage/incremental task 中补齐各自 generation、cutoff/boundary、cursor 和安全 request metadata，交给 non-throwing allowlist event sink；raw error 不进入 repository；
- 增量完成事件的 inserted/unchanged/revised 是本 generation 所有已提交非空页的累计值；失败页、空终止页和 stale 页不累计。

- [ ] **Step 2: 确认 RED**

```bash
npm run build && node --test dist/tests/funding-rates/funding-rate-market-sync.test.js
```

Expected: exit 非 0，仅新增量 case 失败。

- [ ] **Step 3: 实现增量 task**

task 内存字段固定为 `cursor`、`frozenBoundaryMs`、`boundarySeen`、`postBoundaryRequestCompleted` 和三项已提交页面累计计数。完成条件只有：

1. boundary 已观察，且其后的下一次分页请求成功并已提交非空页；或
2. source 明确返回空页（无论 boundary 是否存在/重现）。

空响应不调用页面写入，但 complete transaction 仍验证 incremental lease。任何增量路径不得调用 coverage 完成/失败方法。

同时扩展请求合同与 coverage 共用错误边界：固定名义取消必须原样抛出，固定名义重试耗尽映射 `REQUEST_RETRY_EXHAUSTED`，其他 executor/source rejection 映射 `SOURCE_RESPONSE_INVALID`。所有 `execute` 调用显式传入 retry observer；observer 只经安全事件 sink 发出上下文完整的 `funding_request_retry`，自身失败不影响任务。fake executor 只实现确定性 notice 驱动，不包含真实计时或 CCXT 判断。

- [ ] **Step 4: GREEN 并提交**

```bash
npm run build && node --test dist/tests/funding-rates/funding-rate-market-sync.test.js
git add src/funding-rates/funding-rate-source.ts src/funding-rates/funding-rate-market-sync.ts tests/support/fake-funding-rate-source.ts tests/funding-rates/funding-rate-record.test.ts tests/funding-rates/funding-rate-market-sync.test.ts
git diff --cached --check
git commit -m "feat: increment settled funding rates"
```

Expected: exit 0。

### Task 8: 实现单所公平 worker、重试、周期计划和完整停止

**Files:**
- Create: `src/funding-rates/funding-rate-exchange-worker.ts`
- Create: `src/funding-rates/funding-rate-sync-service.ts`
- Modify: `tests/support/fake-funding-rate-source.ts`
- Create: `tests/funding-rates/funding-rate-sync-service.test.ts`

- [ ] **Step 1: 写确定性并发/调度/关闭红测试**

使用虚拟 `nowMs`、可取消 sleeper 和手动 promise gates，证明：

- Bitget 与 OKX root worker 可同时在途；同一交易所 discovery 与 page 最大并发严格为 1；
- discovery 和所有 coverage/incremental 页面都经同一个 `FundingRequestExecutor`；不存在 source 直调旁路；
- 四类队列顺序为持久 round-robin：`discovery -> incremental -> backfill -> reconcile`（空类别跳过），类别一轮内不得二次执行；同类 market 每页后 FIFO 到队尾；
- key 去重覆盖排队和正在执行状态；持续四类过载、长市场和失败市场都不饿死其他任务；
- 启动先从 SQLite 恢复遗留 BACKFILLING/RUNNING，再立即排 discovery；BACKFILLING coverage 必须用注入时钟调用 `resumeInterruptedCoverage(market, resumedAt)`，原子验证旧恢复状态并递增 generation；RUNNING 增量必须调用 `restartInterruptedIncremental` 原子递增 token；两者都按新 lease 从各自安全位置重建任务；
- 完整发现后新 active 回填、inactive final、reactivation、已到期 incremental/24h periodic 按持久谓词入队；
- 已知 market 从 discovery 消失时整轮不应用，但已知任务继续；发现下周期重试；
- incremental 下次时间按最近 attempt ended + interval；periodic 成功按 last coverage success + 24h，失败按 attempt ended + interval；积压不重复；
- 只有 CCXT `NetworkError` 子类执行初次请求 + 3 次重试，虚拟等待精确为 1000/2000/4000ms；解析/身份/游标/DB 错误零立即重试；
- 每次请求额外满足 source 的 100/250ms spacing；spacing 与 backoff 均不并发发请求；
- retry/incomplete 日志携带精确 request metadata 和 coverage/incremental 分类；
- stop-before-start、重复 start、重复 stop、stop-during-discovery/backoff/request/transaction/timer-race；正常取消不写 INCOMPLETE；
- stop 先取消 timer/sleeper、停止派发，再等待两个完整 root promise；返回后 repository 调用数固定不变。

- [ ] **Step 2: 确认 RED**

```bash
npm run build && node --test dist/tests/funding-rates/funding-rate-sync-service.test.js
```

Expected: exit 非 0，新 worker/service 不存在。

- [ ] **Step 3: 实现公平队列和 service**

worker 为四个 FIFO queue 维护 `Set<taskKey>` 和上次成功取出的 category index。每轮从 index 后最多检查四类，只执行一个 discovery 或一个历史页面；返回 `requeue` 时排到本类尾部，`done` 才删除 key。单一 async loop 是该 exchange 所有 CCXT 调用的唯一入口。

每个 worker 自己实现并独占一个 `FundingRequestExecutor`。discovery task 和由 `FundingRateMarketSync` 创建的所有 page task 必须注入同一个实例；测试用 source 方法调用计数证明无旁路。请求 policy 在每次 attempt 前同时满足 spacing 和取消状态；只捕获 `error instanceof NetworkError` 重试。停止前尚未发出的 attempt 或正在 backoff 的等待抛从 `funding-rate-source.ts` 导入的 `FundingRequestCanceledError`，market task 必须原样传播，worker 不写 INCOMPLETE。第四次临时网络 attempt 失败后抛同文件导出的 `FundingRequestRetryExhaustedError`，由 market task 写对应任务类型的固定 `REQUEST_RETRY_EXHAUSTED`。每次实际重试调用必填 observer，由调用 task 补齐上下文并经安全事件 sink 记录。已经进入不可取消底层请求时，root promise 等待其结束：成功响应仍允许完成该一页验证与原子提交，失败响应在 stop 已请求时改抛取消错误且不改写任务状态；两种情况都不再 requeue。由此持久状态保持可恢复，而 shutdown 本身不伪装成远端数据失败。

`FundingRateSyncService.start()` 同步建立 timer/root loop 后立即调度恢复与 discovery，不返回网络 promise。`stop()` 幂等共享 Promise，按设计先取消、再 join；内部错误只能在 quiescence 后报告。远端单市场失败不得 reject 整个服务 root 或触碰交易组件。

- [ ] **Step 4: GREEN 并提交**

```bash
npm run build && node --test dist/tests/funding-rates/funding-rate-sync-service.test.js
git add src/funding-rates/funding-rate-exchange-worker.ts src/funding-rates/funding-rate-sync-service.ts tests/support/fake-funding-rate-source.ts tests/funding-rates/funding-rate-sync-service.test.ts
git diff --cached --check
git commit -m "feat: schedule funding rate synchronization"
```

Expected: exit 0；测试不使用真实时间等待。

### Task 9: 装配到现有服务并证明 listen/shutdown 顺序

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/main.test.ts`

- [ ] **Step 1: 写装配与生命周期红测试**

在现有 `runnableFixture` 增加 funding sync 计数和事件，覆盖：

- `RuntimeConfig.fundingRateSyncIntervalMs` 默认/自定义；非法值在 gateway factory 和 database factory 调用前失败；
- compose 创建共享同一 SQLite 连接的两个 repository，但 funding source factory 永不收到 credentials/env；
- compose/source/service 构造期间 fake 的 discovery 与 history raw 方法调用数为零；
- listen pending 时 funding start=0；listen resolve 后无 await 间隙地 start 一次；
- listen reject 时 funding 从未 start，但 stop 在 DB close 前安全调用；
- signal-during-listen：`funding.stop -> monitor.stop -> server.close -> database.close`，listen 后 resolve 仍不 start；
- 正常/重复 shutdown 同一顺序、每项一次；funding stop gate 未释放前 DB close=0；
- funding stop 在完整 join 后 reject 时，仍依次关闭 monitor/server/database、移除 signal listeners 且最终 shutdown reject 原 funding error；若同时处于 startup failure 路径，仍抛最初 startup error；
- funding worker 运行失败不调用 strategy repository transition、coordinator 或 monitor 的交易行为。

- [ ] **Step 2: 确认 RED**

```bash
npm run build && node --test dist/tests/main.test.js
```

Expected: exit 非 0，仅新增 funding 装配断言失败；现有生命周期断言仍可解释。

- [ ] **Step 3: 修改生产装配**

`RuntimeConfig` 增加 `fundingRateSyncIntervalMs`；`loadRuntimeConfig` 在 credential map、gateway factory 和 database factory 之前完成 interval 校验。

`ComposeServiceOptions` 增加可注入 `fundingRateSourceFactory`、`fundingRateRepositoryFactory`、`fundingRateSyncFactory`、`fundingRateEvents` 和调度时钟/sleeper，仅供无网络测试；默认路径创建 public source、funding repository 和 service。`ServiceComposition`/`RunnableComposition` 增加：

```ts
readonly fundingRateSync: {
  start(): void;
  stop(): Promise<void>;
};
```

`startService` 的 `closeResources` 先在独立 try/catch 中 await `fundingRateSync.stop()`，把 rejection 保存为 `firstError`，然后无条件继续现有 monitor/server/database/listener 清理；后续错误只在 firstError 为空时占位。全部资源尝试关闭后再记录/抛 firstError。listen 成功后只在同一同步分支 `if (shutdownPromise === null)` 内调用 `fundingRateSync.start()`，start 与检查之间不得有 `await`；随后才记录 `service_started`。startup catch 即使 cleanup 也失败仍保留并抛原始 startup error。

- [ ] **Step 4: 运行主入口和全套聚焦测试**

```bash
npm run build && node --test dist/tests/main.test.js dist/tests/config/funding-rate-config.test.js dist/tests/funding-rates/*.test.js dist/tests/storage/sqlite-funding-rate-repository.test.js
```

Expected: exit 0。命令只构造 fake client/临时 DB，不执行 `npm start`。

- [ ] **Step 5: 提交**

```bash
git add src/main.ts tests/main.test.ts
git diff --cached --check
git commit -m "feat: start funding sync after listen"
```

### Task 10: 更新 README 并执行完整正确性 gates

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify only if a verified omission is found: files already owned by Tasks 1-9

- [ ] **Step 1: 更新运维合同**

README 明确：

- Bitget/OKX、active USDT 线性永续精确谓词；
- 只存已结算历史，Bitget raw `fundingRate`、OKX raw `realizedRate`，不存实时/预测值；
- `FUNDING_RATE_SYNC_INTERVAL_MS` 默认 `3600000`，合法 `60000..86400000`；
- 首次逐 market 回填、完成后立即增量、active 每 24h 全范围复核、inactive 最后复核和 reactivation 门；
- 公共无凭证 client，与交易 credentials/订单链路隔离；
- Bitget 未公布保留期、OKX 最多约三个月；“完整”只表示接口可见范围且验证至持久化 cutoff；
- 三张表、revision、永久保留和文件持续增长；
- coverage/incremental 分离、重试与关键结构化事件的诊断方式。

`.env.example` 在数据库路径之前加入 `FUNDING_RATE_SYNC_INTERVAL_MS=3600000`，不加入任何新凭证字段。

首期无页面/操作入口，不修改 `docs/usage/operator-guide.md`。

- [ ] **Step 2: 由 risk_reviewer 做 defect-first review**

review 范围为本计划全部新增/修改代码及不变量 1-21，重点检查：raw 字段、rate 精度、generation/transaction、OKX overlap、Bitget 双扫描、reactivation、队列公平、stop/join、凭证隔离和缺失测试。P0/P1/P2 必须先以源码和可复现 fake 测试解决；不得按票数忽略。

- [ ] **Step 3: 执行 pre-verification 与完整验证**

先由 `pre-verification-check` 确认 Node/npm/native module/显式测试 glob 可用，且命令不会读取 `.env`、`data/**` 或访问网络。然后运行：

```bash
npm run build
npm test
git diff --check
git status --short
```

Expected:

- `npm run build` exit 0；
- `npm test` exit 0，所有现有和资金费率测试通过；
- `git diff --check` exit 0；
- `git status --short` 只显示明确属于用户或当前任务、已逐项解释的文件，不出现 `dist/`、`data/`、`.env` 或临时 DB。

- [ ] **Step 4: 执行 completion consistency gates**

按顺序运行 `verification-before-completion`、`consistency-check`、`post-verification-check`。逐条回读批准 spec 的完成标准、正确性不变量 1-21、本计划 checkbox、README 与实际接口；任何未证明项保持未完成，不得用“测试大致覆盖”替代证据。

- [ ] **Step 5: 提交 README 或必要的已验证修正**

```bash
git add .env.example README.md
git diff --cached --check
git commit -m "docs: document funding rate synchronization"
```

如果 review 产生代码修正，每一项必须先新增会按预定原因失败的回归测试、单独 GREEN，再按实际 scope 使用独立 conventional commit；不得把用户已有文件混入。

---

## 最终验收索引

- Source tests 证明市场谓词、raw method、settled 字段、游标和无凭证边界。
- Repository tests 证明 TEXT 精度、幂等修订、三表约束、页面原子性、双状态、generation 和 TEMP 集合。
- Market sync tests 证明 Bitget 双扫描、OKX overlap/empty termination、冻结增量边界和状态隔离。
- Service tests 证明两所并行、单所串行、四类公平、退避/spacing、周期语义和完整 root join。
- Main tests 证明配置 fail-fast、构造零网络、listen 后启动和 SQLite 前停止。
- 完整回归证明现有对冲路径没有接口、状态或订单行为变化。
- README 只作“接口当前可见范围、验证至 cutoff”的限定声明，不宣称上市以来绝对完整。
