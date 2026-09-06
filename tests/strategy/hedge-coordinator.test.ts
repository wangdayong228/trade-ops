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
  OrderSnapshot,
  StrategyState
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import { NoOrderSubmittedError } from '../../src/exchanges/exchange-gateway.js';
import type {
  OperationalFields,
  OperationalLog
} from '../../src/logging/logger.js';
import type {
  TradeEvent,
  TradeEventSink
} from '../../src/logging/trade-events.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import type {
  OrderSubmissionFailureCode,
  StrategyFailureCode,
  StrategyOrderPlan,
  StrategyOrderRecord,
  StrategyRecord
} from '../../src/storage/strategy-repository.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import {
  HedgeReconciliation,
  type ReconciliationResult,
  type ReconciliationRunner
} from '../../src/strategy/hedge-reconciliation.js';
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

class ReasonedPreSubmissionGateway extends TrackingGateway {
  readonly attempts: OrderRequest[] = [];

  constructor(
    exchangeId: string,
    private readonly rejectedType: OrderRequest['type'],
    private readonly reason: 'UNCLASSIFIED' | 'UNTRADABLE_REQUEST'
  ) {
    super(exchangeId);
  }

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.attempts.push(structuredClone(request));
    if (request.type === this.rejectedType) {
      throw new NoOrderSubmittedError(this.reason);
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

interface TransitionCall {
  readonly strategyId: string;
  readonly from: readonly StrategyState[];
  readonly to: StrategyState;
  readonly failureCode?: StrategyFailureCode;
}

class CoordinatorRepository extends SqliteStrategyRepository {
  atomicPlanCalls = 0;
  readonly transitionCalls: TransitionCall[] = [];
  readonly evidenceCalls: Array<{
    orderId: string;
    failureCode: OrderSubmissionFailureCode;
  }> = [];
  evidenceWriteBehavior: 'delegate' | 'false' | 'throw' = 'delegate';

  override planOrdersAtomically(
    strategyId: string,
    plans: readonly Readonly<StrategyOrderPlan>[]
  ): StrategyOrderRecord[] {
    this.atomicPlanCalls += 1;
    return super.planOrdersAtomically(strategyId, plans);
  }

  override markDefinitelyNotSubmitted(
    orderId: string,
    failureCode: OrderSubmissionFailureCode
  ): boolean {
    this.evidenceCalls.push({ orderId, failureCode });
    if (this.evidenceWriteBehavior === 'throw') {
      throw new Error('private sqlite detail that must not escape');
    }
    if (this.evidenceWriteBehavior === 'false') return false;
    return super.markDefinitelyNotSubmitted(orderId, failureCode);
  }

  override transition(
    strategyId: string,
    from: StrategyState[],
    to: StrategyState,
    failureCode?: StrategyFailureCode
  ): boolean {
    this.transitionCalls.push({
      strategyId,
      from: [...from],
      to,
      ...(failureCode === undefined ? {} : { failureCode })
    });
    return super.transition(strategyId, from, to, failureCode);
  }
}

class ScriptedReconciliation implements ReconciliationRunner {
  readonly calls: string[] = [];

  constructor(private readonly results: ReconciliationResult[]) {}

  async run(strategyId: string): Promise<ReconciliationResult> {
    this.calls.push(strategyId);
    const result = this.results.shift();
    assert.ok(result, 'unexpected reconciliation call');
    return result;
  }
}

class CapturingOperationalLog implements OperationalLog {
  readonly warnings: Array<{
    event: string;
    fields: Readonly<OperationalFields> | undefined;
  }> = [];

  info(): void {}

  warn(event: string, fields?: Readonly<OperationalFields>): void {
    this.warnings.push({ event, fields });
  }

  error(): void {}

  fatal(): void {}
}

function scriptedPending(
  reason: 'ORDER_LOOKUP_FAILED' | 'SUBMISSION_UNCERTAIN' =
    'ORDER_LOOKUP_FAILED'
): ReconciliationResult {
  return {
    kind: 'pending',
    reason,
    strategyState: 'EXECUTING',
    exposureKnown: false
  };
}

interface SetupResult {
  readonly database: Database.Database;
  readonly repository: CoordinatorRepository;
  readonly registry: ExchangeRegistry;
  readonly spot: TrackingGateway;
  readonly contract: TrackingGateway;
  readonly reconciliation: ReconciliationRunner;
  readonly coordinator: HedgeCoordinator;
  readonly strategyId: string;
  readonly tradeEvents: TradeEvent[];
  readonly tradeEventSink: TradeEventSink;
}

function setup(
  t: TestContext,
  mode: ExecutionMode,
  options: {
    spot?: TrackingGateway;
    contract?: TrackingGateway;
    preflight?: Partial<PreflightResult>;
    tradeEvents?: TradeEventSink;
    reconciliation?: ReconciliationRunner;
    operationalLog?: OperationalLog;
  } = {}
): SetupResult {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new CoordinatorRepository(database);
  const spot = options.spot ?? new TrackingGateway('bitget');
  const contract = options.contract ?? new TrackingGateway('okx');
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const preview = preflight(mode, options.preflight);
  spot.markets.set(`spot:${preview.symbol}`, preview.spotMarket);
  contract.markets.set(`swap:${preview.symbol}`, preview.contractMarket);
  contract.accountSettings = { ...preview.accountSettings };
  const strategyId = repository.createPending(preview).id;
  const tradeEvents: TradeEvent[] = [];
  const tradeEventSink = options.tradeEvents ?? {
    record(event: Readonly<TradeEvent>): void {
      tradeEvents.push(structuredClone(event));
    }
  };
  const reconciliation = options.reconciliation ?? new HedgeReconciliation(
    registry,
    repository,
    tradeEventSink,
    options.operationalLog
  );

  return {
    database,
    repository,
    registry,
    spot,
    contract,
    reconciliation,
    coordinator: new HedgeCoordinator(
      registry,
      repository,
      reconciliation,
      tradeEventSink,
      options.operationalLog
    ),
    strategyId,
    tradeEvents,
    tradeEventSink
  };
}

function seedConcurrentMarketEvidence(
  context: SetupResult,
  spotFill = '1',
  contractFill = '0.6'
): readonly [StrategyOrderRecord, StrategyOrderRecord] {
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  const [spotOrder, contractOrder] = context.repository.planOrdersAtomically(
    context.strategyId,
    [
      {
        role: 'SPOT_MARKET',
        request: requestFor(context.strategyId, 'SPOT_MARKET', '1')
      },
      {
        role: 'CONTRACT_MARKET',
        request: requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
      }
    ]
  );
  assert.ok(spotOrder);
  assert.ok(contractOrder);
  context.repository.attachOrderSnapshot(
    spotOrder.id,
    snapshotFor(context.strategyId, 'SPOT_MARKET', '1', {
      filledBaseQuantity: spotFill,
      remainingBaseQuantity: new Decimal('1').minus(spotFill).toString(),
      averagePrice: spotFill === '0' ? null : '60000'
    })
  );
  context.repository.attachOrderSnapshot(
    contractOrder.id,
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1', {
      filledBaseQuantity: contractFill,
      remainingBaseQuantity: new Decimal('1').minus(contractFill).toString(),
      averagePrice: contractFill === '0' ? null : '60010'
    })
  );
  context.repository.atomicPlanCalls = 0;
  return [spotOrder, contractOrder];
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
  }
}

const COMPLETE_ORDER_LIFECYCLE = [
  'order_planned',
  'order_submit_started',
  'order_submit_succeeded',
  'order_status_changed',
  'order_terminal'
] as const;

const ORCHESTRATION_CASES = [
  ['pending', scriptedPending()],
  ['written', { kind: 'written', state: 'HEDGED' }],
  ['observed', { kind: 'observed_state', state: 'HEDGED' }],
  ['waiting', { kind: 'waiting_gtc' }]
] as const satisfies readonly (readonly [string, ReconciliationResult])[];

for (const [name, result] of ORCHESTRATION_CASES) {
  test(`does not submit or transition for ${name}`, async (t) => {
    const reconciliation = new ScriptedReconciliation([result]);
    const context = setup(t, 'CONCURRENT', { reconciliation });

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.deepEqual(reconciliation.calls, [context.strategyId]);
    assert.equal(
      context.spot.createdRequests.length
        + context.contract.createdRequests.length,
      0
    );
    assert.deepEqual(context.repository.transitionCalls, []);
    assert.equal(
      context.repository.getStrategy(context.strategyId).state,
      'EXECUTING'
    );
  });
}

test('atomically plans and submits both concurrent market legs once', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const context = setup(t, 'CONCURRENT', { reconciliation });
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

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.atomicPlanCalls, 1);
  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map(({ role }) => role),
    ['SPOT_MARKET', 'CONTRACT_MARKET']
  );
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .every(({ snapshot: persistedSnapshot }) => persistedSnapshot === null),
    true
  );
  assert.deepEqual(context.spot.createdRequests, [
    requestFor(context.strategyId, 'SPOT_MARKET', '1')
  ]);
  assert.deepEqual(context.contract.createdRequests, [
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  ]);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('holds one operation lock across a bounded market-to-GTC chain', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    {
      kind: 'need_gtc',
      role: 'SPOT_HEDGE_GTC',
      baseQuantity: '1',
      referencePrice: '60010'
    },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const contract = new DeferredCreateGateway('okx');
  t.after(() => contract.release());
  const context = setup(t, 'CONTRACT_FIRST', {
    contract,
    reconciliation
  });
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    { averagePrice: '60010' }
  ));
  context.spot.quantizedPrices.set('spot:BTC/USDT', '60010');
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

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await contract.started;
  const competing = context.coordinator.confirmAndExecute(context.strategyId);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  try {
    assert.deepEqual(reconciliation.calls, [context.strategyId]);
    assert.equal(contract.createStarts, 1);
    assert.equal(context.spot.createdRequests.length, 0);
  } finally {
    contract.release();
  }
  await Promise.all([execution, competing]);

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map(({ role }) => role),
    ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC']
  );
  assert.deepEqual(context.contract.createdRequests, [
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  ]);
  assert.deepEqual(context.spot.createdRequests, [
    requestFor(
      context.strategyId,
      'SPOT_HEDGE_GTC',
      '1',
      'cross',
      '60010'
    )
  ]);
  assert.equal(context.contract.accountSettingsRequests.length, 2);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('submits only the GTC authorized by the current run result', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    {
      kind: 'need_gtc',
      role: 'CONTRACT_HEDGE_GTC',
      baseQuantity: '0.4',
      referencePrice: '61234.56'
    },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const context = setup(t, 'CONCURRENT', { reconciliation });
  seedConcurrentMarketEvidence(context);
  context.contract.quantizedPrices.set('swap:BTC/USDT', '61234.5');
  context.contract.createResults.push(snapshotFor(
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

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(context.contract.quantizeRequests, [{
    symbol: SYMBOL,
    kind: 'swap',
    price: '61234.56'
  }]);
  assert.deepEqual(context.contract.createdRequests, [
    requestFor(
      context.strategyId,
      'CONTRACT_HEDGE_GTC',
      '0.4',
      'cross',
      '61234.5'
    )
  ]);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('fails closed when final GTC price quantization is unavailable', async (t) => {
  const reconciliation = new ScriptedReconciliation([{
    kind: 'need_gtc',
    role: 'CONTRACT_HEDGE_GTC',
    baseQuantity: '0.4',
    referencePrice: '60000'
  }]);
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONCURRENT', {
    reconciliation,
    operationalLog: operations
  });
  seedConcurrentMarketEvidence(context);
  context.contract.quantizePrice = async () => {
    throw new Error('private price adapter failure');
  };

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [context.strategyId]);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .some(({ role }) => role.endsWith('_HEDGE_GTC')),
    false
  );
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_price_pending'
    ).length,
    1
  );
  assert.equal(
    JSON.stringify(operations.warnings).includes('private price adapter'),
    false
  );
});

test('does not retain a GTC authorization after its account guard fails', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    {
      kind: 'need_gtc',
      role: 'CONTRACT_HEDGE_GTC',
      baseQuantity: '0.4',
      referencePrice: '60000'
    },
    scriptedPending()
  ]);
  const context = setup(t, 'CONCURRENT', { reconciliation });
  seedConcurrentMarketEvidence(context);
  context.contract.accountSettingsResults.push(
    new Error('credential text must not escape')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.equal(context.contract.accountSettingsRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('runs reconciliation before any account guard in WAITING_HEDGE', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'written', state: 'HEDGED' }
  ]);
  const context = setup(t, 'CONTRACT_FIRST', { reconciliation });
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  assert.equal(context.repository.transition(
    context.strategyId,
    ['EXECUTING'],
    'WAITING_HEDGE'
  ), true);
  context.repository.transitionCalls.length = 0;
  context.contract.accountSettingsResults.push(
    new Error('account settings unavailable')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [context.strategyId]);
  assert.equal(context.contract.accountSettingsRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('never submits an order record that existed before the authorization', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const context = setup(t, 'CONTRACT_FIRST', { reconciliation });
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  const existing = context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map(({ id }) => id),
    [existing.id]
  );
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('waits for both submissions and retains the operation lock after one rejects', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const contract = new DeferredCreateGateway('okx');
  t.after(() => contract.release());
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONCURRENT', {
    contract,
    reconciliation,
    operationalLog: operations
  });
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  type SubmitNew = (
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>
  ) => Promise<void>;
  const mutable = context.coordinator as unknown as {
    submitNew: SubmitNew;
  };
  const realSubmit = mutable.submitNew.bind(context.coordinator);
  mutable.submitNew = async (strategy, order) => {
    if (order.role === 'SPOT_MARKET') {
      throw new Error('unexpected internal submission failure');
    }
    await realSubmit(strategy, order);
  };

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await contract.started;
  try {
    await context.coordinator.confirmAndExecute(context.strategyId);
    assert.deepEqual(reconciliation.calls, [context.strategyId]);
  } finally {
    contract.release();
    await execution;
  }

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.equal(contract.createStarts, 1);
  assert.equal(context.repository.atomicPlanCalls, 1);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_internal_failure'
    ).length,
    1
  );
  assert.equal(
    JSON.stringify(operations.warnings).includes(
      'unexpected internal submission failure'
    ),
    false
  );
});

interface NoSubmitCase {
  readonly name: string;
  readonly authorization: 'market' | 'gtc';
  readonly reason: 'UNCLASSIFIED' | 'UNTRADABLE_REQUEST';
  readonly expectedFailureCode: OrderSubmissionFailureCode;
}

const NO_SUBMIT_CASES: readonly NoSubmitCase[] = [
  {
    name: 'unclassified initial market order',
    authorization: 'market',
    reason: 'UNCLASSIFIED',
    expectedFailureCode: 'ORDER_SUBMISSION_FAILED'
  },
  {
    name: 'untradable initial market order',
    authorization: 'market',
    reason: 'UNTRADABLE_REQUEST',
    expectedFailureCode: 'ORDER_SUBMISSION_FAILED'
  },
  {
    name: 'unclassified residual GTC',
    authorization: 'gtc',
    reason: 'UNCLASSIFIED',
    expectedFailureCode: 'ORDER_SUBMISSION_FAILED'
  },
  {
    name: 'untradable residual GTC',
    authorization: 'gtc',
    reason: 'UNTRADABLE_REQUEST',
    expectedFailureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
  }
];

for (const testCase of NO_SUBMIT_CASES) {
  test(`persists definite no-submit evidence for ${testCase.name}`, async (t) => {
    const rejectedType = testCase.authorization === 'market'
      ? 'market'
      : 'limit';
    const contract = new ReasonedPreSubmissionGateway(
      'okx',
      rejectedType,
      testCase.reason
    );
    const authorization: ReconciliationResult =
      testCase.authorization === 'market'
        ? { kind: 'awaiting_market_submission' }
        : {
            kind: 'need_gtc',
            role: 'CONTRACT_HEDGE_GTC',
            baseQuantity: '0.4',
            referencePrice: '60000'
          };
    const reconciliation = new ScriptedReconciliation([
      authorization,
      scriptedPending('SUBMISSION_UNCERTAIN')
    ]);
    const context = setup(
      t,
      testCase.authorization === 'market'
        ? 'CONTRACT_FIRST'
        : 'CONCURRENT',
      { contract, reconciliation }
    );
    if (testCase.authorization === 'gtc') {
      seedConcurrentMarketEvidence(context);
    }

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(contract.attempts.length, 1);
    assert.deepEqual(reconciliation.calls, [
      context.strategyId,
      context.strategyId
    ]);
    assert.equal(context.repository.evidenceCalls.length, 1);
    assert.equal(
      context.repository.evidenceCalls[0]?.failureCode,
      testCase.expectedFailureCode
    );
    const targetRole = testCase.authorization === 'market'
      ? 'CONTRACT_MARKET'
      : 'CONTRACT_HEDGE_GTC';
    const persisted = context.repository.listOrders(context.strategyId)
      .find(({ role }) => role === targetRole);
    assert.ok(persisted);
    assert.equal(
      persisted.submissionDisposition,
      'DEFINITELY_NOT_SUBMITTED'
    );
    assert.equal(
      persisted.submissionFailureCode,
      testCase.expectedFailureCode
    );
    assert.deepEqual(context.repository.transitionCalls, []);
  });
}

for (const behavior of ['false', 'throw'] as const) {
  test(`reconciles again after no-submit evidence ${behavior}`, async (t) => {
    const contract = new ReasonedPreSubmissionGateway(
      'okx',
      'market',
      'UNCLASSIFIED'
    );
    const reconciliation = new ScriptedReconciliation([
      { kind: 'awaiting_market_submission' },
      scriptedPending('SUBMISSION_UNCERTAIN')
    ]);
    const operations = new CapturingOperationalLog();
    const context = setup(t, 'CONTRACT_FIRST', {
      contract,
      reconciliation,
      operationalLog: operations
    });
    context.repository.evidenceWriteBehavior = behavior;

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(contract.attempts.length, 1);
    assert.deepEqual(reconciliation.calls, [
      context.strategyId,
      context.strategyId
    ]);
    const [order] = context.repository.listOrders(context.strategyId);
    assert.ok(order);
    assert.equal(order.submissionDisposition, 'SUBMISSION_UNCERTAIN');
    assert.equal(order.submissionFailureCode, null);
    assert.deepEqual(context.repository.transitionCalls, []);
    assert.equal(
      operations.warnings.filter(
        ({ event }) => event === 'hedge_submission_evidence_conflict'
      ).length,
      1
    );
    assert.equal(
      JSON.stringify(operations.warnings).includes('private sqlite detail'),
      false
    );
  });
}

test('real reconciliation terminates an untradable residual without retry', async (t) => {
  const contract = new ReasonedPreSubmissionGateway(
    'okx',
    'limit',
    'UNTRADABLE_REQUEST'
  );
  const context = setup(t, 'CONCURRENT', { contract });
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '60010'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const persisted = context.repository.getStrategy(context.strategyId);
  assert.equal(persisted.state, 'HEDGE_INCOMPLETE');
  assert.equal(persisted.failureCode, 'HEDGE_RESIDUAL_NOT_TRADABLE');
  assert.equal(
    contract.attempts.filter(({ type }) => type === 'limit').length,
    1
  );
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .filter(({ role }) => role === 'CONTRACT_HEDGE_GTC').length,
    1
  );
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .find(({ role }) => role === 'CONTRACT_HEDGE_GTC')
      ?.submissionDisposition,
    'DEFINITELY_NOT_SUBMITTED'
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(
    contract.attempts.filter(({ type }) => type === 'limit').length,
    1
  );
});

test('real reconciliation recovers uncertain market submissions without duplicates', async (t) => {
  const context = setup(t, 'CONCURRENT');
  const spotSnapshot = snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  );
  const contractSnapshot = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  );
  context.spot.createResults.push(spotSnapshot);
  context.contract.createResults.push(contractSnapshot);
  context.spot.createErrors.set(
    spotSnapshot.clientOrderId,
    new Error('ambiguous transport failure')
  );
  context.contract.createErrors.set(
    contractSnapshot.clientOrderId,
    new Error('ambiguous transport failure')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'HEDGED'
  );
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId)
      .map(({ submissionDisposition }) => submissionDisposition),
    ['REMOTE_OBSERVED', 'REMOTE_OBSERVED']
  );
});

for (const testCase of [
  {
    name: 'settings lookup failure',
    event: 'hedge_submission_guard_pending',
    results: [
      new Error('apiKey=must-not-be-logged'),
      new Error('apiKey=must-not-be-logged')
    ]
  },
  {
    name: 'settings drift',
    event: 'hedge_submission_guard_changed',
    results: [
      { marginMode: 'isolated', positionMode: 'hedged', leverage: '2' },
      { marginMode: 'isolated', positionMode: 'hedged', leverage: '2' }
    ]
  }
] as const) {
  test(`blocks and deduplicates ${testCase.name}`, async (t) => {
    const reconciliation = new ScriptedReconciliation([
      { kind: 'awaiting_market_submission' },
      { kind: 'awaiting_market_submission' }
    ]);
    const operations = new CapturingOperationalLog();
    const context = setup(t, 'CONCURRENT', {
      reconciliation,
      operationalLog: operations
    });
    context.contract.accountSettingsResults.push(...testCase.results);

    await context.coordinator.confirmAndExecute(context.strategyId);
    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.deepEqual(reconciliation.calls, [
      context.strategyId,
      context.strategyId
    ]);
    assert.deepEqual(context.repository.listOrders(context.strategyId), []);
    assert.deepEqual(context.repository.transitionCalls, []);
    assert.equal(context.spot.createdRequests.length, 0);
    assert.equal(context.contract.createdRequests.length, 0);
    assert.equal(
      operations.warnings.filter(
        ({ event }) => event === testCase.event
      ).length,
      1
    );
    assert.equal(
      JSON.stringify(operations.warnings).includes('must-not-be-logged'),
      false
    );
  });
}

test('fresh market orders emit a complete persisted lifecycle in every mode', async (t) => {
  for (const mode of [
    'CONTRACT_FIRST',
    'SPOT_FIRST',
    'CONCURRENT'
  ] as const) {
    await t.test(mode, async (t) => {
      const context = setup(t, mode);
      if (mode !== 'SPOT_FIRST') {
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
      }
      if (mode !== 'CONTRACT_FIRST') {
        context.spot.createResults.push(snapshotFor(
          context.strategyId,
          'SPOT_MARKET',
          '1',
          {
            filledBaseQuantity: '0',
            remainingBaseQuantity: '1',
            averagePrice: null
          }
        ));
      }

      await context.coordinator.confirmAndExecute(context.strategyId);

      const expectedRoles: OrderRole[] = mode === 'CONTRACT_FIRST'
        ? ['CONTRACT_MARKET']
        : mode === 'SPOT_FIRST'
          ? ['SPOT_MARKET']
          : ['SPOT_MARKET', 'CONTRACT_MARKET'];
      for (const role of expectedRoles) {
        const roleEvents = context.tradeEvents.filter(
          (event) => event.role === role
        );
        assert.deepEqual(
          roleEvents.map(({ event }) => event),
          COMPLETE_ORDER_LIFECYCLE
        );
        const statusEvent = roleEvents[3];
        assert.ok(statusEvent);
        assert.equal(statusEvent.strategyId, context.strategyId);
        assert.equal(statusEvent.mode, mode);
        assert.equal(statusEvent.strategyState, 'EXECUTING');
        assert.equal(statusEvent.exchangeId, roleShape(role).exchangeId);
        assert.equal(statusEvent.symbol, SYMBOL);
        assert.equal(statusEvent.requestedBaseQuantity, '1');
        assert.equal(statusEvent.filledBaseQuantity, '0');
        assert.equal(statusEvent.remainingBaseQuantity, '1');
        assert.equal(statusEvent.averagePrice, null);
        assert.equal(statusEvent.status, 'closed');
        assert.equal(
          statusEvent.clientOrderId,
          makeClientOrderId(context.strategyId, role)
        );
      }
      if (mode === 'CONCURRENT') {
        const plannedIndexes = context.tradeEvents.flatMap((event, index) => (
          event.event === 'order_planned' ? [index] : []
        ));
        const submitIndexes = context.tradeEvents.flatMap((event, index) => (
          event.event === 'order_submit_started' ? [index] : []
        ));
        assert.equal(plannedIndexes.length, 2);
        assert.equal(submitIndexes.length, 2);
        assert.ok(Math.max(...plannedIndexes) < Math.min(...submitIndexes));
      }
    });
  }
});

test('a derived GTC order receives its own complete lifecycle', async (t) => {
  const context = setup(t, 'CONTRACT_FIRST');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.8',
      remainingBaseQuantity: '0.2',
      averagePrice: '60000.09'
    }
  ));
  context.spot.quantizedPrices.set('spot:BTC/USDT', '60000.0');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '0.8',
    { averagePrice: '60000.0' }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const hedgeEvents = context.tradeEvents.filter(
    ({ role }) => role === 'SPOT_HEDGE_GTC'
  );
  assert.deepEqual(
    hedgeEvents.map(({ event }) => event),
    COMPLETE_ORDER_LIFECYCLE
  );
  assert.equal(hedgeEvents[0]?.requestedBaseQuantity, '0.8');
  assert.equal(hedgeEvents[0]?.price, '60000.0');
  assert.equal(hedgeEvents[0]?.timeInForce, 'GTC');
  assert.equal(hedgeEvents[4]?.status, 'closed');
  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'HEDGED'
  );
});

test('recovered intents emit persisted status but no new planning or submission', async (t) => {
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
      averagePrice: null
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(context.tradeEvents.map(({ event }) => event), [
    'order_status_changed',
    'order_terminal'
  ]);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.contract.findRequests.length, 1);
});

test('a throwing trade sink cannot change state or duplicate submission', async (t) => {
  const failure = new Error('log sink unavailable');
  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const context = setup(t, 'CONTRACT_FIRST', {
    tradeEvents: {
      async record(): Promise<void> {
        throw failure;
      }
    }
  });
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
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'FAILED');
  assert.equal(strategy.failureCode, 'NO_FILL');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(unhandled, undefined);
});

test('coordinator claims but never submits a persisted one-way strategy', async (t) => {
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONCURRENT', {
    preflight: {
      accountSettings: {
        marginMode: 'cross',
        positionMode: 'one-way',
        leverage: '2'
      }
    },
    operationalLog: operations
  });

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'EXECUTING'
  );
  assert.equal(
    context.repository.getStrategy(context.strategyId).failureCode,
    null
  );
  assert.equal(context.repository.listOrders(context.strategyId).length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.deepEqual(context.repository.transitionCalls, []);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_guard_changed'
    ).length,
    1
  );
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
      const operations = new CapturingOperationalLog();
      const context = setup(t, 'CONTRACT_FIRST', {
        operationalLog: operations
      });
      context.contract.accountSettingsResults.push(testCase.settings);

      await context.coordinator.confirmAndExecute(context.strategyId);

      const strategy = context.repository.getStrategy(context.strategyId);
      assert.equal(strategy.state, 'EXECUTING');
      assert.equal(strategy.failureCode, null);
      assert.equal(context.repository.listOrders(context.strategyId).length, 0);
      assert.equal(context.contract.accountSettingsRequests.length, 1);
      assert.equal(context.contract.createdRequests.length, 0);
      assert.equal(context.spot.createdRequests.length, 0);
      assert.deepEqual(context.repository.transitionCalls, []);
      assert.equal(
        operations.warnings.filter(
          ({ event }) => event === 'hedge_submission_guard_changed'
        ).length,
        1
      );
    });
  }
});

test('fresh settings fetch uncertainty stays executing and submits only after a later valid check', async (t) => {
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONTRACT_FIRST', {
    operationalLog: operations
  });
  context.contract.accountSettingsResults.push(
    new Error('temporary account settings failure')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.repository.listOrders(context.strategyId).length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_guard_pending'
    ).length,
    1
  );

  context.contract.accountSettingsResults.push({
    marginMode: 'cross',
    positionMode: 'hedged',
    leverage: '2.0'
  });
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
  assert.equal(context.contract.accountSettingsRequests.length, 2);
});

test('spot-first rechecks contract settings after the spot fill and before contract create', async (t) => {
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'SPOT_FIRST', {
    operationalLog: operations
  });
  context.contract.accountSettingsResults.push(
    {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
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
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.contract.accountSettingsRequests.length, 2);
  assert.deepEqual(context.repository.transitionCalls, []);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_guard_changed'
    ).length,
    1
  );
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

  context.contract.accountSettingsResults.push({
    marginMode: 'cross',
    positionMode: 'hedged',
    leverage: '2.0'
  });
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '0.6'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'HEDGED');
  assert.equal(context.contract.createdRequests.length, 1);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.contract.accountSettingsRequests.length, 3);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map((order) => order.role),
    ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC']
  );
});

test('guards one concurrent market authorization before atomic planning', async (t) => {
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONCURRENT', {
    operationalLog: operations
  });
  context.contract.accountSettingsResults.push({
    marginMode: 'cross',
    positionMode: 'one-way',
    leverage: '2'
  });

  await context.coordinator.confirmAndExecute(context.strategyId);

  const strategy = context.repository.getStrategy(context.strategyId);
  assert.equal(strategy.state, 'EXECUTING');
  assert.equal(strategy.failureCode, null);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.repository.listOrders(context.strategyId).length, 0);
  assert.equal(context.repository.atomicPlanCalls, 0);
  assert.equal(context.contract.accountSettingsRequests.length, 1);
  assert.deepEqual(context.repository.transitionCalls, []);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_guard_changed'
    ).length,
    1
  );
});

test('runs lookup-only recovery without an account guard', async (t) => {
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONTRACT_FIRST', {
    operationalLog: operations
  });
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
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.getStrategy(context.strategyId).state, 'EXECUTING');
  assert.equal(context.contract.accountSettingsRequests.length, 0);
  assert.equal(context.contract.findRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event.startsWith('hedge_submission_guard_')
    ).length,
    0
  );
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
  assert.deepEqual(context.spot.quantizeRequests, [
    {
      symbol: SYMBOL,
      kind: 'spot',
      price: '60000.09'
    },
    {
      symbol: SYMBOL,
      kind: 'spot',
      price: '60000.09'
    }
  ]);
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
  assert.ok(context.contract.findRequests.length >= 1);
  assert.equal(
    context.contract.findRequests.every(
      ({ clientOrderId }) => clientOrderId === marketClientId
    ),
    true
  );
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
  assert.equal(context.contract.findRequests.length, 2);
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
  const marketSnapshot = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  );
  context.repository.attachOrderSnapshot(market.id, marketSnapshot);
  context.contract.seedObservedOrder(marketSnapshot);
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
  const spotMarketSnapshot = snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  );
  context.repository.attachOrderSnapshot(spotMarket.id, spotMarketSnapshot);
  context.spot.seedObservedOrder(spotMarketSnapshot);
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
  const contractMarketSnapshot = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '60001'
    }
  );
  context.repository.attachOrderSnapshot(
    contractMarket.id,
    contractMarketSnapshot
  );
  context.contract.seedObservedOrder(contractMarketSnapshot);
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
  assert.equal(context.contract.findRequests.length, 2);
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
  const competingReconciliation = new HedgeReconciliation(
    context.registry,
    context.repository,
    context.tradeEventSink
  );
  const competingCoordinator = new HedgeCoordinator(
    context.registry,
    context.repository,
    competingReconciliation,
    context.tradeEventSink
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
      'EXECUTING'
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
      'EXECUTING'
    );
    assert.equal(context.spot.createdRequests.length, 0);
    assert.equal(context.contract.createdRequests.length, 0);
  });
});
