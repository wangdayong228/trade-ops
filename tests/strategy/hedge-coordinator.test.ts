/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import type {
  ExecutionMode,
  MarketKind,
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';
const CREATED_AT = '2026-07-26T00:00:00.000Z';
const UPDATED_AT = '2026-07-26T00:01:00.000Z';

interface RoleShape {
  readonly exchangeId: 'bitget' | 'okx';
  readonly kind: MarketKind;
  readonly type: 'market' | 'limit';
  readonly side: 'buy' | 'sell';
}

function roleShape(role: OrderRole): RoleShape {
  switch (role) {
    case 'SPOT_MARKET':
      return {
        exchangeId: 'bitget',
        kind: 'spot',
        type: 'market',
        side: 'buy'
      };
    case 'CONTRACT_MARKET':
      return {
        exchangeId: 'okx',
        kind: 'swap',
        type: 'market',
        side: 'sell'
      };
    case 'SPOT_HEDGE_GTC':
      return {
        exchangeId: 'bitget',
        kind: 'spot',
        type: 'limit',
        side: 'buy'
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        exchangeId: 'okx',
        kind: 'swap',
        type: 'limit',
        side: 'sell'
      };
  }
}

function preflight(
  mode: ExecutionMode,
  overrides: Partial<PreflightResult> = {}
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode,
    spotMarket: {
      exchangeId: 'bitget',
      symbol: SYMBOL,
      marketId: 'BTCUSDT',
      kind: 'spot',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '0.0000000000000000000000000000000000000001',
      contractSize: '1',
      minBaseAmount: '0.0000000000000000000000000000000000000001',
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
      contractSize: '0.0000000000000000000000000000000000000001',
      minBaseAmount: '0.0000000000000000000000000000000000000001',
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
    createdAt: CREATED_AT,
    ...overrides
  };
}

function requestFor(
  strategyId: string,
  role: OrderRole,
  baseQuantity: string,
  marginMode: 'isolated' | 'cross' = 'cross',
  price = '60000'
): OrderRequest {
  const shape = roleShape(role);
  const common = {
    symbol: SYMBOL,
    kind: shape.kind,
    type: shape.type,
    side: shape.side,
    baseQuantity,
    clientOrderId: makeClientOrderId(strategyId, role)
  };
  if (role === 'SPOT_MARKET') {
    return common;
  }
  if (role === 'CONTRACT_MARKET') {
    return {
      ...common,
      positionSide: 'SHORT',
      marginMode
    };
  }
  if (role === 'SPOT_HEDGE_GTC') {
    return {
      ...common,
      price,
      timeInForce: 'GTC'
    };
  }
  return {
    ...common,
    price,
    timeInForce: 'GTC',
    positionSide: 'SHORT',
    marginMode
  };
}

function snapshotFor(
  strategyId: string,
  role: OrderRole,
  baseQuantity: string,
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  const shape = roleShape(role);
  return {
    exchangeId: shape.exchangeId,
    exchangeOrderId: `${role.toLowerCase()}-order`,
    clientOrderId: makeClientOrderId(strategyId, role),
    symbol: SYMBOL,
    kind: shape.kind,
    type: shape.type,
    side: shape.side,
    requestedBaseQuantity: baseQuantity,
    filledBaseQuantity: baseQuantity,
    remainingBaseQuantity: '0',
    averagePrice: '60000',
    status: 'closed',
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

class TrackingGateway extends FakeExchangeGateway {
  readonly findRequests: Array<{
    clientOrderId: string;
    symbol: string;
    kind: MarketKind;
  }> = [];
  readonly quantizeRequests: Array<{
    symbol: string;
    kind: MarketKind;
    price: string;
  }> = [];
  readonly fetchOrderRequests: Array<{
    exchangeOrderId: string;
    symbol: string;
    kind: MarketKind;
  }> = [];
  readonly forbiddenCalls = {
    cancel: 0,
    replace: 0,
    close: 0
  };
  beforeCreate: (() => void) | undefined;

  override async quantizePrice(
    symbol: string,
    kind: MarketKind,
    price: string
  ): Promise<string> {
    this.quantizeRequests.push({ symbol, kind, price });
    return super.quantizePrice(symbol, kind, price);
  }

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.beforeCreate?.();
    return super.createOrder(request);
  }

  override async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    this.fetchOrderRequests.push({ exchangeOrderId, symbol, kind });
    return super.fetchOrder(exchangeOrderId, symbol, kind);
  }

  override async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    this.findRequests.push({ clientOrderId, symbol, kind });
    return super.findOrderByClientId(clientOrderId, symbol, kind);
  }

  async cancelOrder(): Promise<void> {
    this.forbiddenCalls.cancel += 1;
  }

  async replaceOrder(): Promise<void> {
    this.forbiddenCalls.replace += 1;
  }

  async closePosition(): Promise<void> {
    this.forbiddenCalls.close += 1;
  }
}

class UnknownSubmissionGateway extends TrackingGateway {
  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.beforeCreate?.();
    this.createdRequests.push(request);
    throw new Error(
      'network timeout apiKey=must-never-be-persisted secret=also-private'
    );
  }
}

class UnknownStatusGateway extends TrackingGateway {
  result: OrderSnapshot | undefined;

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.beforeCreate?.();
    this.createdRequests.push(request);
    if (this.result === undefined) {
      throw new Error('missing direct unknown result');
    }
    return this.result;
  }
}

class BlockingUnknownLookupGateway extends UnknownStatusGateway {
  #releaseLookup: (() => void) | undefined;
  #markLookupStarted: (() => void) | undefined;
  readonly lookupStarted = new Promise<void>((resolve) => {
    this.#markLookupStarted = resolve;
  });
  readonly #lookupGate = new Promise<void>((resolve) => {
    this.#releaseLookup = resolve;
  });

  releaseLookup(): void {
    this.#releaseLookup?.();
  }

  override async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    this.findRequests.push({ clientOrderId, symbol, kind });
    this.#markLookupStarted?.();
    await this.#lookupGate;
    return null;
  }
}

class DirectResultGateway extends TrackingGateway {
  readonly directResults: OrderSnapshot[] = [];

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.beforeCreate?.();
    this.createdRequests.push(request);
    const result = this.directResults.shift();
    if (result === undefined) {
      throw new Error('missing direct result');
    }
    return result;
  }
}

class DeferredCreateGateway extends TrackingGateway {
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.beforeCreate?.();
    await this.#gate;
    return super.createOrder(request);
  }
}

interface SetupResult {
  readonly database: Database.Database;
  readonly repository: SqliteStrategyRepository;
  readonly spot: TrackingGateway;
  readonly contract: TrackingGateway;
  readonly coordinator: HedgeCoordinator;
  readonly strategyId: string;
}

function setup(
  t: TestContext,
  mode: ExecutionMode,
  options: {
    spot?: TrackingGateway;
    contract?: TrackingGateway;
    preflight?: Partial<PreflightResult>;
  } = {}
): SetupResult {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new SqliteStrategyRepository(database);
  const spot = options.spot ?? new TrackingGateway('bitget');
  const contract = options.contract ?? new TrackingGateway('okx');
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const strategyId = repository.createPending(
    preflight(mode, options.preflight)
  ).id;

  return {
    database,
    repository,
    spot,
    contract,
    coordinator: new HedgeCoordinator(registry, repository),
    strategyId
  };
}

function assertStableClientId(
  request: OrderRequest | undefined,
  strategyId: string,
  role: OrderRole
): void {
  assert.ok(request);
  assert.equal(request.clientOrderId, makeClientOrderId(strategyId, role));
  assert.match(request.clientOrderId, /^[a-z0-9]{32}$/);
}

function assertNoForbiddenSideEffects(...gateways: TrackingGateway[]): void {
  for (const gateway of gateways) {
    assert.deepEqual(gateway.forbiddenCalls, {
      cancel: 0,
      replace: 0,
      close: 0
    });
    assert.equal(gateway.fetchOrderRequests.length, 0);
  }
}

test('contract-first hedges only the actual partial fill with a quantized spot GTC', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.8',
      remainingBaseQuantity: '0.2',
      averagePrice: '60000.09',
      status: 'closed'
    }
  ));
  context.spot.quantizedPrices.set('spot:BTC/USDT', '60000.0');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.8',
    {
      filledBaseQuantity: '0.3',
      remainingBaseQuantity: '0.5',
      averagePrice: '60000',
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(context.contract.createdRequests[0], {
    symbol: SYMBOL,
    kind: 'swap',
    type: 'market',
    side: 'sell',
    baseQuantity: '1',
    clientOrderId: makeClientOrderId(
      context.strategyId,
      'CONTRACT_MARKET'
    ),
    positionSide: 'SHORT',
    marginMode: 'cross'
  });
  assert.deepEqual(context.spot.createdRequests[0], {
    symbol: SYMBOL,
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    baseQuantity: '0.8',
    price: '60000.0',
    timeInForce: 'GTC',
    clientOrderId: makeClientOrderId(
      context.strategyId,
      'SPOT_HEDGE_GTC'
    )
  });
  assert.deepEqual(context.spot.quantizeRequests, [{
    symbol: SYMBOL,
    kind: 'spot',
    price: '60000.09'
  }]);
  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'WAITING_HEDGE'
  );
  assertStableClientId(
    context.contract.createdRequests[0],
    context.strategyId,
    'CONTRACT_MARKET'
  );
  assertStableClientId(
    context.spot.createdRequests[0],
    context.strategyId,
    'SPOT_HEDGE_GTC'
  );
  assertNoForbiddenSideEffects(context.spot, context.contract);
});

test('spot-first sends a fully persisted SHORT GTC using the confirmed isolated mode', async (t) => {
  const context = setup(t, 'SPOT_FIRST', {
    preflight: {
      accountSettings: {
        marginMode: 'isolated',
        positionMode: 'one-way',
        leverage: '3'
      }
    }
  });
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    { averagePrice: '61000.06' }
  ));
  context.contract.quantizedPrices.set('swap:BTC/USDT', '61000.0');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '1',
    { averagePrice: '61000' }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.deepEqual(context.contract.createdRequests[0], {
    symbol: SYMBOL,
    kind: 'swap',
    type: 'limit',
    side: 'sell',
    baseQuantity: '1',
    price: '61000.0',
    timeInForce: 'GTC',
    clientOrderId: makeClientOrderId(
      context.strategyId,
      'CONTRACT_HEDGE_GTC'
    ),
    positionSide: 'SHORT',
    marginMode: 'isolated'
  });
  assert.equal(
    Object.hasOwn(context.spot.createdRequests[0] ?? {}, 'marginMode'),
    false
  );
});

test('sequential first-leg zero fill fails without submitting a hedge', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'closed'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'FAILED');
  assert.equal(strategy.failureCode, 'NO_FILL');
  assert.equal(context.spot.createdRequests.length, 0);
});

test('sequential rejected or canceled zero-fill market legs fail closed', async (t) => {
  for (const status of ['rejected', 'canceled'] as const) {
    await t.test(status, async (t) => {
      const context = setup(t, 'SPOT_FIRST');
      context.spot.createResults.push(snapshotFor(
        context.strategyId,
        'SPOT_MARKET',
        '1',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '1',
          averagePrice: null,
          status
        }
      ));

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, 'FAILED');
      assert.equal(strategy.failureCode, 'NO_FILL');
      assert.equal(context.contract.createdRequests.length, 0);
    });
  }
});

test('sequential positive fill without a reliable average becomes incomplete', async (t) => {
  for (const averagePrice of [null, '0'] as const) {
    await t.test(String(averagePrice), async (t) => {
      const context = setup(t, 'CONTRACT_FIRST');
      context.contract.createResults.push(snapshotFor(
        context.strategyId,
        'CONTRACT_MARKET',
        '1',
        {
          filledBaseQuantity: '0.8',
          remainingBaseQuantity: '0.2',
          averagePrice
        }
      ));

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
      assert.equal(strategy.failureCode, 'MISSING_AVERAGE_PRICE');
      assert.equal(context.spot.createdRequests.length, 0);
    });
  }
});

test('sequential hedge rejection and cancellation use safe allowlisted codes', async (t) => {
  for (const [status, failureCode] of [
    ['rejected', 'HEDGE_ORDER_REJECTED'],
    ['canceled', 'HEDGE_ORDER_CANCELED']
  ] as const) {
    await t.test(status, async (t) => {
      const context = setup(t, 'SPOT_FIRST');
      context.spot.createResults.push(snapshotFor(
        context.strategyId,
        'SPOT_MARKET',
        '1'
      ));
      context.contract.createResults.push(snapshotFor(
        context.strategyId,
        'CONTRACT_HEDGE_GTC',
        '1',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '1',
          averagePrice: null,
          status
        }
      ));

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
      assert.equal(strategy.failureCode, failureCode);
      assert.equal(context.contract.createdRequests.length, 1);
    });
  }
});

test('create timeout reconciles by stable client id and never resubmits the role', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  const marketClientId = makeClientOrderId(
    context.strategyId,
    'CONTRACT_MARKET'
  );
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));
  context.contract.createErrors.set(
    marketClientId,
    new Error('timeout password=must-never-be-persisted')
  );
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.contract.findRequests[0]?.clientOrderId, marketClientId);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.equal(
    JSON.stringify(context.database.prepare(
      'SELECT * FROM strategies'
    ).all()).includes('must-never-be-persisted'),
    false
  );
});

test('unknown first-leg submission not found by client id fails without retry', async (t) => {
  const contract = new UnknownSubmissionGateway('okx');
  const context = setup(t, 'CONTRACT_FIRST', { contract });

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'FAILED');
  assert.equal(strategy.failureCode, 'ORDER_SUBMISSION_UNKNOWN');
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(
    JSON.stringify(context.database.prepare(
      'SELECT * FROM strategies'
    ).all()).includes('must-never-be-persisted'),
    false
  );
});

test('unknown hedge submission after exposure becomes incomplete without retry', async (t) => {
  const spot = new UnknownSubmissionGateway('bitget');
  const context = setup(t, 'CONTRACT_FIRST', { spot });
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'ORDER_SUBMISSION_UNKNOWN');
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(spot.findRequests.length, 1);
});

test('direct unknown result keeps its known fill exposure when lookup finds nothing', async (t) => {
  const contract = new UnknownStatusGateway('okx');
  const context = setup(t, 'CONTRACT_FIRST', { contract });
  contract.result = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      averagePrice: '60000',
      status: 'unknown'
    }
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'ORDER_NOT_FOUND');
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('direct unknown result is durable before its required lookup completes', async (t) => {
  const contract = new BlockingUnknownLookupGateway('okx');
  const context = setup(t, 'CONTRACT_FIRST', { contract });
  contract.result = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      averagePrice: '60000',
      status: 'unknown'
    }
  );

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await contract.lookupStarted;

  try {
    const duringLookup = context.repository.listOrders(context.strategyId)[0];
    assert.equal(duringLookup?.status, 'unknown');
    assert.equal(duringLookup.snapshot?.filledBaseQuantity, '0.4');
  } finally {
    contract.releaseLookup();
    await execution;
  }
  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'HEDGE_INCOMPLETE'
  );
  assert.equal(contract.createdRequests.length, 1);
});

test('concurrent mode preplans both intents before racing exact equal fills', async (t) => {
  const spot = new DeferredCreateGateway('bitget');
  const contract = new DeferredCreateGateway('okx');
  const exactQuantity = '0.123456789012345678901234567890123456789';
  const context = setup(t, 'CONCURRENT', {
    spot,
    contract,
    preflight: {
      requestedBaseQuantity: exactQuantity,
      effectiveBaseQuantity: exactQuantity
    }
  });
  const plannedCounts: number[] = [];
  spot.beforeCreate = () => {
    plannedCounts.push(context.repository.listOrders(context.strategyId).length);
  };
  contract.beforeCreate = () => {
    plannedCounts.push(context.repository.listOrders(context.strategyId).length);
  };
  spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    exactQuantity
  ));
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    exactQuantity,
    { averagePrice: '60001' }
  ));

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(plannedCounts, [2, 2]);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  spot.release();
  contract.release();
  await execution;

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests[0]?.baseQuantity, exactQuantity);
  assert.equal(context.contract.createdRequests[0]?.baseQuantity, exactQuantity);
  assertNoForbiddenSideEffects(context.spot, context.contract);
});

test('concurrent mode sends one exact contract difference at the larger spot average', async (t) => {
  const context = setup(t, 'CONCURRENT');
  const smaller = '0.9999999999999999999999999999999999999999';
  const difference = '0.0000000000000000000000000000000000000001';
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    { averagePrice: '61000.09' }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: smaller,
      remainingBaseQuantity: difference,
      averagePrice: '61010'
    }
  ));
  context.contract.quantizedPrices.set('swap:BTC/USDT', '61000.0');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    difference,
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: difference,
      averagePrice: null,
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'WAITING_HEDGE'
  );
  assert.deepEqual(context.contract.createdRequests[1], {
    symbol: SYMBOL,
    kind: 'swap',
    type: 'limit',
    side: 'sell',
    baseQuantity: difference,
    price: '61000.0',
    timeInForce: 'GTC',
    clientOrderId: makeClientOrderId(
      context.strategyId,
      'CONTRACT_HEDGE_GTC'
    ),
    positionSide: 'SHORT',
    marginMode: 'cross'
  });
  assert.equal(context.spot.createdRequests.length, 1);
});

test('concurrent arithmetic is isolated from ambient Decimal precision and exponent settings', async (t) => {
  const originalDecimalSettings = {
    precision: Decimal.precision,
    rounding: Decimal.rounding,
    minE: Decimal.minE,
    maxE: Decimal.maxE,
    toExpNeg: Decimal.toExpNeg,
    toExpPos: Decimal.toExpPos,
    modulo: Decimal.modulo,
    crypto: Decimal.crypto
  };
  t.after(() => Decimal.set(originalDecimalSettings));
  const spot = new DirectResultGateway('bitget');
  const contract = new DirectResultGateway('okx');
  const larger = '100000000000000000001';
  const smaller = '100000000000000000000';
  const context = setup(t, 'CONCURRENT', {
    spot,
    contract,
    preflight: {
      requestedBaseQuantity: larger,
      effectiveBaseQuantity: larger
    }
  });
  spot.directResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    larger
  ));
  contract.directResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    larger,
    {
      filledBaseQuantity: smaller,
      remainingBaseQuantity: '1',
      averagePrice: '60001'
    }
  ));
  contract.directResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  Decimal.set({
    precision: 1,
    rounding: Decimal.ROUND_UP,
    minE: -2,
    maxE: 2
  });

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'WAITING_HEDGE'
  );
  assert.equal(context.contract.createdRequests[1]?.baseQuantity, '1');
});

test('concurrent mode sends one spot difference at the larger contract average', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '60990'
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    { averagePrice: '61010.09' }
  ));
  context.spot.quantizedPrices.set('spot:BTC/USDT', '61010.0');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.4',
    { averagePrice: '61010' }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.deepEqual(context.spot.createdRequests[1], {
    symbol: SYMBOL,
    kind: 'spot',
    type: 'limit',
    side: 'buy',
    baseQuantity: '0.4',
    price: '61010.0',
    timeInForce: 'GTC',
    clientOrderId: makeClientOrderId(
      context.strategyId,
      'SPOT_HEDGE_GTC'
    )
  });
});

test('concurrent mode with two reliable zero fills fails without difference order', async (t) => {
  const context = setup(t, 'CONCURRENT');
  for (const [gateway, role] of [
    [context.spot, 'SPOT_MARKET'],
    [context.contract, 'CONTRACT_MARKET']
  ] as const) {
    gateway.createResults.push(snapshotFor(
      context.strategyId,
      role,
      '1',
      {
        filledBaseQuantity: '0',
        remainingBaseQuantity: '1',
        averagePrice: null
      }
    ));
  }

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'FAILED');
  assert.equal(strategy.failureCode, 'NO_FILL');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
});

test('concurrent rejection or cancellation with opposite exposure never submits a difference', async (t) => {
  for (const status of ['rejected', 'canceled'] as const) {
    await t.test(status, async (t) => {
      const context = setup(t, 'CONCURRENT');
      context.spot.createResults.push(snapshotFor(
        context.strategyId,
        'SPOT_MARKET',
        '1'
      ));
      context.contract.createResults.push(snapshotFor(
        context.strategyId,
        'CONTRACT_MARKET',
        '1',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '1',
          averagePrice: null,
          status
        }
      ));

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
      assert.equal(strategy.failureCode, 'NO_FILL');
      assert.equal(context.repository.listOrders(context.strategyId).length, 2);
      assert.equal(context.spot.createdRequests.length, 1);
      assert.equal(context.contract.createdRequests.length, 1);
    });
  }
});

test('concurrent positive fill with missing average fails incomplete before difference order', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.7',
      remainingBaseQuantity: '0.3',
      averagePrice: null
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '61010'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'MISSING_AVERAGE_PRICE');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
});

test('concurrent missing average takes precedence over another unknown submission', async (t) => {
  const spot = new UnknownSubmissionGateway('bitget');
  const context = setup(t, 'CONCURRENT', { spot });
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: null
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'MISSING_AVERAGE_PRICE');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
});

test('repository snapshot failure is preserved after a safe generic transition', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  const repositoryFailure = new Error('repository-integrity-failure');
  const writableRepository = context.repository as unknown as {
    attachOrderSnapshot(
      strategyOrderId: string,
      snapshot: OrderSnapshot
    ): void;
  };
  writableRepository.attachOrderSnapshot = () => {
    throw repositoryFailure;
  };
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  await assert.rejects(
    context.coordinator.confirmAndExecute(context.strategyId),
    (error) => error === repositoryFailure
  );

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.createdRequests.length, 0);
});

test('sequential restart reconciles an existing first role before creating only its hedge', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );
  context.contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'WAITING_HEDGE'
  );
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 1);
});

test('sequential restart reconciles a persisted hedge without re-quantizing its price', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  const marketRequest = requestFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  );
  const market = context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    marketRequest
  );
  context.repository.attachOrderSnapshot(
    market.id,
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );
  context.repository.planOrder(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    requestFor(
      context.strategyId,
      'SPOT_HEDGE_GTC',
      '1',
      'cross',
      '59999.9'
    )
  );
  context.spot.seedObservedOrder(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  context.spot.quantizePrice = async () => {
    throw new Error('market metadata unavailable during restart');
  };

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'WAITING_HEDGE'
  );
  assert.equal(context.spot.quantizeRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.spot.findRequests.length, 1);
});

test('concurrent restart reconciles two existing market intents without recreating either', async (t) => {
  const context = setup(t, 'CONCURRENT');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  for (const [gateway, role] of [
    [context.spot, 'SPOT_MARKET'],
    [context.contract, 'CONTRACT_MARKET']
  ] as const) {
    context.repository.planOrder(
      context.strategyId,
      role,
      requestFor(context.strategyId, role, '1')
    );
    gateway.seedObservedOrder(snapshotFor(
      context.strategyId,
      role,
      '1',
      { averagePrice: role === 'SPOT_MARKET' ? '60000' : '60001' }
    ));
  }

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.findRequests.length, 1);
  assert.equal(context.contract.findRequests.length, 1);
});

test('concurrent restart reconciles a persisted difference without recomputing its price', async (t) => {
  const context = setup(t, 'CONCURRENT');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  const spotMarketRequest = requestFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  );
  const spotMarket = context.repository.planOrder(
    context.strategyId,
    'SPOT_MARKET',
    spotMarketRequest
  );
  context.repository.attachOrderSnapshot(
    spotMarket.id,
    snapshotFor(context.strategyId, 'SPOT_MARKET', '1')
  );
  const contractMarketRequest = requestFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  );
  const contractMarket = context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    contractMarketRequest
  );
  context.repository.attachOrderSnapshot(
    contractMarket.id,
    snapshotFor(
      context.strategyId,
      'CONTRACT_MARKET',
      '1',
      {
        filledBaseQuantity: '0.6',
        remainingBaseQuantity: '0.4',
        averagePrice: '60001'
      }
    )
  );
  context.repository.planOrder(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    requestFor(
      context.strategyId,
      'CONTRACT_HEDGE_GTC',
      '0.4',
      'cross',
      '59999.9'
    )
  );
  context.contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '0.4',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.4',
      averagePrice: null,
      status: 'open'
    }
  ));
  context.contract.quantizedPrices.set('swap:BTC/USDT', '12345.6');

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'WAITING_HEDGE'
  );
  assert.equal(context.contract.quantizeRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.contract.findRequests.length, 1);
});

test('concurrent restart with only one persisted market intent never starts the missing leg', async (t) => {
  const context = setup(t, 'CONCURRENT');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  context.repository.planOrder(
    context.strategyId,
    'SPOT_MARKET',
    requestFor(context.strategyId, 'SPOT_MARKET', '1')
  );
  context.spot.seedObservedOrder(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.spot.findRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.repository.listOrders(context.strategyId).length, 1);
});

test('concurrent restart reconciles an extra hedge instead of hiding its exposure', async (t) => {
  const context = setup(t, 'CONCURRENT');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  const spotMarketRequest = requestFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  );
  const spotMarket = context.repository.planOrder(
    context.strategyId,
    'SPOT_MARKET',
    spotMarketRequest
  );
  context.repository.attachOrderSnapshot(
    spotMarket.id,
    snapshotFor(
      context.strategyId,
      'SPOT_MARKET',
      '1',
      {
        filledBaseQuantity: '0',
        remainingBaseQuantity: '1',
        averagePrice: null
      }
    )
  );
  context.repository.planOrder(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    requestFor(context.strategyId, 'CONTRACT_HEDGE_GTC', '1')
  );
  context.contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
});

test('concurrent equal-fill restart never declares hedged with an extra hedge role', async (t) => {
  const context = setup(t, 'CONCURRENT');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  for (const [role, gateway] of [
    ['SPOT_MARKET', context.spot],
    ['CONTRACT_MARKET', context.contract]
  ] as const) {
    const request = requestFor(context.strategyId, role, '1');
    const planned = context.repository.planOrder(
      context.strategyId,
      role,
      request
    );
    context.repository.attachOrderSnapshot(
      planned.id,
      snapshotFor(context.strategyId, role, '1')
    );
    assert.equal(gateway.createdRequests.length, 0);
  }
  context.repository.planOrder(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    requestFor(context.strategyId, 'SPOT_HEDGE_GTC', '0.2')
  );
  context.spot.seedObservedOrder(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.2'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
});

test('concurrent market lookup failures still reconcile a persisted hedge exactly once', async (t) => {
  const context = setup(t, 'CONCURRENT');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  context.repository.planOrder(
    context.strategyId,
    'SPOT_MARKET',
    requestFor(context.strategyId, 'SPOT_MARKET', '1')
  );
  context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );
  context.repository.planOrder(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    requestFor(context.strategyId, 'SPOT_HEDGE_GTC', '0.2')
  );
  context.spot.seedObservedOrder(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.2'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.findRequests.length, 2);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
});

test('sequential restart reconciles every mode-inconsistent extra role', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  assert.equal(
    context.repository.claimForExecution(context.strategyId),
    true
  );
  context.repository.planOrder(
    context.strategyId,
    'SPOT_MARKET',
    requestFor(context.strategyId, 'SPOT_MARKET', '1')
  );
  context.spot.seedObservedOrder(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.findRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
});

test('a second confirmation and a failed competing claim never submit any role twice', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    { averagePrice: '60001' }
  ));

  await Promise.all([
    context.coordinator.confirmAndExecute(context.strategyId),
    context.coordinator.confirmAndExecute(context.strategyId)
  ]);
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
});

test('pre-existing planned or snapshotted pending roles are never submitted', async (t) => {
  await t.test('planned', async (t) => {
    const context = setup(t, 'SPOT_FIRST');
    context.repository.planOrder(
      context.strategyId,
      'SPOT_MARKET',
      requestFor(context.strategyId, 'SPOT_MARKET', '1')
    );

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(
      context.repository.getStrategy(context.strategyId).state,
      'PENDING_CONFIRMATION'
    );
    assert.equal(context.spot.createdRequests.length, 0);
  });

  await t.test('snapshot', async (t) => {
    const context = setup(t, 'SPOT_FIRST');
    const planned = context.repository.planOrder(
      context.strategyId,
      'SPOT_MARKET',
      requestFor(context.strategyId, 'SPOT_MARKET', '1')
    );
    context.repository.attachOrderSnapshot(
      planned.id,
      snapshotFor(context.strategyId, 'SPOT_MARKET', '1')
    );

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(
      context.repository.getStrategy(context.strategyId).state,
      'PENDING_CONFIRMATION'
    );
    assert.equal(context.spot.createdRequests.length, 0);
    assert.equal(context.contract.createdRequests.length, 0);
  });
});
