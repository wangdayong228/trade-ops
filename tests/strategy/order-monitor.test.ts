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
  OrderSnapshot,
  StrategyState
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import type {
  StrategyFailureCode,
  StrategyOrderPlan,
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../../src/storage/strategy-repository.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import { OrderMonitor } from '../../src/strategy/order-monitor.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';
const CREATED_AT = '2026-07-26T00:00:00.000Z';
const FIRST_UPDATE = '2026-07-26T00:01:00.000Z';
const SECOND_UPDATE = '2026-07-26T00:02:00.000Z';

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
  baseQuantity: string
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
      positionSide: 'SHORT' as const,
      marginMode: 'cross' as const
    };
  }
  if (role === 'SPOT_HEDGE_GTC') {
    return {
      ...common,
      price: '60000',
      timeInForce: 'GTC' as const
    };
  }
  return {
    ...common,
    price: '60000',
    timeInForce: 'GTC' as const,
    positionSide: 'SHORT' as const,
    marginMode: 'cross' as const
  };
}

function snapshotFor(
  strategyId: string,
  role: OrderRole,
  requestedBaseQuantity: string,
  filledBaseQuantity: string,
  remainingBaseQuantity: string,
  status: OrderSnapshot['status'],
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  const shape = roleShape(role);
  return {
    exchangeId: shape.exchangeId,
    exchangeOrderId: `${strategyId}-${role.toLowerCase()}`,
    clientOrderId: makeClientOrderId(strategyId, role),
    symbol: SYMBOL,
    kind: shape.kind,
    type: shape.type,
    side: shape.side,
    requestedBaseQuantity,
    filledBaseQuantity,
    remainingBaseQuantity,
    averagePrice: filledBaseQuantity === '0' ? null : '60000',
    status,
    updatedAt: FIRST_UPDATE,
    ...overrides
  };
}

type ScriptedResult = OrderSnapshot | null | Error;

class MonitorGateway extends FakeExchangeGateway {
  readonly fetchRequests: Array<{
    exchangeOrderId: string;
    symbol: string;
    kind: MarketKind;
  }> = [];
  readonly findRequests: Array<{
    clientOrderId: string;
    symbol: string;
    kind: MarketKind;
  }> = [];
  readonly scriptedFetches = new Map<string, ScriptedResult[]>();
  readonly scriptedFinds = new Map<string, ScriptedResult[]>();

  override async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    this.fetchRequests.push({ exchangeOrderId, symbol, kind });
    const scripted = this.scriptedFetches.get(exchangeOrderId)?.shift();
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted === null) {
      throw new Error('fetchOrder cannot return null');
    }
    if (scripted !== undefined) {
      return scripted;
    }
    return super.fetchOrder(exchangeOrderId, symbol, kind);
  }

  override async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    this.findRequests.push({ clientOrderId, symbol, kind });
    const scripted = this.scriptedFinds.get(clientOrderId)?.shift();
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted !== undefined) {
      return scripted;
    }
    return super.findOrderByClientId(clientOrderId, symbol, kind);
  }
}

interface Fixture {
  readonly database: Database.Database;
  readonly repository: SqliteStrategyRepository;
  readonly spot: MonitorGateway;
  readonly contract: MonitorGateway;
  readonly registry: ExchangeRegistry;
}

function fixture(t: TestContext): Fixture {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new SqliteStrategyRepository(database);
  const spot = new MonitorGateway('bitget');
  const contract = new MonitorGateway('okx');
  contract.accountSettings = {
    marginMode: 'cross',
    positionMode: 'hedged',
    leverage: '2'
  };
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  return { database, repository, spot, contract, registry };
}

function createStrategy(
  repository: StrategyRepository,
  mode: ExecutionMode,
  state: Extract<StrategyState, 'EXECUTING' | 'WAITING_HEDGE'> = 'EXECUTING',
  overrides: Partial<PreflightResult> = {}
): StrategyRecord {
  const strategy = repository.createPending(preflight(mode, overrides));
  assert.equal(repository.claimForExecution(strategy.id), true);
  if (state === 'WAITING_HEDGE') {
    assert.equal(
      repository.transition(strategy.id, ['EXECUTING'], 'WAITING_HEDGE'),
      true
    );
  }
  return repository.getStrategy(strategy.id);
}

function planOrder(
  repository: StrategyRepository,
  strategyId: string,
  role: OrderRole,
  baseQuantity: string,
  snapshot?: OrderSnapshot
): StrategyOrderRecord {
  const record = repository.planOrder(
    strategyId,
    role,
    requestFor(strategyId, role, baseQuantity)
  );
  if (snapshot !== undefined) {
    repository.attachOrderSnapshot(record.id, snapshot);
  }
  return repository.listOrders(strategyId).find(
    (order) => order.id === record.id
  ) as StrategyOrderRecord;
}

function assertNoCreates(f: Fixture): void {
  assert.equal(f.spot.createdRequests.length, 0);
  assert.equal(f.contract.createdRequests.length, 0);
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

interface ManualInterval {
  active: boolean;
  readonly callback: (...arguments_: unknown[]) => void;
  readonly arguments: unknown[];
}

function installManualIntervals(t: TestContext): {
  readonly tick: (cycles?: number) => void;
} {
  const intervals: ManualInterval[] = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((
    callback: (...arguments_: unknown[]) => void,
    _intervalMs?: number,
    ...arguments_: unknown[]
  ) => {
    const interval: ManualInterval = {
      active: true,
      callback,
      arguments: arguments_
    };
    intervals.push(interval);
    return interval as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((
    interval: ReturnType<typeof setInterval>
  ) => {
    (interval as unknown as ManualInterval).active = false;
  }) as typeof clearInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return {
    tick(cycles = 1): void {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (const interval of [...intervals]) {
          if (interval.active) {
            interval.callback(...interval.arguments);
          }
        }
      }
    }
  };
}

class RepositoryProxy implements StrategyRepository {
  constructor(protected readonly target: StrategyRepository) {}

  createPending(value: PreflightResult): StrategyRecord {
    return this.target.createPending(value);
  }

  getStrategy(id: string): StrategyRecord {
    return this.target.getStrategy(id);
  }

  claimForExecution(id: string): boolean {
    return this.target.claimForExecution(id);
  }

  planOrder(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord {
    return this.target.planOrder(strategyId, role, request);
  }

  planOrdersAtomically(
    strategyId: string,
    plans: readonly Readonly<StrategyOrderPlan>[]
  ): StrategyOrderRecord[] {
    return this.target.planOrdersAtomically(strategyId, plans);
  }

  attachOrderSnapshot(
    strategyOrderId: string,
    snapshot: OrderSnapshot
  ): void {
    this.target.attachOrderSnapshot(strategyOrderId, snapshot);
  }

  listOrders(strategyId: string): StrategyOrderRecord[] {
    return this.target.listOrders(strategyId);
  }

  listOrderEvents(strategyOrderId: string): OrderSnapshot[] {
    return this.target.listOrderEvents(strategyOrderId);
  }

  transition(
    strategyId: string,
    from: StrategyState[],
    to: StrategyState,
    failureCode?: StrategyFailureCode
  ): boolean {
    return failureCode === undefined
      ? this.target.transition(strategyId, from, to)
      : this.target.transition(strategyId, from, to, failureCode);
  }

  listRecoverable(): StrategyRecord[] {
    return this.target.listRecoverable();
  }
}

test('keeps waiting after a partial GTC fill', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.4', '0.6', 'open', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(
    f.repository.listOrders(strategy.id).find(
      (order) => order.role === 'SPOT_HEDGE_GTC'
    )?.snapshot?.filledBaseQuantity,
    '0.4'
  );
  assertNoCreates(f);
});

test('marks a strategy hedged only after a full terminal GTC matches exposure', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.4', '0.6', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'HEDGED');
  assertNoCreates(f);
});

test('marks an externally canceled GTC incomplete with a safe code', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.2', '0.8', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.2', '0.8', 'canceled', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'HEDGE_ORDER_CANCELED'
    }
  );
  assertNoCreates(f);
});

test('marks an externally rejected GTC incomplete with a safe code', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'SPOT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  f.contract.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_HEDGE_GTC', '1', '0', '1', 'rejected', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'HEDGE_ORDER_REJECTED'
    }
  );
  assertNoCreates(f);
});

test('marks unequal terminal exposure incomplete without replaying event history', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE'
  );
  const spot = planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0.9', '0.1', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '0.05',
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.05',
      '0.05',
      '0',
      'closed'
    )
  );
  assert.equal(f.repository.listOrderEvents(spot.id).length, 1);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    }
  );
  assertNoCreates(f);
});

test('does not race an active coordinator planning a concurrent difference GTC', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONCURRENT');
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0.9', '0.1', 'closed')
  );
  let releaseQuantize: (() => void) | undefined;
  let markQuantizeStarted: (() => void) | undefined;
  const quantizeStarted = new Promise<void>((resolve) => {
    markQuantizeStarted = resolve;
  });
  const quantizeGate = new Promise<void>((resolve) => {
    releaseQuantize = resolve;
  });
  t.after(() => releaseQuantize?.());
  f.contract.quantizePrice = async (
    _symbol: string,
    _kind: MarketKind,
    price: string
  ): Promise<string> => {
    markQuantizeStarted?.();
    await quantizeGate;
    return price;
  };
  f.contract.createResults.push(
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0',
      '0.1',
      'open'
    )
  );
  const execution = new HedgeCoordinator(
    f.registry,
    f.repository
  ).confirmAndExecute(strategy.id);
  void execution.catch(() => {
    // The awaited assertion below reports coordinator failure without an
    // unhandled rejection if an earlier assertion aborts this test.
  });
  await quantizeStarted;

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'EXECUTING');
  assert.equal(f.repository.listOrders(strategy.id).length, 2);
  assert.equal(f.contract.createdRequests.length, 0);
  releaseQuantize?.();
  await execution;
  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(f.contract.createdRequests.length, 1);
  assert.equal(f.spot.createdRequests.length, 0);
});

test('restart monitor preserves an executable concurrent difference topology for coordinator recovery', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONCURRENT');
  const spot = planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  const contract = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0.9', '0.1', 'closed')
  );
  const restartedMonitorRepository = new SqliteStrategyRepository(f.database);

  await new OrderMonitor(
    f.registry,
    restartedMonitorRepository
  ).reconcileStrategy(strategy.id);

  assert.equal(
    restartedMonitorRepository.getStrategy(strategy.id).state,
    'EXECUTING'
  );
  assert.equal(restartedMonitorRepository.listOrderEvents(spot.id).length, 1);
  assert.equal(
    restartedMonitorRepository.listOrderEvents(contract.id).length,
    1
  );
  assertNoCreates(f);

  f.contract.createResults.push(
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0',
      '0.1',
      'open'
    )
  );
  const restartedCoordinatorRepository =
    new SqliteStrategyRepository(f.database);
  await new HedgeCoordinator(
    f.registry,
    restartedCoordinatorRepository
  ).confirmAndExecute(strategy.id);

  assert.equal(
    restartedCoordinatorRepository.getStrategy(strategy.id).state,
    'WAITING_HEDGE'
  );
  assert.equal(f.contract.createdRequests.length, 1);
  assert.deepEqual(
    {
      kind: f.contract.createdRequests[0]?.kind,
      type: f.contract.createdRequests[0]?.type,
      side: f.contract.createdRequests[0]?.side,
      baseQuantity: f.contract.createdRequests[0]?.baseQuantity,
      positionSide: f.contract.createdRequests[0]?.positionSide,
      timeInForce: f.contract.createdRequests[0]?.timeInForce
    },
    {
      kind: 'swap',
      type: 'limit',
      side: 'sell',
      baseQuantity: '0.1',
      positionSide: 'SHORT',
      timeInForce: 'GTC'
    }
  );
  await new HedgeCoordinator(
    f.registry,
    new SqliteStrategyRepository(f.database)
  ).confirmAndExecute(strategy.id);
  assert.equal(f.contract.createdRequests.length, 1);
  assert.equal(f.spot.createdRequests.length, 0);
});

test('restart monitor continues a reliable concurrent positive-zero topology exactly once', async (t) => {
  for (const positiveStatus of ['closed', 'canceled'] as const) {
    await t.test(positiveStatus, async (t) => {
      const f = fixture(t);
      const strategy = createStrategy(f.repository, 'CONCURRENT');
      planOrder(
        f.repository,
        strategy.id,
        'SPOT_MARKET',
        '1',
        snapshotFor(
          strategy.id,
          'SPOT_MARKET',
          '1',
          '0.7',
          '0.3',
          positiveStatus,
          { averagePrice: '61111' }
        )
      );
      planOrder(
        f.repository,
        strategy.id,
        'CONTRACT_MARKET',
        '1',
        snapshotFor(
          strategy.id,
          'CONTRACT_MARKET',
          '1',
          '0',
          '1',
          'canceled',
          { averagePrice: null }
        )
      );
      f.contract.createResults.push(snapshotFor(
        strategy.id,
        'CONTRACT_HEDGE_GTC',
        '0.7',
        '0',
        '0.7',
        'open',
        { averagePrice: null }
      ));
      const coordinator = new HedgeCoordinator(f.registry, f.repository);
      const monitor = new OrderMonitor(
        f.registry,
        f.repository,
        coordinator
      );

      await monitor.recover();

      assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
      assert.equal(f.contract.createdRequests.length, 1);
      assert.equal(f.contract.createdRequests[0]?.baseQuantity, '0.7');
      assert.equal(f.contract.createdRequests[0]?.price, '61111');
      await monitor.recover();
      assert.equal(f.contract.createdRequests.length, 1);
      assert.equal(f.spot.createdRequests.length, 0);
    });
  }
});

test('restart reconciliation uses topology-dependent concurrent averages', async (t) => {
  await t.test('equal positive terminals need no averages', async (t) => {
    const f = fixture(t);
    const strategy = createStrategy(f.repository, 'CONCURRENT');
    for (const [role, status] of [
      ['SPOT_MARKET', 'closed'],
      ['CONTRACT_MARKET', 'canceled']
    ] as const) {
      planOrder(
        f.repository,
        strategy.id,
        role,
        '1',
        snapshotFor(
          strategy.id,
          role,
          '1',
          '0.6',
          '0.4',
          status,
          { averagePrice: null }
        )
      );
    }

    await new OrderMonitor(f.registry, f.repository)
      .reconcileStrategy(strategy.id);

    assert.equal(f.repository.getStrategy(strategy.id).state, 'HEDGED');
    assertNoCreates(f);
  });

  await t.test('unequal terminals need only the larger average', async (t) => {
    const f = fixture(t);
    const strategy = createStrategy(f.repository, 'CONCURRENT');
    planOrder(
      f.repository,
      strategy.id,
      'SPOT_MARKET',
      '1',
      snapshotFor(
        strategy.id,
        'SPOT_MARKET',
        '1',
        '0.8',
        '0.2',
        'canceled',
        { averagePrice: '61234' }
      )
    );
    planOrder(
      f.repository,
      strategy.id,
      'CONTRACT_MARKET',
      '1',
      snapshotFor(
        strategy.id,
        'CONTRACT_MARKET',
        '1',
        '0.5',
        '0.5',
        'closed',
        { averagePrice: null }
      )
    );
    f.contract.createResults.push(snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.3',
      '0',
      '0.3',
      'open',
      { averagePrice: null }
    ));
    const coordinator = new HedgeCoordinator(f.registry, f.repository);

    await new OrderMonitor(
      f.registry,
      f.repository,
      coordinator
    ).recover();

    assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
    assert.equal(f.contract.createdRequests.length, 1);
    assert.equal(f.contract.createdRequests[0]?.baseQuantity, '0.3');
    assert.equal(f.contract.createdRequests[0]?.price, '61234');
  });
});

test('start automatically continues a terminal sequential market exactly once', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONTRACT_FIRST');
  const market = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0', '1', 'open')
  );
  f.contract.scriptedFetches.set(market.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  const hedge = snapshotFor(
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    '0',
    '1',
    'open',
    { updatedAt: SECOND_UPDATE }
  );
  f.spot.createResults.push(hedge);
  f.spot.scriptedFetches.set(hedge.exchangeOrderId, [hedge, hedge]);
  installManualIntervals(t);
  const coordinator = new HedgeCoordinator(f.registry, f.repository);
  const monitor = new OrderMonitor(
    f.registry,
    f.repository,
    coordinator
  );

  monitor.start(10);
  await monitor.stop();

  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(f.spot.createdRequests.length, 1);
  assert.equal(f.contract.createdRequests.length, 0);
  await monitor.recover();
  await monitor.recover();
  assert.equal(f.spot.createdRequests.length, 1);
  assert.equal(
    f.repository.listOrders(strategy.id).filter(
      (order) => order.role === 'SPOT_HEDGE_GTC'
    ).length,
    1
  );
});

test('concurrent asynchronous market terminals create one difference GTC after both settle', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONCURRENT');
  const spot = planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '0', '1', 'open')
  );
  const contract = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0', '1', 'open')
  );
  const spotTerminal = snapshotFor(
    strategy.id,
    'SPOT_MARKET',
    '1',
    '1',
    '0',
    'closed',
    { updatedAt: SECOND_UPDATE }
  );
  const contractTerminal = snapshotFor(
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    '0.9',
    '0.1',
    'closed',
    { updatedAt: SECOND_UPDATE }
  );
  let resolveSpot: ((snapshot: OrderSnapshot) => void) | undefined;
  let resolveContract: ((snapshot: OrderSnapshot) => void) | undefined;
  const spotGate = new Promise<OrderSnapshot>((resolve) => {
    resolveSpot = resolve;
  });
  const contractGate = new Promise<OrderSnapshot>((resolve) => {
    resolveContract = resolve;
  });
  t.after(() => {
    resolveSpot?.(spotTerminal);
    resolveContract?.(contractTerminal);
  });
  f.spot.fetchOrder = async (
    exchangeOrderId: string
  ): Promise<OrderSnapshot> => {
    assert.equal(exchangeOrderId, spot.exchangeOrderId);
    return spotGate;
  };
  const difference = snapshotFor(
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '0.1',
    '0',
    '0.1',
    'open',
    { updatedAt: SECOND_UPDATE }
  );
  f.contract.fetchOrder = async (
    exchangeOrderId: string
  ): Promise<OrderSnapshot> => {
    if (exchangeOrderId === contract.exchangeOrderId) {
      return contractGate;
    }
    assert.equal(exchangeOrderId, difference.exchangeOrderId);
    return difference;
  };
  f.contract.createResults.push(difference);
  const coordinator = new HedgeCoordinator(f.registry, f.repository);
  const monitor = new OrderMonitor(
    f.registry,
    f.repository,
    coordinator
  );

  const recovery = monitor.recover();
  resolveSpot?.(spotTerminal);
  await flushMicrotasks();
  assert.equal(f.contract.createdRequests.length, 0);
  resolveContract?.(contractTerminal);
  await recovery;

  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(f.contract.createdRequests.length, 1);
  assert.equal(f.contract.createdRequests[0]?.baseQuantity, '0.1');
  assert.equal(f.spot.createdRequests.length, 0);
  await monitor.recover();
  await monitor.recover();
  assert.equal(f.contract.createdRequests.length, 1);
  assert.equal(
    f.repository.listOrders(strategy.id).filter(
      (order) => order.role === 'CONTRACT_HEDGE_GTC'
    ).length,
    1
  );
});

test('does not continue incomplete, planned, or open market intent topologies', async (t) => {
  const f = fixture(t);
  const incomplete = createStrategy(f.repository, 'CONCURRENT');
  const incompleteOrder = planOrder(
    f.repository,
    incomplete.id,
    'SPOT_MARKET',
    '1'
  );
  f.spot.scriptedFinds.set(incompleteOrder.clientOrderId, [
    snapshotFor(incomplete.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  ]);
  const planned = createStrategy(f.repository, 'CONTRACT_FIRST');
  const plannedOrder = planOrder(
    f.repository,
    planned.id,
    'CONTRACT_MARKET',
    '1'
  );
  f.contract.scriptedFinds.set(plannedOrder.clientOrderId, [null]);
  const nonterminal = createStrategy(f.repository, 'CONCURRENT');
  planOrder(
    f.repository,
    nonterminal.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(nonterminal.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  const openOrder = planOrder(
    f.repository,
    nonterminal.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(nonterminal.id, 'CONTRACT_MARKET', '1', '0', '1', 'open')
  );
  f.contract.scriptedFetches.set(openOrder.exchangeOrderId as string, [
    snapshotFor(nonterminal.id, 'CONTRACT_MARKET', '1', '0', '1', 'open', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  const continued: string[] = [];
  const monitor = new OrderMonitor(f.registry, f.repository, {
    async confirmAndExecute(strategyId: string): Promise<void> {
      continued.push(strategyId);
    }
  });

  await monitor.recover();

  assert.deepEqual(continued, []);
  for (const strategy of [incomplete, planned, nonterminal]) {
    assert.equal(f.repository.getStrategy(strategy.id).state, 'EXECUTING');
  }
  assertNoCreates(f);
});

test('keeps coordinator-continuable missing-GTC topologies executing', async (t) => {
  const f = fixture(t);
  const contractFirst = createStrategy(f.repository, 'CONTRACT_FIRST');
  planOrder(
    f.repository,
    contractFirst.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(
      contractFirst.id,
      'CONTRACT_MARKET',
      '1',
      '1',
      '0',
      'closed'
    )
  );
  const spotFirst = createStrategy(f.repository, 'SPOT_FIRST');
  planOrder(
    f.repository,
    spotFirst.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(spotFirst.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  const oneConcurrentMarket = createStrategy(f.repository, 'CONCURRENT');
  planOrder(
    f.repository,
    oneConcurrentMarket.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(
      oneConcurrentMarket.id,
      'SPOT_MARKET',
      '1',
      '1',
      '0',
      'closed'
    )
  );
  const noConcurrentOrders = createStrategy(f.repository, 'CONCURRENT');
  const monitor = new OrderMonitor(f.registry, f.repository);

  for (const strategy of [
    contractFirst,
    spotFirst,
    oneConcurrentMarket,
    noConcurrentOrders
  ]) {
    await monitor.reconcileStrategy(strategy.id);
    assert.equal(f.repository.getStrategy(strategy.id).state, 'EXECUTING');
  }
  assertNoCreates(f);
});

test('does not preserve a malformed persisted GTC as a restart precursor', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONCURRENT');
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0.9', '0.1', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '0.1',
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0.1',
      '0',
      'closed'
    )
  );
  class MalformedGtcRepository extends RepositoryProxy {
    override listOrders(strategyId: string): StrategyOrderRecord[] {
      return super.listOrders(strategyId).map((record) => (
        record.role === 'CONTRACT_HEDGE_GTC'
          ? {
            ...record,
            request: {
              ...record.request,
              price: '0'
            }
          }
          : record
      ));
    }
  }

  await new OrderMonitor(
    f.registry,
    new MalformedGtcRepository(f.repository)
  ).reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    }
  );
  assertNoCreates(f);
});

test('gives canceled GTC status priority over an inconsistent extra GTC role', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '0.1',
    snapshotFor(
      strategy.id,
      'SPOT_HEDGE_GTC',
      '0.1',
      '0',
      '0.1',
      'canceled'
    )
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '0.1',
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0',
      '0.1',
      'rejected'
    )
  );

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'HEDGE_ORDER_CANCELED'
    }
  );
  assertNoCreates(f);
});

test('gives rejected GTC status priority over an inconsistent extra GTC role', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '0.1',
    snapshotFor(
      strategy.id,
      'SPOT_HEDGE_GTC',
      '0.1',
      '0',
      '0.1',
      'rejected'
    )
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '0.1',
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0.1',
      '0',
      'closed'
    )
  );

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'HEDGE_ORDER_REJECTED'
    }
  );
  assertNoCreates(f);
});

test('keeps waiting when exchange status is open even with zero remaining', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.5', '0.5', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'open', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(
    f.repository.listOrders(strategy.id).find(
      (order) => order.id === gtc.id
    )?.snapshot?.status,
    'open'
  );
  assertNoCreates(f);
});

test('does not attach any fetched snapshot when another order fetch fails', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  const market = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0.2', '0.8', 'unknown')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  f.contract.scriptedFetches.set(market.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    new Error('auth token=must-not-be-persisted')
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(f.repository.listOrderEvents(market.id).length, 1);
  assert.equal(f.repository.listOrderEvents(gtc.id).length, 1);
  assert.equal(
    f.repository.listOrders(strategy.id).find(
      (order) => order.id === market.id
    )?.snapshot?.filledBaseQuantity,
    '0.2'
  );
  assertNoCreates(f);
});

test('rejects non-decimal numeric syntax before attaching any fetched snapshot', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  const market = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0.2', '0.8', 'unknown')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  f.contract.scriptedFetches.set(market.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0x0', '1', 'open', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    }
  );
  assert.equal(f.repository.listOrderEvents(market.id).length, 1);
  assert.equal(f.repository.listOrderEvents(gtc.id).length, 1);
  assertNoCreates(f);
});

test('uses a direct client-id lookup for a planned order and never submits it', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONTRACT_FIRST');
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1'
  );
  f.spot.scriptedFinds.set(gtc.clientOrderId, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.1', '0.9', 'open')
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    f.spot.findRequests.map(({ clientOrderId }) => clientOrderId),
    [gtc.clientOrderId]
  );
  assert.equal(f.spot.fetchRequests.length, 0);
  assert.equal(f.repository.getStrategy(strategy.id).state, 'WAITING_HEDGE');
  assert.equal(f.repository.listOrderEvents(gtc.id).length, 1);
  assertNoCreates(f);
});

test('preserves EXECUTING when a planned client-id lookup is null or unknown', async (t) => {
  const f = fixture(t);
  const nullStrategy = createStrategy(f.repository, 'CONCURRENT');
  const nullOrder = planOrder(
    f.repository,
    nullStrategy.id,
    'SPOT_MARKET',
    '1'
  );
  f.spot.scriptedFinds.set(nullOrder.clientOrderId, [null]);

  const unknownStrategy = createStrategy(f.repository, 'CONCURRENT');
  const unknownOrder = planOrder(
    f.repository,
    unknownStrategy.id,
    'SPOT_MARKET',
    '1'
  );
  f.spot.scriptedFinds.set(unknownOrder.clientOrderId, [
    snapshotFor(
      unknownStrategy.id,
      'SPOT_MARKET',
      '1',
      '0',
      '1',
      'unknown'
    )
  ]);

  const monitor = new OrderMonitor(f.registry, f.repository);
  await monitor.reconcileStrategy(nullStrategy.id);
  await monitor.reconcileStrategy(unknownStrategy.id);

  assert.equal(f.repository.getStrategy(nullStrategy.id).state, 'EXECUTING');
  assert.equal(f.repository.listOrderEvents(nullOrder.id).length, 0);
  assert.equal(f.repository.getStrategy(unknownStrategy.id).state, 'EXECUTING');
  assert.equal(f.repository.listOrderEvents(unknownOrder.id).length, 1);
  assertNoCreates(f);
});

test('fails closed when a nonterminal market order coexists with known exposure', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  const market = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0', '1', 'unknown')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_HEDGE_GTC', '1', '0.2', '0.8', 'open')
  );
  f.contract.scriptedFetches.set(market.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0', '1', 'unknown', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  f.contract.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_HEDGE_GTC', '1', '0.2', '0.8', 'open', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    }
  );
  assertNoCreates(f);
});

test('defensively rejects a persisted swap request with the wrong confirmed margin mode', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed')
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  class WrongMarginRepository extends RepositoryProxy {
    override listOrders(strategyId: string): StrategyOrderRecord[] {
      return super.listOrders(strategyId).map((record) => (
        record.role === 'CONTRACT_MARKET'
          ? {
            ...record,
            request: {
              ...record.request,
              marginMode: 'isolated'
            }
          }
          : record
      ));
    }
  }

  await new OrderMonitor(
    f.registry,
    new WrongMarginRepository(f.repository)
  ).reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    }
  );
  assertNoCreates(f);
});

test('isolates recovery failures between strategies', async (t) => {
  const f = fixture(t);
  const failedLookup = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    failedLookup.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(failedLookup.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const failedGtc = planOrder(
    f.repository,
    failedLookup.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(failedLookup.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  f.spot.scriptedFetches.set(failedGtc.exchangeOrderId as string, [
    new Error('network secret=never-store-this')
  ]);

  const successful = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    successful.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(successful.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const successfulGtc = planOrder(
    f.repository,
    successful.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(successful.id, 'SPOT_HEDGE_GTC', '1', '0.5', '0.5', 'open')
  );
  f.spot.scriptedFetches.set(successfulGtc.exchangeOrderId as string, [
    snapshotFor(successful.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  await new OrderMonitor(f.registry, f.repository).recover();

  assert.equal(
    f.repository.getStrategy(failedLookup.id).state,
    'WAITING_HEDGE'
  );
  assert.equal(f.repository.getStrategy(successful.id).state, 'HEDGED');
  assertNoCreates(f);
});

test('preserves the current state when snapshot attachment temporarily fails', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.5', '0.5', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  class FailingAttachRepository extends RepositoryProxy {
    override attachOrderSnapshot(): void {
      throw new Error('sqlite password=must-not-escape');
    }
  }

  await new OrderMonitor(
    f.registry,
    new FailingAttachRepository(f.repository)
  ).reconcileStrategy(strategy.id);

  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'WAITING_HEDGE',
      failureCode: null
    }
  );
  assert.equal(f.repository.listOrderEvents(gtc.id).length, 1);
  assertNoCreates(f);
});

test('keeps the first attachment and stops before the third when the second attachment fails', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE'
  );
  const spot = planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '0', '1', 'unknown')
  );
  const contract = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0', '1', 'unknown')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    '0.1',
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0',
      '0.1',
      'open'
    )
  );
  f.spot.scriptedFetches.set(spot.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  f.contract.scriptedFetches.set(contract.exchangeOrderId as string, [
    snapshotFor(
      strategy.id,
      'CONTRACT_MARKET',
      '1',
      '0.9',
      '0.1',
      'closed',
      { updatedAt: SECOND_UPDATE }
    )
  ]);
  f.contract.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      '0.1',
      '0.1',
      '0',
      'closed',
      { updatedAt: SECOND_UPDATE }
    )
  ]);
  class FailSecondAttachRepository extends RepositoryProxy {
    readonly attachmentAttempts: string[] = [];
    readonly transitionTargets: StrategyState[] = [];

    override attachOrderSnapshot(
      strategyOrderId: string,
      snapshot: OrderSnapshot
    ): void {
      this.attachmentAttempts.push(strategyOrderId);
      if (this.attachmentAttempts.length === 2) {
        throw new Error('second attach secret=must-not-escape');
      }
      super.attachOrderSnapshot(strategyOrderId, snapshot);
    }

    override transition(
      strategyId: string,
      from: StrategyState[],
      to: StrategyState,
      failureCode?: StrategyFailureCode
    ): boolean {
      this.transitionTargets.push(to);
      return super.transition(strategyId, from, to, failureCode);
    }
  }
  const repository = new FailSecondAttachRepository(f.repository);

  await new OrderMonitor(f.registry, repository)
    .reconcileStrategy(strategy.id);

  assert.deepEqual(repository.attachmentAttempts, [spot.id, contract.id]);
  assert.deepEqual(repository.transitionTargets, []);
  assert.deepEqual(
    {
      state: f.repository.getStrategy(strategy.id).state,
      failureCode: f.repository.getStrategy(strategy.id).failureCode
    },
    {
      state: 'WAITING_HEDGE',
      failureCode: null
    }
  );
  const latest = new Map(
    f.repository.listOrders(strategy.id).map((order) => [
      order.id,
      order.snapshot?.filledBaseQuantity
    ])
  );
  assert.equal(latest.get(spot.id), '1');
  assert.equal(latest.get(contract.id), '0');
  assert.equal(latest.get(gtc.id), '0');
  assert.equal(f.repository.listOrderEvents(spot.id).length, 2);
  assert.equal(f.repository.listOrderEvents(contract.id).length, 1);
  assert.equal(f.repository.listOrderEvents(gtc.id).length, 1);
  assert.equal(f.spot.fetchRequests.length, 1);
  assert.equal(f.contract.fetchRequests.length, 2);
  assertNoCreates(f);
});

test('stops persisting when strategy state changes during attachment', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(f.repository, 'CONCURRENT');
  const spot = planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    '1',
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '0', '1', 'unknown')
  );
  const contract = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '0', '1', 'unknown')
  );
  f.spot.scriptedFetches.set(spot.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_MARKET', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  f.contract.scriptedFetches.set(contract.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  class StateChangingRepository extends RepositoryProxy {
    attachments = 0;

    override attachOrderSnapshot(
      orderId: string,
      snapshot: OrderSnapshot
    ): void {
      super.attachOrderSnapshot(orderId, snapshot);
      this.attachments += 1;
      if (this.attachments === 1) {
        assert.equal(
          this.target.transition(
            strategy.id,
            ['EXECUTING'],
            'HEDGED'
          ),
          true
        );
      }
    }
  }
  const repository = new StateChangingRepository(f.repository);

  await new OrderMonitor(f.registry, repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'HEDGED');
  assert.equal(repository.attachments, 1);
  assert.deepEqual(
    f.repository.listOrders(strategy.id).map(
      (order) => order.snapshot?.filledBaseQuantity
    ),
    ['1', '0']
  );
  assertNoCreates(f);
});

test('does nothing for pending and terminal strategies', async (t) => {
  const f = fixture(t);
  const pending = f.repository.createPending(preflight('CONTRACT_FIRST'));
  const pendingOrder = planOrder(
    f.repository,
    pending.id,
    'SPOT_HEDGE_GTC',
    '1'
  );
  f.spot.scriptedFinds.set(pendingOrder.clientOrderId, [
    snapshotFor(pending.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed')
  ]);
  const terminal = createStrategy(f.repository, 'CONTRACT_FIRST');
  const terminalOrder = planOrder(
    f.repository,
    terminal.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(terminal.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  assert.equal(
    f.repository.transition(terminal.id, ['EXECUTING'], 'HEDGED'),
    true
  );
  f.spot.scriptedFetches.set(terminalOrder.exchangeOrderId as string, [
    snapshotFor(terminal.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);

  const monitor = new OrderMonitor(f.registry, f.repository);
  await monitor.reconcileStrategy(pending.id);
  await monitor.reconcileStrategy(terminal.id);

  assert.equal(f.spot.findRequests.length, 0);
  assert.equal(f.spot.fetchRequests.length, 0);
  assert.equal(f.repository.listOrderEvents(pendingOrder.id).length, 0);
  assert.equal(f.repository.listOrderEvents(terminalOrder.id).length, 1);
  assertNoCreates(f);
});

test('uses exact private Decimal arithmetic despite global configuration pollution', async (t) => {
  const f = fixture(t);
  const original = {
    precision: Decimal.precision,
    rounding: Decimal.rounding,
    minE: Decimal.minE,
    maxE: Decimal.maxE
  };
  t.after(() => Decimal.set(original));
  Decimal.set({
    precision: 1,
    rounding: Decimal.ROUND_UP,
    minE: -9,
    maxE: 9
  });
  const spotFill = `0.${'1'.repeat(149)}2`;
  const contractFill = `0.${'1'.repeat(149)}1`;
  const difference = `0.${'0'.repeat(149)}1`;
  const strategy = createStrategy(
    f.repository,
    'CONCURRENT',
    'WAITING_HEDGE',
    {
      requestedBaseQuantity: spotFill,
      effectiveBaseQuantity: spotFill
    }
  );
  planOrder(
    f.repository,
    strategy.id,
    'SPOT_MARKET',
    spotFill,
    snapshotFor(
      strategy.id,
      'SPOT_MARKET',
      spotFill,
      spotFill,
      '0',
      'closed'
    )
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    spotFill,
    snapshotFor(
      strategy.id,
      'CONTRACT_MARKET',
      spotFill,
      contractFill,
      difference,
      'closed'
    )
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_HEDGE_GTC',
    difference,
    snapshotFor(
      strategy.id,
      'CONTRACT_HEDGE_GTC',
      difference,
      difference,
      '0',
      'closed'
    )
  );

  await new OrderMonitor(f.registry, f.repository)
    .reconcileStrategy(strategy.id);

  assert.equal(f.repository.getStrategy(strategy.id).state, 'HEDGED');
  assertNoCreates(f);
});

test('recovers persisted SQLite state through a new repository and monitor instance', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.7', '0.3', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  const restartedRepository = new SqliteStrategyRepository(f.database);

  await new OrderMonitor(f.registry, restartedRepository).recover();

  assert.equal(restartedRepository.getStrategy(strategy.id).state, 'HEDGED');
  assert.equal(restartedRepository.listOrderEvents(gtc.id).length, 2);
  assertNoCreates(f);
});

test('validates interval input before starting recovery', (t) => {
  const f = fixture(t);
  const monitor = new OrderMonitor(f.registry, f.repository);
  for (const interval of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    assert.throws(
      () => monitor.start(interval),
      /interval must be a positive safe integer/
    );
  }
});

test('start recovers immediately, prevents overlap, and stops idempotently', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  let releaseFirst: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let fetches = 0;
  const originalFetch = f.spot.fetchOrder.bind(f.spot);
  f.spot.fetchOrder = async (
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> => {
    fetches += 1;
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    if (fetches === 1) {
      markStarted?.();
      await firstGate;
    }
    try {
      return await originalFetch(exchangeOrderId, symbol, kind);
    } finally {
      activeFetches -= 1;
    }
  };
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.1', '0.9', 'open', {
      updatedAt: SECOND_UPDATE
    }),
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0.2', '0.8', 'open', {
      updatedAt: '2026-07-26T00:03:00.000Z'
    })
  ]);
  const clock = installManualIntervals(t);

  const stop = new OrderMonitor(f.registry, f.repository).start(10);
  await firstStarted;
  clock.tick(3);
  assert.equal(fetches, 1);
  releaseFirst?.();
  await flushMicrotasks();
  clock.tick();
  await flushMicrotasks();

  assert.equal(fetches, 2);
  assert.equal(maxActiveFetches, 1);
  stop();
  stop();
  clock.tick(10);
  await flushMicrotasks();
  assert.equal(fetches, 2);
  assertNoCreates(f);
});

test('stop clears scheduling and waits for the immediate recovery to settle', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  let releaseFetch: (() => void) | undefined;
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let fetches = 0;
  const originalFetch = f.spot.fetchOrder.bind(f.spot);
  f.spot.fetchOrder = async (
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> => {
    fetches += 1;
    markFetchStarted?.();
    await fetchGate;
    return originalFetch(exchangeOrderId, symbol, kind);
  };
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  const clock = installManualIntervals(t);
  const monitor = new OrderMonitor(f.registry, f.repository);

  monitor.start(10);
  await fetchStarted;
  let stopped = false;
  const stopping = monitor.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  clock.tick(10);
  assert.equal(fetches, 1);

  releaseFetch?.();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(
    f.repository.getStrategy(strategy.id).state,
    'HEDGED'
  );
  clock.tick(10);
  await flushMicrotasks();
  assert.equal(fetches, 1);
  assertNoCreates(f);
});

test('a rejected immediate recovery does not cause an unhandled rejection or stop later rounds', async (t) => {
  const f = fixture(t);
  const strategy = createStrategy(
    f.repository,
    'CONTRACT_FIRST',
    'WAITING_HEDGE'
  );
  planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    snapshotFor(strategy.id, 'CONTRACT_MARKET', '1', '1', '0', 'closed')
  );
  const gtc = planOrder(
    f.repository,
    strategy.id,
    'SPOT_HEDGE_GTC',
    '1',
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '0', '1', 'open')
  );
  f.spot.scriptedFetches.set(gtc.exchangeOrderId as string, [
    snapshotFor(strategy.id, 'SPOT_HEDGE_GTC', '1', '1', '0', 'closed', {
      updatedAt: SECOND_UPDATE
    })
  ]);
  class FailOnceRecoveryRepository extends RepositoryProxy {
    calls = 0;

    override listRecoverable(): StrategyRecord[] {
      this.calls += 1;
      if (this.calls === 1) {
        throw new Error('database secret=must-not-be-logged');
      }
      return super.listRecoverable();
    }
  }
  const repository = new FailOnceRecoveryRepository(f.repository);
  const clock = installManualIntervals(t);

  const stop = new OrderMonitor(f.registry, repository).start(10);
  await flushMicrotasks();
  assert.equal(repository.calls, 1);
  clock.tick();
  await flushMicrotasks();

  assert.equal(repository.calls, 2);
  assert.equal(f.repository.getStrategy(strategy.id).state, 'HEDGED');
  stop();
  assertNoCreates(f);
});
