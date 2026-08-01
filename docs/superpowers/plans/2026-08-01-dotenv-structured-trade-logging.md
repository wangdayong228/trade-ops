# Dotenv and Structured Trade Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load an optional root `.env`, replace opaque startup failures with safe JSON diagnostics, and emit a complete allowlisted lifecycle log for every persisted order without changing trading semantics.

**Architecture:** Add a focused dotenv loader, a root Pino/operational logger, and a narrow trade-event sink. The entrypoint owns environment loading and lifecycle logs; Fastify reuses the root Pino instance; the coordinator and monitor emit allowlisted order events only after the corresponding execution or persistence boundary.

**Tech Stack:** Node.js >=20, TypeScript ESM, dotenv 17.4.2, Pino 10.3.1, Fastify 5, SQLite, Node.js built-in test runner.

## Global Constraints

- The runtime floor is exactly `Node.js >=20`; do not add a Node 24-only API or startup check.
- `.env` is optional, loads from `process.cwd()`, and never overrides an existing environment variable.
- An explicitly supplied `RunOptions.env` skips `.env` loading.
- Every application log line is JSON on stdout; do not add file output, rotation, pretty printing, metrics, tracing, or remote transports.
- Never log API keys, secrets, passwords, signatures, authorization/cookie headers, `process.env`, complete HTTP bodies, or raw CCXT requests/responses.
- SQLite remains authoritative. Logging failure must not change order submission count, persistence, strategy state, recovery, or idempotency.
- Do not run `npm start` against the real workspace `.env`; process tests use an isolated temporary working directory and fail before gateway construction.
- Follow strict RED -> GREEN -> refactor for every behavior change and retain the existing explicit Node test globs.
- Before completion use `high-stakes-implementation-testing`, then `pre-verification-check` -> `verification-before-completion` -> `consistency-check` -> `post-verification-check`.

---

## File Map

- Create `src/config/environment-loader.ts`: optional dotenv loading and ENOENT classification.
- Create `src/logging/logger.ts`: Pino construction, operational events, safe error serialization, and redaction paths.
- Create `src/logging/trade-events.ts`: allowlisted order events, no-op sink, Pino sink, and event builders.
- Create focused tests under `tests/config/` and `tests/logging/`.
- Modify `src/main.ts` and `src/http/server.ts`: bootstrap, lifecycle, and shared Fastify logging.
- Modify `src/strategy/hedge-coordinator.ts` and `src/strategy/order-monitor.ts`: order lifecycle events.
- Modify `package.json`, `package-lock.json`, `.env.example`, and `README.md`: dependency, runtime, setup, and operations contract.

---

### Task 1: Dependency Baseline and Optional Environment Loader

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.env.example` if it is not already present
- Create: `src/config/environment-loader.ts`
- Create: `tests/config/environment-loader.test.ts`

**Interfaces:**
- Produces: `loadEnvironmentFile(options?: LoadEnvironmentFileOptions): 'loaded' | 'missing'`
- Consumed later by: `run()` in `src/main.ts`

- [x] **Step 1: Install exact dependencies and lower the runtime floor**

Run:

```bash
npm install dotenv@17.4.2 pino@10.3.1
```

Set the root and lockfile engine declaration to `"node": ">=20"`. Expected: dotenv and Pino are direct dependencies; Pino is deduplicated with Fastify where npm permits.

- [x] **Step 2: Write the failing environment-loader tests**

Create `tests/config/environment-loader.test.ts` with these cases:

```ts
test('loads .env without overriding an existing variable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  await writeFile(path, 'PORT=4000\nTRADING_EXCHANGES=bitget,okx\n');
  const processEnv: NodeJS.ProcessEnv = { PORT: '3000' };

  assert.equal(loadEnvironmentFile({ path, processEnv }), 'loaded');
  assert.equal(processEnv.PORT, '3000');
  assert.equal(processEnv.TRADING_EXCHANGES, 'bitget,okx');
});

test('treats only ENOENT as an optional missing file', () => {
  const output = (code: string): DotenvConfigOutput => ({
    error: Object.assign(new Error(code), { code })
  });
  assert.equal(
    loadEnvironmentFile({ load: () => output('ENOENT') }),
    'missing'
  );
  assert.throws(
    () => loadEnvironmentFile({ load: () => output('EACCES') }),
    /^Error: EACCES$/
  );
});
```

Import Node test/assert/fs/os/path helpers, `DotenvConfigOutput`, and the missing production module.

- [x] **Step 3: Run RED**

Run `npm run build`.

Expected: FAIL because `src/config/environment-loader.ts` does not exist.

- [x] **Step 4: Implement the minimal loader**

Create `src/config/environment-loader.ts`:

```ts
import { resolve } from 'node:path';
import {
  config,
  type DotenvConfigOptions,
  type DotenvConfigOutput
} from 'dotenv';

export interface LoadEnvironmentFileOptions {
  readonly path?: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly load?: (options: DotenvConfigOptions) => DotenvConfigOutput;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined;
}

export function loadEnvironmentFile(
  options: LoadEnvironmentFileOptions = {}
): 'loaded' | 'missing' {
  const result = (options.load ?? config)({
    path: options.path ?? resolve(process.cwd(), '.env'),
    processEnv: options.processEnv ?? process.env,
    override: false,
    quiet: true
  });
  if (result.error === undefined) return 'loaded';
  if (errorCode(result.error) === 'ENOENT') return 'missing';
  throw result.error;
}
```

- [x] **Step 5: Verify GREEN and template completeness**

Run:

```bash
npm run build
node --test dist/tests/config/environment-loader.test.js
git diff --check -- package.json package-lock.json .env.example src/config/environment-loader.ts tests/config/environment-loader.test.ts
```

Expected: build succeeds, loader tests pass, and `.env.example` contains the ten supported safe placeholder keys.

- [x] **Step 6: Commit the loader**

```bash
git add package.json package-lock.json .env.example src/config/environment-loader.ts tests/config/environment-loader.test.ts
git commit -m "feat: load optional dotenv configuration"
```

---

### Task 2: Root Pino Logger and Safe Operational Errors

**Files:**
- Create: `src/logging/logger.ts`
- Create: `tests/logging/logger.test.ts`
- Modify: `src/http/server.ts`
- Modify: `tests/http/server.test.ts`

**Interfaces:**
- Produces: `createAppLogger(destination?: DestinationStream): Logger`
- Produces: `safeError(error, secrets): SafeError`
- Produces: `configuredSecretValues(env): string[]`
- Produces: `OperationalLog`, `createOperationalLog(logger, secretProvider)`
- Produces: `LOGGER_REDACT_PATHS`

- [x] **Step 1: Write failing JSON and secret-replacement tests**

Use a Node `Writable` to capture Pino output and assert:

```ts
const logger = createAppLogger(destination);
const operations = createOperationalLog(
  logger,
  () => ['api-key-value', 'secret-value']
);
operations.error(
  'service_startup_failed',
  new Error('api-key-value failed with secret-value'),
  { phase: 'configuration' }
);
const line = JSON.parse(output.join('').trim()) as Record<string, unknown>;
assert.equal(line.event, 'service_startup_failed');
assert.equal(line.phase, 'configuration');
assert.doesNotMatch(JSON.stringify(line), /api-key-value|secret-value/);
assert.match(JSON.stringify(line), /\[Redacted\]/);
```

Add tests proving arbitrary enumerable `request`, `response`, `apiKey`, and `cause` properties are absent, and only the six exact non-empty credential values are returned by `configuredSecretValues`.
Parse `package.json` in the test and assert the emitted base `version` equals its `version`, preventing the fixed logger field from drifting.

- [x] **Step 2: Run RED**

Run `npm run build`.

Expected: FAIL because `src/logging/logger.ts` does not exist.

- [x] **Step 3: Implement public logger contracts**

Create `src/logging/logger.ts` with:

```ts
export interface SafeError {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

export interface OperationalLog {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, error: unknown,
    fields?: Readonly<Record<string, unknown>>): void;
  fatal(event: string, error: unknown,
    fields?: Readonly<Record<string, unknown>>): void;
}
```

Define the existing 14 Fastify redact paths as `LOGGER_REDACT_PATHS`. `createAppLogger` uses `level: 'info'`, base `{ service: 'trade-ops', version: '1.0.0' }`, censor `[Redacted]`, and stdout unless a test destination is supplied.

`safeError` reads only name/message/code/stack under `try/catch`, replaces every current non-empty secret substring, and never spreads the original object. `createOperationalLog` obtains secrets from its callback for every error and catches logger-write failures so logging remains a side effect only.

- [x] **Step 4: Move Fastify redact ownership without behavior change**

Import and re-export `LOGGER_REDACT_PATHS` from `src/http/server.ts`; delete its local duplicate. Keep its default logger configuration unchanged.

- [x] **Step 5: Verify GREEN**

Run:

```bash
npm run build
node --test dist/tests/logging/logger.test.js dist/tests/http/server.test.js
```

Expected: all logger and HTTP tests pass; captured output is JSON and contains no seeded secret.

- [x] **Step 6: Commit the logger foundation**

```bash
git add src/logging/logger.ts tests/logging/logger.test.ts src/http/server.ts tests/http/server.test.ts
git commit -m "feat: add safe structured logger"
```

---

### Task 3: Bootstrap, Fastify, and Service Lifecycle Logging

**Files:**
- Modify: `src/main.ts`
- Modify: `src/http/server.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/http/server.test.ts`

**Interfaces:**
- Adds: `ComposeServiceOptions.loggerInstance?: Logger`
- Adds: `ComposeServiceOptions.operationalLog?: OperationalLog`
- Adds: `StartServiceOptions.operationalLog?: OperationalLog`
- Adds: `BuildServerDependencies.loggerInstance?: FastifyBaseLogger`
- Adds: `BuildServerDependencies.operationalLog?: OperationalLog`
- Produces: `resolveRuntimeEnvironment(explicitEnv, load?): { env; fileStatus }`

- [x] **Step 1: Write failing lifecycle tests**

Extend the existing runnable fixture and assert one successful lifecycle, including host, port, database path, and exchange IDs when the fixture supplies them:

```ts
assert.deepEqual(logEvents, [
  'service_starting',
  'service_started',
  'service_stopping',
  'service_stopped'
]);
```

Assert repeated signals/shutdown calls do not duplicate stopping/stopped events, and a listen failure logs `service_start_failed` before existing cleanup.

- [x] **Step 2: Write the safe child-process startup regression**

Create a temporary cwd containing only `TRADING_EXCHANGES=bitget,okx` in `.env`. Spawn the absolute `dist/src/main.js` with safe minimal environment and capture stdout/stderr. Assert exit code 1, each stdout line parses as JSON, `environment_loaded` exists, and `service_startup_failed.error.message` equals `missing credentials for configured exchange bitget`.

Add a second temporary cwd without `.env` and assert `environment_file_missing` precedes the expected invalid-configuration fatal event. Unit-test `resolveRuntimeEnvironment` with an explicit `{}` and a loader spy; assert the returned object is the same object, `fileStatus === 'skipped'`, and the spy call count is zero.

This must fail before gateway/database construction and must never use the workspace `.env`.

- [x] **Step 3: Run RED**

Run:

```bash
npm run build
node --test dist/tests/main.test.js
```

Expected: new tests fail because the entrypoint neither loads `.env` nor emits lifecycle JSON.

- [x] **Step 4: Load dotenv only in the default run path**

Implement `resolveRuntimeEnvironment`: when explicit env exists, return it unchanged with `fileStatus: 'skipped'`; otherwise call the injectable loader once against `process.env` and return its loaded/missing status. `run` logs only loaded/missing statuses and passes the resolved env explicitly to `composeService`.

- [x] **Step 5: Add lifecycle events without changing resource ownership**

In `startService`, log `service_starting` before monitor start, `service_started` after listen resolves, `service_stopping` exactly when the idempotent shutdown promise is created, and `service_stopped` after all three resources close. Extend `RunnableComposition.config` with optional `databasePath` and `exchangeIds` fields so real compositions log them while existing fixtures may omit them. If cleanup preserves an error, log `service_stop_failed` and rethrow the same first error.

- [x] **Step 6: Share one logger with Fastify**

Build Fastify with exactly one logger option:

```ts
const loggerOptions = dependencies.loggerInstance === undefined
  ? { logger: dependencies.logger ?? { redact: [...LOGGER_REDACT_PATHS] } }
  : { loggerInstance: dependencies.loggerInstance };
const app = Fastify({
  ...loggerOptions,
  ajv: {
    customOptions: {
      coerceTypes: false,
      removeAdditional: false
    }
  }
});
```

Replace the background confirmation and unhandled HTTP fixed-message logs with `OperationalLog.error`, including `strategyId` or request ID/method/URL, never the raw error object.

- [x] **Step 7: Replace the opaque entrypoint catch**

Create Pino before `run`, pass it and the operational facade through options, then catch with:

```ts
process.exitCode = 1;
operations.fatal('service_startup_failed', error);
```

The facade's secret-provider callback must read current `process.env` after dotenv loading; do not capture a pre-load array.

- [x] **Step 8: Verify GREEN and commit**

Run:

```bash
npm run build
node --test dist/tests/main.test.js dist/tests/http/server.test.js
```

Expected: all focused tests pass and the fixed stderr-only line is absent.

```bash
git add src/main.ts src/http/server.ts tests/main.test.ts tests/http/server.test.ts
git commit -m "feat: log service lifecycle failures"
```

---

### Task 4: Allowlisted Trade Event Contract and Pino Sink

**Files:**
- Create: `src/logging/trade-events.ts`
- Create: `tests/logging/trade-events.test.ts`

**Interfaces:**
- Produces: `TradeEvent`, `TradeEventSink`, `NOOP_TRADE_EVENT_SINK`
- Produces: `orderEvent(name, order, snapshot?, details?): TradeEvent`
- Produces: `PinoTradeEventSink`

- [x] **Step 1: Write failing runtime-allowlist tests**

Build a valid `StrategyOrderRecord`, unsafe-cast extra `apiKey`, `secret`, `rawRequest`, and `rawResponse` fields, pass it through `PinoTradeEventSink`, and assert JSON includes identifiers, request fields, quantities/prices/status while excluding every forbidden key and value. Use a fake logger whose `info()` throws and assert `sink.record(event)` does not throw.

- [x] **Step 2: Run RED**

Run `npm run build`.

Expected: FAIL because `src/logging/trade-events.ts` does not exist.

- [x] **Step 3: Define the allowlisted contract**

Use this event union:

```ts
export type OrderLifecycleEventName =
  | 'order_planned'
  | 'order_submit_started'
  | 'order_submit_succeeded'
  | 'order_submit_uncertain'
  | 'order_rejected_before_submit'
  | 'order_status_changed'
  | 'order_terminal';
```

`TradeEvent` contains only event, strategyId, mode, strategyState, role, exchangeId, symbol, kind, type, side, client/exchange order ID, requested/filled/remaining quantity, price/average price, timeInForce, positionSide, marginMode, status, failureCode, errorType, and errorCode. `mode` and `strategyState` are optional and are passed only where the producer already owns the strategy record; logging must not add repository reads. Define a frozen no-op sink with `record(): void {}`.

- [x] **Step 4: Implement two runtime allowlists**

`orderEvent` constructs a fresh object by explicitly copying only declared fields; never spread order/request/snapshot/details. `PinoTradeEventSink.record` reconstructs the allowlisted object again before `logger.info(fields, event.event)` and catches logger errors. This protects JavaScript callers and unsafe casts as well as typed callers.

- [x] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run build
node --test dist/tests/logging/trade-events.test.js dist/tests/logging/logger.test.js
```

Expected: tests pass with no forbidden field/value in captured JSON.

```bash
git add src/logging/trade-events.ts tests/logging/trade-events.test.ts
git commit -m "feat: define safe trade lifecycle events"
```

---

### Task 5: Coordinator Order Lifecycle Events

**Files:**
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `tests/strategy/hedge-coordinator.test.ts`

**Interfaces:**
- Changes constructor to: `new HedgeCoordinator(registry, repository, tradeEvents?)`
- Existing two-argument construction remains valid through `NOOP_TRADE_EVENT_SINK`.

- [ ] **Step 1: Add a capturing sink to the coordinator fixture**

Add `tradeEvents?: TradeEventSink` to setup options, store `structuredClone(event)` in a test sink, and pass it as the optional third constructor argument.

- [ ] **Step 2: Write failing successful lifecycle tests**

Table-drive `CONTRACT_FIRST`, `SPOT_FIRST`, and `CONCURRENT` so every mode proves that each fresh market order emits the lifecycle. For one persisted terminal market order assert:

```ts
assert.deepEqual(events.map(({ event }) => event), [
  'order_planned',
  'order_submit_started',
  'order_submit_succeeded',
  'order_status_changed',
  'order_terminal'
]);
```

Assert all correlation, mode/state, and normalized quantity/price/status fields. In concurrent mode, assert both `order_planned` events precede either submit-start event. Add a filled sequential first leg that derives a GTC and assert the GTC receives its own full planned/submit/result/status lifecycle.

- [ ] **Step 3: Write failing boundary and side-effect tests**

Assert `NoOrderSubmittedError` emits `order_rejected_before_submit`/`ORDER_SUBMISSION_FAILED`; a generic create error emits `order_submit_uncertain`/`ORDER_SUBMISSION_UNKNOWN`; recovered intent emits no new planned/submit-started event; a throwing sink preserves strategy state and exact create count.

- [ ] **Step 4: Run RED**

Run:

```bash
npm run build
node --test dist/tests/strategy/hedge-coordinator.test.js
```

Expected: new event assertions fail while existing execution assertions remain unchanged.

- [ ] **Step 5: Emit planning and submission events at exact boundaries**

Add optional sink dependency. Emit planned only after `planOrder` returns; after atomic planning emit both returned records before submitting either. Emit submit-started immediately before `gateway.createOrder`. In catches emit only the typed failure code plus error name/code, never raw error/message/object.

- [ ] **Step 6: Emit persisted result/status/terminal events**

Add `source: 'submission' | 'lookup'` to `persistSnapshot`. Immediately after `attachOrderSnapshot` succeeds, emit submit-succeeded for submission source, then status-changed, then terminal for closed/canceled/rejected. All earlier returns emit none. Direct create paths pass submission; lookup paths pass lookup.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm run build
node --test dist/tests/strategy/hedge-coordinator.test.js dist/tests/logging/trade-events.test.js
```

Expected: all tests pass and create/recovery counts are unchanged.

```bash
git add src/strategy/hedge-coordinator.ts tests/strategy/hedge-coordinator.test.ts
git commit -m "feat: log coordinator order lifecycle"
```

---

### Task 6: Monitor Status Events and Logger Composition

**Files:**
- Modify: `src/strategy/order-monitor.ts`
- Modify: `src/main.ts`
- Modify: `tests/strategy/order-monitor.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**
- Changes constructor to: `new OrderMonitor(registry, repository, continuation?, tradeEvents?, operationalLog?)`
- Existing two- and three-argument calls remain valid.
- Adds: `ComposeServiceOptions.tradeEvents?: TradeEventSink`

- [ ] **Step 1: Write failing monitor event tests**

Inject a capturing fourth argument. Extend partial-GTC coverage to assert one status-changed event with fill `0.4` and no terminal; reconcile the same snapshot again and assert no new event. Extend full-terminal coverage to assert status-changed followed by terminal. A throwing sink must not prevent persistence/classification.

- [ ] **Step 2: Write failing recovery error tests**

Inject an operational fifth argument. A per-strategy failure records `strategy_recovery_failed` with strategyId; an interval-level rejection records `monitor_recovery_failed`; a later interval still runs.

- [ ] **Step 3: Run RED**

Run:

```bash
npm run build
node --test dist/tests/strategy/order-monitor.test.js
```

Expected: new logging assertions fail.

- [ ] **Step 4: Emit only persisted, changed snapshots**

After the existing `sameSnapshot` gate and successful `attachOrderSnapshot`, emit status-changed and, for closed/canceled/rejected, terminal. Keep identical polls silent. Log the two currently swallowed recovery catches through `OperationalLog.error`; do not log successful or unchanged polls.

- [ ] **Step 5: Compose shared sinks**

In `composeService`, create one `PinoTradeEventSink(loggerInstance.child({ component: 'trade' }))` when a root logger exists, otherwise use the no-op sink. Pass the same sink to coordinator and monitor, the operational facade to monitor/HTTP, and the same root instance to Fastify.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run build
node --test dist/tests/strategy/order-monitor.test.js dist/tests/strategy/hedge-coordinator.test.js dist/tests/main.test.js
```

Expected: all tests pass, identical polling is silent, and logger failures change no order state or count.

```bash
git add src/strategy/order-monitor.ts src/main.ts tests/strategy/order-monitor.test.ts tests/main.test.ts
git commit -m "feat: log monitored trade updates"
```

---

### Task 7: Documentation and High-Stakes Verification

**Files:**
- Modify: `README.md`
- Verify: `.env.example`
- Verify: every production/test file touched above

**Interfaces:**
- Documents Node >=20, automatic optional `.env`, precedence, JSON stdout, event names, safe fields, and external rotation.

- [ ] **Step 1: Update operator startup instructions**

Replace Node 24 with Node 20 or later and the export block with:

```bash
cp .env.example .env
npm run build
npm start
```

State that `.env` is loaded from cwd, system variables win, and a missing file is allowed when all values are externally injected.

- [ ] **Step 2: Document stdout JSON trade logs**

List the seven lifecycle event names, allowlisted IDs/quantities/prices/status fields, forbidden credential/raw-payload fields, and the process manager's responsibility for persistence/rotation.

- [ ] **Step 3: Run focused security and startup regressions**

```bash
npm run build
node --test dist/tests/logging/logger.test.js dist/tests/logging/trade-events.test.js dist/tests/main.test.js dist/tests/http/server.test.js
```

Expected: all pass; child-process failure is specific JSON; no seeded credential appears.

- [ ] **Step 4: Run financial-state regressions**

```bash
node --test dist/tests/strategy/hedge-coordinator.test.js dist/tests/strategy/order-monitor.test.js dist/tests/storage/sqlite-repository.test.js dist/tests/acceptance/hedge-opening.test.js
```

Expected: all pass with no order-count, terminal-state, recovery, or topology regression.

- [ ] **Step 5: Run full Node 20 verification**

Apply `high-stakes-implementation-testing`, then run:

```bash
node --version
npm test
npm run build
git diff --check
git status --short --branch
```

Expected: `v20.x`, zero test failures, build exit 0, empty diff-check output, and only intended changes.

- [ ] **Step 6: Run completion gates and check every plan item**

Use `pre-verification-check`, `verification-before-completion`, `consistency-check`, and `post-verification-check` in order. Cross-check package/lockfile, README, `.env.example`, logger redactions, event union, every constructor call site, and every checkbox in this plan.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md .env.example
git commit -m "docs: explain dotenv and trade logs"
```

Do not stage unrelated user changes. Any code correction found during verification must first receive its own RED -> GREEN cycle and focused conventional commit.
