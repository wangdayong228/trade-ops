# Precise Error Contract and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace coarse failure codes and unversioned SQLite initialization with one safe structured error contract persisted on strategies and orders.

**Architecture:** Add a dependency-free `TradeOpsError` module that owns the closed code/phase/subject/value contract and deterministic Chinese formatting. Replace `failure_code` with validated `failure_json`, add `issue_json`, and reject existing unversioned schemas before any repository query or recovery. Update all compile-time consumers in the same plan so no legacy compatibility carrier remains.

**Tech Stack:** TypeScript ESM, Node.js >=20, better-sqlite3, Node.js built-in test runner.

## Global Constraints

- Approved design: `docs/superpowers/specs/2026-08-09-ordered-workflows-and-precise-errors-design.md`.
- Follow `docs/standards/code-rules.md`: fixed-order fail-fast and precise safe object/expected/actual errors.
- The new contract is intentionally incompatible with `failureCode`, `failure_code`, and the old public error detail.
- Do not add a compatibility field, adapter, migration, automatic rebuild, or destructive SQL.
- Never read `.env`, credentials, a real business database, or any exchange endpoint.
- Use only in-memory/temporary SQLite and deterministic clocks.
- Run strict RED -> GREEN for every task and commit only the task-owned files after GREEN.

---

## File Map

- Create `src/errors/trade-ops-error.ts`: closed error model, formatter, validator, and boundary conversion.
- Create `tests/errors/trade-ops-error.test.ts`: hostile input, formatting, bounding, and serialization tests.
- Modify `src/domain/types.ts`: add `PREFLIGHT_INVALIDATED`.
- Modify `src/storage/schema.ts`: schema version and new JSON columns/constraints.
- Modify `src/storage/strategy-repository.ts`: `failure`, `issue`, and transition/issue methods.
- Modify `src/storage/sqlite-strategy-repository.ts`: version gate and validated atomic persistence.
- Modify `tests/storage/sqlite-repository.test.ts`: empty/current/legacy schema and error persistence.
- Modify coordinator, monitor, logging, HTTP projection, UI validation, acceptance fixtures, and their tests only as required to remove the old `StrategyFailureCode`/`failureCode` contract and restore a passing build.

### Task 1: Closed Error Model

**Files:**
- Create: `src/errors/trade-ops-error.ts`
- Create: `tests/errors/trade-ops-error.test.ts`

**Interfaces:**
- Produces `ErrorCode`, `ErrorPhase`, `ErrorSubject`, `SafeDiagnosticValue`, `ErrorDetail`, `TradeOpsError`, `OrderSubmissionError`, `makeTradeOpsError`, `makeOrderSubmissionError`, `parseErrorDetail`, and `safeUnknownActual`.
- `OrderSubmissionError.certainty` is exactly `'NOT_SUBMITTED' | 'UNKNOWN'`.

- [ ] **Step 1: Write failing contract tests**

Test exact formatting and round-trip validation with:

```ts
const error = makeTradeOpsError({
  code: 'ACCOUNT_POSITION_MODE_MISMATCH',
  phase: 'confirmation',
  subject: {
    type: 'account',
    exchangeId: 'okx',
    symbol: 'BTC/USDT',
    field: 'positionMode'
  },
  expected: 'hedged',
  actual: 'one-way'
}, () => new Date('2026-08-09T00:00:00.000Z'));

assert.equal(
  error.message,
  'OKX BTC/USDT 账户 positionMode 检查失败：期望 hedged，实际为 one-way'
);
assert.deepEqual(parseErrorDetail(JSON.parse(JSON.stringify(error.detail))), error.detail);
```

Add table cases for every subject variant, every phase, scalar/list values, non-canonical timestamps, extra keys, getters, prototypes, arrays as subjects, oversized IDs/values/lists, non-finite numbers, messages inconsistent with their fields, and credential-like raw objects. Assert parsers return `null` rather than invoking getters or retaining hostile data.

- [ ] **Step 2: Run RED**

Run `npm run build`.

Expected: FAIL because `src/errors/trade-ops-error.ts` does not exist.

- [ ] **Step 3: Implement the exact public types**

Use these exact shapes:

```ts
export const ERROR_CODES = [
  'CONFIG_FIELD_MISSING',
  'CONFIG_FIELD_INVALID',
  'DATABASE_OPEN_FAILED',
  'DATABASE_SCHEMA_VERSION_MISMATCH',
  'SERVICE_COMPONENT_FAILED',
  'SERVICE_LISTEN_FAILED',
  'REQUEST_FORBIDDEN',
  'REQUEST_BODY_INVALID',
  'REQUEST_FIELD_INVALID',
  'STRATEGY_NOT_FOUND',
  'STRATEGY_STATE_MISMATCH',
  'EXCHANGE_NOT_CONFIGURED',
  'MARKET_UNAVAILABLE',
  'MARKET_IDENTITY_MISMATCH',
  'MARKET_INACTIVE',
  'MARKET_RULE_INVALID',
  'ACCOUNT_SETTINGS_UNAVAILABLE',
  'ACCOUNT_SETTINGS_CONFLICT',
  'ACCOUNT_POSITION_MODE_MISMATCH',
  'ACCOUNT_MARGIN_MODE_MISMATCH',
  'ACCOUNT_LEVERAGE_MISMATCH',
  'QUANTITY_INVALID',
  'QUANTITY_NOT_REPRESENTABLE',
  'QUANTITY_OUT_OF_RANGE',
  'PRICE_UNAVAILABLE',
  'PRICE_INVALID',
  'NOTIONAL_OUT_OF_RANGE',
  'BALANCE_UNAVAILABLE',
  'BALANCE_INSUFFICIENT',
  'PREFLIGHT_INVALIDATED',
  'ORDER_TOPOLOGY_MISMATCH',
  'ORDER_INTENT_MISMATCH',
  'ORDER_NOT_SUBMITTED',
  'ORDER_SUBMISSION_UNKNOWN',
  'ORDER_SNAPSHOT_MISMATCH',
  'ORDER_STATUS_MISMATCH',
  'ORDER_NOT_FOUND',
  'ORDER_NO_FILL',
  'ORDER_AVERAGE_PRICE_UNAVAILABLE',
  'HEDGE_ORDER_REJECTED',
  'HEDGE_ORDER_CANCELED',
  'INVARIANT_VIOLATION',
  'RECOVERY_QUERY_FAILED',
  'RECOVERY_STATE_MISMATCH',
  'STORAGE_OPERATION_FAILED',
  'STORAGE_RECORD_INVALID',
  'STORAGE_TRANSITION_REJECTED'
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export type ErrorPhase =
  | 'startup' | 'request' | 'preflight' | 'confirmation'
  | 'execution' | 'recovery' | 'storage';

export type SafeDiagnosticValue =
  | string | number | boolean | null | readonly string[];

export type ErrorSubject =
  | { readonly type: 'configuration'; readonly field: string }
  | { readonly type: 'request'; readonly field: string }
  | { readonly type: 'exchange'; readonly exchangeId: string; readonly operation: string }
  | { readonly type: 'market'; readonly exchangeId: string; readonly symbol: string; readonly kind: 'spot' | 'swap'; readonly field?: string }
  | { readonly type: 'account'; readonly exchangeId: string; readonly symbol: string; readonly field: string }
  | { readonly type: 'strategy'; readonly strategyId: string; readonly field?: string }
  | { readonly type: 'order'; readonly strategyId: string; readonly orderId?: string; readonly role?: string; readonly exchangeId?: string; readonly symbol?: string; readonly field?: string }
  | { readonly type: 'database'; readonly path: string; readonly table?: string; readonly recordId?: string; readonly field?: string };

export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly phase: ErrorPhase;
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
  readonly message: string;
  readonly occurredAt: string;
}
```

Use an exhaustive `Record<ErrorCode, string>` for the action phrase and an exhaustive subject formatter. `makeTradeOpsError` must clone/freeze subject and list values, bound strings to 2,000 code units, generate `message` itself, and accept an injected clock. `parseErrorDetail` must rebuild the message and reject any mismatch or extra key.

`safeUnknownActual` returns only a bounded error `name` or a primitive category such as `string`, `number`, `null`, or `unknown`; it never reads arbitrary properties or messages.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm run build
node --test dist/tests/errors/trade-ops-error.test.js
git diff --check -- src/errors/trade-ops-error.ts tests/errors/trade-ops-error.test.ts
```

Expected: PASS.

Commit: `feat(errors): add precise error contract`.

### Task 2: Versioned Non-Compatible Schema

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/sqlite-strategy-repository.ts`
- Modify: `tests/storage/sqlite-repository.test.ts`

**Interfaces:**
- Produces `SQLITE_SCHEMA_VERSION = 1` and `initializeStrategySchema(database, databasePath)`.
- `SqliteStrategyRepository` accepts an optional third constructor argument `databasePath = ':memory:'`.

- [ ] **Step 1: Write failing schema-gate tests**

Add tests proving:

```ts
const empty = new Database(':memory:');
new SqliteStrategyRepository(empty, fixedClock, ':memory:');
assert.equal(empty.pragma('user_version', { simple: true }), 1);

const legacy = new Database(':memory:');
legacy.exec('CREATE TABLE strategies (id TEXT PRIMARY KEY)');
assert.throws(
  () => new SqliteStrategyRepository(legacy, fixedClock, '/safe/legacy.sqlite'),
  (error: unknown) => error instanceof TradeOpsError
    && error.detail.code === 'DATABASE_SCHEMA_VERSION_MISMATCH'
    && error.detail.expected === 1
    && error.detail.actual === 'unversioned'
);
```

Add cases for a non-current positive `user_version`, a current database reopening successfully, and a failed version gate leaving every existing table/row unchanged.

- [ ] **Step 2: Run RED**

Run `npm run build && node --test dist/tests/storage/sqlite-repository.test.js`.

Expected: FAIL because legacy tables are currently accepted and altered.

- [ ] **Step 3: Replace schema initialization**

Before executing table DDL, query `sqlite_master` for `strategies`, `strategy_orders`, or `order_events` and read `PRAGMA user_version`.

- No business tables and version `0`: apply connection PRAGMAs first, create the new tables/indexes/triggers in one transaction, and set `user_version = 1` as the transaction's last statement.
- Any business table and version other than `1`: throw `DATABASE_SCHEMA_VERSION_MISMATCH`; report `unversioned` for `0`.
- Version `1`: execute only idempotent current-schema setup and validate foreign keys.

In `strategies`, change state and failure storage to:

```sql
state TEXT NOT NULL CHECK (state IN (
  'PENDING_CONFIRMATION', 'PREFLIGHT_INVALIDATED', 'EXECUTING',
  'WAITING_HEDGE', 'HEDGED', 'HEDGE_INCOMPLETE', 'FAILED'
)),
failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json))
```

In `strategy_orders`, add:

```sql
issue_json TEXT CHECK (issue_json IS NULL OR json_valid(issue_json))
```

Require `failure_json` exactly for `PREFLIGHT_INVALIDATED`, `HEDGE_INCOMPLETE`, and `FAILED`; remove `failure_code` completely.

- [ ] **Step 4: Verify GREEN and commit**

Run the storage suite and `git diff --check`. Expected: PASS and no legacy table mutation.

Commit: `feat(storage): require versioned strategy schema`.

### Task 3: Persist Strategy Failures and Order Issues

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/storage/strategy-repository.ts`
- Modify: `src/storage/sqlite-strategy-repository.ts`
- Modify: `tests/storage/sqlite-repository.test.ts`

**Interfaces:**

```ts
export interface StrategyRecord {
  readonly id: string;
  readonly state: StrategyState;
  readonly mode: ExecutionMode;
  readonly spotExchangeId: string;
  readonly contractExchangeId: string;
  readonly symbol: string;
  readonly requestedBaseQuantity: string;
  readonly effectiveBaseQuantity: string;
  readonly preflight: PreflightResult;
  readonly failure: ErrorDetail | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StrategyOrderRecord {
  readonly id: string;
  readonly strategyId: string;
  readonly role: OrderRole;
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly request: OrderRequest;
  readonly snapshot: OrderSnapshot | null;
  readonly status: StrategyOrderStatus;
  readonly issue: ErrorDetail | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

transition(
  strategyId: string,
  from: StrategyState[],
  to: StrategyState,
  failure?: ErrorDetail
): boolean;
recordOrderIssue(strategyOrderId: string, issue: ErrorDetail): void;
clearOrderIssue(strategyOrderId: string): void;
```

- [ ] **Step 1: Add RED repository tests**

Test atomic transition to every failure state, rejection of failure on non-failure states, rejection of missing failure, exact restart round-trip, hostile/extra-key JSON rejection, issue replacement, issue clearing, and `attachOrderSnapshot` atomically clearing a resolved issue.

- [ ] **Step 2: Run RED**

Run the storage suite. Expected: compile/test failures because records and SQL still use `failureCode`.

- [ ] **Step 3: Implement validated persistence**

Serialize only `parseErrorDetail(detail)` results. Parse stored JSON through `parseErrorDetail`; on failure throw `STORAGE_RECORD_INVALID` with database/table/record/field subject and safe expected/actual categories. Update snapshot attachment so snapshot/event write and `issue_json = NULL` occur in the same transaction.

- [ ] **Step 4: Verify focused GREEN**

Run build and storage tests. Expected: storage passes; build may still report old consumers, which Task 4 removes without a legacy shim.

### Task 4: Remove the Old Failure Contract End-to-End

**Files:**
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `src/strategy/order-monitor.ts`
- Modify: `src/logging/trade-events.ts`
- Modify: `src/http/server.ts`
- Modify: `public/app.js`
- Modify: affected tests and `tests/support/fake-exchange-gateway.ts`

**Interfaces:**
- Consumers use `strategy.failure?.code`, never `failureCode`.
- Coordinator/monitor transitions pass an `ErrorDetail` created with the strategy/order subject and the specific known invariant.
- Status JSON exposes `failure` and `issue` as structured values.

- [ ] **Step 1: Update tests to the new record/status shape**

Mechanically replace assertions such as:

```ts
assert.equal(strategy.failureCode, 'HEDGE_ORDER_CANCELED');
```

with:

```ts
assert.equal(strategy.failure?.code, 'HEDGE_ORDER_CANCELED');
assert.equal(strategy.failure?.subject.type, 'order');
assert.equal(strategy.failure?.expected, 'closed');
assert.equal(strategy.failure?.actual, 'canceled');
```

Remove browser acceptance of `failureCode`; require `failure` and per-order `issue`.

- [ ] **Step 2: Run RED build**

Run `npm run build`. Expected: failures enumerate every legacy consumer.

- [ ] **Step 3: Replace every legacy consumer**

Use specific error codes already established by the current branch. Map reliable zero fill to `ORDER_NO_FILL`; missing average to `ORDER_AVERAGE_PRICE_UNAVAILABLE`; canceled/rejected GTC to their exact codes. Use `INVARIANT_VIOLATION` only when no more specific persisted/request/order invariant applies, and always include the precise invariant in expected/actual.

Do not implement final HTTP envelope or final log formatting here; only project the new structured fields sufficiently to compile and preserve safety. Those boundaries are finalized in Plan 4.

- [ ] **Step 4: Run complete regression and commit**

Run:

```bash
npm run build
npm test
git diff --check
```

Expected: PASS with no `StrategyFailureCode`, `failureCode`, or `failure_code` under `src/`, `public/`, or `tests/`.

Commit Task 3 and Task 4 together: `feat(storage): persist precise strategy failures`.

## Plan 1 Completion Gate

Run `rg -n "StrategyFailureCode|failureCode|failure_code" src public tests` and expect no matches. Run `npm test` and confirm no real environment or network access occurred. Do not start Plan 2 until this gate passes.
