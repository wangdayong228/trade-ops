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
  OperationalFields,
  OperationalLog
} from '../../src/logging/logger.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import type {
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../../src/storage/strategy-repository.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import { HedgeReconciliation } from '../../src/strategy/hedge-reconciliation.js';
import {
  type ExecutionContinuation,
  OrderMonitor
} from '../../src/strategy/order-monitor.js';
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

function preflight(mode: ExecutionMode): PreflightResult {
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
    createdAt: CREATED_AT
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

class MonitorGateway extends FakeExchangeGateway {
  readonly scriptedFetches = new Map<string, Array<OrderSnapshot | Error>>();

  override async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    const scripted = this.scriptedFetches.get(exchangeOrderId)?.shift();
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted !== undefined) {
      return scripted;
    }
    return super.fetchOrder(exchangeOrderId, symbol, kind);
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
  const preview = preflight('CONCURRENT');
  spot.markets.set(`spot:${preview.symbol}`, preview.spotMarket);
  contract.markets.set(`swap:${preview.symbol}`, preview.contractMarket);
  contract.accountSettings = { ...preview.accountSettings };
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  return { database, repository, spot, contract, registry };
}

function createWaitingStrategy(
  repository: StrategyRepository
): StrategyRecord {
  const strategy = repository.createPending(preflight('CONTRACT_FIRST'));
  assert.equal(repository.claimForExecution(strategy.id), true);
  assert.equal(
    repository.transition(strategy.id, ['EXECUTING'], 'WAITING_HEDGE'),
    true
  );
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

function monitorStrategy(
  id: string,
  state: 'EXECUTING' | 'WAITING_HEDGE'
): StrategyRecord {
  const preview = preflight('CONCURRENT');
  return {
    id,
    state,
    mode: preview.mode,
    spotExchangeId: preview.spotExchangeId,
    contractExchangeId: preview.contractExchangeId,
    symbol: preview.symbol,
    requestedBaseQuantity: preview.requestedBaseQuantity,
    effectiveBaseQuantity: preview.effectiveBaseQuantity,
    preflight: preview,
    failureCode: null,
    createdAt: preview.createdAt,
    updatedAt: preview.createdAt
  };
}

function monitorRepository(
  records: readonly StrategyRecord[]
): StrategyRepository {
  const target = {
    listRecoverable(): StrategyRecord[] {
      return [...records];
    }
  } as unknown as StrategyRepository;
  return new Proxy(target, {
    get(object, property, receiver): unknown {
      if (property !== 'listRecoverable') {
        throw new Error(
          `monitor touched forbidden repository member ${String(property)}`
        );
      }
      return Reflect.get(object, property, receiver);
    }
  });
}

class CapturingContinuation implements ExecutionContinuation {
  readonly calls: string[] = [];
  errorFor = new Set<string>();

  async confirmAndExecute(strategyId: string): Promise<void> {
    this.calls.push(strategyId);
    if (this.errorFor.has(strategyId)) {
      throw new Error('controlled continuation failure');
    }
  }
}

class DeferredContinuation implements ExecutionContinuation {
  readonly calls: string[] = [];
  #release: (() => void) | undefined;
  #started: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.#started = resolve;
  });
  readonly gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  async confirmAndExecute(strategyId: string): Promise<void> {
    this.calls.push(strategyId);
    this.#started?.();
    await this.gate;
  }
}

interface CapturedOperationalError {
  readonly event: string;
  readonly error: unknown;
  readonly fields: Readonly<OperationalFields> | undefined;
}

function captureOperationalErrors(
  errors: CapturedOperationalError[]
): OperationalLog {
  return {
    info(): void {},
    warn(): void {},
    error(event, error, fields): void {
      errors.push({ event, error, fields });
    },
    fatal(): void {}
  };
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

test('deduplicates concurrent reconciliation for one strategy', async (t) => {
  const continuation = new DeferredContinuation();
  t.after(() => continuation.release());
  const monitor = new OrderMonitor(
    monitorRepository([]),
    continuation
  );

  const first = monitor.reconcileStrategy('strategy-1');
  await continuation.started;
  const second = monitor.reconcileStrategy('strategy-1');
  await Promise.resolve();

  assert.deepEqual(continuation.calls, ['strategy-1']);
  continuation.release();
  await Promise.all([first, second]);
  assert.deepEqual(continuation.calls, ['strategy-1']);
});

test('forwards every recoverable strategy and touches no other dependency', async () => {
  const records = [
    monitorStrategy('executing', 'EXECUTING'),
    monitorStrategy('waiting', 'WAITING_HEDGE')
  ];
  const continuation = new CapturingContinuation();
  const monitor = new OrderMonitor(
    monitorRepository(records),
    continuation
  );

  await monitor.recover();

  assert.deepEqual(continuation.calls, ['executing', 'waiting']);
});

test('isolates one continuation failure and continues recovery', async () => {
  const records = [
    monitorStrategy('fails', 'EXECUTING'),
    monitorStrategy('continues', 'WAITING_HEDGE')
  ];
  const continuation = new CapturingContinuation();
  continuation.errorFor.add('fails');
  const monitor = new OrderMonitor(
    monitorRepository(records),
    continuation
  );

  await monitor.recover();

  assert.deepEqual(continuation.calls, ['fails', 'continues']);
});

test('logging failures cannot change recovery forwarding', async () => {
  const records = [monitorStrategy('fails', 'EXECUTING')];
  const continuation = new CapturingContinuation();
  continuation.errorFor.add('fails');
  const throwingLog: OperationalLog = {
    info(): void { throw new Error('logger info failure'); },
    warn(): void { throw new Error('logger warn failure'); },
    error(): void { throw new Error('logger error failure'); },
    fatal(): void { throw new Error('logger fatal failure'); }
  };
  const monitor = new OrderMonitor(
    monitorRepository(records),
    continuation,
    throwingLog
  );

  await monitor.recover();

  assert.deepEqual(continuation.calls, ['fails']);
});

test('recovers persisted SQLite state through a new repository and monitor instance', async (t) => {
  const f = fixture(t);
  const strategy = createWaitingStrategy(f.repository);
  const contractMarketSnapshot = snapshotFor(
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    '1',
    '0',
    'closed'
  );
  const contractMarket = planOrder(
    f.repository,
    strategy.id,
    'CONTRACT_MARKET',
    '1',
    contractMarketSnapshot
  );
  f.contract.scriptedFetches.set(
    contractMarket.exchangeOrderId as string,
    [structuredClone(contractMarketSnapshot)]
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
  const reconciliation = new HedgeReconciliation(
    f.registry,
    restartedRepository
  );
  const coordinator = new HedgeCoordinator(
    f.registry,
    restartedRepository,
    reconciliation
  );

  await new OrderMonitor(restartedRepository, coordinator).recover();

  assert.equal(restartedRepository.getStrategy(strategy.id).state, 'HEDGED');
  assert.equal(restartedRepository.listOrderEvents(gtc.id).length, 2);
  assertNoCreates(f);
});

test('validates interval input before starting recovery', () => {
  const monitor = new OrderMonitor(
    monitorRepository([]),
    new CapturingContinuation()
  );
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
  const continuation = new DeferredContinuation();
  t.after(() => continuation.release());
  const clock = installManualIntervals(t);
  const stop = new OrderMonitor(
    monitorRepository([monitorStrategy('strategy-1', 'EXECUTING')]),
    continuation
  ).start(10);

  await continuation.started;
  clock.tick(3);
  assert.deepEqual(continuation.calls, ['strategy-1']);
  continuation.release();
  await flushMicrotasks();
  clock.tick();
  await flushMicrotasks();

  assert.deepEqual(continuation.calls, ['strategy-1', 'strategy-1']);
  stop();
  stop();
  clock.tick(10);
  await flushMicrotasks();
  assert.deepEqual(continuation.calls, ['strategy-1', 'strategy-1']);
});

test('stop clears scheduling and waits for the immediate recovery to settle', async (t) => {
  const continuation = new DeferredContinuation();
  t.after(() => continuation.release());
  const clock = installManualIntervals(t);
  const monitor = new OrderMonitor(
    monitorRepository([monitorStrategy('strategy-1', 'WAITING_HEDGE')]),
    continuation
  );

  monitor.start(10);
  await continuation.started;
  let stopped = false;
  const stopping = monitor.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  clock.tick(10);
  assert.deepEqual(continuation.calls, ['strategy-1']);

  continuation.release();
  await stopping;
  assert.equal(stopped, true);
  clock.tick(10);
  await flushMicrotasks();
  assert.deepEqual(continuation.calls, ['strategy-1']);
});

test('a rejected immediate recovery does not cause an unhandled rejection or stop later rounds', async (t) => {
  const operationalErrors: CapturedOperationalError[] = [];
  const records = [monitorStrategy('strategy-1', 'EXECUTING')];
  let repositoryCalls = 0;
  const target = {
    listRecoverable(): StrategyRecord[] {
      repositoryCalls += 1;
      if (repositoryCalls === 1) {
        throw new Error('database secret=must-not-be-logged');
      }
      return [...records];
    }
  } as unknown as StrategyRepository;
  const repository = new Proxy(target, {
    get(object, property, receiver): unknown {
      if (property !== 'listRecoverable') {
        throw new Error(
          `monitor touched forbidden repository member ${String(property)}`
        );
      }
      return Reflect.get(object, property, receiver);
    }
  });
  const continuation = new CapturingContinuation();
  const clock = installManualIntervals(t);

  const stop = new OrderMonitor(
    repository,
    continuation,
    captureOperationalErrors(operationalErrors)
  ).start(10);
  await flushMicrotasks();
  assert.equal(repositoryCalls, 1);
  clock.tick();
  await flushMicrotasks();

  assert.equal(repositoryCalls, 2);
  assert.deepEqual(continuation.calls, ['strategy-1']);
  assert.equal(operationalErrors.length, 1);
  assert.equal(operationalErrors[0]?.event, 'monitor_recovery_failed');
  assert.equal(
    (operationalErrors[0]?.error as Error | undefined)?.message,
    'database secret=must-not-be-logged'
  );
  assert.equal(operationalErrors[0]?.fields, undefined);
  stop();
});
