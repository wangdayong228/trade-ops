# Checked Execution and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every new-order check before deterministic intent persistence and external submission, preserve concurrent mode, and make recovery select precise errors without losing reliable fill evidence.

**Architecture:** Split gateway preparation from submission, add `ExecutionPrecheckService` for ordered account/market/notional/balance checks, and simplify the coordinator to consume prepared submissions. Persist uncertain submission/query issues on orders. Recovery observes concurrently but validates, prioritizes, and persists in deterministic role order before asking the coordinator to continue.

**Tech Stack:** TypeScript ESM, Decimal.js, CCXT, SQLite, Node.js built-in test runner.

## Global Constraints

- Requires completed Plans 1 and 2.
- Approved design: `docs/superpowers/specs/2026-08-09-ordered-workflows-and-precise-errors-design.md`.
- Preserve deterministic client order IDs, atomic concurrent intent planning, exact decimal arithmetic, and existing exposure classification.
- Existing intents are lookup-only. No recovery path may call external create for an existing role.
- `CONCURRENT` checks are sequential; its two actual submissions remain concurrent.
- Any error after the underlying CCXT create call begins has certainty `UNKNOWN`.
- Never read `.env`, contact exchanges, or use a real database.

---

## File Map

- Modify `src/exchanges/exchange-gateway.ts`: prepared-submission contract and typed certainty.
- Modify `src/exchanges/ccxt-exchange-gateway.ts`: prepare/submit split and precise normalization errors.
- Modify exchange profiles only where preparation must return its safe reference price.
- Create `src/strategy/execution-precheck-service.ts`: ordered per-order safety checks.
- Modify `src/strategy/hedge-coordinator.ts`: prepared-order orchestration and issue persistence.
- Modify `src/strategy/order-monitor.ts`: deterministic evidence processing.
- Modify fake gateway, exchange, coordinator, monitor, storage, logging, and acceptance tests.

### Task 1: Gateway Prepare/Submit Boundary

**Files:**
- Modify: `src/exchanges/exchange-gateway.ts`
- Modify: `src/exchanges/ccxt-exchange-gateway.ts`
- Modify: `tests/support/fake-exchange-gateway.ts`
- Modify: `tests/exchanges/ccxt-gateway.test.ts`

**Interfaces:**

```ts
export interface PreparedOrderSubmission {
  readonly exchangeId: string;
  readonly request: Readonly<OrderRequest>;
  readonly market: Readonly<MarketRules>;
  readonly referencePrice: string;
}

export interface ExchangeGateway {
  readonly exchangeId: string;
  loadMarket(symbol: string, kind: MarketKind): Promise<MarketRules>;
  quantizePrice(symbol: string, kind: MarketKind, price: string): Promise<string>;
  fetchFreeBalance(asset: 'USDT', kind: MarketKind): Promise<string>;
  fetchAccountSettings(symbol: string): Promise<AccountSettings>;
  fetchLastPrice(symbol: string, kind: MarketKind): Promise<string>;
  prepareOrder(request: OrderRequest): Promise<PreparedOrderSubmission>;
  submitPreparedOrder(
    prepared: PreparedOrderSubmission
  ): Promise<OrderSnapshot>;
  fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot>;
  findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null>;
}
```

Each gateway retains private ownership data for prepared objects and rejects forged/cross-gateway objects with `ORDER_INTENT_MISMATCH` and certainty `NOT_SUBMITTED`.

- [ ] **Step 1: Replace gateway tests with RED boundary tests**

Prove request shape, market, precision, quantity, quote-notional, ticker, and profile preparation failures occur in `prepareOrder`, carry exact `ErrorDetail`, and leave CCXT `createOrder` count zero. Prove `submitPreparedOrder` performs no market/ticker/balance read and calls CCXT create exactly once.

Test direct CCXT rejection and every post-call normalization failure as `OrderSubmissionError` with certainty `UNKNOWN`. Test a forged prepared object as `NOT_SUBMITTED`.

- [ ] **Step 2: Run RED**

Run build and focused gateway tests. Expected: missing methods and current generic `NoOrderSubmittedError` assertions fail.

- [ ] **Step 3: Implement immutable preparation**

Move the current `prepareCreateOrder` work behind public `prepareOrder`. Always produce a safe positive `referencePrice`: formatted limit price for limits; ask then last for market buys; bid then last for market sells. Clone/freeze the public request and market rules. Keep exchange-specific formatted amount, submission price, params, and market object in a private class/WeakMap owned by that gateway instance.

`submitPreparedOrder` first validates private ownership without external I/O, then calls CCXT `createOrder` as its first external operation. Wrap pre-call ownership failure as `NOT_SUBMITTED`; wrap CCXT and subsequent normalization errors as `UNKNOWN` with precise safe detail.

- [ ] **Step 4: Remove old create boundary and verify**

Delete `createOrder` and `NoOrderSubmittedError`. Update the fake gateway with `prepareRequests`, `preparedSubmissions`, `submitRequests`, and separate scripted prepare/submit failures.

Run exchange tests and build. Expected: gateway tests pass; coordinator compile failures identify Task 3 consumers.

- [ ] **Step 5: Commit**

Commit: `refactor(exchange): separate order preparation and submission`.

### Task 2: Ordered Execution Prechecks

**Files:**
- Create: `src/strategy/execution-precheck-service.ts`
- Create: `tests/strategy/execution-precheck-service.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

```ts
export interface CheckedOrderSubmission {
  readonly gateway: ExchangeGateway;
  readonly prepared: PreparedOrderSubmission;
}

export class ExecutionPrecheckService {
  constructor(
    registry: ExchangeRegistry,
    clock?: () => Date
  );
  prepare(
    strategy: Readonly<StrategyRecord>,
    role: OrderRole,
    request: Readonly<OrderRequest>,
    phase: 'execution' | 'recovery' = 'execution'
  ): Promise<CheckedOrderSubmission>;
}
```

- [ ] **Step 1: Add RED exact-order tests**

For each spot/contract market and GTC role, require this order:

```text
contract account settings
target gateway prepareOrder (market -> precision -> reference price)
target-leg free balance
```

At each injected failure assert no later read, no intent, and no submit. Assert fresh market identity/rules match the confirmed preflight snapshot, contract settings match with decimal-equivalent leverage, and current notional/balance is sufficient for the exact order quantity.

- [ ] **Step 2: Run RED, implement using trading-check helpers, verify GREEN**

Use Plan 2 helpers for market/account/notional/balance semantics. Spot uses current USDT notional; contract compares leveraged free USDT. Use the explicit `phase` parameter for every error, and include strategy/order role plus exchange/symbol in every applicable subject.

- [ ] **Step 3: Wire composition and commit**

Inject one service into `HedgeCoordinator`. Commit: `feat(strategy): check every new order before planning`.

### Task 3: Coordinator Consumes Prepared Orders

**Files:**
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `src/http/server.ts`
- Modify: `src/strategy/order-monitor.ts` only for the continuation method rename.

**Interfaces:**
- Rename public execution entry to `execute(strategyId): Promise<void>`.
- The server queues `coordinator.execute(strategyId)` only after ConfirmationService has claimed the strategy.
- Monitor continuation calls the same method only for already-`EXECUTING` strategies.

- [ ] **Step 1: Add RED precheck/intent/submit sequence tests**

Assert for every new role: precheck completes, intent persists, then submit begins. A preparation failure leaves no intent. A `NOT_SUBMITTED` submit failure leaves the deterministic intent but terminalizes according to known exposure. An `UNKNOWN` failure stores order `issue`, performs client-ID lookup only, and never submits again.

For `CONCURRENT`, use deferred promises to prove both prechecks finish and both intents persist atomically before either submit starts, then prove both submits overlap. If the second precheck fails, assert zero intents and zero submits.

- [ ] **Step 2: Run RED**

Run coordinator tests. Expected: old `createOrder` path and parallel settings guards violate the assertions.

- [ ] **Step 3: Refactor preparation and submission helpers**

`PreparedOrder` now contains repository record plus `CheckedOrderSubmission`. New roles call `ExecutionPrecheckService.prepare` before `planOrder`/`planOrdersAtomically`. Existing roles never call the service and go directly to client-ID/exchange-ID lookup.

On direct valid snapshot, attach it and clear `issue` atomically. On `UNKNOWN`, record `issue` before lookup. If lookup succeeds, attachment clears it; if lookup is unavailable/null, remain recoverable.

Replace every broad inconsistency transition with the exact error detail for role, field, expected, and actual. Preserve current `FAILED` versus `HEDGE_INCOMPLETE` exposure rules.

- [ ] **Step 4: Cover sequential second leg and difference GTC**

Add tests where market rule, settings, price, minimum, or balance changes after first-leg fill. Assert no second submit, state `HEDGE_INCOMPLETE`, and exact failure. Retain exact actual-fill quantity, average-price, and one-GTC idempotency tests.

- [ ] **Step 5: Verify and commit**

Run build, coordinator, exchange, storage, and HTTP confirmation suites. Commit: `refactor(strategy): submit only checked persisted intents`.

### Task 4: Deterministic Recovery Evidence

**Files:**
- Modify: `src/strategy/order-monitor.ts`
- Modify: `tests/strategy/order-monitor.test.ts`

**Interfaces:**
- Observation remains concurrent.
- Validation order is `SPOT_MARKET`, `CONTRACT_MARKET`, `SPOT_HEDGE_GTC`, `CONTRACT_HEDGE_GTC`, then order ID.
- Error priority is malformed/inconsistent evidence, canceled/rejected hedge evidence, submission issue, query failure.

- [ ] **Step 1: Add RED mixed-evidence tests**

Cover: one query rejects while another returns a newer positive fill; malformed snapshot plus canceled GTC; canceled/rejected GTC plus extra topology; planned null lookup plus reliable terminal companion; state change during observation; and attachment failure after all validation.

Assert no snapshot is attached until every fulfilled observation validates. Assert reliable snapshots are not discarded merely because another query failed. Assert selected terminal failure follows the fixed priority and includes exact order subject/expected/actual.

- [ ] **Step 2: Run RED**

Run monitor tests. Expected: current early return on any rejected observation loses reliable evidence.

- [ ] **Step 3: Implement evidence collection and deterministic processing**

Convert each settled rejection into a safe `RECOVERY_QUERY_FAILED` issue tied to its order. Sort observations by the fixed role order. Validate all candidates into immutable evidence before any write. Recheck strategy/order versions, attach valid snapshots in the same order, then classify using the complete evidence set.

Only after classification may continuation call `coordinator.execute`; any new role then passes through `ExecutionPrecheckService`.

- [ ] **Step 4: Verify and commit**

Run monitor, coordinator, storage, and acceptance suites. Commit: `fix(recovery): preserve and prioritize precise order evidence`.

### Task 5: Execution Acceptance Matrix

**Files:**
- Modify: `tests/acceptance/hedge-opening.test.ts`
- Modify: `tests/support/order-fixtures.ts`

- [ ] **Step 1: Add end-to-end fake scenarios**

Cover all three modes through preflight, confirmation, execution, restart, and final status. Include successful hedge, pre-submit failure, uncertain first submit recovered by client ID, second-leg failure with exposure, canceled GTC, and concurrent unequal fills.

- [ ] **Step 2: Assert persisted diagnostics across restart**

Reopen only a temporary SQLite file. Assert strategy `failure`, order `issue`, exact fills, and no duplicate submit survive. Never instantiate a production gateway.

- [ ] **Step 3: Full verification**

Run:

```bash
npm run build
node --test dist/tests/exchanges/ccxt-gateway.test.js dist/tests/strategy/execution-precheck-service.test.js dist/tests/strategy/hedge-coordinator.test.js dist/tests/strategy/order-monitor.test.js dist/tests/acceptance/hedge-opening.test.js
npm test
git diff --check
```

Expected: PASS; fake submit counts prove idempotency and concurrent overlap.

Commit: `test(strategy): cover checked execution recovery`.

## Plan 3 Completion Gate

Run `rg -n "createOrder\(|NoOrderSubmittedError|confirmAndExecute" src tests/support` and expect no legacy gateway/coordinator boundary matches. Run the full suite before Plan 4.
