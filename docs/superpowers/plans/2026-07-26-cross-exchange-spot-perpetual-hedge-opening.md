# Cross-Exchange Spot–Perpetual Hedge Opening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an operator-confirmed service that buys spot and opens an equal USDT-margined perpetual short across user-selected exchanges in concurrent, contract-first, or spot-first mode.

**Architecture:** A strict TypeScript domain layer owns decimal normalization and strategy state, while CCXT gateways hide exchange-specific spot and perpetual details. A single hedge coordinator persists intent before submission, SQLite enforces idempotency, and an order monitor reconciles GTC fills across restarts. A small Fastify API and framework-free browser page expose preflight, explicit mode selection, confirmation, and status.

**Tech Stack:** Node.js 24 LTS, TypeScript with strict checking, CCXT, Decimal.js, SQLite through `better-sqlite3`, Fastify, `@fastify/static`, Node.js built-in test runner.

## Global Constraints

- Only same-base, `USDT`-quoted spot and USDT-margined perpetual markets are supported.
- The first release supports only Bitget and OKX; either may provide the spot or perpetual leg, but the two legs must use different exchanges.
- The system reads and displays the current margin mode, position mode, and leverage; it never changes them.
- Order price, quantity, contract-size, and fill-difference calculations use Decimal.js, never JavaScript `number` arithmetic.
- Fees do not change the second-leg price.
- Execution mode is always explicitly selected; there is no automatic mode fallback.
- Sequential modes submit a market first leg and one GTC second leg at the first leg’s actual average price.
- Concurrent mode submits both market legs together and places one GTC difference order on the smaller side at the larger side’s average price.
- A partially filled first market order defines the actual hedge target; the service does not chase the original requested quantity.
- GTC orders have no local expiry and are never automatically canceled, repriced, resubmitted, rolled back, or closed.
- SQLite is the only persistence service and the first release runs as one application process.
- API credentials are never stored in SQLite or logs and must not have withdrawal permission.
- Client order IDs are deterministic 32-character lowercase alphanumeric digests of strategy ID plus order role; literal `${strategyId}:${role}` values must never be sent to an exchange.
- Bitget spot market buys use a fresh ask price, falling back to last price, to convert requested base quantity into Bitget's quote-cost request; the actual base fill remains the hedge target, and missing reference prices block submission.
- Closing the hedge is outside this plan.

---

## Planned File Structure

```text
package.json                              project scripts and dependencies
package-lock.json                         exact dependency lock
tsconfig.json                             strict TypeScript build
.gitignore                                generated output, databases, and secrets
src/config/exchange-credentials.ts        environment-backed secret lookup
src/domain/decimal.ts                     Decimal.js construction and serialization
src/domain/types.ts                       strategy, order, market, and API types
src/domain/quantity-normalizer.ts         common executable base-quantity calculation
src/domain/client-order-id.ts             OKX-safe deterministic client order IDs
src/exchanges/exchange-gateway.ts         normalized exchange interface
src/exchanges/ccxt-exchange-gateway.ts    CCXT implementation
src/exchanges/exchange-registry.ts        configured gateway lookup
src/exchanges/exchange-profile.ts         exchange-specific order parameter contract
src/exchanges/profiles/bitget-profile.ts  Bitget client-id, GTC, and position parameters
src/exchanges/profiles/okx-profile.ts     OKX client-id, GTC, and position parameters
src/strategy/preflight-service.ts         market/account validation and preview
src/strategy/hedge-coordinator.ts         three execution modes and idempotent submission
src/strategy/order-monitor.ts             GTC reconciliation and restart recovery
src/storage/schema.ts                     SQLite schema
src/storage/strategy-repository.ts        persistence interface
src/storage/sqlite-strategy-repository.ts SQLite implementation and transactions
src/http/server.ts                        Fastify routes and static page
src/main.ts                               production composition root
public/index.html                         explicit hedge-opening form and status view
public/app.js                             browser API calls and rendering
tests/domain/quantity-normalizer.test.ts  decimal and common-quantity cases
tests/exchanges/ccxt-gateway.test.ts       market/order normalization
tests/support/fake-exchange-gateway.ts     deterministic exchange double
tests/support/order-fixtures.ts            complete normalized order snapshots
tests/strategy/preflight-service.test.ts   preflight behavior
tests/storage/sqlite-repository.test.ts    schema, state claims, and uniqueness
tests/strategy/hedge-coordinator.test.ts   sequential and concurrent execution
tests/strategy/order-monitor.test.ts       partial fills and restart recovery
tests/http/server.test.ts                  API confirmation and status contract
tests/acceptance/hedge-opening.test.ts     end-to-end simulated exchange flow
README.md                                 setup, secrets, runbook, and risk behavior
```

### Task 1: Project Baseline and Common Quantity Calculation

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/domain/decimal.ts`
- Create: `src/domain/quantity-normalizer.ts`
- Create: `tests/domain/quantity-normalizer.test.ts`

**Interfaces:**
- Produces: `decimal(value: Decimal.Value): Decimal`
- Produces: `normalizeCommonBaseQuantity(input: CommonQuantityInput): string`
- Produces: `baseStepFor(rules: TradableAmountRules): Decimal`

- [x] **Step 1: Verify Git and install the exact project dependencies**

Run:

```bash
git status --short --branch
npm init -y
npm install ccxt decimal.js better-sqlite3 fastify @fastify/static
npm install --save-dev typescript @types/node @types/better-sqlite3
```

Expected: Git reports the current branch; `package.json` and `package-lock.json` exist; npm exits successfully.

- [x] **Step 2: Replace the generated package scripts and add strict TypeScript configuration**

Write `package.json` with the installed versions retained from `npm install`, `"type": "module"`, and these scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test dist/tests",
    "start": "node dist/src/main.js"
  }
}
```

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
data/
.env
.firecrawl/
.superpowers/
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

- [x] **Step 3: Write failing common-quantity tests**

Create `tests/domain/quantity-normalizer.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCommonBaseQuantity } from '../../src/domain/quantity-normalizer.js';

test('uses the least common multiple of both base-quantity steps', () => {
  assert.equal(normalizeCommonBaseQuantity({
    requestedBaseQuantity: '1',
    spot: { amountStep: '0.002', contractSize: '1', minBaseAmount: '0.002' },
    swap: { amountStep: '3', contractSize: '0.001', minBaseAmount: '0.003' }
  }), '0.996');
});

test('rejects a normalized amount below either market minimum', () => {
  assert.throws(() => normalizeCommonBaseQuantity({
    requestedBaseQuantity: '0.004',
    spot: { amountStep: '0.001', contractSize: '1', minBaseAmount: '0.005' },
    swap: { amountStep: '1', contractSize: '0.001', minBaseAmount: '0.001' }
  }), /minimum/);
});
```

- [x] **Step 4: Run the test and verify the missing module failure**

Run:

```bash
npm test
```

Expected: FAIL because `src/domain/quantity-normalizer.ts` does not exist.

- [x] **Step 5: Implement Decimal.js setup and common-step normalization**

Create `src/domain/decimal.ts`:

```ts
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

export function decimal(value: Decimal.Value): Decimal {
  return new Decimal(value);
}
```

Create `src/domain/quantity-normalizer.ts`:

```ts
import Decimal from 'decimal.js';
import { decimal } from './decimal.js';

export interface TradableAmountRules {
  amountStep: string;
  contractSize: string;
  minBaseAmount: string;
  maxBaseAmount?: string;
}

export interface CommonQuantityInput {
  requestedBaseQuantity: string;
  spot: TradableAmountRules;
  swap: TradableAmountRules;
}

export function baseStepFor(rules: TradableAmountRules): Decimal {
  return decimal(rules.amountStep).mul(rules.contractSize);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function commonStep(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.decimalPlaces(), right.decimalPlaces());
  const factor = 10n ** BigInt(scale);
  const a = BigInt(left.mul(factor.toString()).toFixed(0));
  const b = BigInt(right.mul(factor.toString()).toFixed(0));
  const multiple = (a / gcd(a, b)) * b;
  return decimal(multiple.toString()).div(factor.toString());
}

export function normalizeCommonBaseQuantity(input: CommonQuantityInput): string {
  const requested = decimal(input.requestedBaseQuantity);
  const step = commonStep(baseStepFor(input.spot), baseStepFor(input.swap));
  let effective = requested.div(step).floor().mul(step);

  for (const maximum of [input.spot.maxBaseAmount, input.swap.maxBaseAmount]) {
    if (maximum !== undefined) {
      effective = Decimal.min(effective, decimal(maximum).div(step).floor().mul(step));
    }
  }

  if (
    effective.lte(0)
    || effective.lt(input.spot.minBaseAmount)
    || effective.lt(input.swap.minBaseAmount)
  ) {
    throw new Error('normalized quantity is below a market minimum');
  }
  return effective.toFixed();
}
```

- [x] **Step 6: Build and run the domain tests**

Run:

```bash
npm test
```

Expected: 2 tests pass and TypeScript reports no errors.

- [x] **Step 7: Commit the project baseline**

```bash
git add .gitignore package.json package-lock.json tsconfig.json src/domain tests/domain
git commit -m "feat: establish decimal quantity domain"
```

### Task 2: Domain Contracts and Deterministic Exchange Double

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/exchanges/exchange-gateway.ts`
- Create: `tests/support/fake-exchange-gateway.ts`
- Create: `tests/support/order-fixtures.ts`
- Create: `tests/exchanges/exchange-gateway.test.ts`

**Interfaces:**
- Produces: `ExecutionMode`, `StrategyState`, `OrderRole`, `MarketRules`, `AccountSettings`, `OrderRequest`, and `OrderSnapshot`
- Produces: `ExchangeGateway`
- Produces: `FakeExchangeGateway`

- [x] **Step 1: Write a failing base/contracts conversion test**

Create `tests/exchanges/exchange-gateway.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { baseToExchangeAmount, exchangeAmountToBase } from '../../src/exchanges/exchange-gateway.js';

test('converts perpetual contracts to and from base quantity', () => {
  assert.equal(baseToExchangeAmount('0.015', '0.001'), '15');
  assert.equal(exchangeAmountToBase('15', '0.001'), '0.015');
});

test('rejects a base quantity that is not an exact contract count', () => {
  assert.throws(() => baseToExchangeAmount('0.0155', '0.001'), /whole contract/);
});
```

- [x] **Step 2: Run the focused test**

Run:

```bash
npm run build
```

Expected: FAIL because the exchange gateway module does not exist.

- [x] **Step 3: Define the complete domain and gateway contracts**

Create `src/domain/types.ts` with these exact exported contracts:

```ts
export type MarketKind = 'spot' | 'swap';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type ExecutionMode = 'CONCURRENT' | 'CONTRACT_FIRST' | 'SPOT_FIRST';
export type StrategyState =
  | 'PENDING_CONFIRMATION'
  | 'EXECUTING'
  | 'WAITING_HEDGE'
  | 'HEDGED'
  | 'HEDGE_INCOMPLETE'
  | 'FAILED';
export type OrderRole =
  | 'SPOT_MARKET'
  | 'CONTRACT_MARKET'
  | 'SPOT_HEDGE_GTC'
  | 'CONTRACT_HEDGE_GTC';

export interface MarketRules {
  exchangeId: string;
  symbol: string;
  marketId: string;
  kind: MarketKind;
  base: string;
  quote: 'USDT';
  active: boolean;
  amountStep: string;
  contractSize: string;
  minBaseAmount: string;
  maxBaseAmount?: string;
  priceStep: string;
}

export interface AccountSettings {
  marginMode: 'isolated' | 'cross' | 'unknown';
  positionMode: 'one-way' | 'hedged' | 'unknown';
  leverage: string | null;
}

export interface OrderRequest {
  symbol: string;
  kind: MarketKind;
  type: OrderType;
  side: OrderSide;
  baseQuantity: string;
  price?: string;
  timeInForce?: 'GTC';
  clientOrderId: string;
  positionSide?: 'SHORT';
}

export interface OrderSnapshot {
  exchangeId: string;
  exchangeOrderId: string;
  clientOrderId: string;
  symbol: string;
  kind: MarketKind;
  type: OrderType;
  side: OrderSide;
  requestedBaseQuantity: string;
  filledBaseQuantity: string;
  remainingBaseQuantity: string;
  averagePrice: string | null;
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'unknown';
  updatedAt: string;
}
```

Create `src/exchanges/exchange-gateway.ts`:

```ts
import { decimal } from '../domain/decimal.js';
import type {
  AccountSettings,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../domain/types.js';

export interface ExchangeGateway {
  readonly exchangeId: string;
  loadMarket(symbol: string, kind: MarketKind): Promise<MarketRules>;
  quantizePrice(symbol: string, kind: MarketKind, price: string): Promise<string>;
  fetchFreeBalance(asset: 'USDT'): Promise<string>;
  fetchAccountSettings(symbol: string): Promise<AccountSettings>;
  fetchLastPrice(symbol: string, kind: MarketKind): Promise<string>;
  createOrder(request: OrderRequest): Promise<OrderSnapshot>;
  fetchOrder(exchangeOrderId: string, symbol: string, kind: MarketKind): Promise<OrderSnapshot>;
  findOrderByClientId(clientOrderId: string, symbol: string, kind: MarketKind): Promise<OrderSnapshot | null>;
}

export function baseToExchangeAmount(baseQuantity: string, contractSize: string): string {
  const contracts = decimal(baseQuantity).div(contractSize);
  if (!contracts.isInteger()) {
    throw new Error('base quantity does not produce a whole contract count');
  }
  return contracts.toFixed();
}

export function exchangeAmountToBase(amount: string, contractSize: string): string {
  return decimal(amount).mul(contractSize).toFixed();
}
```

- [x] **Step 4: Add the reusable fake gateway**

Create `tests/support/fake-exchange-gateway.ts` as a class implementing every `ExchangeGateway` method. It must expose `markets`, `freeUsdt`, `accountSettings`, `lastPrices`, `createdRequests`, `createResults`, and `fetchResults` collections; `createOrder` shifts one result from `createResults`, and `fetchOrder` shifts one result from the matching `fetchResults` queue. Missing configured values throw descriptive errors so tests never pass accidentally.

Its `quantizePrice` method returns the input price unless a per-market quantized result has been configured by the test.

Use this constructor and public shape:

```ts
export class FakeExchangeGateway implements ExchangeGateway {
  readonly markets = new Map<string, MarketRules>();
  readonly lastPrices = new Map<string, string>();
  readonly createdRequests: OrderRequest[] = [];
  readonly createResults: OrderSnapshot[] = [];
  readonly fetchResults = new Map<string, OrderSnapshot[]>();
  freeUsdt = '100000';
  accountSettings: AccountSettings = {
    marginMode: 'isolated',
    positionMode: 'one-way',
    leverage: '2'
  };

  constructor(readonly exchangeId: string) {}
}
```

Create `tests/support/order-fixtures.ts` so all later tests use a complete snapshot rather than inventing incompatible partial shapes:

```ts
import type { OrderSnapshot } from '../../src/domain/types.js';

export function order(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    exchangeId: 'test-exchange',
    exchangeOrderId: 'order-1',
    clientOrderId: 'client-1',
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'market',
    side: 'buy',
    requestedBaseQuantity: '1',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null,
    status: 'open',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  };
}
```

- [x] **Step 5: Run all tests**

Run:

```bash
npm test
```

Expected: 4 tests pass.

- [x] **Step 6: Commit the contracts**

```bash
git add src/domain/types.ts src/exchanges tests/exchanges tests/support
git commit -m "feat: define normalized exchange contracts"
```

### Task 3: CCXT Gateway, Precision, and Environment Secrets

**Files:**
- Create: `src/config/exchange-credentials.ts`
- Create: `src/domain/client-order-id.ts`
- Create: `src/exchanges/ccxt-exchange-gateway.ts`
- Create: `src/exchanges/exchange-registry.ts`
- Create: `src/exchanges/exchange-profile.ts`
- Create: `src/exchanges/profiles/bitget-profile.ts`
- Create: `src/exchanges/profiles/okx-profile.ts`
- Create: `tests/exchanges/ccxt-gateway.test.ts`

**Interfaces:**
- Consumes: `ExchangeGateway`, `MarketRules`, `OrderRequest`, `OrderSnapshot`
- Produces: `loadExchangeCredentials(exchangeId: string, env?: NodeJS.ProcessEnv): ExchangeCredentials`
- Produces: `CcxtExchangeGateway`
- Produces: `ExchangeRegistry.get(exchangeId: string): ExchangeGateway`
- Produces: `ExchangeProfile` implementations for `bitget` and `okx`
- Produces: `makeClientOrderId(strategyId: string, role: OrderRole): string`

- [x] **Step 1: Write failing adapter tests with an injected CCXT double**

Create tests that verify:

```ts
test('normalizes a linear swap amount into base quantity', async () => {
  const gateway = makeGatewayWithMarket({
    symbol: 'BTC/USDT:USDT',
    base: 'BTC',
    quote: 'USDT',
    settle: 'USDT',
    swap: true,
    linear: true,
    active: true,
    contractSize: 0.001,
    precision: { amount: 1, price: 0.1 },
    limits: { amount: { min: 1, max: 100000 } }
  });
  const rules = await gateway.loadMarket('BTC/USDT', 'swap');
  assert.equal(rules.amountStep, '1');
  assert.equal(rules.contractSize, '0.001');
  assert.equal(rules.minBaseAmount, '0.001');
});

test('creates a hedged-mode short with GTC and a stable client id', async () => {
  await gateway.createOrder({
    symbol: 'BTC/USDT',
    kind: 'swap',
    type: 'limit',
    side: 'sell',
    baseQuantity: '0.01',
    price: '60000',
    timeInForce: 'GTC',
    clientOrderId: 'strategy-1-contract-hedge',
    positionSide: 'SHORT'
  });
  assert.deepEqual(ccxtDouble.lastCreateOrderParams, {
    timeInForce: 'GTC',
    clientOrderId: 'strategy-1-contract-hedge',
    reduceOnly: false,
    positionSide: 'SHORT'
  });
});

test('creates a deterministic OKX-safe client order id', () => {
  const id = makeClientOrderId('strategy-uuid', 'CONTRACT_HEDGE_GTC');
  assert.match(id, /^[a-z0-9]{32}$/);
  assert.equal(id, makeClientOrderId('strategy-uuid', 'CONTRACT_HEDGE_GTC'));
  assert.notEqual(id, makeClientOrderId('strategy-uuid', 'SPOT_HEDGE_GTC'));
});
```

- [x] **Step 2: Run the adapter test and verify failure**

Run:

```bash
npm run build
```

Expected: FAIL because `CcxtExchangeGateway` and its test factory do not exist.

- [x] **Step 3: Implement environment-only credential lookup**

Create `src/config/exchange-credentials.ts`:

```ts
export interface ExchangeCredentials {
  apiKey: string;
  secret: string;
  password?: string;
}

export function loadExchangeCredentials(
  exchangeId: string,
  env: NodeJS.ProcessEnv = process.env
): ExchangeCredentials {
  const prefix = `TRADING_${exchangeId.replaceAll('-', '_').toUpperCase()}`;
  const apiKey = env[`${prefix}_API_KEY`];
  const secret = env[`${prefix}_SECRET`];
  const password = env[`${prefix}_PASSWORD`];
  if (apiKey === undefined || secret === undefined) {
    throw new Error(`missing credentials for configured exchange ${exchangeId}`);
  }
  return password === undefined ? { apiKey, secret } : { apiKey, secret, password };
}
```

- [x] **Step 4: Implement the CCXT gateway**

`CcxtExchangeGateway` must:

1. Accept an injected CCXT `Exchange` in tests and create one from `ccxt[exchangeId]` in production.
2. Set `enableRateLimit: true`.
3. Resolve `BTC/USDT` spot directly and resolve the linear `BTC/USDT:USDT` swap whose base and quote match.
4. Reject inactive, inverse, non-swap, non-USDT-settled, or missing markets.
5. Convert CCXT amount precision into an exchange amount step, then multiply by `contractSize` for base-quantity rules.
6. Convert requested base quantity back to exchange amount before `createOrder`.
7. Use `amountToPrecision` and `priceToPrecision` immediately before submission.
8. Pass `reduceOnly: false`; pass `positionSide: 'SHORT'` only when required by the account snapshot.
9. Normalize `fetchOrder`, `fetchOpenOrders`, and `fetchClosedOrders` results into `OrderSnapshot`.
10. Implement `findOrderByClientId` with Bitget/OKX direct client-ID order lookup without submitting a replacement.

Expose `quantizePrice` by resolving the normalized market and returning `exchange.priceToPrecision(exchangeSymbol, price)`. The coordinator must use this method for every GTC price.

`ExchangeProfile` is the only place allowed to add exchange-specific order parameters. Implement one profile for Bitget and one for OKX using their verified CCXT adapter/API semantics for client order IDs, GTC, and hedged-position direction. The registry accepts only `bitget` and `okx`; any other exchange ID is rejected before a gateway is constructed.

For Bitget spot market buys, the profile must fetch a fresh ticker immediately before submission, use `ask` and fall back to `last`, and pass that price to CCXT so it can convert base quantity to quote cost. Reject the order if neither price is finite and positive. Normalize returned fills back to base quantity; do not treat the conversion price as an actual fill price.

For both Bitget and OKX, `findOrderByClientId` must use the exchange's direct `fetchOrder` client-ID parameter first. It must return `null` only for a verified order-not-found response and must propagate authentication, permission, network, and malformed-response errors. It must never submit a replacement.

The order parameter builder must be a pure function with this exact behavior:

```ts
export function buildCreateOrderParams(request: OrderRequest): Record<string, unknown> {
  const params: Record<string, unknown> = { clientOrderId: request.clientOrderId };
  if (request.timeInForce !== undefined) params.timeInForce = request.timeInForce;
  if (request.kind === 'swap') params.reduceOnly = false;
  if (request.positionSide !== undefined) params.positionSide = request.positionSide;
  return params;
}
```

- [x] **Step 5: Implement configured gateway lookup**

Create `src/exchanges/exchange-registry.ts`:

```ts
import type { ExchangeGateway } from './exchange-gateway.js';

export class ExchangeRegistry {
  constructor(private readonly gateways: ReadonlyMap<string, ExchangeGateway>) {}

  get(exchangeId: string): ExchangeGateway {
    const gateway = this.gateways.get(exchangeId);
    if (gateway === undefined) {
      throw new Error(`exchange is not configured: ${exchangeId}`);
    }
    return gateway;
  }

  ids(): string[] {
    return [...this.gateways.keys()].sort();
  }
}
```

- [x] **Step 6: Run adapter tests**

Run:

```bash
npm test
```

Expected: all tests pass without any network request.

- [x] **Step 7: Commit the CCXT boundary**

```bash
git add src/config src/exchanges tests/exchanges
git commit -m "feat: add ccxt exchange gateway"
```

### Task 4: Preflight and User Confirmation Snapshot

**Files:**
- Create: `src/strategy/preflight-service.ts`
- Create: `tests/strategy/preflight-service.test.ts`

**Interfaces:**
- Consumes: `ExchangeRegistry`, `normalizeCommonBaseQuantity`
- Produces: `PreflightInput`, `PreflightResult`, `PreflightService.run(input)`

- [x] **Step 1: Write failing preflight tests**

Cover the accepted happy path and the critical rejections:

```ts
test('returns normalized quantity and current contract settings', async () => {
  const result = await service.run({
    spotExchangeId: 'spot-x',
    contractExchangeId: 'swap-y',
    symbol: 'BTC/USDT',
    requestedBaseQuantity: '1.001',
    mode: 'CONTRACT_FIRST'
  });
  assert.equal(result.effectiveBaseQuantity, '1');
  assert.deepEqual(result.accountSettings, {
    marginMode: 'isolated',
    positionMode: 'one-way',
    leverage: '2'
  });
  assert.equal(result.riskAcknowledgementRequired, true);
});

test('rejects different base assets or non-USDT quote', async () => {
  await assert.rejects(() => service.run(invalidInput), /same base.*USDT/);
});

test('rejects insufficient estimated spot balance', async () => {
  spot.freeUsdt = '10';
  await assert.rejects(() => service.run(input), /spot USDT balance/);
});
```

- [x] **Step 2: Run the focused tests**

Run:

```bash
npm run build
```

Expected: FAIL because `PreflightService` does not exist.

- [x] **Step 3: Implement the preflight contract and checks**

Use these exact result fields:

```ts
export interface PreflightInput {
  spotExchangeId: string;
  contractExchangeId: string;
  symbol: string;
  requestedBaseQuantity: string;
  mode: ExecutionMode;
}

export interface PreflightResult extends PreflightInput {
  effectiveBaseQuantity: string;
  spotMarket: MarketRules;
  contractMarket: MarketRules;
  accountSettings: AccountSettings;
  spotFreeUsdt: string;
  contractFreeUsdt: string;
  spotReferencePrice: string;
  contractReferencePrice: string;
  riskAcknowledgementRequired: true;
  createdAt: string;
}
```

`PreflightService.run` must load both markets concurrently, assert matching base and `USDT` quote, normalize the common quantity, fetch balances/prices/settings concurrently, and reject when:

- either exchange is not `bitget` or `okx`, or both legs select the same exchange;
- spot free USDT is less than `effectiveBaseQuantity × spotReferencePrice`;
- contract free USDT is less than `effectiveBaseQuantity × contractReferencePrice ÷ leverage` when leverage is known;
- the contract is not an active linear USDT-settled perpetual;
- either market is inactive;
- a mode is not one of the three domain values.

The result is a preview snapshot, not a guarantee that balances remain unchanged.

- [x] **Step 4: Run preflight tests**

Run:

```bash
npm test
```

Expected: all preflight and earlier tests pass.

- [x] **Step 5: Commit preflight behavior**

```bash
git add src/strategy/preflight-service.ts tests/strategy/preflight-service.test.ts
git commit -m "feat: add hedge opening preflight"
```

### Task 5: SQLite Strategy Repository and Idempotent Claims

**Files:**
- Create: `src/storage/schema.ts`
- Create: `src/storage/strategy-repository.ts`
- Create: `src/storage/sqlite-strategy-repository.ts`
- Create: `tests/storage/sqlite-repository.test.ts`

**Interfaces:**
- Consumes: `PreflightResult`, `StrategyState`, `OrderRole`, `OrderSnapshot`
- Produces: `StrategyRecord`, `StrategyOrderRecord`, `StrategyRepository`
- Produces: `SqliteStrategyRepository`

- [x] **Step 1: Write failing persistence tests**

Create tests using `new Database(':memory:')`:

```ts
test('only one confirmation can claim a pending strategy', () => {
  const id = repository.createPending(preflight).id;
  assert.equal(repository.claimForExecution(id), true);
  assert.equal(repository.claimForExecution(id), false);
  assert.equal(repository.getStrategy(id).state, 'EXECUTING');
});

test('enforces one order per strategy role', () => {
  const id = repository.createPending(preflight).id;
  repository.planOrder(id, 'SPOT_MARKET', request);
  assert.throws(() => repository.planOrder(id, 'SPOT_MARKET', request), /UNIQUE/);
});

test('lists executing and waiting strategies for restart recovery', () => {
  assert.deepEqual(repository.listRecoverable().map((row) => row.state).sort(), [
    'EXECUTING',
    'WAITING_HEDGE'
  ]);
});

test('keeps an immutable event for every order snapshot change', () => {
  repository.attachOrderSnapshot(orderRow.id, order({ filledBaseQuantity: '0.4' }));
  repository.attachOrderSnapshot(orderRow.id, order({ filledBaseQuantity: '1', status: 'closed' }));
  assert.equal(repository.listOrderEvents(orderRow.id).length, 2);
});
```

- [x] **Step 2: Run the storage test**

Run:

```bash
npm run build
```

Expected: FAIL because the repository modules do not exist.

- [x] **Step 3: Define the SQLite schema**

Create `src/storage/schema.ts` exporting SQL with:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  mode TEXT NOT NULL,
  spot_exchange_id TEXT NOT NULL,
  contract_exchange_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  requested_base_quantity TEXT NOT NULL,
  effective_base_quantity TEXT NOT NULL,
  preflight_json TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_orders (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  role TEXT NOT NULL,
  exchange_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  exchange_order_id TEXT,
  request_json TEXT NOT NULL,
  snapshot_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(strategy_id, role)
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_order_id TEXT NOT NULL REFERENCES strategy_orders(id),
  snapshot_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
```

- [x] **Step 4: Define the repository interface**

`StrategyRepository` must expose:

```ts
export interface StrategyRepository {
  createPending(preflight: PreflightResult): StrategyRecord;
  getStrategy(id: string): StrategyRecord;
  claimForExecution(id: string): boolean;
  planOrder(strategyId: string, role: OrderRole, request: OrderRequest): StrategyOrderRecord;
  attachOrderSnapshot(strategyOrderId: string, snapshot: OrderSnapshot): void;
  listOrders(strategyId: string): StrategyOrderRecord[];
  listOrderEvents(strategyOrderId: string): OrderSnapshot[];
  transition(strategyId: string, from: StrategyState[], to: StrategyState, error?: string): boolean;
  listRecoverable(): StrategyRecord[];
}
```

Generate IDs with `randomUUID()`. `claimForExecution` must be one SQL update from `PENDING_CONFIRMATION` to `EXECUTING` and return whether exactly one row changed. Every transition must compare its allowed source states in SQL.

- [x] **Step 5: Implement the SQLite repository and transactions**

Use prepared statements for every query. Parse `preflight_json`, `request_json`, and `snapshot_json` only inside the repository. `attachOrderSnapshot` must insert an immutable `order_events` row and update the latest `strategy_orders.snapshot_json` in one transaction. Wrap `planOrder` and state-changing snapshot updates in `database.transaction`. Never persist credentials or gateway objects.

- [x] **Step 6: Run repository tests**

Run:

```bash
npm test
```

Expected: all tests pass; no SQLite file is created because tests use `:memory:`.

- [x] **Step 7: Commit persistence**

```bash
git add src/storage tests/storage
git commit -m "feat: persist hedge strategy state"
```

### Task 6: Three-Mode Hedge Execution Coordinator

**Files:**
- Create: `src/strategy/hedge-coordinator.ts`
- Create: `tests/strategy/hedge-coordinator.test.ts`

**Interfaces:**
- Consumes: `ExchangeRegistry`, `StrategyRepository`, persisted `PreflightResult`
- Produces: `HedgeCoordinator.confirmAndExecute(strategyId: string): Promise<void>`
- Produces: stable client IDs from `makeClientOrderId(strategyId, role)`

- [x] **Step 1: Write failing sequential-mode tests**

Use `FakeExchangeGateway` and an in-memory repository:

```ts
test('contract-first hedges actual market fill with a same-price spot GTC', async () => {
  contract.createResults.push(order({
    filledBaseQuantity: '0.8',
    remainingBaseQuantity: '0',
    averagePrice: '60000',
    status: 'closed'
  }));
  spot.createResults.push(order({
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.8',
    averagePrice: null,
    status: 'open'
  }));

  await coordinator.confirmAndExecute(strategyId);

  assert.deepEqual(spot.createdRequests[0], {
    symbol: 'BTC/USDT',
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    baseQuantity: '0.8',
    price: '60000',
    timeInForce: 'GTC',
    clientOrderId: `${strategyId}:SPOT_HEDGE_GTC`
  });
  assert.equal(repository.getStrategy(strategyId).state, 'WAITING_HEDGE');
});

test('spot-first sends a SHORT GTC for the actual spot fill', async () => {
  await coordinator.confirmAndExecute(strategyId);
  assert.equal(contract.createdRequests[0]?.side, 'sell');
  assert.equal(contract.createdRequests[0]?.positionSide, 'SHORT');
});
```

- [x] **Step 2: Write failing concurrent-mode tests**

Cover equal fills, unequal fills, both zero, and one rejected side:

```ts
test('concurrent mode fills the smaller contract side at the spot average', async () => {
  spot.createResults.push(order({
    filledBaseQuantity: '1',
    averagePrice: '61000',
    status: 'closed'
  }));
  contract.createResults.push(order({
    filledBaseQuantity: '0.6',
    averagePrice: '61010',
    status: 'closed'
  }));
  contract.createResults.push(order({
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.4',
    averagePrice: null,
    status: 'open'
  }));

  await coordinator.confirmAndExecute(strategyId);

  const difference = contract.createdRequests[1];
  assert.equal(difference?.baseQuantity, '0.4');
  assert.equal(difference?.price, '61000');
  assert.equal(difference?.type, 'limit');
  assert.equal(repository.getStrategy(strategyId).state, 'WAITING_HEDGE');
});
```

- [x] **Step 3: Run the coordinator tests and verify failure**

Run:

```bash
npm run build
```

Expected: FAIL because `HedgeCoordinator` does not exist.

- [x] **Step 4: Implement idempotent order submission**

Add a private `submit` method with this sequence:

1. Create the stable 32-character lowercase alphanumeric client order ID with `makeClientOrderId(strategyId, role)`.
2. Call `repository.planOrder` before contacting the exchange.
3. Call `gateway.createOrder`.
4. Persist the returned snapshot.
5. On a timeout or unknown result, call `gateway.findOrderByClientId`.
6. Persist a found order; never submit the same role again.
7. If no order can be found, transition to `FAILED` when nothing filled or `HEDGE_INCOMPLETE` when exposure already exists.

The public method starts with:

```ts
async confirmAndExecute(strategyId: string): Promise<void> {
  if (!this.repository.claimForExecution(strategyId)) return;
  const strategy = this.repository.getStrategy(strategyId);
  switch (strategy.preflight.mode) {
    case 'CONTRACT_FIRST':
      await this.executeSequential(strategy, 'contract');
      return;
    case 'SPOT_FIRST':
      await this.executeSequential(strategy, 'spot');
      return;
    case 'CONCURRENT':
      await this.executeConcurrent(strategy);
      return;
  }
}
```

- [x] **Step 5: Implement sequential execution**

For the first market leg, submit the preflight effective quantity. When its terminal snapshot has zero fill, transition to `FAILED`. When it has a positive fill and average price, quantize the price through the second gateway, submit exactly the filled base quantity as GTC, and transition to:

- `HEDGED` if the returned GTC snapshot is already fully filled;
- `WAITING_HEDGE` if it remains open or partially filled;
- `HEDGE_INCOMPLETE` if it is rejected or canceled.

Do not submit the second leg if no reliable average price exists.

- [x] **Step 6: Implement concurrent execution**

Submit both planned market orders with `Promise.allSettled`, reconcile unknown submissions by client ID, and compare normalized filled base quantities using Decimal.js.

- Equal and positive: transition to `HEDGED`.
- Both zero: transition to `FAILED`.
- Unequal: set the larger fill as the hedge target and submit one GTC difference order on the smaller side.
- Spot is smaller: buy spot at the contract market order’s average price.
- Contract is smaller: sell/open `SHORT` at the spot market order’s average price.
- Missing required average price: transition to `HEDGE_INCOMPLETE`.

- [x] **Step 7: Run coordinator tests**

Run:

```bash
npm test
```

Expected: sequential, concurrent, partial-fill, zero-fill, and idempotency cases pass.

- [x] **Step 8: Commit execution coordination**

```bash
git add src/strategy/hedge-coordinator.ts tests/strategy/hedge-coordinator.test.ts
git commit -m "feat: coordinate three hedge opening modes"
```

### Task 7: GTC Monitoring and Restart Recovery

**Files:**
- Create: `src/strategy/order-monitor.ts`
- Create: `tests/strategy/order-monitor.test.ts`

**Interfaces:**
- Consumes: `ExchangeRegistry`, `StrategyRepository`
- Produces: `OrderMonitor.reconcileStrategy(strategyId: string): Promise<void>`
- Produces: `OrderMonitor.recover(): Promise<void>`
- Produces: `OrderMonitor.start(intervalMs: number): () => void`

- [x] **Step 1: Write failing monitor tests**

```ts
test('keeps waiting after a partial GTC fill', async () => {
  gateway.fetchResults.set('gtc-1', [order({
    exchangeOrderId: 'gtc-1',
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6',
    status: 'open'
  })]);
  await monitor.reconcileStrategy(strategyId);
  assert.equal(repository.getStrategy(strategyId).state, 'WAITING_HEDGE');
});

test('marks the strategy hedged when cumulative quantities match', async () => {
  gateway.fetchResults.set('gtc-1', [order({
    exchangeOrderId: 'gtc-1',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    status: 'closed'
  })]);
  await monitor.reconcileStrategy(strategyId);
  assert.equal(repository.getStrategy(strategyId).state, 'HEDGED');
});

test('retains exposure and marks an externally canceled GTC incomplete', async () => {
  gateway.fetchResults.set('gtc-1', [order({
    exchangeOrderId: 'gtc-1',
    status: 'canceled'
  })]);
  await monitor.reconcileStrategy(strategyId);
  assert.equal(repository.getStrategy(strategyId).state, 'HEDGE_INCOMPLETE');
});
```

- [x] **Step 2: Run the focused test**

Run:

```bash
npm run build
```

Expected: FAIL because `OrderMonitor` does not exist.

- [x] **Step 3: Implement reconciliation**

`reconcileStrategy` must:

1. Load all persisted orders.
2. Fetch every open or unknown exchange order by ID.
3. Persist each new snapshot.
4. Sum this strategy’s spot buy fills and contract short fills with Decimal.js.
5. Transition to `HEDGED` only when both are positive and equal.
6. Keep `WAITING_HEDGE` while the GTC is open, including partial fills.
7. Transition to `HEDGE_INCOMPLETE` when the GTC is canceled or rejected.
8. On a transient fetch error, preserve state and return without an order mutation.

- [x] **Step 4: Implement recovery and scheduling**

`recover()` calls `listRecoverable()` and reconciles each strategy independently so one exchange failure does not prevent recovery of another strategy.

`start(intervalMs)` uses `setInterval`, prevents overlapping polling cycles with an internal boolean, starts one immediate recovery pass, and returns a stop function that clears the interval. It does not create any local GTC expiry.

- [x] **Step 5: Run monitor tests**

Run:

```bash
npm test
```

Expected: partial, complete, canceled, transient-error, and restart-recovery tests pass.

- [x] **Step 6: Commit monitoring**

```bash
git add src/strategy/order-monitor.ts tests/strategy/order-monitor.test.ts
git commit -m "feat: recover and monitor open hedge orders"
```

### Task 8: Fastify API and Explicit Operator Interface

**Files:**
- Create: `src/http/server.ts`
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `tests/http/server.test.ts`

**Interfaces:**
- Consumes: `ExchangeRegistry`, `PreflightService`, `StrategyRepository`, `HedgeCoordinator`
- Produces: `buildServer(dependencies): FastifyInstance`
- Produces: `GET /api/exchanges`
- Produces: `POST /api/hedges/preflight`
- Produces: `POST /api/hedges/:id/confirm`
- Produces: `GET /api/hedges/:id`

- [x] **Step 1: Write failing API tests with Fastify injection**

```ts
test('preflight persists a pending strategy and returns the preview', async () => {
  const response = await server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    payload: {
      spotExchangeId: 'spot-x',
      contractExchangeId: 'swap-y',
      symbol: 'BTC/USDT',
      requestedBaseQuantity: '1',
      mode: 'CONTRACT_FIRST'
    }
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().state, 'PENDING_CONFIRMATION');
  assert.equal(response.json().preflight.riskAcknowledgementRequired, true);
});

test('two confirmations create only one execution claim', async () => {
  const responses = await Promise.all([
    server.inject({ method: 'POST', url: `/api/hedges/${id}/confirm` }),
    server.inject({ method: 'POST', url: `/api/hedges/${id}/confirm` })
  ]);
  assert.deepEqual(responses.map((value) => value.statusCode).sort(), [202, 202]);
  assert.equal(executionCount, 1);
});
```

- [x] **Step 2: Run the HTTP tests**

Run:

```bash
npm run build
```

Expected: FAIL because `buildServer` does not exist.

- [x] **Step 3: Implement the API**

`POST /api/hedges/preflight` validates all five required fields, calls `PreflightService.run`, persists the result with `createPending`, and returns the ID, `PENDING_CONFIRMATION`, and preview.

`POST /api/hedges/:id/confirm` returns `202` and queues `confirmAndExecute` with `setImmediate`. The coordinator’s SQL claim supplies idempotency.

`GET /api/hedges/:id` returns the strategy, preview, persisted orders, actual spot fill total, actual contract short fill total, and unmatched base quantity.

Configure Fastify logging with redaction:

```ts
const app = Fastify({
  logger: {
    redact: [
      'req.headers.authorization',
      'req.body.apiKey',
      'req.body.secret',
      'req.body.password'
    ]
  }
});
```

Serve `public/` with `@fastify/static`.

- [x] **Step 4: Build the explicit mode-selection page**

`public/index.html` must contain:

```html
<label for="mode">执行模式</label>
<select id="mode" name="mode" required>
  <option value="" selected disabled>请选择执行模式</option>
  <option value="CONCURRENT">并发：两边同时市价下单</option>
  <option value="CONTRACT_FIRST">合约优先：合约市价后挂现货 GTC</option>
  <option value="SPOT_FIRST">现货优先：现货市价后挂合约 GTC</option>
</select>
```

The form must also select both exchanges, accept symbol and base quantity, and have separate “预检” and “确认开仓” buttons. The confirmation button remains disabled until preflight succeeds and the operator checks:

```html
<label>
  <input id="risk-ack" type="checkbox">
  我理解顺序模式和差额补单可能长期产生单边敞口
</label>
```

`public/app.js` must render input quantity, effective quantity, both reference prices, balances, margin mode, position mode, leverage, strategy state, both order IDs, actual fills, and unmatched quantity. Any input edit invalidates the previous preview and disables confirmation.

- [x] **Step 5: Test the page contract**

Add an HTTP test that fetches `/`, asserts the three exact execution mode values, asserts there is no preselected valid mode, and asserts the risk acknowledgement text is present.

- [x] **Step 6: Run API and page tests**

Run:

```bash
npm test
```

Expected: API validation, duplicate confirmation, status response, explicit mode selection, and risk acknowledgement tests pass.

- [x] **Step 7: Commit the operator surface**

```bash
git add src/http public tests/http
git commit -m "feat: expose hedge opening operator flow"
```

### Task 9: Composition Root, Acceptance Test, and Operations Guide

**Files:**
- Create: `src/main.ts`
- Create: `tests/acceptance/hedge-opening.test.ts`
- Create: `README.md`
- Modify: `docs/manual/feature_list.md`

**Interfaces:**
- Consumes: all completed components
- Produces: runnable single-process service
- Produces: simulated end-to-end acceptance coverage

- [ ] **Step 1: Write the failing end-to-end acceptance test**

The test must compose real preflight, SQLite repository, coordinator, monitor, and Fastify server with two fake gateways, then prove:

```ts
test('operator confirms contract-first and restart recovery reaches HEDGED', async () => {
  const preview = await apiPreflight({
    spotExchangeId: 'spot-x',
    contractExchangeId: 'swap-y',
    symbol: 'BTC/USDT',
    requestedBaseQuantity: '1',
    mode: 'CONTRACT_FIRST'
  });
  await apiConfirm(preview.id);
  await waitForState(preview.id, 'WAITING_HEDGE');

  spot.fetchResults.set('spot-gtc-1', [
    order({ filledBaseQuantity: '0.4', remainingBaseQuantity: '0.6', status: 'open' }),
    order({ filledBaseQuantity: '1', remainingBaseQuantity: '0', status: 'closed' })
  ]);

  const restartedMonitor = composeMonitorUsingSameDatabase();
  await restartedMonitor.recover();
  assert.equal(repository.getStrategy(preview.id).state, 'WAITING_HEDGE');
  await restartedMonitor.recover();
  assert.equal(repository.getStrategy(preview.id).state, 'HEDGED');
});
```

- [ ] **Step 2: Run the acceptance test**

Run:

```bash
npm run build
```

Expected: FAIL because the production composition root does not exist.

- [ ] **Step 3: Implement the production composition root**

`src/main.ts` must:

1. Read `TRADING_EXCHANGES` as a comma-separated allowlist.
2. Load each exchange’s credentials from environment variables.
3. Construct one configured CCXT gateway per exchange.
4. Open `TRADING_DATABASE_PATH`, defaulting to `./data/trade-ops.sqlite`.
5. Construct repository, registry, preflight service, coordinator, monitor, and Fastify server.
6. Call `monitor.start(5000)` before listening.
7. Listen on `HOST`, default `127.0.0.1`, and `PORT`, default `3000`.
8. On `SIGINT` or `SIGTERM`, stop monitoring, close Fastify, close SQLite, and exit after resources close.

The startup path must fail before listening when the exchange allowlist is empty, credentials are missing, or the database cannot be opened.

- [ ] **Step 4: Write the operations and risk guide**

Create `README.md` with:

- Node.js 24 installation requirement.
- `npm install`, `npm test`, `npm run build`, and `npm start` commands.
- `TRADING_EXCHANGES`, per-exchange credential variable naming, `TRADING_DATABASE_PATH`, `HOST`, and `PORT`.
- A warning that API keys require read/trade permission and must have withdrawal disabled.
- The exact behavior of concurrent, contract-first, and spot-first modes.
- The fact that GTC orders can remain open indefinitely and are not repriced, retried, rolled back, or closed automatically.
- Recovery steps for `HEDGE_INCOMPLETE`: inspect both exchange order IDs and positions, then resolve manually outside this release.
- A statement that tests use fakes or exchange sandboxes and never real funds.

- [ ] **Step 5: Run all verification**

Run:

```bash
npm test
npm run build
```

Expected: every unit, coordinator, persistence, API, monitor, and acceptance test passes; the strict TypeScript build exits successfully.

- [ ] **Step 6: Verify the documented feature boundary**

After all tests pass, change the opening checkbox in `docs/manual/feature_list.md` from:

```markdown
    - [ ] 开空合约，同时买现货（本期：策略设计完成，待实现）
```

to:

```markdown
    - [x] 开空合约，同时买现货（已实现）
```

Do not change the unchecked closing item.

Run:

```bash
rg -n "开空合约，同时买现货|卖出现货，同时平掉合约空单" docs/manual/feature_list.md README.md
```

Expected: opening is marked as the current implementation and closing remains explicitly marked as a later feature.

- [ ] **Step 7: Commit the runnable service**

```bash
git add src/main.ts tests/acceptance README.md docs/manual/feature_list.md
git commit -m "feat: deliver cross-exchange hedge opening"
```

## Final Verification Gate

- [ ] Run `npm test` and confirm every test passes.
- [ ] Run `npm run build` and confirm strict TypeScript compilation succeeds.
- [ ] Inspect `git status --short` and confirm no generated `dist/`, SQLite database, credential file, or unrelated file is staged.
- [ ] Confirm logs and SQLite rows contain no API key, secret, password, or request signature.
- [ ] Confirm every strategy order role is unique and duplicate confirmation cannot create a second order.
- [ ] Confirm all three UI execution modes map to the matching coordinator branch.
- [ ] Confirm no path automatically cancels, reprices, resubmits, rolls back, or closes a GTC hedge.
- [ ] Confirm `HEDGED` requires equal, positive base fills produced by this strategy’s orders.
