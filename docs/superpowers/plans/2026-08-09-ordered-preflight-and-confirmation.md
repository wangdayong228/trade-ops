# Ordered Preflight and Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make initial preflight and confirmation revalidation use one strict fail-fast sequence, and invalidate stale previews before any execution claim or order intent.

**Architecture:** Extract reusable pure trading checks from `PreflightService`, keep remote reads explicitly sequential, and add `ConfirmationService` as the sole owner of preview comparison plus `PENDING_CONFIRMATION -> EXECUTING/PREFLIGHT_INVALIDATED`. Fastify calls confirmation synchronously and queues the coordinator only after a successful claim.

**Tech Stack:** TypeScript ESM, Decimal.js, Fastify 5, Node.js built-in test runner.

## Global Constraints

- Requires completed Plan 1: `docs/superpowers/plans/2026-08-09-precise-error-contract-and-storage.md`.
- Approved design: `docs/superpowers/specs/2026-08-09-ordered-workflows-and-precise-errors-design.md`.
- Preserve all three execution modes and existing quantity/notional arithmetic.
- Do not use `Promise.all` or `Promise.allSettled` inside preflight or confirmation reads.
- A failed initial preflight writes nothing. A failed confirmation revalidation atomically writes `PREFLIGHT_INVALIDATED` plus its precise failure.
- A failed invalidation transaction returns `STORAGE_OPERATION_FAILED` and must not claim that the state changed.
- Never access `.env`, a real exchange, or a real database.

---

## File Map

- Create `src/strategy/trading-checks.ts`: pure decimal, market, account, notional, and balance checks with precise errors.
- Modify `src/strategy/preflight-service.ts`: explicit ordered reads and `phase` context.
- Create `src/strategy/confirmation-service.ts`: revalidation, comparison, invalidation, and claim.
- Modify `src/exchanges/profiles/okx-profile.ts`: position-mode-first fail-fast.
- Modify `src/http/server.ts` and `src/main.ts`: inject and call `ConfirmationService` synchronously.
- Modify fake gateway and preflight/coordinator/HTTP/main/acceptance tests.

### Task 1: Pure Precise Trading Checks

**Files:**
- Create: `src/strategy/trading-checks.ts`
- Create: `tests/strategy/trading-checks.test.ts`
- Modify: `src/strategy/preflight-service.ts`

**Interfaces:**

```ts
export interface CheckContext {
  readonly phase: 'preflight' | 'confirmation' | 'execution' | 'recovery';
  readonly clock: () => Date;
}

export function checkedPositiveDecimal(
  value: unknown,
  subject: ErrorSubject,
  context: CheckContext
): Decimal;
export function checkedMarketPair(
  input: Readonly<PreflightInput>,
  spotMarket: Readonly<MarketRules>,
  contractMarket: Readonly<MarketRules>,
  context: CheckContext
): void;
export function checkedAccountSettings(
  settings: Readonly<AccountSettings>,
  exchangeId: string,
  symbol: string,
  context: CheckContext
): {
  readonly settings: AccountSettings & {
    readonly marginMode: 'isolated' | 'cross';
    readonly positionMode: 'hedged';
    readonly leverage: string;
  };
  readonly leverage: Decimal;
};
export function checkedQuoteNotional(
  quantity: Decimal,
  priceValue: unknown,
  market: Readonly<MarketRules>,
  leg: 'spot' | 'contract',
  context: CheckContext
): { readonly price: string; readonly notional: Decimal };
export function checkedAvailableBalance(
  balanceValue: unknown,
  requiredNotional: Decimal,
  exchangeId: string,
  symbol: string,
  kind: 'spot' | 'swap',
  leverage: Decimal | undefined,
  context: CheckContext
): string;
```

- [ ] **Step 1: Write RED table tests**

For every helper, assert the exact `code`, `phase`, subject, expected, actual, and Chinese message. Include malformed decimal, zero/negative/non-finite values, market identity/base/quote/kind/activity, unknown/one-way position mode, unknown margin mode, invalid leverage, minimum/maximum notional, and just-below/exact/just-above balances.

- [ ] **Step 2: Run RED**

Run `npm run build`. Expected: missing module failures.

- [ ] **Step 3: Move existing arithmetic without changing formulas**

Move the current private decimal/product/market/account/notional checks from `preflight-service.ts` into `trading-checks.ts`. Replace each free-form `Error` with `makeTradeOpsError`. Keep private Decimal precision/exponent behavior unchanged and pass the injected clock through `CheckContext`.

- [ ] **Step 4: Verify and commit**

Run build plus `trading-checks` and existing preflight tests. Expected: arithmetic regressions remain GREEN.

Commit: `refactor(strategy): centralize precise trading checks`.

### Task 2: Strict Preflight Read Order

**Files:**
- Modify: `src/strategy/preflight-service.ts`
- Modify: `tests/strategy/preflight-service.test.ts`
- Modify: `tests/support/fake-exchange-gateway.ts`

**Interfaces:**

```ts
export interface PreflightRunContext {
  readonly phase: 'preflight' | 'confirmation';
}

async run(
  input: PreflightInput,
  context: PreflightRunContext = { phase: 'preflight' }
): Promise<PreflightResult>;
```

The fake gateway records reads as exact strings: `market:spot:BTC/USDT`, `market:swap:BTC/USDT`, `settings:BTC/USDT`, `price:spot:BTC/USDT`, `price:swap:BTC/USDT`, `balance:spot:USDT`, and `balance:swap:USDT`.

- [ ] **Step 1: Add RED order and early-stop tests**

For a successful preflight require:

```ts
assert.deepEqual(reads, [
  'bitget:market:spot:BTC/USDT',
  'okx:market:swap:BTC/USDT',
  'okx:settings:BTC/USDT',
  'bitget:price:spot:BTC/USDT',
  'okx:price:swap:BTC/USDT',
  'bitget:balance:spot:USDT',
  'okx:balance:swap:USDT'
]);
```

Inject a failure at every step and assert no later read occurred. The one-way case must stop after `settings`, even when all later fake reads are configured to fail.

- [ ] **Step 2: Run RED**

Run preflight tests. Expected: order assertions fail because current reads use two `Promise.all` blocks.

- [ ] **Step 3: Implement explicit sequential awaits**

The body order must be: local input checks; registry lookup; spot market read/check; contract market read/check; pair check; account read/check; quantity normalization; spot price/notional; contract price/notional; spot balance; contract balance; result creation. Freeze input/market snapshots as today.

- [ ] **Step 4: Verify and commit**

Run build and preflight tests. Expected: exact traces and all current numerical boundary tests pass.

Commit: `refactor(strategy): order preflight checks`.

### Task 3: OKX Position Mode First

**Files:**
- Modify: `src/exchanges/profiles/okx-profile.ts`
- Modify: `tests/exchanges/ccxt-gateway.test.ts`

**Interfaces:**
- `OkxProfile.fetchAccountSettings` first awaits `fetchPositionMode(exchangeSymbol)`.
- For `hedged === false`, return `{ marginMode: 'unknown', positionMode: 'one-way', leverage: null }` without calling `fetchPositions`.
- For unknown mode, return all unknown/null without calling `fetchPositions`.
- Only `hedged === true` may call `fetchPositions`.

- [ ] **Step 1: Add RED call-count tests**

Configure `fetchPositions` to throw and assert one-way/unknown results are still returned and the call count remains zero. Retain hedged short-side, flat account, and conflicting settings tests.

- [ ] **Step 2: Run RED, implement sequential branching, verify GREEN**

Run the focused OKX account tests before and after the change. Confirm no settings mutation method exists or is called.

- [ ] **Step 3: Commit**

Commit: `fix(okx): stop account checks after position mode failure`.

### Task 4: Synchronous Confirmation Service

**Files:**
- Create: `src/strategy/confirmation-service.ts`
- Create: `tests/strategy/confirmation-service.test.ts`
- Modify: `src/http/server.ts`
- Modify: `src/main.ts`
- Modify: `tests/http/server.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**

```ts
export interface ConfirmationService {
  confirm(strategyId: string): Promise<StrategyRecord>;
}

export class DefaultConfirmationService implements ConfirmationService {
  constructor(
    preflight: PreflightService,
    repository: StrategyRepository,
    clock?: () => Date
  );
}
```

`BuildServerDependencies` replaces direct confirmation-state logic with `confirmationService`. The route does:

```ts
const strategy = await dependencies.confirmationService.confirm(request.params.id);
queueConfirmation(strategy.id);
return reply.status(202).send({ accepted: true, strategyId: strategy.id });
```

- [ ] **Step 1: Add RED service tests**

Cover unknown strategy; non-pending state; pending strategy with an order; exact successful revalidation/claim; market identity/rule/effective quantity/account setting drift; current price change with sufficient balance; insufficient latest balance; remote read failure; invalidation transaction failure; and two concurrent confirmations. Assert every rejected confirmation has zero creates and zero new order intents.

For drift/error cases assert persisted state `PREFLIGHT_INVALIDATED`, exact `failure`, and no orders. For the transaction-failure case assert state remains `PENDING_CONFIRMATION` and the thrown code is `STORAGE_OPERATION_FAILED`.

- [ ] **Step 2: Run RED**

Run build and the new service tests. Expected: missing module failures.

- [ ] **Step 3: Implement comparison and atomic state ownership**

Acquire the existing in-process strategy operation owner before reading state and release it in `finally`. Compare immutable preview fields with exact decimal equivalence where appropriate. On revalidation failure, persist that precise error detail while transitioning from pending to invalidated; on claim race, return `STRATEGY_STATE_MISMATCH`. Never queue from inside the service.

- [ ] **Step 4: Replace HTTP confirmation behavior**

Update tests that currently accept `EXECUTING` or terminal confirmations as idempotent `202`; the new result is `409` with expected `PENDING_CONFIRMATION` and actual state. Prove the route does not return until revalidation resolves, queues exactly once only after claim, and a coordinator failure after `202` remains a background concern.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run build
node --test dist/tests/strategy/trading-checks.test.js dist/tests/strategy/preflight-service.test.js dist/tests/strategy/confirmation-service.test.js dist/tests/exchanges/ccxt-gateway.test.js dist/tests/http/server.test.js dist/tests/main.test.js
npm test
git diff --check
```

Expected: PASS with no preflight/confirmation `Promise.all` and no order create on confirmation failure.

Commit: `feat(strategy): revalidate before confirmation`.

## Plan 2 Completion Gate

Run `rg -n "Promise\.all" src/strategy/preflight-service.ts src/strategy/confirmation-service.ts` and expect no matches. Verify the one-way trace ends at position-mode/settings inspection and the complete suite passes before Plan 3.
