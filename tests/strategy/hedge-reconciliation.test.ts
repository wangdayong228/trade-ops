/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  AccountSettings,
  ExecutionMode,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import type {
  TradeEvent,
  TradeEventSink
} from '../../src/logging/trade-events.js';
import type {
  OperationalFields,
  OperationalLog
} from '../../src/logging/logger.js';
import { HedgeReconciliation } from '../../src/strategy/hedge-reconciliation.js';
import {
  HedgeOrderEvidenceCollector,
  inspectLocalTopology
} from '../../src/strategy/hedge-reconciliation-evidence.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  OrderSnapshotWriteConflictError,
  type StrategyRepository,
  type StrategyOrderRecord
} from '../../src/storage/strategy-repository.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';
const OBSERVED_AT = '2026-09-05T00:01:00.000Z';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      assert.ok(resolvePromise);
      resolvePromise();
    }
  };
}

class ReconciliationGateway extends FakeExchangeGateway {
  readonly fetchCalls: string[] = [];
  readonly findCalls: string[] = [];
  readonly marketCalls: Array<{
    readonly symbol: string;
    readonly kind: MarketKind;
  }> = [];
  readonly quantizeCalls: Array<{
    readonly symbol: string;
    readonly kind: MarketKind;
    readonly price: string;
  }> = [];
  readonly lastPriceCalls: Array<{
    readonly symbol: string;
    readonly kind: MarketKind;
  }> = [];
  readonly accountSettingsCalls: string[] = [];
  readonly scriptedFetch = new Map<
    string,
    Array<OrderSnapshot | Error>
  >();
  readonly scriptedFind = new Map<
    string,
    Array<OrderSnapshot | null | Error>
  >();
  readonly findGates = new Map<string, Promise<void>>();

  override async loadMarket(
    symbol: string,
    kind: MarketKind
  ): Promise<MarketRules> {
    this.marketCalls.push({ symbol, kind });
    return super.loadMarket(symbol, kind);
  }

  override async quantizePrice(
    symbol: string,
    kind: MarketKind,
    price: string
  ): Promise<string> {
    this.quantizeCalls.push({ symbol, kind, price });
    return super.quantizePrice(symbol, kind, price);
  }

  override async fetchLastPrice(
    symbol: string,
    kind: MarketKind
  ): Promise<string> {
    this.lastPriceCalls.push({ symbol, kind });
    return super.fetchLastPrice(symbol, kind);
  }

  override async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    this.fetchCalls.push(exchangeOrderId);
    const value = this.scriptedFetch.get(exchangeOrderId)?.shift();
    if (value instanceof Error) throw value;
    if (value !== undefined) return value;
    return super.fetchOrder(exchangeOrderId, symbol, kind);
  }

  override async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    this.findCalls.push(clientOrderId);
    await this.findGates.get(clientOrderId);
    const value = this.scriptedFind.get(clientOrderId)?.shift();
    if (value instanceof Error) throw value;
    if (value !== undefined) return value;
    return super.findOrderByClientId(clientOrderId, symbol, kind);
  }

  override async fetchAccountSettings(symbol: string): Promise<AccountSettings> {
    this.accountSettingsCalls.push(symbol);
    return super.fetchAccountSettings(symbol);
  }
}

function reconciliationPreflight(
  mode: ExecutionMode,
  effectiveBaseQuantity = '1'
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: effectiveBaseQuantity,
    effectiveBaseQuantity,
    mode,
    spotMarket: {
      exchangeId: 'bitget',
      symbol: SYMBOL,
      marketId: 'BTCUSDT',
      kind: 'spot',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '0.001',
      contractSize: '1',
      minBaseAmount: '0.001',
      minQuoteNotional: '0',
      priceStep: '0.1'
    },
    contractMarket: {
      exchangeId: 'okx',
      symbol: SYMBOL,
      marketId: 'BTC-USDT-SWAP',
      kind: 'swap',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '1',
      contractSize: '0.001',
      minBaseAmount: '0.001',
      minQuoteNotional: '0',
      priceStep: '0.1'
    },
    accountSettings: {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-09-05T00:00:00.000Z'
  };
}

function requestForRole(
  strategyId: string,
  role: OrderRole,
  baseQuantity = '1'
): OrderRequest {
  const clientOrderId = makeClientOrderId(strategyId, role);
  switch (role) {
    case 'SPOT_MARKET':
      return {
        symbol: SYMBOL,
        kind: 'spot',
        type: 'market',
        side: 'buy',
        baseQuantity,
        clientOrderId
      };
    case 'CONTRACT_MARKET':
      return {
        symbol: SYMBOL,
        kind: 'swap',
        type: 'market',
        side: 'sell',
        baseQuantity,
        clientOrderId,
        positionSide: 'SHORT',
        marginMode: 'cross'
      };
    case 'SPOT_HEDGE_GTC':
      return {
        symbol: SYMBOL,
        kind: 'spot',
        type: 'limit',
        side: 'buy',
        baseQuantity,
        price: '60000',
        timeInForce: 'GTC',
        clientOrderId
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        symbol: SYMBOL,
        kind: 'swap',
        type: 'limit',
        side: 'sell',
        baseQuantity,
        price: '60000',
        timeInForce: 'GTC',
        clientOrderId,
        positionSide: 'SHORT',
        marginMode: 'cross'
      };
  }
}

function snapshotForOrder(
  order: Readonly<StrategyOrderRecord>,
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  return {
    exchangeId: order.exchangeId,
    exchangeOrderId: `${order.role.toLowerCase()}-remote`,
    clientOrderId: order.clientOrderId,
    symbol: order.request.symbol,
    kind: order.request.kind,
    type: order.request.type,
    side: order.request.side,
    requestedBaseQuantity: order.request.baseQuantity,
    filledBaseQuantity: order.request.baseQuantity,
    remainingBaseQuantity: '0',
    averagePrice: '60000',
    status: 'closed',
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

interface ReconciliationFixture {
  readonly repository: SqliteStrategyRepository;
  readonly registry: ExchangeRegistry;
  readonly collector: HedgeOrderEvidenceCollector;
  readonly spot: ReconciliationGateway;
  readonly contract: ReconciliationGateway;
  readonly strategyId: string;
  readonly tradeEvents: TradeEvent[];
  readonly tradeEventSink: TradeEventSink;
}

function fixture(
  t: TestContext,
  mode: ExecutionMode,
  effectiveBaseQuantity = '1',
  claimForExecution = true
): ReconciliationFixture {
  const database = new Database(':memory:');
  t.after(() => database.close());
  let clockTick = 0;
  const repository = new SqliteStrategyRepository(
    database,
    () => new Date(
      Date.parse('2026-09-05T00:00:00.000Z') + clockTick++ * 1000
    )
  );
  const preview = reconciliationPreflight(mode, effectiveBaseQuantity);
  const strategyId = repository.createPending(preview).id;
  if (claimForExecution) {
    assert.equal(repository.claimForExecution(strategyId), true);
  }
  const spot = new ReconciliationGateway('bitget');
  const contract = new ReconciliationGateway('okx');
  spot.markets.set(`spot:${SYMBOL}`, preview.spotMarket);
  contract.markets.set(`swap:${SYMBOL}`, preview.contractMarket);
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const tradeEvents: TradeEvent[] = [];
  const tradeEventSink: TradeEventSink = {
    record: (event) => {
      tradeEvents.push(structuredClone(event));
    }
  };
  const collector = new HedgeOrderEvidenceCollector(
    registry,
    repository,
    tradeEventSink
  );
  return {
    repository,
    registry,
    collector,
    spot,
    contract,
    strategyId,
    tradeEvents,
    tradeEventSink
  };
}

function planOrder(
  f: ReconciliationFixture,
  role: OrderRole,
  baseQuantity = '1'
): StrategyOrderRecord {
  return f.repository.planOrder(
    f.strategyId,
    role,
    requestForRole(f.strategyId, role, baseQuantity)
  );
}

function gatewayFor(
  f: ReconciliationFixture,
  order: Readonly<StrategyOrderRecord>
): ReconciliationGateway {
  return order.exchangeId === 'bitget' ? f.spot : f.contract;
}

function scriptFind(
  f: ReconciliationFixture,
  order: Readonly<StrategyOrderRecord>,
  result: OrderSnapshot | null | Error
): void {
  gatewayFor(f, order).scriptedFind.set(order.clientOrderId, [result]);
}

function assertNoGatewayCalls(f: ReconciliationFixture): void {
  assert.deepEqual({
    fetch: f.spot.fetchCalls.length + f.contract.fetchCalls.length,
    find: f.spot.findCalls.length + f.contract.findCalls.length,
    create:
      f.spot.createdRequests.length + f.contract.createdRequests.length,
    balance:
      f.spot.balanceRequests.length + f.contract.balanceRequests.length,
    accountSettings:
      f.spot.accountSettingsCalls.length + f.contract.accountSettingsCalls.length,
    market: f.spot.marketCalls.length + f.contract.marketCalls.length,
    quantize: f.spot.quantizeCalls.length + f.contract.quantizeCalls.length,
    lastPrice: f.spot.lastPriceCalls.length + f.contract.lastPriceCalls.length
  }, {
    fetch: 0,
    find: 0,
    create: 0,
    balance: 0,
    accountSettings: 0,
    market: 0,
    quantize: 0,
    lastPrice: 0
  });
}

function assertNoTradingSideEffects(f: ReconciliationFixture): void {
  assert.deepEqual({
    create: f.spot.createdRequests.length + f.contract.createdRequests.length,
    balance: f.spot.balanceRequests.length + f.contract.balanceRequests.length,
    accountSettings:
      f.spot.accountSettingsCalls.length + f.contract.accountSettingsCalls.length
  }, { create: 0, balance: 0, accountSettings: 0 });
}

interface DecisionFixture extends ReconciliationFixture {
  readonly reconciliation: HedgeReconciliation;
}

function decisionFixture(
  t: TestContext,
  mode: ExecutionMode,
  operationalLog?: OperationalLog,
  effectiveBaseQuantity = '1',
  claimForExecution = true
): DecisionFixture {
  const f = fixture(t, mode, effectiveBaseQuantity, claimForExecution);
  return {
    ...f,
    reconciliation: new HedgeReconciliation(
      f.registry,
      f.repository,
      f.tradeEventSink,
      operationalLog
    )
  };
}

function marketRoles(mode: ExecutionMode): readonly OrderRole[] {
  if (mode === 'CONTRACT_FIRST') return ['CONTRACT_MARKET'];
  if (mode === 'SPOT_FIRST') return ['SPOT_MARKET'];
  return ['SPOT_MARKET', 'CONTRACT_MARKET'];
}

function fixtureRemaining(filled: string): string {
  switch (filled) {
    case '0': return '1';
    case '0.6': return '0.4';
    case '1': return '0';
    default: throw new Error(`missing explicit fixture remaining for ${filled}`);
  }
}

interface ClosedConcurrentSeed {
  readonly requested: string;
  readonly spotFill: string;
  readonly spotRemaining: string;
  readonly spotAverage: string | null;
  readonly contractFill: string;
  readonly contractRemaining: string;
  readonly contractAverage: string | null;
}

function seedClosedConcurrentMarkets(
  f: DecisionFixture,
  seed: ClosedConcurrentSeed
): readonly [StrategyOrderRecord, StrategyOrderRecord] {
  const spotOrder = planOrder(f, 'SPOT_MARKET', seed.requested);
  const contractOrder = planOrder(f, 'CONTRACT_MARKET', seed.requested);
  scriptFind(f, spotOrder, snapshotForOrder(spotOrder, {
    filledBaseQuantity: seed.spotFill,
    remainingBaseQuantity: seed.spotRemaining,
    averagePrice: seed.spotAverage,
    status: 'closed'
  }));
  scriptFind(f, contractOrder, snapshotForOrder(contractOrder, {
    filledBaseQuantity: seed.contractFill,
    remainingBaseQuantity: seed.contractRemaining,
    averagePrice: seed.contractAverage,
    status: 'closed'
  }));
  return [spotOrder, contractOrder];
}

function canonicalScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  const whole = magnitude.slice(0, -scale);
  const fraction = magnitude.slice(-scale).replace(/0+$/, '');
  const unsigned = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${unsigned}` : unsigned;
}

const INVALID_TOPOLOGIES = [
  ['GTC only', 'CONCURRENT', 'EXECUTING', ['CONTRACT_HEDGE_GTC']],
  ['wrong sequential market', 'CONTRACT_FIRST', 'EXECUTING', ['SPOT_MARKET']],
  ['one concurrent market', 'CONCURRENT', 'EXECUTING', ['SPOT_MARKET']],
  ['two GTC orders', 'CONCURRENT', 'EXECUTING', [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'SPOT_HEDGE_GTC',
    'CONTRACT_HEDGE_GTC'
  ]],
  ['GTC planned before its market', 'CONTRACT_FIRST', 'EXECUTING', [
    'SPOT_HEDGE_GTC',
    'CONTRACT_MARKET'
  ]],
  ['empty waiting strategy', 'CONTRACT_FIRST', 'WAITING_HEDGE', []],
  ['waiting strategy without GTC', 'CONCURRENT', 'WAITING_HEDGE', [
    'SPOT_MARKET',
    'CONTRACT_MARKET'
  ]]
] as const satisfies readonly (readonly [
  string,
  ExecutionMode,
  'EXECUTING' | 'WAITING_HEDGE',
  readonly OrderRole[]
])[];

for (const [name, mode, state, roles] of INVALID_TOPOLOGIES) {
  test(`rejects invalid local topology: ${name}`, (t) => {
    const f = fixture(t, mode);
    for (const role of roles) planOrder(f, role);
    if (state === 'WAITING_HEDGE') {
      assert.equal(f.repository.transition(
        f.strategyId,
        ['EXECUTING'],
        'WAITING_HEDGE'
      ), true);
    }

    const result = inspectLocalTopology(
      f.repository.getStrategy(f.strategyId),
      f.repository.listOrders(f.strategyId)
    );

    assert.equal(result.kind, 'pending');
    if (result.kind === 'pending') {
      assert.equal(result.reason, 'INVALID_LOCAL_TOPOLOGY');
      assert.equal(result.exposureKnown, false);
    }
    assertNoGatewayCalls(f);
  });
}

for (const [mode, roles] of [
  ['CONTRACT_FIRST', ['CONTRACT_MARKET']],
  ['CONTRACT_FIRST', ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC']],
  ['SPOT_FIRST', ['SPOT_MARKET']],
  ['SPOT_FIRST', ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC']],
  ['CONCURRENT', ['SPOT_MARKET', 'CONTRACT_MARKET']],
  ['CONCURRENT', [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'CONTRACT_HEDGE_GTC'
  ]],
  ['CONCURRENT', [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'SPOT_HEDGE_GTC'
  ]]
] as const satisfies readonly (
  readonly [ExecutionMode, readonly OrderRole[]]
)[]) {
  test(`accepts valid local topology: ${mode}/${roles.join('+')}`, (t) => {
    const f = fixture(t, mode);
    const planned = roles.map((role) => planOrder(f, role));

    const result = inspectLocalTopology(
      f.repository.getStrategy(f.strategyId),
      f.repository.listOrders(f.strategyId)
    );

    assert.equal(result.kind, 'valid');
    if (result.kind === 'valid') {
      assert.deepEqual(
        result.orders.map((order: StrategyOrderRecord) => order.id),
        planned.map(({ id }) => id)
      );
    }
    assertNoGatewayCalls(f);
  });
}

test('classifies only an empty executing strategy as empty topology', (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  assert.deepEqual(inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    []
  ), { kind: 'empty' });
  assertNoGatewayCalls(f);
});

test('rejects a market intent whose quantity differs from the strategy target', (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  planOrder(f, 'CONTRACT_MARKET', '0.5');

  const result = inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.deepEqual(result, {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    exposureKnown: false
  });
  assertNoGatewayCalls(f);
});

test('accepts numerically equal market quantities with different decimal scale', (t) => {
  const f = fixture(t, 'CONTRACT_FIRST', '1.000');
  const planned = planOrder(f, 'CONTRACT_MARKET', '1.0');

  const result = inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'valid');
  if (result.kind === 'valid') {
    assert.deepEqual(
      result.orders.map((order: StrategyOrderRecord) => order.id),
      [planned.id]
    );
  }
  assertNoGatewayCalls(f);
});

test('reports known local exposure while rejecting an invalid topology', (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spot = planOrder(f, 'SPOT_MARKET');
  assert.equal(f.repository.attachOrderSnapshot(
    spot.id,
    snapshotForOrder(spot, {
      status: 'open',
      filledBaseQuantity: '0.2',
      remainingBaseQuantity: '0.8',
      averagePrice: '60000'
    })
  ), 'attached');

  assert.deepEqual(inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  ), {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    exposureKnown: true
  });
  assertNoGatewayCalls(f);
});

test('persists successful observations before returning a partial lookup failure', async (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spotOrder = planOrder(f, 'SPOT_MARKET');
  const contractOrder = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, spotOrder, snapshotForOrder(spotOrder));
  scriptFind(f, contractOrder, new Error('private detail'));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_LOOKUP_FAILED');
  assert.equal(result.strategyOrderId, contractOrder.id);
  assert.equal(result.exposureKnown, true);
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'closed');
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.spot.createdRequests.length, 0);
  assert.equal(f.contract.createdRequests.length, 0);
});

test('awaits market submission for an empty executing strategy', async (t) => {
  const f = decisionFixture(t, 'CONTRACT_FIRST');

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'awaiting_market_submission'
  });
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assertNoGatewayCalls(f);
});

const NO_GTC_CASES = [
  {
    name: 'sequential rejected zero fill',
    mode: 'CONTRACT_FIRST',
    fills: ['0'],
    statuses: ['rejected'],
    expected: ['FAILED', 'ORDER_SUBMISSION_FAILED']
  },
  {
    name: 'sequential closed zero fill',
    mode: 'CONTRACT_FIRST',
    fills: ['0'],
    statuses: ['closed'],
    expected: ['FAILED', 'NO_FILL']
  },
  {
    name: 'concurrent equal fills',
    mode: 'CONCURRENT',
    fills: ['1', '1'],
    statuses: ['closed', 'closed'],
    expected: ['HEDGED', null]
  },
  {
    name: 'concurrent rejected opposite positive fill',
    mode: 'CONCURRENT',
    fills: ['1', '0'],
    statuses: ['closed', 'rejected'],
    expected: ['HEDGE_INCOMPLETE', 'INCONSISTENT_ORDER_STATE']
  },
  {
    name: 'concurrent rejected zero fills',
    mode: 'CONCURRENT',
    fills: ['0', '0'],
    statuses: ['rejected', 'closed'],
    expected: ['FAILED', 'ORDER_SUBMISSION_FAILED']
  },
  {
    name: 'concurrent ordinary zero fills',
    mode: 'CONCURRENT',
    fills: ['0', '0'],
    statuses: ['canceled', 'closed'],
    expected: ['FAILED', 'NO_FILL']
  }
] as const;

for (const testCase of NO_GTC_CASES) {
  test(testCase.name, async (t) => {
    const f = decisionFixture(t, testCase.mode);
    const roles = marketRoles(testCase.mode);
    for (const [index, role] of roles.entries()) {
      const order = planOrder(f, role);
      const filled = testCase.fills[index];
      const status = testCase.statuses[index];
      assert.ok(filled);
      assert.ok(status);
      scriptFind(f, order, snapshotForOrder(order, {
        filledBaseQuantity: filled,
        remainingBaseQuantity: fixtureRemaining(filled),
        averagePrice: filled === '0' ? null : '60000',
        status
      }));
    }

    const [expectedState, expectedFailureCode] = testCase.expected;
    const result = await f.reconciliation.run(f.strategyId);

    assert.deepEqual(result, expectedFailureCode === null
      ? { kind: 'written', state: expectedState }
      : {
          kind: 'written',
          state: expectedState,
          failureCode: expectedFailureCode
        });
    const persisted = f.repository.getStrategy(f.strategyId);
    assert.equal(persisted.state, expectedState);
    assert.equal(persisted.failureCode, expectedFailureCode);
    assertNoTradingSideEffects(f);
  });
}

test('authorizes exactly 0.4 contract GTC after reconciling spot 1 and contract 0.6', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'need_gtc',
    role: 'CONTRACT_HEDGE_GTC',
    baseQuantity: '0.4',
    referencePrice: '60000'
  });
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assertNoTradingSideEffects(f);
});

for (const status of ['open', 'unknown'] as const) {
  test(`keeps an active ${status} market order pending`, async (t) => {
    const f = decisionFixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, snapshotForOrder(order, {
      status,
      filledBaseQuantity: '0.2',
      remainingBaseQuantity: '0.8',
      averagePrice: '60010'
    }));

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'MARKET_ORDER_ACTIVE');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assertNoTradingSideEffects(f);
  });
}

test('short-circuits a terminal strategy without touching orders or gateways', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  assert.equal(f.repository.transition(
    f.strategyId,
    ['EXECUTING'],
    'HEDGED'
  ), true);

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'observed_state',
    state: 'HEDGED'
  });
  assertNoGatewayCalls(f);
  assert.deepEqual(f.repository.listOrders(f.strategyId), []);
});

test('rejects a non-terminal state outside the run contract', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT', undefined, '1', false);

  await assert.rejects(
    f.reconciliation.run(f.strategyId),
    /^Error: hedge reconciliation requires an executing or waiting strategy$/
  );
  assertNoGatewayCalls(f);
  assert.equal(
    f.repository.getStrategy(f.strategyId).state,
    'PENDING_CONFIRMATION'
  );
});

for (const [mode, marketRole, hedgeRole, referencePrice] of [
  ['CONTRACT_FIRST', 'CONTRACT_MARKET', 'SPOT_HEDGE_GTC', '60010'],
  ['SPOT_FIRST', 'SPOT_MARKET', 'CONTRACT_HEDGE_GTC', '60000']
] as const) {
  test(`authorizes the opposite GTC after ${mode} first-leg fill`, async (t) => {
    const f = decisionFixture(t, mode);
    const order = planOrder(f, marketRole);
    scriptFind(f, order, snapshotForOrder(order, {
      status: 'closed',
      filledBaseQuantity: '1',
      remainingBaseQuantity: '0',
      averagePrice: referencePrice
    }));

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'need_gtc',
      role: hedgeRole,
      baseQuantity: '1',
      referencePrice
    });
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assertNoTradingSideEffects(f);
  });
}

test('writes missing average only after a positive reconciled residual', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: null,
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'written',
    state: 'HEDGE_INCOMPLETE',
    failureCode: 'MISSING_AVERAGE_PRICE'
  });
  assertNoTradingSideEffects(f);
});

for (const failureCode of [
  'ORDER_SUBMISSION_FAILED',
  'HEDGE_RESIDUAL_NOT_TRADABLE'
] as const) {
  test(`prioritizes definite market failure ${failureCode}`, async (t) => {
    const f = decisionFixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    assert.equal(
      f.repository.markDefinitelyNotSubmitted(order.id, failureCode),
      true
    );
    scriptFind(f, order, null);

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'FAILED',
      failureCode
    });
    assert.equal(
      f.repository.getStrategy(f.strategyId).failureCode,
      failureCode
    );
    assertNoTradingSideEffects(f);
  });
}

test('keeps a residual that differs only after forty decimal places', async (t) => {
  const scale = 50;
  const one = 10n ** BigInt(scale);
  const spotScaled = one + 1n;
  const contractScaled = one;
  const requested = canonicalScaled(spotScaled, scale);
  const expectedResidual = canonicalScaled(spotScaled - contractScaled, scale);
  const originalPrecision = Decimal.precision;
  Decimal.set({ precision: 5 });
  t.after(() => Decimal.set({ precision: originalPrecision }));
  const f = decisionFixture(t, 'CONCURRENT', undefined, requested);
  const market = f.contract.markets.get(`swap:${SYMBOL}`);
  assert.ok(market);
  f.contract.markets.set(`swap:${SYMBOL}`, {
    ...market,
    amountStep: '1',
    contractSize: expectedResidual,
    minBaseAmount: expectedResidual
  });
  seedClosedConcurrentMarkets(f, {
    requested,
    spotFill: requested,
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: canonicalScaled(contractScaled, scale),
    contractRemaining: expectedResidual,
    contractAverage: '60010'
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'need_gtc',
    role: 'CONTRACT_HEDGE_GTC',
    baseQuantity: expectedResidual,
    referencePrice: '60000'
  });
  assert.equal(Decimal.precision, 5);
  assertNoTradingSideEffects(f);
});

test('uses full product precision for amount step times contract size', async (t) => {
  const amountStep = 12345678901234567890123456789012345678901n;
  const residual = canonicalScaled(amountStep, 40);
  const f = decisionFixture(t, 'CONCURRENT', undefined, residual);
  const market = f.contract.markets.get(`swap:${SYMBOL}`);
  assert.ok(market);
  f.contract.markets.set(`swap:${SYMBOL}`, {
    ...market,
    amountStep: amountStep.toString(),
    contractSize: canonicalScaled(1n, 40),
    minBaseAmount: canonicalScaled(1n, 40)
  });
  seedClosedConcurrentMarkets(f, {
    requested: residual,
    spotFill: residual,
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0',
    contractRemaining: residual,
    contractAverage: null
  });

  assert.equal(canonicalScaled(amountStep * 1n, 40), residual);
  assert.equal((await f.reconciliation.run(f.strategyId)).kind, 'need_gtc');
  assertNoTradingSideEffects(f);
});

for (const [name, minimumOffset, expectedKind] of [
  ['exact notional boundary', 0n, 'need_gtc'],
  ['one scaled unit below minimum', 1n, 'written']
] as const) {
  test(`uses full residual-price product precision: ${name}`, async (t) => {
    const residualScale = 39;
    const priceScale = 36;
    const residualInt = 123456789012345678901234567890123456789n;
    const priceInt = 81000000000000000000000000000000000001n;
    const residual = canonicalScaled(residualInt, residualScale);
    const price = canonicalScaled(priceInt, priceScale);
    const notionalScale = residualScale + priceScale;
    const exactNotional = residualInt * priceInt;
    const minimum = canonicalScaled(
      exactNotional + minimumOffset,
      notionalScale
    );
    const f = decisionFixture(t, 'CONCURRENT', undefined, residual);
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      amountStep: '1',
      contractSize: canonicalScaled(1n, residualScale),
      minBaseAmount: canonicalScaled(1n, residualScale),
      priceStep: canonicalScaled(1n, priceScale),
      minQuoteNotional: minimum
    });
    seedClosedConcurrentMarkets(f, {
      requested: residual,
      spotFill: residual,
      spotRemaining: '0',
      spotAverage: price,
      contractFill: '0',
      contractRemaining: residual,
      contractAverage: null
    });

    const result = await f.reconciliation.run(f.strategyId);

    if (expectedKind === 'need_gtc') {
      assert.deepEqual(result, {
        kind: 'need_gtc',
        role: 'CONTRACT_HEDGE_GTC',
        baseQuantity: residual,
        referencePrice: price
      });
    } else {
      assert.deepEqual(result, {
        kind: 'written',
        state: 'HEDGE_INCOMPLETE',
        failureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
      });
    }
    assertNoTradingSideEffects(f);
  });
}

test(
  'blocks a compact decimal whose canonical form exceeds the resource limit',
  { timeout: 1_000 },
  async (t) => {
    const f = decisionFixture(
      t,
      'CONCURRENT',
      undefined,
      '2e-9000000000000000'
    );
    seedClosedConcurrentMarkets(f, {
      requested: '2e-9000000000000000',
      spotFill: '2e-9000000000000000',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '1e-9000000000000000',
      contractRemaining: '1e-9000000000000000',
      contractAverage: '60010'
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'pending',
      reason: 'EXACT_ARITHMETIC_UNAVAILABLE',
      strategyState: 'EXECUTING',
      exposureKnown: true,
      expected: 'canonical decimal at most 1000000 characters',
      actual: 'canonical decimal exceeds resource limit'
    });
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assertNoTradingSideEffects(f);
  }
);

test('keeps an uncertain planned order pending when lookup returns null', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, null);

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'SUBMISSION_UNCERTAIN');
  assert.equal(f.contract.createdRequests.length, 0);
});

test('looks up heterogeneous exchanges serially in repository order', async (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spotOrder = planOrder(f, 'SPOT_MARKET');
  const contractOrder = planOrder(f, 'CONTRACT_MARKET');
  const firstLookup = deferred();
  f.spot.findGates.set(spotOrder.clientOrderId, firstLookup.promise);
  scriptFind(f, spotOrder, snapshotForOrder(spotOrder));
  scriptFind(f, contractOrder, snapshotForOrder(contractOrder));

  const collection = f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );
  await Promise.resolve();

  assert.deepEqual(f.spot.findCalls, [spotOrder.clientOrderId]);
  assert.deepEqual(f.contract.findCalls, []);
  firstLookup.resolve();

  const result = await collection;
  assert.equal(result.kind, 'ready');
  assert.deepEqual(f.contract.findCalls, [contractOrder.clientOrderId]);
});

test('continues after the first lookup failure in repository order', async (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spotOrder = planOrder(f, 'SPOT_MARKET');
  const contractOrder = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, spotOrder, new Error('private first failure'));
  scriptFind(f, contractOrder, snapshotForOrder(contractOrder));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_LOOKUP_FAILED');
  assert.equal(result.strategyOrderId, spotOrder.id);
  assert.equal(f.repository.listOrders(f.strategyId)[1]?.status, 'closed');
  assert.deepEqual(f.spot.findCalls, [spotOrder.clientOrderId]);
  assert.deepEqual(f.contract.findCalls, [contractOrder.clientOrderId]);
});

test('falls back from exchange id lookup to client id lookup', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const planned = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.attachOrderSnapshot(
    planned.id,
    snapshotForOrder(planned, {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      status: 'open'
    })
  ), 'attached');
  const observed = f.repository.listOrders(f.strategyId)[0];
  assert.ok(observed?.exchangeOrderId);
  f.contract.scriptedFetch.set(observed.exchangeOrderId, [
    new Error('private fetch failure')
  ]);
  scriptFind(f, observed, snapshotForOrder(observed, {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    status: 'closed',
    updatedAt: '2026-09-05T00:02:00.000Z'
  }));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [observed]
  );

  assert.equal(result.kind, 'ready');
  assert.deepEqual(f.contract.fetchCalls, [observed.exchangeOrderId]);
  assert.deepEqual(f.contract.findCalls, [observed.clientOrderId]);
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'closed');
});

for (const [name, disposition, expectedReason] of [
  ['uncertain', 'SUBMISSION_UNCERTAIN', 'SUBMISSION_UNCERTAIN'],
  ['remote observed', 'REMOTE_OBSERVED', 'ORDER_NOT_FOUND']
] as const) {
  test(`classifies a missing ${name} order exactly`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const planned = planOrder(f, 'CONTRACT_MARKET');
    if (disposition === 'REMOTE_OBSERVED') {
      assert.equal(f.repository.attachOrderSnapshot(
        planned.id,
        snapshotForOrder(planned, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          status: 'open'
        })
      ), 'attached');
    }
    const order = f.repository.listOrders(f.strategyId)[0];
    assert.ok(order);
    if (order.exchangeOrderId !== null) {
      f.contract.scriptedFetch.set(order.exchangeOrderId, [
        new Error('private fetch failure')
      ]);
    }
    scriptFind(f, order, null);

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, expectedReason);
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  });
}

test('accepts definite no-submit only after client lookup confirms null', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.markDefinitelyNotSubmitted(
    order.id,
    'ORDER_SUBMISSION_FAILED'
  ), true);
  scriptFind(f, order, null);

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.equal(
      result.orders[0]?.submissionDisposition,
      'DEFINITELY_NOT_SUBMITTED'
    );
    assert.equal(result.orders[0]?.snapshot, null);
  }
  assert.deepEqual(f.contract.findCalls, [order.clientOrderId]);
});

test('persists a remote contradiction to definite no-submit then blocks', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.markDefinitelyNotSubmitted(
    order.id,
    'ORDER_SUBMISSION_FAILED'
  ), true);
  scriptFind(f, order, snapshotForOrder(order));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
  assert.equal(result.expected, 'DEFINITELY_NOT_SUBMITTED');
  assert.equal(result.actual, 'REMOTE_OBSERVED');
  const persisted = f.repository.listOrders(f.strategyId)[0];
  assert.equal(persisted?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(persisted?.status, 'closed');
});

test('uses the latest definite no-submit disposition with a stale planned input', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const stalePlanned = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.markDefinitelyNotSubmitted(
    stalePlanned.id,
    'ORDER_SUBMISSION_FAILED'
  ), true);
  scriptFind(f, stalePlanned, snapshotForOrder(stalePlanned));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [stalePlanned]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
  assert.equal(result.expected, 'DEFINITELY_NOT_SUBMITTED');
  assert.equal(result.actual, 'REMOTE_OBSERVED');
  const persisted = f.repository.listOrders(f.strategyId)[0];
  assert.equal(persisted?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(persisted?.status, 'closed');
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});

for (const [name, patch] of [
  ['exchange identity', { exchangeId: 'bitget' }],
  ['client identity', { clientOrderId: 'different-client-id' }],
  ['symbol', { symbol: 'ETH/USDT' }],
  ['kind', { kind: 'spot' }],
  ['type', { type: 'limit' }],
  ['side', { side: 'buy' }],
  ['requested quantity', { requestedBaseQuantity: '2' }]
] as const satisfies readonly (
  readonly [string, Partial<OrderSnapshot>]
)[]) {
  test(`blocks remote ${name} mismatch`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, snapshotForOrder(order, patch));

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
    assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'planned');
  });
}

test('reports safe scalar diagnostics for a client identity mismatch', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  const remoteClientOrderId = 'different-client-id';
  scriptFind(f, order, snapshotForOrder(order, {
    clientOrderId: remoteClientOrderId,
    averagePrice: '87654.321',
    updatedAt: '2026-09-05T00:09:00.000Z'
  }));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
  assert.equal(result.expected, order.clientOrderId);
  assert.equal(result.actual, remoteClientOrderId);
  assert.doesNotMatch(
    JSON.stringify(result),
    /87654\.321|2026-09-05T00:09:00\.000Z/
  );
  assert.equal(f.repository.listOrderEvents(order.id).length, 0);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});

for (const [name, patch] of [
  ['quantity conservation', {
    filledBaseQuantity: '0.7',
    remainingBaseQuantity: '0.4'
  }],
  ['negative quantity', {
    filledBaseQuantity: '-0.1',
    remainingBaseQuantity: '1.1'
  }],
  ['numeric format', { filledBaseQuantity: 'not-a-decimal' }],
  ['average price format', { averagePrice: 'not-a-decimal' }]
] as const satisfies readonly (
  readonly [string, Partial<OrderSnapshot>]
)[]) {
  test(`blocks invalid snapshot ${name}`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, snapshotForOrder(order, patch));

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'ORDER_SNAPSHOT_INVALID');
    assert.equal(f.repository.listOrderEvents(order.id).length, 0);
  });
}

test('accepts a zero-fill open snapshot as valid boundary evidence', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order, {
    status: 'open',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null
  }));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'ready');
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'open');
  assert.equal(
    f.repository.listOrders(f.strategyId)[0]?.snapshot?.filledBaseQuantity,
    '0'
  );
});

test('persists positive fill with missing average price for later decision', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order, {
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: null
  }));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'ready');
  assert.equal(
    f.repository.listOrders(f.strategyId)[0]?.snapshot?.averagePrice,
    null
  );
});

test('maps an attach compare-and-set conflict without retaining its cause', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order));
  const originalAttach = f.repository.attachOrderSnapshot.bind(f.repository);
  Reflect.set(f.repository, 'attachOrderSnapshot', () => {
    throw new OrderSnapshotWriteConflictError();
  });
  t.after(() => Reflect.set(
    f.repository,
    'attachOrderSnapshot',
    originalAttach
  ));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'SNAPSHOT_WRITE_CONFLICT');
  assert.equal(f.repository.listOrderEvents(order.id).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /strategy order changed/);
});

test('rethrows an unknown snapshot attachment failure unchanged', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order));
  const sentinel = new Error('synthetic storage failure');
  const originalAttach = f.repository.attachOrderSnapshot.bind(f.repository);
  Reflect.set(f.repository, 'attachOrderSnapshot', () => {
    throw sentinel;
  });
  t.after(() => Reflect.set(
    f.repository,
    'attachOrderSnapshot',
    originalAttach
  ));

  await assert.rejects(
    f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    ),
    (error: unknown) => error === sentinel
  );
  assert.equal(f.repository.listOrderEvents(order.id).length, 0);
  assert.equal(f.tradeEvents.length, 0);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});

for (const [name, localPatch, remotePatch] of [
  ['status regression', {
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  }, {
    status: 'open',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  }],
  ['exchange order id change', {
    status: 'open',
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6'
  }, {
    exchangeOrderId: 'different-remote-order',
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  }]
] as const satisfies readonly (readonly [
  string,
  Partial<OrderSnapshot>,
  Partial<OrderSnapshot>
])[]) {
  test(`blocks ${name} against persisted evidence`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const planned = planOrder(f, 'CONTRACT_MARKET');
    assert.equal(f.repository.attachOrderSnapshot(
      planned.id,
      snapshotForOrder(planned, localPatch)
    ), 'attached');
    const before = f.repository.listOrders(f.strategyId)[0];
    assert.ok(before?.exchangeOrderId);
    f.contract.scriptedFetch.set(before.exchangeOrderId, [
      snapshotForOrder(before, {
        ...remotePatch,
        updatedAt: '2026-09-05T00:02:00.000Z'
      })
    ]);

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [before]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
    assert.deepEqual(f.repository.listOrders(f.strategyId)[0], before);
    assert.equal(f.repository.listOrderEvents(planned.id).length, 1);
  });
}

test('uses the latest status for safe mismatch diagnostics with stale input', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const stalePlanned = planOrder(f, 'CONTRACT_MARKET');
  const persistedClosed = snapshotForOrder(stalePlanned, {
    exchangeOrderId: 'status-baseline',
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  });
  assert.equal(f.repository.attachOrderSnapshot(
    stalePlanned.id,
    persistedClosed
  ), 'attached');
  scriptFind(f, stalePlanned, snapshotForOrder(stalePlanned, {
    exchangeOrderId: 'status-baseline',
    status: 'open',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '98765.4321',
    updatedAt: '2026-09-05T00:02:00.000Z'
  }));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [stalePlanned]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
  assert.equal(result.expected, 'closed');
  assert.equal(result.actual, 'open');
  assert.doesNotMatch(
    JSON.stringify(result),
    /98765\.4321|2026-09-05T00:02:00\.000Z/
  );
  assert.deepEqual(
    f.repository.listOrders(f.strategyId)[0]?.snapshot,
    persistedClosed
  );
  assert.equal(f.repository.listOrderEvents(stalePlanned.id).length, 1);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});

test('reports both exchange-id and client-id lookup failure safely', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const planned = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.attachOrderSnapshot(
    planned.id,
    snapshotForOrder(planned, {
      status: 'open',
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    })
  ), 'attached');
  const order = f.repository.listOrders(f.strategyId)[0];
  assert.ok(order?.exchangeOrderId);
  f.contract.scriptedFetch.set(order.exchangeOrderId, [
    new Error('private fetch detail')
  ]);
  scriptFind(f, order, new Error('private client lookup detail'));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_LOOKUP_FAILED');
  assert.doesNotMatch(
    JSON.stringify(result),
    /private fetch detail|private client lookup detail/
  );
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
});

test('keeps persisted evidence when the lifecycle event sink throws', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order));
  const throwingSink: TradeEventSink = {
    record(): void {
      throw new Error('private logging failure');
    }
  };
  const collector = new HedgeOrderEvidenceCollector(
    f.registry,
    f.repository,
    throwingSink
  );

  const result = await collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'ready');
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'closed');
  assert.equal(f.repository.listOrderEvents(order.id).length, 1);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});

test('emits lifecycle events only for semantic snapshot changes', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  const firstOpen = snapshotForOrder(order, {
    exchangeOrderId: 'contract-lifecycle',
    status: 'open',
    filledBaseQuantity: '0.2',
    remainingBaseQuantity: '0.8',
    averagePrice: '60010'
  });
  const timestampOnly = {
    ...firstOpen,
    updatedAt: '2026-09-05T00:02:00.000Z'
  };
  const changedOpen = {
    ...firstOpen,
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6',
    updatedAt: '2026-09-05T00:03:00.000Z'
  };
  const closed = {
    ...firstOpen,
    status: 'closed' as const,
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    updatedAt: '2026-09-05T00:04:00.000Z'
  };
  const closedTimestampOnly = {
    ...closed,
    updatedAt: '2026-09-05T00:05:00.000Z'
  };
  scriptFind(f, order, firstOpen);
  f.contract.scriptedFetch.set('contract-lifecycle', [
    timestampOnly,
    changedOpen,
    closed,
    closedTimestampOnly
  ]);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  const afterFirst = structuredClone(
    f.repository.listOrders(f.strategyId)[0]
  );
  assert.equal(f.repository.listOrderEvents(order.id).length, 1);
  assert.equal(f.tradeEvents.length, 1);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.deepEqual(f.repository.listOrders(f.strategyId)[0], afterFirst);
  assert.equal(f.repository.listOrderEvents(order.id).length, 1);
  assert.equal(f.tradeEvents.length, 1);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.equal(f.repository.listOrderEvents(order.id).length, 2);
  assert.equal(f.tradeEvents.length, 2);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.equal(f.repository.listOrderEvents(order.id).length, 3);
  assert.equal(
    f.tradeEvents.filter(({ event }) => event === 'order_status_changed').length,
    3
  );
  assert.equal(
    f.tradeEvents.filter(({ event }) => event === 'order_terminal').length,
    1
  );

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.equal(f.repository.listOrderEvents(order.id).length, 3);
  assert.equal(f.tradeEvents.length, 4);
  assert.equal(f.contract.createdRequests.length, 0);
});

test('emits one terminal event across attached closed snapshots from stale input', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const stalePlanned = planOrder(f, 'CONTRACT_MARKET');
  const firstClosed = snapshotForOrder(stalePlanned, {
    exchangeOrderId: 'stale-lifecycle',
    status: 'closed',
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6',
    updatedAt: '2026-09-05T00:01:00.000Z'
  });
  const secondClosed = {
    ...firstClosed,
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    updatedAt: '2026-09-05T00:02:00.000Z'
  };
  f.contract.scriptedFind.set(stalePlanned.clientOrderId, [
    firstClosed,
    secondClosed
  ]);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [stalePlanned]
  )).kind, 'ready');
  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [stalePlanned]
  )).kind, 'ready');

  assert.equal(f.repository.listOrderEvents(stalePlanned.id).length, 2);
  assert.equal(
    f.tradeEvents.filter(({ event }) => event === 'order_status_changed').length,
    2
  );
  assert.equal(
    f.tradeEvents.filter(({ event }) => event === 'order_terminal').length,
    1
  );
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'closed');
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});

const GTC_CASES = [
  ['open partial', 'open', '0.1', '0.3', 'WAITING_HEDGE', null],
  ['closed full', 'closed', '0.4', '0', 'HEDGED', null],
  ['canceled full', 'canceled', '0.4', '0', 'HEDGED', null],
  [
    'rejected zero',
    'rejected',
    '0',
    '0.4',
    'HEDGE_INCOMPLETE',
    'HEDGE_ORDER_REJECTED'
  ],
  [
    'canceled partial',
    'canceled',
    '0.1',
    '0.3',
    'HEDGE_INCOMPLETE',
    'HEDGE_ORDER_CANCELED'
  ]
] as const;

for (const [name, status, filled, remaining, state, failureCode]
  of GTC_CASES) {
  test(`reconciles an existing GTC: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });
    const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
    scriptFind(f, gtc, snapshotForOrder(gtc, {
      filledBaseQuantity: filled,
      remainingBaseQuantity: remaining,
      averagePrice: filled === '0' ? null : '60000',
      status
    }));

    const result = await f.reconciliation.run(f.strategyId);

    assert.deepEqual(result, failureCode === null
      ? { kind: 'written', state }
      : { kind: 'written', state, failureCode });
    const persisted = f.repository.getStrategy(f.strategyId);
    assert.equal(persisted.state, state);
    assert.equal(persisted.failureCode, failureCode);
    assertNoTradingSideEffects(f);
  });
}

for (const failureCode of [
  'ORDER_SUBMISSION_FAILED',
  'HEDGE_RESIDUAL_NOT_TRADABLE'
] as const) {
  test(`uses persisted definite GTC failure ${failureCode}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });
    const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
    assert.equal(
      f.repository.markDefinitelyNotSubmitted(gtc.id, failureCode),
      true
    );
    scriptFind(f, gtc, null);

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'HEDGE_INCOMPLETE',
      failureCode
    });
    assert.equal(
      f.repository.getStrategy(f.strategyId).failureCode,
      failureCode
    );
    assertNoTradingSideEffects(f);
  });
}

interface InvalidGtcCase {
  readonly name: string;
  readonly role: 'SPOT_HEDGE_GTC' | 'CONTRACT_HEDGE_GTC';
  readonly quantity: string;
  readonly contractFill?: string;
  readonly contractRemaining?: string;
  readonly snapshot: Readonly<Pick<
    OrderSnapshot,
    'status' | 'filledBaseQuantity' | 'remainingBaseQuantity'
  >>;
}

const INVALID_GTC_CASES = [
  {
    name: 'wrong role',
    role: 'SPOT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: {
      status: 'open',
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.4'
    }
  },
  {
    name: 'request differs from pre-GTC residual',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.5',
    snapshot: {
      status: 'open',
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.5'
    }
  },
  {
    name: 'remaining differs from current residual',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    contractFill: '0.5',
    contractRemaining: '0.5',
    snapshot: {
      status: 'open',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.3'
    }
  },
  {
    name: 'fill crosses the original market residual',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.5',
    snapshot: {
      status: 'closed',
      filledBaseQuantity: '0.5',
      remainingBaseQuantity: '0'
    }
  },
  {
    name: 'open has zero remaining',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: {
      status: 'open',
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0'
    }
  },
  {
    name: 'closed is not fully filled',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: {
      status: 'closed',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.3'
    }
  },
  {
    name: 'rejected has a positive fill',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: {
      status: 'rejected',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.3'
    }
  }
] as const satisfies readonly InvalidGtcCase[];

for (const testCase of INVALID_GTC_CASES) {
  test(`writes the unique failure for invalid GTC: ${testCase.name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: 'contractFill' in testCase
        ? testCase.contractFill
        : '0.6',
      contractRemaining: 'contractRemaining' in testCase
        ? testCase.contractRemaining
        : '0.4',
      contractAverage: '60010'
    });
    const gtc = planOrder(f, testCase.role, testCase.quantity);
    scriptFind(f, gtc, snapshotForOrder(gtc, {
      ...testCase.snapshot,
      averagePrice: testCase.snapshot.filledBaseQuantity === '0'
        ? null
        : '60000'
    }));

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    });
    assertNoTradingSideEffects(f);
  });
}

test('keeps an unknown GTC pending', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });
  const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
  scriptFind(f, gtc, snapshotForOrder(gtc, {
    status: 'unknown',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.4',
    averagePrice: null
  }));

  const result = await f.reconciliation.run(f.strategyId);

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'GTC_STATUS_UNKNOWN');
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assertNoTradingSideEffects(f);
});

test('rejects two GTC roles before any lookup', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  planOrder(f, 'SPOT_MARKET');
  planOrder(f, 'CONTRACT_MARKET');
  planOrder(f, 'SPOT_HEDGE_GTC', '0.4');
  planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');

  const result = await f.reconciliation.run(f.strategyId);

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'INVALID_LOCAL_TOPOLOGY');
  assertNoGatewayCalls(f);
});

test('returns waiting_gtc without a WAITING_HEDGE self-transition', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });
  const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
  scriptFind(f, gtc, snapshotForOrder(gtc, {
    status: 'open',
    filledBaseQuantity: '0.1',
    remainingBaseQuantity: '0.3'
  }));
  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'written',
    state: 'WAITING_HEDGE'
  });

  const persistedOrders = f.repository.listOrders(f.strategyId);
  for (const order of persistedOrders) {
    const exchangeOrderId = order.exchangeOrderId;
    const snapshot = order.snapshot;
    assert.ok(exchangeOrderId);
    assert.ok(snapshot);
    gatewayFor(f, order).scriptedFetch.set(exchangeOrderId, [
      { ...snapshot, updatedAt: '2026-09-05T00:03:00.000Z' }
    ]);
  }
  let transitions = 0;
  const originalTransition = f.repository.transition.bind(f.repository);
  Reflect.set(f.repository, 'transition', (...args: Parameters<
    StrategyRepository['transition']
  >) => {
    transitions += 1;
    return originalTransition(...args);
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'waiting_gtc'
  });
  assert.equal(transitions, 0);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'WAITING_HEDGE');
  assertNoTradingSideEffects(f);
});

const TRADABILITY_CASES = [
  ['below step', '0.002', { amountStep: '1', contractSize: '0.003' }],
  [
    'not a whole contract',
    '0.0045',
    { amountStep: '0.5', contractSize: '0.003' }
  ],
  ['below minimum', '0.004', { minBaseAmount: '0.005' }],
  ['above maximum', '1.1', { maxBaseAmount: '1' }],
  ['below notional', '0.01', { minQuoteNotional: '10' }, '900'],
  ['above notional', '2', { maxQuoteNotional: '100' }, '60']
] as const;

for (const [name, residual, overrides, referencePrice = '60000']
  of TRADABILITY_CASES) {
  test(`does not round an untradable residual: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT', undefined, residual);
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      ...overrides
    });
    seedClosedConcurrentMarkets(f, {
      requested: residual,
      spotFill: residual,
      spotRemaining: '0',
      spotAverage: referencePrice,
      contractFill: '0',
      contractRemaining: residual,
      contractAverage: null
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
    });
    assertNoTradingSideEffects(f);
  });
}

const TRADABILITY_BOUNDARIES = [
  ['step', '0.003', { amountStep: '1', contractSize: '0.003' }, '60000'],
  ['minimum', '0.005', { minBaseAmount: '0.005' }, '60000'],
  ['maximum', '1', { maxBaseAmount: '1' }, '60000'],
  ['minimum notional', '0.01', { minQuoteNotional: '10' }, '1000'],
  ['maximum notional', '1', { maxQuoteNotional: '100' }, '100']
] as const;

for (const [name, residual, overrides, referencePrice]
  of TRADABILITY_BOUNDARIES) {
  test(`authorizes a residual exactly on the ${name} boundary`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT', undefined, residual);
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      ...overrides
    });
    seedClosedConcurrentMarkets(f, {
      requested: residual,
      spotFill: residual,
      spotRemaining: '0',
      spotAverage: referencePrice,
      contractFill: '0',
      contractRemaining: residual,
      contractAverage: null
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'need_gtc',
      role: 'CONTRACT_HEDGE_GTC',
      baseQuantity: residual,
      referencePrice
    });
    assertNoTradingSideEffects(f);
  });
}

for (const [name, mutate] of [
  ['load failure', (f: DecisionFixture) => {
    f.contract.markets.clear();
  }],
  ['inactive market', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, { ...market, active: false });
  }],
  ['market identity mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      exchangeId: 'bitget'
    });
  }],
  ['market id mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      marketId: 'WRONG-SWAP'
    });
  }],
  ['market symbol mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      symbol: 'ETH/USDT'
    });
  }],
  ['market kind mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, { ...market, kind: 'spot' });
  }],
  ['base asset mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, { ...market, base: 'ETH' });
  }],
  ['quote asset mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      quote: 'USD' as 'USDT'
    });
  }],
  ['inverted base range', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      minBaseAmount: '1',
      maxBaseAmount: '0.5'
    });
  }],
  ['inverted notional range', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      minQuoteNotional: '100',
      maxQuoteNotional: '10'
    });
  }],
  ['invalid rule number', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      amountStep: 'not-a-decimal'
    });
  }]
] as const) {
  test(`keeps uncertain market rules pending: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    mutate(f);
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'MARKET_RULES_UNAVAILABLE');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assertNoTradingSideEffects(f);
  });
}

for (const [name, mutate] of [
  ['quantize failure', (f: DecisionFixture) => {
    Reflect.set(f.contract, 'quantizePrice', async () => {
      throw new Error('private quantize detail');
    });
  }],
  ['non-positive candidate', (f: DecisionFixture) => {
    f.contract.quantizedPrices.set(`swap:${SYMBOL}`, '0');
  }],
  ['off-step candidate', (f: DecisionFixture) => {
    f.contract.quantizedPrices.set(`swap:${SYMBOL}`, '60000.05');
  }]
] as const) {
  test(`keeps uncertain candidate price pending: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    mutate(f);
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'PRICE_QUANTIZATION_FAILED');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assertNoTradingSideEffects(f);
    assert.doesNotMatch(JSON.stringify(result), /private quantize detail/);
  });
}

for (const [behavior, expected, persistedState] of [
  ['false unchanged', 'pending', 'EXECUTING'],
  ['false after target write', 'observed', 'HEDGED'],
  ['throw after target write', 'observed', 'HEDGED'],
  ['throw after other write', 'pending', 'FAILED']
] as const) {
  test(`never fabricates written when transition ${behavior}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: null,
      contractFill: '1',
      contractRemaining: '0',
      contractAverage: null
    });
    const original = f.repository.transition.bind(f.repository);
    Reflect.set(f.repository, 'transition', (...args: Parameters<
      StrategyRepository['transition']
    >): boolean => {
      if (behavior === 'false unchanged') return false;
      if (behavior === 'throw after other write') {
        assert.equal(original(
          f.strategyId,
          ['EXECUTING'],
          'FAILED',
          'ORDER_SUBMISSION_FAILED'
        ), true);
        throw new Error('private competing write detail');
      }
      assert.equal(original(...args), true);
      if (behavior === 'false after target write') return false;
      throw new Error('private post-commit detail');
    });

    const result = await f.reconciliation.run(f.strategyId);

    if (expected === 'observed') {
      assert.deepEqual(result, {
        kind: 'observed_state',
        state: 'HEDGED'
      });
    } else {
      assert.equal(result.kind, 'pending');
      assert.equal(result.reason, 'STATE_WRITE_CONFLICT');
      assert.notEqual(result.kind, 'written');
    }
    assert.equal(
      f.repository.getStrategy(f.strategyId).state,
      persistedState
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /private competing write detail|private post-commit detail/
    );
    assertNoTradingSideEffects(f);
  });
}

interface CapturedReconciliationOperation {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<OperationalFields> | undefined;
}

function captureReconciliationOperations(
  entries: CapturedReconciliationOperation[]
): OperationalLog {
  return {
    info: (event, fields) => {
      entries.push({ level: 'info', event, fields });
    },
    warn: (event, fields) => {
      entries.push({ level: 'warn', event, fields });
    },
    error(): void {},
    fatal(): void {}
  };
}

test('deduplicates one pending revision and logs a changed reason', async (t) => {
  const entries: CapturedReconciliationOperation[] = [];
  const f = decisionFixture(
    t,
    'CONTRACT_FIRST',
    captureReconciliationOperations(entries)
  );
  const order = planOrder(f, 'CONTRACT_MARKET');
  f.contract.scriptedFind.set(order.clientOrderId, [
    null,
    null,
    new Error('private lookup detail')
  ]);

  assert.equal((await f.reconciliation.run(f.strategyId)).kind, 'pending');
  assert.equal((await f.reconciliation.run(f.strategyId)).kind, 'pending');
  assert.equal(
    entries.filter(({ level }) => level === 'warn').length,
    1
  );
  const changed = await f.reconciliation.run(f.strategyId);
  assert.equal(changed.kind, 'pending');
  assert.equal(changed.reason, 'ORDER_LOOKUP_FAILED');
  assert.deepEqual(
    entries.filter(({ level }) => level === 'warn')
      .map(({ fields }) => fields?.reason),
    ['SUBMISSION_UNCERTAIN', 'ORDER_LOOKUP_FAILED']
  );

  scriptFind(f, order, snapshotForOrder(order, {
    status: 'open',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null,
    updatedAt: '2026-09-05T00:02:00.000Z'
  }));
  const firstActive = await f.reconciliation.run(f.strategyId);
  assert.equal(firstActive.kind, 'pending');
  assert.equal(firstActive.reason, 'MARKET_ORDER_ACTIVE');
  const persisted = f.repository.listOrders(f.strategyId)[0];
  assert.ok(persisted?.exchangeOrderId);
  f.contract.scriptedFetch.set(persisted.exchangeOrderId, [
    snapshotForOrder(persisted, {
      status: 'open',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.9',
      averagePrice: '60000',
      updatedAt: '2026-09-05T00:03:00.000Z'
    })
  ]);
  const revisedActive = await f.reconciliation.run(f.strategyId);
  assert.equal(revisedActive.kind, 'pending');
  assert.equal(revisedActive.reason, 'MARKET_ORDER_ACTIVE');
  assert.deepEqual(
    entries.filter(({ level }) => level === 'warn')
      .map(({ fields }) => fields?.reason),
    [
      'SUBMISSION_UNCERTAIN',
      'ORDER_LOOKUP_FAILED',
      'MARKET_ORDER_ACTIVE',
      'MARKET_ORDER_ACTIVE'
    ]
  );
  assert.doesNotMatch(JSON.stringify(entries), /private lookup detail/);
  assertNoTradingSideEffects(f);
});

test('logs written, observed terminal, and need_gtc conclusions', async (t) => {
  const terminalEntries: CapturedReconciliationOperation[] = [];
  const terminal = decisionFixture(
    t,
    'CONCURRENT',
    captureReconciliationOperations(terminalEntries)
  );
  seedClosedConcurrentMarkets(terminal, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: null,
    contractFill: '1',
    contractRemaining: '0',
    contractAverage: null
  });
  assert.deepEqual(await terminal.reconciliation.run(terminal.strategyId), {
    kind: 'written',
    state: 'HEDGED'
  });
  assert.deepEqual(await terminal.reconciliation.run(terminal.strategyId), {
    kind: 'observed_state',
    state: 'HEDGED'
  });
  assert.equal(
    terminalEntries.filter(
      ({ event }) => event === 'hedge_reconciliation_conclusion'
    ).length,
    2
  );

  const gtcEntries: CapturedReconciliationOperation[] = [];
  const gtc = decisionFixture(
    t,
    'CONCURRENT',
    captureReconciliationOperations(gtcEntries)
  );
  seedClosedConcurrentMarkets(gtc, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });
  assert.equal((await gtc.reconciliation.run(gtc.strategyId)).kind, 'need_gtc');
  const fields = gtcEntries.find(
    ({ event }) => event === 'hedge_reconciliation_conclusion'
  )?.fields;
  assert.equal(fields?.marketSpot, '1');
  assert.equal(fields?.marketContract, '0.6');
  assert.equal(fields?.preGtcResidual, '0.4');
  assert.equal(fields?.currentResidual, '0.4');
  assertNoTradingSideEffects(terminal);
  assertNoTradingSideEffects(gtc);
});

for (const [name, operationalLog] of [
  ['sync throw', {
    info(): never { throw new Error('sync log failure'); },
    warn(): never { throw new Error('sync log failure'); },
    error(): void {},
    fatal(): void {}
  }],
  ['async rejection', {
    info: () => Promise.reject(new Error('async log failure')),
    warn: () => Promise.reject(new Error('async log failure')),
    error(): void {},
    fatal(): void {}
  } as unknown as OperationalLog]
] as const) {
  test(`logging cannot change reconciliation: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONTRACT_FIRST', operationalLog);
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, null);

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'SUBMISSION_UNCERTAIN');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assertNoTradingSideEffects(f);
  });
}

test('writes inconsistent state for a sequential rejected positive fill', async (t) => {
  const f = decisionFixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order, {
    status: 'rejected',
    filledBaseQuantity: '0.2',
    remainingBaseQuantity: '0.8',
    averagePrice: '60010'
  }));

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'written',
    state: 'HEDGE_INCOMPLETE',
    failureCode: 'INCONSISTENT_ORDER_STATE'
  });
  assertNoTradingSideEffects(f);
});

test('rejects an existing GTC when the market residual is zero', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '1',
    contractRemaining: '0',
    contractAverage: '60010'
  });
  const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.1');
  scriptFind(f, gtc, snapshotForOrder(gtc, {
    status: 'open',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.1',
    averagePrice: null
  }));

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'written',
    state: 'HEDGE_INCOMPLETE',
    failureCode: 'INCONSISTENT_ORDER_STATE'
  });
  assertNoTradingSideEffects(f);
});

for (const testCase of [
  {
    name: 'contract target',
    spotFill: '1',
    spotRemaining: '0',
    contractFill: '0.6',
    contractRemaining: '0.4',
    target: 'contract',
    role: 'CONTRACT_HEDGE_GTC',
    kind: 'swap',
    sourcePrice: '60000',
    candidatePrice: '59999.9'
  },
  {
    name: 'spot target',
    spotFill: '0.6',
    spotRemaining: '0.4',
    contractFill: '1',
    contractRemaining: '0',
    target: 'spot',
    role: 'SPOT_HEDGE_GTC',
    kind: 'spot',
    sourcePrice: '60010',
    candidatePrice: '60010.1'
  }
] as const) {
  test(`loads and quantizes only the ${testCase.name} market`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    const target = testCase.target === 'spot' ? f.spot : f.contract;
    target.quantizedPrices.set(
      `${testCase.kind}:${SYMBOL}`,
      testCase.candidatePrice
    );
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: testCase.spotFill,
      spotRemaining: testCase.spotRemaining,
      spotAverage: '60000',
      contractFill: testCase.contractFill,
      contractRemaining: testCase.contractRemaining,
      contractAverage: '60010'
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'need_gtc',
      role: testCase.role,
      baseQuantity: '0.4',
      referencePrice: testCase.sourcePrice
    });
    assert.deepEqual(target.marketCalls, [{
      symbol: SYMBOL,
      kind: testCase.kind
    }]);
    assert.deepEqual(target.quantizeCalls, [{
      symbol: SYMBOL,
      kind: testCase.kind,
      price: testCase.sourcePrice
    }]);
    const other = target === f.spot ? f.contract : f.spot;
    assert.deepEqual(other.marketCalls, []);
    assert.deepEqual(other.quantizeCalls, []);
    assert.deepEqual(f.spot.lastPriceCalls, []);
    assert.deepEqual(f.contract.lastPriceCalls, []);
    assertNoTradingSideEffects(f);
  });
}

test('blocks a decision when an order revision changes after evidence collection', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  const spotOrder = planOrder(f, 'SPOT_MARKET');
  const contractOrder = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, spotOrder, snapshotForOrder(spotOrder, {
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: null
  }));
  scriptFind(f, contractOrder, snapshotForOrder(contractOrder, {
    status: 'open',
    filledBaseQuantity: '0.6',
    remainingBaseQuantity: '0.4',
    averagePrice: '60010'
  }));
  const originalListOrders = f.repository.listOrders.bind(f.repository);
  const originalTransition = f.repository.transition.bind(f.repository);
  let listsAfterBothLookups = 0;
  let mutated = false;
  let transitions = 0;
  Reflect.set(f.repository, 'transition', (...args: Parameters<
    StrategyRepository['transition']
  >): boolean => {
    transitions += 1;
    return originalTransition(...args);
  });
  Reflect.set(f.repository, 'listOrders', (...args: Parameters<
    StrategyRepository['listOrders']
  >): StrategyOrderRecord[] => {
    const orders = originalListOrders(...args);
    if (
      f.spot.findCalls.length === 1
      && f.contract.findCalls.length === 1
    ) {
      listsAfterBothLookups += 1;
      if (listsAfterBothLookups === 3 && !mutated) {
        const current = orders.find(({ id }) => id === contractOrder.id);
        assert.ok(current?.snapshot);
        assert.equal(f.repository.attachOrderSnapshot(
          contractOrder.id,
          {
            ...current.snapshot,
            filledBaseQuantity: '0.7',
            remainingBaseQuantity: '0.3',
            averagePrice: '60010',
            updatedAt: '2026-09-05T00:04:00.000Z'
          }
        ), 'attached');
        mutated = true;
        return originalListOrders(...args);
      }
    }
    return orders;
  });

  const result = await f.reconciliation.run(f.strategyId);

  assert.equal(mutated, true);
  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
  assert.equal(result.exposureKnown, true);
  assert.equal(transitions, 0);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assertNoTradingSideEffects(f);
});
