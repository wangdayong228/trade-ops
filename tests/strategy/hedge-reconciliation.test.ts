/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  ExecutionMode,
  MarketKind,
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import type {
  TradeEvent,
  TradeEventSink
} from '../../src/logging/trade-events.js';
import {
  HedgeOrderEvidenceCollector,
  inspectLocalTopology
} from '../../src/strategy/hedge-reconciliation-evidence.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  OrderSnapshotWriteConflictError,
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
  readonly scriptedFetch = new Map<
    string,
    Array<OrderSnapshot | Error>
  >();
  readonly scriptedFind = new Map<
    string,
    Array<OrderSnapshot | null | Error>
  >();
  readonly findGates = new Map<string, Promise<void>>();

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
      f.spot.createdRequests.length + f.contract.createdRequests.length
  }, { fetch: 0, find: 0, create: 0 });
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
