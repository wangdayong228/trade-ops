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
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import { NoOrderSubmittedError } from '../../src/exchanges/exchange-gateway.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import { OrderMonitor } from '../../src/strategy/order-monitor.js';
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
  readonly accountSettingsRequests: string[] = [];
  readonly accountSettingsResults: Array<AccountSettings | Error> = [];
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

  override async fetchAccountSettings(
    symbol: string
  ): Promise<AccountSettings> {
    this.accountSettingsRequests.push(symbol);
    const result = this.accountSettingsResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result ?? super.fetchAccountSettings(symbol);
  }

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

class PreSubmissionRejectingGateway extends TrackingGateway {
  constructor(
    exchangeId: string,
    private readonly rejectedType: OrderRequest['type'] | 'all'
  ) {
    super(exchangeId);
  }

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    if (this.rejectedType === 'all' || request.type === this.rejectedType) {
      throw new NoOrderSubmittedError();
    }
    return super.createOrder(request);
  }
}

class DeferredCreateGateway extends TrackingGateway {
  #release: (() => void) | undefined;
  #markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.#markStarted = resolve;
  });
  createStarts = 0;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.beforeCreate?.();
    this.createStarts += 1;
    this.#markStarted?.();
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
  const preview = preflight(mode, options.preflight);
  contract.accountSettings = { ...preview.accountSettings };
  const strategyId = repository.createPending(preview).id;

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

test('coordinator never claims or submits a persisted one-way strategy', async (t) => {
  const context = setup(t, 'CONCURRENT', {
    preflight: {
      accountSettings: {
        marginMode: 'cross',
        positionMode: 'one-way',
        leverage: '2'
      }
    }
  });

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'PENDING_CONFIRMATION'
  );
  assert.equal(context.repository.listOrders(context.strategyId).length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
});

test('fresh contract settings reject one-way, unknown, margin drift, and leverage drift before any order', async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly settings: AccountSettings;
  }[] = [
    {
      name: 'one-way position mode',
      settings: {
        marginMode: 'cross',
        positionMode: 'one-way',
        leverage: '2'
      }
    },
    {
      name: 'unknown position mode',
      settings: {
        marginMode: 'cross',
        positionMode: 'unknown',
        leverage: '2'
      }
    },
    {
      name: 'margin mode drift',
      settings: {
        marginMode: 'isolated',
        positionMode: 'hedged',
        leverage: '2'
      }
    },
    {
      name: 'leverage drift',
      settings: {
        marginMode: 'cross',
        positionMode: 'hedged',
        leverage: '3'
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const context = setup(t, 'CONTRACT_FIRST');
      context.contract.accountSettingsResults.push(testCase.settings);

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, 'FAILED');
      assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
      assert.equal(context.repository.listOrders(context.strategyId).length, 0);
      assert.equal(context.contract.accountSettingsRequests.length, 1);
      assert.equal(context.contract.createdRequests.length, 0);
      assert.equal(context.spot.createdRequests.length, 0);
    });
  }
});

test('fresh settings fetch uncertainty stays executing and submits only after a later valid check', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.accountSettingsResults.push(
    new Error('temporary account settings failure')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.listOrders(context.strategyId).length, 0);
  assert.equal(context.contract.createdRequests.length, 0);

  context.contract.accountSettingsResults.push(
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2.0'
    },
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2.00'
    }
  );
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'FAILED');
  assert.equal(context.repository.getStrategy(context.strategyId).failureCode, 'NO_FILL');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.contract.accountSettingsRequests.length, 3);
});

test('fresh settings drift classifies persisted exposure conservatively', async (t) => {
  const cases = [
    {
      name: 'planned intent is uncertain exposure',
      snapshot: null,
      expectedState: 'HEDGE_INCOMPLETE'
    },
    {
      name: 'open zero fill is uncertain exposure',
      snapshot: {
        filledBaseQuantity: '0',
        remainingBaseQuantity: '1',
        averagePrice: null,
        status: 'open'
      },
      expectedState: 'HEDGE_INCOMPLETE'
    },
    {
      name: 'terminal positive fill is known exposure',
      snapshot: {
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0.6',
        averagePrice: '61234',
        status: 'closed'
      },
      expectedState: 'HEDGE_INCOMPLETE'
    },
    {
      name: 'reliable terminal zero fill excludes exposure',
      snapshot: {
        filledBaseQuantity: '0',
        remainingBaseQuantity: '1',
        averagePrice: null,
        status: 'canceled'
      },
      expectedState: 'FAILED'
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const context = setup(t, 'CONTRACT_FIRST');
      assert.equal(context.repository.claimForExecution(context.strategyId), true);
      const order = context.repository.planOrder(
        context.strategyId,
        'CONTRACT_MARKET',
        requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
      );
      if (testCase.snapshot !== null) {
        context.repository.attachOrderSnapshot(
          order.id,
          snapshotFor(
            context.strategyId,
            'CONTRACT_MARKET',
            '1',
            testCase.snapshot
          )
        );
      }
      context.contract.accountSettingsResults.push({
        marginMode: 'isolated',
        positionMode: 'hedged',
        leverage: '2'
      });

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, testCase.expectedState);
      assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
      assert.equal(context.contract.createdRequests.length, 0);
      assert.equal(context.contract.findRequests.length, 0);
    });
  }
});

test('repository uncertainty while classifying settings drift remains recoverable', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );
  context.contract.accountSettingsResults.push({
    marginMode: 'isolated',
    positionMode: 'hedged',
    leverage: '2'
  });
  const originalListOrders = context.repository.listOrders.bind(
    context.repository
  );
  let failOnce = true;
  context.repository.listOrders = (strategyId) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('temporary exposure read failure');
    }
    return originalListOrders(strategyId);
  };

  await context.coordinator.confirmAndExecute(context.strategyId);
  context.repository.listOrders = originalListOrders;

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.getStrategy(context.strategyId).failureCode, null);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.contract.findRequests.length, 0);
});

test('spot-first rechecks contract settings after the spot fill and before contract create', async (t) => {
  const context = setup(t, 'SPOT_FIRST');
  context.contract.accountSettingsResults.push(
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2.0'
    },
    {
      marginMode: 'isolated',
      positionMode: 'hedged',
      leverage: '2'
    }
  );
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '61234'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.contract.accountSettingsRequests.length, 3);
  assert.equal(
    context.repository.listOrders(context.strategyId).filter(
      (order) => order.role === 'CONTRACT_HEDGE_GTC'
    ).length,
    0
  );
});

test('second-leg settings fetch uncertainty recovers without stranding a planned intent', async (t) => {
  const context = setup(t, 'SPOT_FIRST');
  context.contract.accountSettingsResults.push(
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    new Error('temporary second-leg settings failure')
  );
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '61234'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map((order) => order.role),
    ['SPOT_MARKET']
  );
  assert.equal(context.contract.createdRequests.length, 0);

  context.contract.accountSettingsResults.push(
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2.0'
    },
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2.00'
    }
  );
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '0.6'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.contract.findRequests.length, 0);
  assert.equal(context.contract.accountSettingsRequests.length, 5);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map((order) => order.role),
    ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC']
  );
});

test('concurrent mode rechecks settings for each new create and blocks both on drift', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.contract.accountSettingsResults.push(
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2.00'
    },
    {
      marginMode: 'cross',
      positionMode: 'one-way',
      leverage: '2'
    }
  );
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'FAILED');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.repository.listOrders(context.strategyId).length, 0);
  assert.equal(context.contract.accountSettingsRequests.length, 3);
});

test('lookup-only recovery checks fresh settings once without treating the existing role as a new create', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );
  context.contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  context.contract.accountSettingsResults.push({
    marginMode: 'cross',
    positionMode: 'hedged',
    leverage: '2.0'
  });

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.contract.accountSettingsRequests.length, 1);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

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
        positionMode: 'hedged',
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

test('sequential open market remains executing until terminal observation then hedges once', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  context.contract.fetchResults.set('contract_market-order', [
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1', {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      averagePrice: '60002',
      status: 'open',
      updatedAt: '2026-07-26T00:02:00.000Z'
    }),
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1', {
      filledBaseQuantity: '0.7',
      remainingBaseQuantity: '0.3',
      averagePrice: '60003',
      status: 'closed',
      updatedAt: '2026-07-26T00:03:00.000Z'
    })
  ]);
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.7',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.7',
      averagePrice: null,
      status: 'open'
    }
  ));
  const monitor = new OrderMonitor(
    new ExchangeRegistry(new Map([
      ['bitget', context.spot],
      ['okx', context.contract]
    ])),
    context.repository
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.spot.createdRequests.length, 0);

  await monitor.reconcileStrategy(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.spot.createdRequests.length, 0);

  await monitor.reconcileStrategy(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.spot.createdRequests.length, 0);

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests[0]?.baseQuantity, '0.7');
  assert.equal(context.spot.createdRequests[0]?.price, '60003');
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'WAITING_HEDGE');
});

test('concurrent open markets progress asynchronously without an early GTC or terminal state', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.2',
      remainingBaseQuantity: '0.8',
      averagePrice: '60000',
      status: 'open'
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  context.spot.fetchResults.set('spot_market-order', [
    snapshotFor(context.strategyId, 'SPOT_MARKET', '1', {
      filledBaseQuantity: '0.8',
      remainingBaseQuantity: '0.2',
      averagePrice: '60001',
      status: 'closed',
      updatedAt: '2026-07-26T00:02:00.000Z'
    })
  ]);
  context.contract.fetchResults.set('contract_market-order', [
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1', {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      averagePrice: '60002',
      status: 'open',
      updatedAt: '2026-07-26T00:02:00.000Z'
    }),
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1', {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '60003',
      status: 'canceled',
      updatedAt: '2026-07-26T00:03:00.000Z'
    })
  ]);
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '0.2',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.2',
      averagePrice: null,
      status: 'open'
    }
  ));
  const monitor = new OrderMonitor(
    new ExchangeRegistry(new Map([
      ['bitget', context.spot],
      ['okx', context.contract]
    ])),
    context.repository
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);

  await monitor.reconcileStrategy(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);

  await monitor.reconcileStrategy(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 2);
  assert.equal(context.contract.createdRequests[1]?.type, 'limit');
  assert.equal(context.contract.createdRequests[1]?.baseQuantity, '0.2');
  assert.equal(context.contract.createdRequests[1]?.price, '60001');
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'WAITING_HEDGE');
});

test('create side effect plus transient lookup error remains recoverable and never recreates', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  const marketClientId = makeClientOrderId(context.strategyId, 'CONTRACT_MARKET');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  context.contract.createErrors.set(
    marketClientId,
    new Error('timeout apiKey=must-never-escape')
  );
  const originalFind = context.contract.findOrderByClientId.bind(context.contract);
  let lookupCount = 0;
  context.contract.findOrderByClientId = async (clientOrderId, symbol, kind) => {
    lookupCount += 1;
    if (lookupCount === 1) {
      context.contract.findRequests.push({ clientOrderId, symbol, kind });
      throw new Error('lookup secret=must-never-escape');
    }
    return originalFind(clientOrderId, symbol, kind);
  };
  const monitor = new OrderMonitor(
    new ExchangeRegistry(new Map([
      ['bitget', context.spot],
      ['okx', context.contract]
    ])),
    context.repository
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.getStrategy(context.strategyId).failureCode, null);
  assert.equal(context.contract.createdRequests.length, 1);

  await monitor.reconcileStrategy(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.repository.listOrders(context.strategyId)[0]?.status, 'open');
  assert.doesNotMatch(
    JSON.stringify(context.database.prepare('SELECT * FROM strategies').all()),
    /must-never-escape/
  );
});

test('create snapshot attach failure remains executing for monitor recovery by client id', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));
  const originalAttach = context.repository.attachOrderSnapshot.bind(context.repository);
  let failAttach = true;
  context.repository.attachOrderSnapshot = (orderId, snapshot) => {
    if (failAttach) {
      failAttach = false;
      throw new Error('sqlite password=must-never-escape');
    }
    originalAttach(orderId, snapshot);
  };
  const monitor = new OrderMonitor(
    new ExchangeRegistry(new Map([
      ['bitget', context.spot],
      ['okx', context.contract]
    ])),
    context.repository
  );

  await assert.doesNotReject(
    context.coordinator.confirmAndExecute(context.strategyId)
  );
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.getStrategy(context.strategyId).failureCode, null);
  assert.equal(context.contract.createdRequests.length, 1);

  await monitor.reconcileStrategy(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.repository.listOrders(context.strategyId)[0]?.status, 'open');
  assert.doesNotMatch(
    JSON.stringify(context.database.prepare('SELECT * FROM strategies').all()),
    /must-never-escape/
  );
});

test('sequential canceled-positive market hedges the exact reliable fill', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.35',
      remainingBaseQuantity: '0.65',
      averagePrice: '60004',
      status: 'canceled'
    }
  ));
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.35',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.35',
      averagePrice: null,
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.spot.createdRequests[0]?.baseQuantity, '0.35');
  assert.equal(context.spot.createdRequests[0]?.price, '60004');
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'WAITING_HEDGE');
});

test('concurrent canceled-positive markets hedge the exact difference or finish equal', async (t) => {
  await t.test('difference', async (t) => {
    const context = setup(t, 'CONCURRENT');
    context.spot.createResults.push(snapshotFor(
      context.strategyId,
      'SPOT_MARKET',
      '1',
      {
        filledBaseQuantity: '0.8',
        remainingBaseQuantity: '0.2',
        averagePrice: '60005',
        status: 'closed'
      }
    ));
    context.contract.createResults.push(snapshotFor(
      context.strategyId,
      'CONTRACT_MARKET',
      '1',
      {
        filledBaseQuantity: '0.55',
        remainingBaseQuantity: '0.45',
        averagePrice: '60006',
        status: 'canceled'
      }
    ));
    context.contract.createResults.push(snapshotFor(
      context.strategyId,
      'CONTRACT_HEDGE_GTC',
      '0.25',
      {
        filledBaseQuantity: '0',
        remainingBaseQuantity: '0.25',
        averagePrice: null,
        status: 'open'
      }
    ));

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(context.contract.createdRequests[1]?.baseQuantity, '0.25');
    assert.equal(context.contract.createdRequests[1]?.price, '60005');
    assert.equal(context.repository.getStrategy(context.strategyId).state, 'WAITING_HEDGE');
  });

  await t.test('equal', async (t) => {
    const context = setup(t, 'CONCURRENT');
    context.spot.createResults.push(snapshotFor(
      context.strategyId,
      'SPOT_MARKET',
      '1',
      {
        filledBaseQuantity: '0.65',
        remainingBaseQuantity: '0.35',
        averagePrice: '60005',
        status: 'canceled'
      }
    ));
    context.contract.createResults.push(snapshotFor(
      context.strategyId,
      'CONTRACT_MARKET',
      '1',
      {
        filledBaseQuantity: '0.65',
        remainingBaseQuantity: '0.35',
        averagePrice: '60006',
        status: 'closed'
      }
    ));

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
    assert.equal(context.spot.createdRequests.length, 1);
    assert.equal(context.contract.createdRequests.length, 1);
  });
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
      assert.equal(
        strategy.failureCode,
        status === 'rejected' ? 'ORDER_SUBMISSION_FAILED' : 'NO_FILL'
      );
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

test('unknown first-leg submission not found by client id stays recoverable without retry', async (t) => {
  const contract = new UnknownSubmissionGateway('okx');
  const context = setup(t, 'CONTRACT_FIRST', { contract });

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
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

test('unknown hedge submission after exposure stays recoverable without retry', async (t) => {
  const spot = new UnknownSubmissionGateway('bitget');
  const context = setup(t, 'CONTRACT_FIRST', { spot });
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(spot.findRequests.length, 1);
});

test('a typed no-order-submitted first leg fails without lookup or indefinite planned state', async (t) => {
  const contract = new PreSubmissionRejectingGateway('okx', 'all');
  const context = setup(t, 'CONTRACT_FIRST', { contract });

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'FAILED');
  assert.equal(strategy.failureCode, 'ORDER_SUBMISSION_FAILED');
  assert.equal(contract.createdRequests.length, 0);
  assert.equal(contract.findRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('concurrent typed rejection with uncertain companion terminalizes possible exposure', async (t) => {
  const spot = new PreSubmissionRejectingGateway('bitget', 'all');
  const contract = new UnknownSubmissionGateway('okx');
  const context = setup(t, 'CONCURRENT', { spot, contract });

  await context.coordinator.confirmAndExecute(context.strategyId);
  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'ORDER_SUBMISSION_FAILED');
  assert.equal(spot.createdRequests.length, 0);
  assert.equal(spot.findRequests.length, 0);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 1);
});

test('concurrent typed rejection with an open zero-fill companion is incomplete', async (t) => {
  const spot = new PreSubmissionRejectingGateway('bitget', 'all');
  const context = setup(t, 'CONCURRENT', { spot });
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
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

  const strategy = context.repository.getStrategy(context.strategyId);
  const contractOrder = context.repository.listOrders(context.strategyId).find(
    (order) => order.role === 'CONTRACT_MARKET'
  );
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'ORDER_SUBMISSION_FAILED');
  assert.equal(contractOrder?.snapshot?.status, 'open');
  assert.equal(contractOrder?.snapshot?.filledBaseQuantity, '0');
  assert.equal(spot.createdRequests.length, 0);
  assert.equal(spot.findRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 1);
});

test('a typed no-order-submitted too-small derived difference becomes incomplete without lookup', async (t) => {
  const spot = new PreSubmissionRejectingGateway('bitget', 'limit');
  const context = setup(t, 'CONTRACT_FIRST', { spot });
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.0001',
      remainingBaseQuantity: '0.9999',
      averagePrice: '61234'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'ORDER_SUBMISSION_FAILED');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.spot.findRequests.length, 0);
  assert.equal(
    context.repository.listOrders(context.strategyId).filter(
      (order) => order.role === 'SPOT_HEDGE_GTC'
    ).length,
    1
  );
});

test('direct unknown result keeps its known fill recoverable when lookup finds nothing', async (t) => {
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
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('malformed direct unknown result terminalizes before lookup or repository uncertainty', async (t) => {
  const contract = new UnknownStatusGateway('okx');
  const context = setup(t, 'CONTRACT_FIRST', { contract });
  contract.result = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      exchangeId: 'unexpected-exchange',
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      averagePrice: '60000',
      status: 'unknown'
    }
  );
  const originalListOrders = context.repository.listOrders.bind(
    context.repository
  );
  let failCandidateReload = false;
  contract.beforeCreate = () => {
    failCandidateReload = true;
  };
  context.repository.listOrders = (strategyId) => {
    if (failCandidateReload) {
      failCandidateReload = false;
      throw new Error('candidate-reload-failure');
    }
    return originalListOrders(strategyId);
  };

  await context.coordinator.confirmAndExecute(context.strategyId);
  context.repository.listOrders = originalListOrders;

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(failCandidateReload, true);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('direct unknown positive fill rejects a later zero snapshot without downgrading exposure', async (t) => {
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
  contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'unknown'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  const order = context.repository.listOrders(context.strategyId)[0];
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(order?.snapshot?.filledBaseQuantity, '0.4');
  assert.equal(context.repository.listOrderEvents(order!.id).length, 1);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('direct unknown positive fill survives a malformed zero lookup snapshot', async (t) => {
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
  contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0',
      averagePrice: null,
      status: 'unknown'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  const order = context.repository.listOrders(context.strategyId)[0];
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(order?.snapshot?.filledBaseQuantity, '0.4');
  assert.equal(context.repository.listOrderEvents(order!.id).length, 1);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(contract.findRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('candidate positive fill remains known before repository reload failures', async (t) => {
  await t.test('direct identity-malformed result survives list failure', async (t) => {
    const contract = new DirectResultGateway('okx');
    const context = setup(t, 'CONTRACT_FIRST', { contract });
    contract.directResults.push(snapshotFor(
      context.strategyId,
      'CONTRACT_MARKET',
      '1',
      {
        exchangeId: 'unexpected-exchange',
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0.6'
      }
    ));
    const originalListOrders = context.repository.listOrders.bind(
      context.repository
    );
    let failCandidateReload = false;
    contract.beforeCreate = () => {
      failCandidateReload = true;
    };
    context.repository.listOrders = (strategyId) => {
      if (failCandidateReload) {
        failCandidateReload = false;
        throw new Error('candidate-reload-failure');
      }
      return originalListOrders(strategyId);
    };

    await context.coordinator.confirmAndExecute(context.strategyId);
    context.repository.listOrders = originalListOrders;

    const strategy = context.repository.getStrategy(context.strategyId);
    const order = context.repository.listOrders(context.strategyId)[0];
    assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
    assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
    assert.equal(order?.snapshot, null);
    assert.deepEqual(context.repository.listOrderEvents(order!.id), []);
    assert.equal(contract.createdRequests.length, 1);
    assert.equal(contract.findRequests.length, 0);
    assert.equal(context.spot.createdRequests.length, 0);
  });

  await t.test('lookup arithmetic-malformed result survives missing order', async (t) => {
    const context = setup(t, 'CONTRACT_FIRST');
    assert.equal(
      context.repository.claimForExecution(context.strategyId),
      true
    );
    const planned = context.repository.planOrder(
      context.strategyId,
      'CONTRACT_MARKET',
      requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
    );
    context.repository.attachOrderSnapshot(
      planned.id,
      snapshotFor(
        context.strategyId,
        'CONTRACT_MARKET',
        '1',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '1',
          averagePrice: null,
          status: 'unknown'
        }
      )
    );
    context.contract.seedObservedOrder(snapshotFor(
      context.strategyId,
      'CONTRACT_MARKET',
      '1',
      {
        filledBaseQuantity: '0.4',
        remainingBaseQuantity: '0.7',
        updatedAt: '2026-07-26T00:02:00.000Z'
      }
    ));
    const originalFind = context.contract.findOrderByClientId.bind(
      context.contract
    );
    const originalListOrders = context.repository.listOrders.bind(
      context.repository
    );
    let hideCandidateReload = false;
    context.contract.findOrderByClientId = async (...args) => {
      const found = await originalFind(...args);
      hideCandidateReload = true;
      return found;
    };
    context.repository.listOrders = (strategyId) => {
      if (hideCandidateReload) {
        hideCandidateReload = false;
        return [];
      }
      return originalListOrders(strategyId);
    };

    await context.coordinator.confirmAndExecute(context.strategyId);
    context.repository.listOrders = originalListOrders;

    const strategy = context.repository.getStrategy(context.strategyId);
    const order = context.repository.listOrders(context.strategyId)[0];
    assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
    assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
    assert.equal(order?.snapshot?.filledBaseQuantity, '0');
    assert.equal(context.repository.listOrderEvents(order!.id).length, 1);
    assert.equal(context.contract.createdRequests.length, 0);
    assert.equal(context.contract.findRequests.length, 1);
    assert.equal(context.spot.createdRequests.length, 0);
  });
});

test('valid create results survive transient repository reload failures and recover without duplicate create', async (t) => {
  for (const method of ['listOrders', 'getStrategy'] as const) {
    await t.test(method, async (t) => {
      const contract = new DirectResultGateway('okx');
      const context = setup(t, 'CONTRACT_FIRST', { contract });
      const market = snapshotFor(
        context.strategyId,
        'CONTRACT_MARKET',
        '1',
        {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          averagePrice: '61234',
          status: 'closed'
        }
      );
      contract.directResults.push(market);
      contract.seedObservedOrder(market);
      context.spot.createResults.push(snapshotFor(
        context.strategyId,
        'SPOT_HEDGE_GTC',
        '0.4',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '0.4',
          averagePrice: null,
          status: 'open'
        }
      ));
      const originalListOrders = context.repository.listOrders.bind(
        context.repository
      );
      const originalGetStrategy = context.repository.getStrategy.bind(
        context.repository
      );
      let failReload = false;
      contract.beforeCreate = () => {
        failReload = true;
      };
      if (method === 'listOrders') {
        context.repository.listOrders = (strategyId) => {
          if (failReload) {
            failReload = false;
            throw new Error('transient-list-failure');
          }
          return originalListOrders(strategyId);
        };
      } else {
        context.repository.getStrategy = (strategyId) => {
          if (failReload) {
            failReload = false;
            throw new Error('transient-get-failure');
          }
          return originalGetStrategy(strategyId);
        };
      }

      await context.coordinator.confirmAndExecute(context.strategyId);
      context.repository.listOrders = originalListOrders;
      context.repository.getStrategy = originalGetStrategy;

      assert.equal(
        context.repository.getStrategy(context.strategyId).state,
        'EXECUTING'
      );
      assert.equal(
        context.repository.listOrders(context.strategyId)[0]?.snapshot,
        null
      );
      assert.equal(contract.createdRequests.length, 1);
      assert.equal(context.spot.createdRequests.length, 0);

      await context.coordinator.confirmAndExecute(context.strategyId);

      assert.equal(
        context.repository.getStrategy(context.strategyId).state,
        'WAITING_HEDGE'
      );
      assert.equal(contract.createdRequests.length, 1);
      assert.equal(contract.findRequests.length, 1);
      assert.equal(context.spot.createdRequests.length, 1);
      assert.equal(context.spot.createdRequests[0]?.baseQuantity, '0.4');
      assert.equal(context.spot.createdRequests[0]?.price, '61234');
    });
  }
});

test('a definitively missing persisted role after a valid create result still fails safely', async (t) => {
  const contract = new DirectResultGateway('okx');
  const context = setup(t, 'CONTRACT_FIRST', { contract });
  contract.directResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    }
  ));
  const originalListOrders = context.repository.listOrders.bind(
    context.repository
  );
  let hideReload = false;
  contract.beforeCreate = () => {
    hideReload = true;
  };
  context.repository.listOrders = (strategyId) => {
    if (hideReload) {
      hideReload = false;
      return [];
    }
    return originalListOrders(strategyId);
  };

  await context.coordinator.confirmAndExecute(context.strategyId);
  context.repository.listOrders = originalListOrders;

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('attach failure after a persisted positive unknown fill stays recoverable', async (t) => {
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
  contract.seedObservedOrder(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '60000',
      status: 'closed',
      updatedAt: '2026-07-26T00:02:00.000Z'
    }
  ));
  const repositoryFailure = new Error('second-attach-integrity-failure');
  const originalAttach = context.repository.attachOrderSnapshot.bind(
    context.repository
  );
  let attachCalls = 0;
  context.repository.attachOrderSnapshot = (orderId, snapshot) => {
    attachCalls += 1;
    if (attachCalls === 2) {
      throw repositoryFailure;
    }
    originalAttach(orderId, snapshot);
  };

  await assert.doesNotReject(
    context.coordinator.confirmAndExecute(context.strategyId)
  );

  const strategy = context.repository.getStrategy(context.strategyId);
  const order = context.repository.listOrders(context.strategyId)[0];
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(order?.snapshot?.filledBaseQuantity, '0.4');
  assert.equal(context.repository.listOrderEvents(order!.id).length, 1);
  assert.equal(attachCalls, 2);
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
    'EXECUTING'
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

test('concurrent planning failure leaves no orphan and later creates each leg once', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.database.exec(`
    CREATE TRIGGER fail_contract_plan
    BEFORE INSERT ON strategy_orders
    WHEN NEW.role = 'CONTRACT_MARKET'
    BEGIN
      SELECT RAISE(ABORT, 'second plan failed');
    END;
  `);
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  await assert.rejects(
    context.coordinator.confirmAndExecute(context.strategyId),
    /second plan failed/
  );

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.deepEqual(context.repository.listOrders(context.strategyId), []);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);

  context.database.exec('DROP TRIGGER fail_contract_plan');
  await context.coordinator.confirmAndExecute(context.strategyId);

  const orders = context.repository.listOrders(context.strategyId);
  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.deepEqual(
    orders.map((order) => order.role).sort(),
    ['CONTRACT_MARKET', 'SPOT_MARKET']
  );
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
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

test('concurrent reliable positive and zero fills hedge the full difference on the zero side', async (t) => {
  const cases = [
    {
      name: 'closed spot positive and closed contract zero',
      positiveRole: 'SPOT_MARKET',
      positiveStatus: 'closed',
      zeroStatus: 'closed',
      hedgeRole: 'CONTRACT_HEDGE_GTC'
    },
    {
      name: 'canceled spot positive and closed contract zero',
      positiveRole: 'SPOT_MARKET',
      positiveStatus: 'canceled',
      zeroStatus: 'closed',
      hedgeRole: 'CONTRACT_HEDGE_GTC'
    },
    {
      name: 'closed contract positive and canceled spot zero',
      positiveRole: 'CONTRACT_MARKET',
      positiveStatus: 'closed',
      zeroStatus: 'canceled',
      hedgeRole: 'SPOT_HEDGE_GTC'
    },
    {
      name: 'canceled contract positive and canceled spot zero',
      positiveRole: 'CONTRACT_MARKET',
      positiveStatus: 'canceled',
      zeroStatus: 'canceled',
      hedgeRole: 'SPOT_HEDGE_GTC'
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const context = setup(t, 'CONCURRENT');
      const positiveGateway = testCase.positiveRole === 'SPOT_MARKET'
        ? context.spot
        : context.contract;
      const zeroGateway = testCase.positiveRole === 'SPOT_MARKET'
        ? context.contract
        : context.spot;
      const zeroRole = testCase.positiveRole === 'SPOT_MARKET'
        ? 'CONTRACT_MARKET'
        : 'SPOT_MARKET';
      const hedgeGateway = testCase.hedgeRole === 'SPOT_HEDGE_GTC'
        ? context.spot
        : context.contract;

      positiveGateway.createResults.push(snapshotFor(
        context.strategyId,
        testCase.positiveRole,
        '1',
        {
          filledBaseQuantity: '0.75',
          remainingBaseQuantity: '0.25',
          averagePrice: '61234',
          status: testCase.positiveStatus
        }
      ));
      zeroGateway.createResults.push(snapshotFor(
        context.strategyId,
        zeroRole,
        '1',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '1',
          averagePrice: null,
          status: testCase.zeroStatus
        }
      ));
      hedgeGateway.createResults.push(snapshotFor(
        context.strategyId,
        testCase.hedgeRole,
        '0.75',
        {
          filledBaseQuantity: '0',
          remainingBaseQuantity: '0.75',
          averagePrice: null,
          status: 'open'
        }
      ));

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      const hedgeRequest = hedgeGateway.createdRequests[1];
      assert.equal(strategy.state, 'WAITING_HEDGE');
      assert.equal(strategy.failureCode, null);
      assert.equal(hedgeRequest?.baseQuantity, '0.75');
      assert.equal(hedgeRequest?.price, '61234');
      assert.equal(
        context.repository.listOrders(context.strategyId).filter(
          (order) => order.role === testCase.hedgeRole
        ).length,
        1
      );
    });
  }
});

test('concurrent rejected zero side with opposite exposure never submits a difference', async (t) => {
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
      status: 'rejected'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'INCONSISTENT_ORDER_STATE');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
});

test('concurrent equal positive terminal fills do not require either average', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: null,
      status: 'canceled'
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: null,
      status: 'closed'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGED');
  assert.equal(strategy.failureCode, null);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
});

test('concurrent unequal terminal fills require only the larger-side average', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.8',
      remainingBaseQuantity: '0.2',
      averagePrice: '61234',
      status: 'canceled'
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.5',
      remainingBaseQuantity: '0.5',
      averagePrice: null,
      status: 'closed'
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '0.3',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.3',
      averagePrice: null,
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'WAITING_HEDGE');
  assert.equal(strategy.failureCode, null);
  assert.equal(context.contract.createdRequests[1]?.baseQuantity, '0.3');
  assert.equal(context.contract.createdRequests[1]?.price, '61234');
});

test('concurrent unequal terminal fills fail incomplete when the larger-side average is missing', async (t) => {
  const context = setup(t, 'CONCURRENT');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.8',
      remainingBaseQuantity: '0.2',
      averagePrice: null
    }
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.5',
      remainingBaseQuantity: '0.5',
      averagePrice: '61235'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'HEDGE_INCOMPLETE');
  assert.equal(strategy.failureCode, 'MISSING_AVERAGE_PRICE');
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.equal(context.contract.createdRequests.length, 1);
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

test('concurrent unknown submission defers missing-average classification', async (t) => {
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
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
});

test('concurrent attach failure preserves both intents without terminal transition', async (t) => {
  const spot = new DirectResultGateway('bitget');
  const contract = new DirectResultGateway('okx');
  const context = setup(t, 'CONCURRENT', { spot, contract });
  spot.directResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    }
  ));
  contract.directResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null
    }
  ));
  const repositoryFailure = new Error(
    'spot-attach-failure apiKey=must-never-escape'
  );
  const originalAttach = context.repository.attachOrderSnapshot.bind(
    context.repository
  );
  context.repository.attachOrderSnapshot = (orderId, snapshot) => {
    if (snapshot.kind === 'spot') {
      throw repositoryFailure;
    }
    originalAttach(orderId, snapshot);
  };
  const originalTransition = context.repository.transition.bind(
    context.repository
  );
  let transitionCalls = 0;
  context.repository.transition = (...args) => {
    transitionCalls += 1;
    if (transitionCalls === 1) {
      return false;
    }
    return originalTransition(...args);
  };
  await assert.doesNotReject(
    context.coordinator.confirmAndExecute(context.strategyId)
  );

  const strategy = context.repository.getStrategy(context.strategyId);
  const [spotOrder, contractOrder] = context.repository.listOrders(
    context.strategyId
  );
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(spotOrder?.snapshot, null);
  assert.deepEqual(
    context.repository.listOrderEvents(spotOrder!.id),
    []
  );
  assert.equal(contractOrder?.snapshot?.filledBaseQuantity, '0');
  assert.equal(
    context.repository.listOrderEvents(contractOrder!.id).length,
    1
  );
  assert.equal(transitionCalls, 0);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(spot.findRequests.length, 0);
  assert.equal(contract.findRequests.length, 0);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.doesNotMatch(
    JSON.stringify(context.database.prepare('SELECT * FROM strategies').all()),
    /apiKey|must-never-escape/
  );
});

test('concurrent attach failure never invokes a terminal transition', async (t) => {
  const spot = new DirectResultGateway('bitget');
  const contract = new DirectResultGateway('okx');
  const context = setup(t, 'CONCURRENT', { spot, contract });
  spot.directResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    }
  ));
  contract.directResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null
    }
  ));
  const originalAttach = context.repository.attachOrderSnapshot.bind(
    context.repository
  );
  context.repository.attachOrderSnapshot = (orderId, snapshot) => {
    if (snapshot.kind === 'spot') {
      throw new Error('spot attach secret=must-never-escape');
    }
    originalAttach(orderId, snapshot);
  };
  const originalTransition = context.repository.transition.bind(
    context.repository
  );
  let transitionCalls = 0;
  context.repository.transition = () => {
    transitionCalls += 1;
    throw new Error('transition secret=must-never-escape');
  };
  await assert.doesNotReject(
    context.coordinator.confirmAndExecute(context.strategyId)
  );

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'EXECUTING'
  );
  assert.equal(transitionCalls, 0);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);

  context.repository.attachOrderSnapshot = originalAttach;
  context.repository.transition = originalTransition;
  spot.findOrderByClientId = async (clientOrderId, symbol, kind) => {
    spot.findRequests.push({ clientOrderId, symbol, kind });
    return null;
  };

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(spot.findRequests.length, 1);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(contract.createdRequests.length, 1);
  assert.equal(context.repository.listOrders(context.strategyId).length, 2);
  assert.equal(
    context.repository.getStrategy(context.strategyId).failureCode,
    null
  );
});

test('repository snapshot failure preserves a recoverable intent without transition', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  const repositoryFailure = new Error(
    'repository-integrity-failure secret=must-never-escape'
  );
  const writableRepository = context.repository as unknown as {
    attachOrderSnapshot(
      strategyOrderId: string,
      snapshot: OrderSnapshot
    ): void;
  };
  writableRepository.attachOrderSnapshot = () => {
    throw repositoryFailure;
  };
  const originalTransition = context.repository.transition.bind(
    context.repository
  );
  let transitionCalls = 0;
  context.repository.transition = (...args) => {
    transitionCalls += 1;
    if (transitionCalls === 1) {
      return false;
    }
    return originalTransition(...args);
  };
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  await assert.doesNotReject(
    context.coordinator.confirmAndExecute(context.strategyId)
  );

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(transitionCalls, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.doesNotMatch(
    JSON.stringify(context.database.prepare('SELECT * FROM strategies').all()),
    /secret|must-never-escape/
  );
});

test('sequential attach failure never invokes a terminal transition', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    }
  ));
  const originalAttach = context.repository.attachOrderSnapshot.bind(
    context.repository
  );
  context.repository.attachOrderSnapshot = () => {
    throw new Error('market attach secret=must-never-escape');
  };
  const originalTransition = context.repository.transition.bind(
    context.repository
  );
  let transitionCalls = 0;
  context.repository.transition = () => {
    transitionCalls += 1;
    throw new Error('transition secret=must-never-escape');
  };
  await assert.doesNotReject(
    context.coordinator.confirmAndExecute(context.strategyId)
  );

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'EXECUTING'
  );
  assert.equal(transitionCalls, 0);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.repository.listOrders(context.strategyId).length, 1);

  context.repository.attachOrderSnapshot = originalAttach;
  context.repository.transition = originalTransition;
  context.contract.findOrderByClientId = async (
    clientOrderId,
    symbol,
    kind
  ) => {
    context.contract.findRequests.push({ clientOrderId, symbol, kind });
    return null;
  };

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.repository.listOrders(context.strategyId).length, 1);
  assert.equal(
    context.repository.getStrategy(context.strategyId).failureCode,
    null
  );
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

test('concurrent market lookup failures leave a persisted hedge untouched and recoverable', async (t) => {
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
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(context.spot.findRequests.length, 1);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(
    context.repository.listOrders(context.strategyId).find(
      (order) => order.role === 'SPOT_HEDGE_GTC'
    )?.snapshot,
    null
  );
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

test('an active execution owner blocks restart recovery across coordinator instances', async (t) => {
  const spot = new DeferredCreateGateway('bitget');
  const contract = new DeferredCreateGateway('okx');
  const context = setup(t, 'CONCURRENT', { spot, contract });
  spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    { averagePrice: '60001' }
  ));
  const competingCoordinator = new HedgeCoordinator(
    new ExchangeRegistry(new Map([
      ['bitget', spot],
      ['okx', contract]
    ])),
    context.repository
  );
  const originalTransition = context.repository.transition.bind(
    context.repository
  );
  let transitionCalls = 0;
  context.repository.transition = (...args) => {
    transitionCalls += 1;
    return originalTransition(...args);
  };

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await Promise.all([spot.started, contract.started]);

  try {
    await competingCoordinator.confirmAndExecute(context.strategyId);

    assert.equal(
      context.repository.getStrategy(context.strategyId).state,
      'EXECUTING'
    );
    assert.equal(transitionCalls, 0);
    assert.equal(spot.createStarts, 1);
    assert.equal(contract.createStarts, 1);
    assert.equal(spot.findRequests.length, 0);
    assert.equal(contract.findRequests.length, 0);
  } finally {
    spot.release();
    contract.release();
    await execution;
  }

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.equal(transitionCalls, 1);
  assert.equal(spot.createdRequests.length, 1);
  assert.equal(contract.createdRequests.length, 1);
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
