/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import * as ccxt from 'ccxt';
import {
  type FundingRateEvent,
  type FundingRateEventSink
} from '../../src/funding-rates/funding-rate-events.js';
import {
  settledFundingRate,
  type FundingMarketIdentity,
  type FundingMarketObservation,
  type SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import type { FundingRateSource } from '../../src/funding-rates/funding-rate-source.js';
import {
  fundingTaskFailure,
  type CoverageLease,
  type FundingCoverageKind,
  type FundingDiscoveryResult,
  type FundingExhaustionEvidence,
  type FundingMarketState,
  type FundingPageWriteResult,
  type FundingRateRepository,
  type FundingTaskFailure,
  type IncrementalLease
} from '../../src/storage/funding-rate-repository.js';
import { SqliteFundingRateRepository } from '../../src/storage/sqlite-funding-rate-repository.js';
import {
  FakeAsyncGate,
  FakeFundingRateSource,
  fakeOkxPage,
  type FakeFundingDiscoveryStep,
  type FakeFundingPageStep
} from '../support/fake-funding-rate-source.js';

type FundingSleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

interface FundingRateExchangeWorkerOptions {
  readonly source: FundingRateSource;
  readonly repository: FundingRateRepository;
  readonly events: FundingRateEventSink;
  readonly intervalMs: number;
  readonly nowMs: () => number;
  readonly sleep: FundingSleep;
}

interface Task8Worker {
  start(): void;
  scheduleDiscovery(): void;
  stop(): Promise<void>;
}

interface FundingRateSyncServiceOptions {
  readonly bitgetSource: FundingRateSource;
  readonly okxSource: FundingRateSource;
  readonly repository: FundingRateRepository;
  readonly events: FundingRateEventSink;
  readonly intervalMs: number;
  readonly nowMs: () => number;
  readonly sleep: FundingSleep;
}

interface Task8Service {
  start(): void;
  stop(): Promise<void>;
}

interface Task8Modules {
  readonly FundingRateExchangeWorker: new (
    options: FundingRateExchangeWorkerOptions
  ) => Task8Worker;
  readonly FundingRateSyncService: new (
    options: FundingRateSyncServiceOptions
  ) => Task8Service;
}

interface LoadedTask8Modules {
  readonly modules: Task8Modules | null;
  readonly issue: string | null;
}

const fundingModuleDirectory = '../../src/funding-rates/';

async function loadTask8Modules(): Promise<LoadedTask8Modules> {
  try {
    const [worker, service] = await Promise.all([
      import(fundingModuleDirectory + 'funding-rate-exchange-worker.js'),
      import(fundingModuleDirectory + 'funding-rate-sync-service.js')
    ]);
    const workerConstructor = Reflect.get(worker, 'FundingRateExchangeWorker');
    const serviceConstructor = Reflect.get(service, 'FundingRateSyncService');
    if (typeof workerConstructor !== 'function') {
      return { modules: null, issue: 'FundingRateExchangeWorker export is missing' };
    }
    if (typeof serviceConstructor !== 'function') {
      return { modules: null, issue: 'FundingRateSyncService export is missing' };
    }
    return {
      modules: {
        FundingRateExchangeWorker: workerConstructor as Task8Modules['FundingRateExchangeWorker'],
        FundingRateSyncService: serviceConstructor as Task8Modules['FundingRateSyncService']
      },
      issue: null
    };
  } catch (error) {
    return {
      modules: null,
      issue: error instanceof Error ? error.message : String(error)
    };
  }
}

const loadedTask8 = await loadTask8Modules();
const task8Skip = loadedTask8.issue ?? false;

function task8Modules(): Task8Modules {
  if (loadedTask8.modules === null) {
    assert.fail(`Task 8 production modules unavailable: ${loadedTask8.issue}`);
  }
  return loadedTask8.modules;
}

function task8Test(
  name: string,
  body: (t: TestContext) => void | Promise<void>
): void {
  test(name, { skip: task8Skip }, body);
}

const START_MS = Date.parse('2026-09-06T00:00:00.000Z');
const INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

const BITGET_BTC = {
  exchangeId: 'bitget',
  exchangeMarketId: 'BTCUSDT',
  symbol: 'BTC/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const OKX_BTC = {
  exchangeId: 'okx',
  exchangeMarketId: 'BTC-USDT-SWAP',
  symbol: 'BTC/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const OKX_ETH = {
  exchangeId: 'okx',
  exchangeMarketId: 'ETH-USDT-SWAP',
  symbol: 'ETH/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const OKX_SOL = {
  exchangeId: 'okx',
  exchangeMarketId: 'SOL-USDT-SWAP',
  symbol: 'SOL/USDT:USDT'
} as const satisfies FundingMarketIdentity;

class ManualClock {
  constructor(private value: number = START_MS) {}

  readonly nowMs = (): number => this.value;

  set(value: number): void {
    this.value = value;
  }

  advance(delayMs: number): void {
    this.value += delayMs;
  }
}

class AutoAdvancingSleeper {
  readonly calls: number[] = [];

  constructor(private readonly clock: ManualClock) {}

  readonly sleep: FundingSleep = async (delayMs, signal) => {
    this.calls.push(delayMs);
    if (!signal.aborted) this.clock.advance(delayMs);
    await Promise.resolve();
  };
}

interface PendingSleep {
  readonly delayMs: number;
  readonly signal: AbortSignal;
  canceled: boolean;
  release(): void;
}

class ManualSleeper {
  readonly calls: PendingSleep[] = [];

  constructor(private readonly clock: ManualClock) {}

  readonly sleep: FundingSleep = (delayMs, signal) => new Promise((resolveSleep) => {
    let settled = false;
    const finish = (canceled: boolean): void => {
      if (settled) return;
      settled = true;
      call.canceled = canceled;
      signal.removeEventListener('abort', onAbort);
      if (!canceled) this.clock.advance(delayMs);
      resolveSleep();
    };
    const onAbort = (): void => finish(true);
    const call: PendingSleep = {
      delayMs,
      signal,
      canceled: false,
      release: () => finish(false)
    };
    this.calls.push(call);
    if (signal.aborted) finish(true);
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

class RecordingEventSink implements FundingRateEventSink {
  readonly events: FundingRateEvent[] = [];

  record(event: Readonly<FundingRateEvent>): void {
    this.events.push(event);
  }
}

interface RepositoryCall {
  readonly method: keyof FundingRateRepository;
  readonly arguments: readonly unknown[];
}

type RepositoryHook = (
  arguments_: readonly unknown[],
  target: FundingRateRepository
) => void;

function observeRepository(
  target: FundingRateRepository,
  hooks: Partial<Record<keyof FundingRateRepository, RepositoryHook>> = {}
): { readonly repository: FundingRateRepository; readonly calls: RepositoryCall[] } {
  const calls: RepositoryCall[] = [];
  const repository = new Proxy(target, {
    get(object, property, receiver): unknown {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      return (...arguments_: unknown[]): unknown => {
        const method = property as keyof FundingRateRepository;
        calls.push({ method, arguments: arguments_ });
        hooks[method]?.(arguments_, target);
        return Reflect.apply(value, object, arguments_);
      };
    }
  });
  return { repository, calls };
}

function memoryRepository(t: TestContext): {
  readonly database: Database.Database;
  readonly target: SqliteFundingRateRepository;
} {
  const database = new Database(':memory:');
  t.after(() => database.close());
  return { database, target: new SqliteFundingRateRepository(database) };
}

function observation(
  market: FundingMarketIdentity,
  active = true
): FundingMarketObservation {
  return { ...market, active };
}

function fundingRecord(
  market: FundingMarketIdentity,
  fundingTimestampMs: number
): SettledFundingRate {
  return settledFundingRate(
    market,
    '0.00010000000000000001',
    fundingTimestampMs,
    market.exchangeId === 'bitget'
      ? {
          symbol: market.exchangeMarketId,
          fundingRate: '0.00010000000000000001',
          fundingTime: String(fundingTimestampMs)
        }
      : {
          instId: market.exchangeMarketId,
          realizedRate: '0.00010000000000000001',
          fundingTime: String(fundingTimestampMs)
        }
  );
}

function discover(
  repository: FundingRateRepository,
  markets: readonly FundingMarketIdentity[],
  observedAtMs = START_MS
): void {
  const grouped = new Map<'bitget' | 'okx', FundingMarketObservation[]>();
  for (const market of markets) {
    const values = grouped.get(market.exchangeId) ?? [];
    values.push(observation(market));
    grouped.set(market.exchangeId, values);
  }
  for (const [exchangeId, values] of grouped) {
    repository.applyCompleteDiscovery(exchangeId, values, new Date(observedAtMs));
  }
}

function completeOkxCoverage(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  completedAtMs: number,
  cutoffMs = completedAtMs
): CoverageLease {
  const lease = repository.startCoverage(
    market,
    'INITIAL',
    cutoffMs,
    new Date(completedAtMs - 1)
  );
  repository.completeCoverage(
    lease,
    {
      exchangeId: 'okx',
      generation: lease.generation,
      cutoffMs,
      explicitEmpty: true,
      finalRequestAfterMs: null
    },
    new Date(completedAtMs)
  );
  return lease;
}

function startWorker(
  t: TestContext,
  options: FundingRateExchangeWorkerOptions
): Task8Worker {
  const { FundingRateExchangeWorker } = task8Modules();
  const worker = new FundingRateExchangeWorker(options);
  t.after(async () => {
    await worker.stop().catch(() => undefined);
  });
  worker.start();
  return worker;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  turns = 200
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

interface ManualInterval {
  active: boolean;
  readonly callback: () => void;
}

function installManualIntervals(t: TestContext): {
  readonly intervals: ManualInterval[];
  readonly tick: (includeInactive?: boolean) => void;
} {
  const intervals: ManualInterval[] = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((callback: () => void) => {
    const interval = { active: true, callback };
    intervals.push(interval);
    return interval as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    (timer as unknown as ManualInterval).active = false;
  }) as typeof clearInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return {
    intervals,
    tick(includeInactive = false): void {
      for (const interval of [...intervals]) {
        if (interval.active || includeInactive) interval.callback();
      }
    }
  };
}

function workerOptions(
  source: FundingRateSource,
  repository: FundingRateRepository,
  clock: ManualClock,
  sleep: FundingSleep,
  events: FundingRateEventSink = new RecordingEventSink()
): FundingRateExchangeWorkerOptions {
  return {
    source,
    repository,
    events,
    intervalMs: INTERVAL_MS,
    nowMs: clock.nowMs,
    sleep
  };
}

function callsNamed(
  calls: readonly RepositoryCall[],
  method: keyof FundingRateRepository
): RepositoryCall[] {
  return calls.filter((call) => call.method === method);
}

test('exports the approved Task 8 worker and service runtime constructors', () => {
  assert.equal(
    loadedTask8.issue,
    null,
    loadedTask8.issue ?? 'Task 8 production modules are unavailable'
  );
  assert.notEqual(loadedTask8.modules, null);
});

task8Test('pins both direct CCXT declarations to exactly 4.5.68', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve('package.json'), 'utf8')
  ) as { readonly dependencies?: Readonly<Record<string, string>> };
  const packageLock = JSON.parse(
    readFileSync(resolve('package-lock.json'), 'utf8')
  ) as {
    readonly packages?: Readonly<Record<
      string,
      { readonly dependencies?: Readonly<Record<string, string>> }
    >>;
  };

  assert.equal(packageJson.dependencies?.ccxt, '4.5.68');
  assert.equal(packageLock.packages?.['']?.dependencies?.ccxt, '4.5.68');
});

task8Test('retries only the pinned ESM NetworkError prototype family', async (t) => {
  type ErrorConstructor = new (message: string) => Error;
  const expectedDescendants = [
    'ChecksumError',
    'DDoSProtection',
    'ExchangeNotAvailable',
    'InvalidNonce',
    'OnMaintenance',
    'RateLimitExceeded',
    'RequestTimeout'
  ];
  const discoveredDescendants = Object.entries(ccxt)
    .filter(([, value]) => (
      typeof value === 'function'
      && value.prototype instanceof ccxt.NetworkError
    ))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(discoveredDescendants, expectedDescendants);

  const constructors: ErrorConstructor[] = [
    ccxt.NetworkError,
    ...expectedDescendants.map((name) => {
      const constructor = Reflect.get(ccxt, name);
      assert.equal(typeof constructor, 'function');
      return constructor as ErrorConstructor;
    })
  ];
  for (const ErrorType of constructors) {
    const { target } = memoryRepository(t);
    const clock = new ManualClock();
    const sleeper = new AutoAdvancingSleeper(clock);
    const source = new FakeFundingRateSource(
      'bitget',
      [],
      [],
      [
        { responseError: new ErrorType('temporary') },
        { observations: [] }
      ],
      clock.nowMs
    );
    const probe = observeRepository(target);
    const worker = startWorker(
      t,
      workerOptions(source, probe.repository, clock, sleeper.sleep)
    );
    await waitFor(
      () => callsNamed(probe.calls, 'applyCompleteDiscovery').length === 1,
      `${ErrorType.name} was not retried`
    );
    await worker.stop();
    assert.equal(source.discoveryCalls.length, 2, ErrorType.name);
    assert.deepEqual(sleeper.calls, [1_000], ErrorType.name);
  }

  const require = createRequire(import.meta.url);
  const commonJsCcxt = require('ccxt') as {
    readonly NetworkError: ErrorConstructor;
  };
  const negativeErrors = [
    new ccxt.ExchangeError('exchange'),
    new ccxt.OperationFailed('operation'),
    new commonJsCcxt.NetworkError('cross-instance'),
    Object.assign(new Error('forged'), { name: 'NetworkError' })
  ];
  for (const error of negativeErrors) {
    const { target } = memoryRepository(t);
    const clock = new ManualClock();
    const sleeper = new AutoAdvancingSleeper(clock);
    const events = new RecordingEventSink();
    const source = new FakeFundingRateSource(
      'bitget',
      [],
      [],
      [
        { responseError: error },
        { observations: [] }
      ],
      clock.nowMs
    );
    const worker = startWorker(
      t,
      workerOptions(source, target, clock, sleeper.sleep, events)
    );
    await waitFor(
      () => events.events.some(({ event }) => event === 'funding_market_discovery_incomplete'),
      `${error.name} did not finish without retry`
    );
    await worker.stop();
    assert.equal(source.discoveryCalls.length, 1, error.name);
    assert.deepEqual(sleeper.calls, [], error.name);
  }
});

task8Test('uses initial plus three retries with exact backoff and exact discovery metadata', async (t) => {
  const { target } = memoryRepository(t);
  const clock = new ManualClock();
  const sleeper = new AutoAdvancingSleeper(clock);
  const events = new RecordingEventSink();
  const source = new FakeFundingRateSource(
    'okx',
    [],
    [],
    [1, 2, 3, 4].map(() => ({
      responseError: new ccxt.NetworkError('temporary secret=hidden')
    })),
    clock.nowMs
  );
  const worker = startWorker(
    t,
    workerOptions(source, target, clock, sleeper.sleep, events)
  );

  await waitFor(
    () => events.events.some(({ event }) => event === 'funding_market_discovery_incomplete'),
    'retry exhaustion was not reported'
  );
  await worker.stop();

  assert.equal(source.discoveryCalls.length, 4);
  assert.deepEqual(sleeper.calls, [1_000, 2_000, 4_000]);
  const retries = events.events.filter(({ event }) => event === 'funding_request_retry');
  assert.deepEqual(
    retries.map((event) => event.event === 'funding_request_retry'
      ? [event.taskCategory, event.retryAttempt, event.retryDelayMs, event.request]
      : null),
    [
      ['discovery', 1, 1_000, source.discoveryRequestCalls[0]],
      ['discovery', 2, 2_000, source.discoveryRequestCalls[0]],
      ['discovery', 3, 4_000, source.discoveryRequestCalls[0]]
    ]
  );
});

task8Test('reports real executor retries and exhaustion in the matching task category', async (t) => {
  for (const category of ['coverage', 'incremental'] as const) {
    const { target } = memoryRepository(t);
    discover(target, [OKX_BTC]);
    if (category === 'incremental') {
      completeOkxCoverage(target, OKX_BTC, START_MS - 10);
      target.startIncremental(OKX_BTC, new Date(START_MS - 1));
    } else {
      target.startCoverage(OKX_BTC, 'INITIAL', START_MS, new Date(START_MS));
    }
    const clock = new ManualClock(START_MS + 1);
    const sleeper = new AutoAdvancingSleeper(clock);
    const events = new RecordingEventSink();
    const source = new FakeFundingRateSource(
      'okx',
      [1, 2, 3, 4].map(() => ({
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx' as const, afterMs: null },
        responseError: new ccxt.RequestTimeout('temporary')
      })),
      [],
      [{ observations: [observation(OKX_BTC)] }],
      clock.nowMs
    );
    const worker = startWorker(
      t,
      workerOptions(source, target, clock, sleeper.sleep, events)
    );
    await waitFor(
      () => events.events.some(({ event }) => event === 'funding_task_incomplete'),
      `${category} retry exhaustion was not reported`
    );
    await worker.stop();

    const request = {
      method: 'GET',
      path: '/api/v5/public/funding-rate-history',
      query: { instId: OKX_BTC.exchangeMarketId, limit: 400 },
      body: null
    } as const;
    const retries = events.events.filter((event) => event.event === 'funding_request_retry');
    assert.deepEqual(
      retries.map((event) => [
        event.taskCategory,
        event.retryAttempt,
        event.retryDelayMs,
        event.request
      ]),
      [
        [category, 1, 1_000, request],
        [category, 2, 2_000, request],
        [category, 3, 4_000, request]
      ]
    );
    const incomplete = events.events.find((event) => event.event === 'funding_task_incomplete');
    assert.equal(incomplete?.event, 'funding_task_incomplete');
    if (incomplete?.event === 'funding_task_incomplete') {
      assert.equal(incomplete.taskCategory, category);
      assert.deepEqual(incomplete.request, request);
      assert.equal(incomplete.error.type, 'FundingRequestRetryExhaustedError');
    }
  }
});

task8Test('runs exchanges in parallel while serializing discovery and pages per exchange', async (t) => {
  const { target } = memoryRepository(t);
  const bitgetGate = new FakeAsyncGate();
  const okxGate = new FakeAsyncGate();
  const pageGate = new FakeAsyncGate();
  const clock = new ManualClock();
  const sleeper = new AutoAdvancingSleeper(clock);
  const bitget = new FakeFundingRateSource(
    'bitget',
    [{
      marketId: BITGET_BTC.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      page: {
        cursor: { exchangeId: 'bitget', pageNo: 1 },
        records: [],
        nextCursor: null,
        recoveryAnchorMs: null
      },
      parseGate: pageGate
    }],
    [],
    [{ observations: [observation(BITGET_BTC)], gate: bitgetGate }],
    clock.nowMs
  );
  const okx = new FakeFundingRateSource(
    'okx',
    [],
    [],
    [{ observations: [], gate: okxGate }],
    clock.nowMs
  );
  const { FundingRateSyncService } = task8Modules();
  const service = new FundingRateSyncService({
    bitgetSource: bitget,
    okxSource: okx,
    repository: target,
    events: new RecordingEventSink(),
    intervalMs: INTERVAL_MS,
    nowMs: clock.nowMs,
    sleep: sleeper.sleep
  });
  t.after(async () => service.stop().catch(() => undefined));

  service.start();
  await Promise.all([bitgetGate.entered, okxGate.entered]);
  assert.equal(bitget.discoveryCalls.length, 1);
  assert.equal(okx.discoveryCalls.length, 1);
  bitgetGate.release();
  await pageGate.entered;
  assert.equal(bitget.maximumConcurrentOperations, 1);
  assert.equal(okx.maximumConcurrentOperations, 1);

  const stopping = service.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  okxGate.release();
  pageGate.release();
  await stopping;
  assert.equal(bitget.fetchCalls.length, 1);
  assert.ok(sleeper.calls.includes(100));
});

task8Test('does not barrier immediate incremental behind another recovery coverage', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC, OKX_ETH]);
  target.startCoverage(
    OKX_BTC,
    'INITIAL',
    START_MS,
    new Date(START_MS)
  );
  target.startCoverage(
    OKX_ETH,
    'INITIAL',
    START_MS,
    new Date(START_MS)
  );
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new AutoAdvancingSleeper(clock);
  const immediateIncrementalGate = new FakeAsyncGate();
  const source = new FakeFundingRateSource(
    'okx',
    [
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [])
      },
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, []),
        parseGate: immediateIncrementalGate
      }
    ],
    [],
    [{ observations: [observation(OKX_BTC), observation(OKX_ETH)] }],
    clock.nowMs
  );
  const worker = startWorker(
    t,
    workerOptions(source, target, clock, sleeper.sleep)
  );

  try {
    await waitFor(
      () => source.fetchCalls.length >= 2,
      'worker did not dispatch two recovery-era page turns'
    );
    assert.deepEqual(
      source.fetchCalls.slice(0, 2).map(({ market }) => market.exchangeMarketId),
      [OKX_BTC.exchangeMarketId, OKX_BTC.exchangeMarketId],
      'completed recovery coverage must expose its immediate incremental to round-robin'
    );
  } finally {
    const stopping = worker.stop();
    immediateIncrementalGate.release();
    await stopping.catch(() => undefined);
  }
});

task8Test('recovers SQLite leases and preserves discovery-incremental-backfill-reconcile rotation', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC, OKX_ETH, OKX_SOL]);

  completeOkxCoverage(target, OKX_BTC, START_MS + 10);
  const oldIncremental = target.startIncremental(OKX_BTC, new Date(START_MS + 20));

  const oldBackfill = target.startCoverage(
    OKX_ETH,
    'INITIAL',
    START_MS + 30,
    new Date(START_MS + 30)
  );
  target.commitCoveragePage(
    oldBackfill,
    [fundingRecord(OKX_ETH, START_MS - 1_000)],
    { exchangeId: 'okx', recoveryAnchorMs: START_MS - 1_000 },
    new Date(START_MS + 31)
  );

  completeOkxCoverage(target, OKX_SOL, START_MS + 40);
  const oldReconcile = target.startCoverage(
    OKX_SOL,
    'PERIODIC',
    START_MS + 50,
    new Date(START_MS + 50)
  );

  const clock = new ManualClock(START_MS + 60);
  const sleeper = new AutoAdvancingSleeper(clock);
  const lastGate = new FakeAsyncGate();
  const trace: string[] = [];
  const steps: FakeFundingPageStep[] = [
    {
      marketId: OKX_BTC.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      page: fakeOkxPage(null, [fundingRecord(OKX_BTC, START_MS + 5)])
    },
    {
      marketId: OKX_ETH.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: START_MS - 1_000 },
      page: fakeOkxPage(START_MS - 1_000, [fundingRecord(OKX_ETH, START_MS - 2_000)])
    },
    {
      marketId: OKX_SOL.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      page: fakeOkxPage(null, [fundingRecord(OKX_SOL, START_MS - 3_000)])
    },
    {
      marketId: OKX_SOL.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      page: fakeOkxPage(null, []),
      parseGate: lastGate
    }
  ];
  const source = new FakeFundingRateSource(
    'okx',
    steps,
    trace,
    [{ observations: [
      observation(OKX_BTC),
      observation(OKX_ETH),
      observation(OKX_SOL)
    ] }],
    clock.nowMs
  );
  const probe = observeRepository(target);
  const worker = startWorker(
    t,
    workerOptions(source, probe.repository, clock, sleeper.sleep)
  );

  try {
    await waitFor(
      () => source.fetchCalls.length >= 4,
      'worker did not dispatch the fifth recovery-era operation'
    );
    assert.deepEqual(
      source.operationCalls.map(({ kind, marketId }) => [kind, marketId]),
      [
        ['discovery', null],
        ['page', OKX_BTC.exchangeMarketId],
        ['page', OKX_ETH.exchangeMarketId],
        ['page', OKX_SOL.exchangeMarketId],
        ['page', OKX_SOL.exchangeMarketId]
      ]
    );
    const resumeCall = callsNamed(probe.calls, 'resumeInterruptedCoverage');
    const restartCall = callsNamed(probe.calls, 'restartInterruptedIncremental');
    assert.equal(resumeCall.length, 2);
    assert.equal(restartCall.length, 1);
    assert.deepEqual(restartCall[0]?.arguments[0], OKX_BTC);
    assert.equal((restartCall[0]?.arguments[1] as Date).getTime(), START_MS + 60);
    assert.equal((resumeCall[0]?.arguments[1] as Date).getTime(), START_MS + 60);
    assert.ok(oldIncremental.generation < target.listMarketStates('okx')[0]!.incrementalGeneration);
    assert.ok(oldBackfill.generation < target.listMarketStates('okx')[1]!.coverageGeneration);
    assert.ok(oldReconcile.generation < target.listMarketStates('okx')[2]!.coverageGeneration);
  } finally {
    const stopping = worker.stop();
    lastGate.release();
    await stopping.catch(() => undefined);
  }
});

task8Test('rotates FIFO markets after one page and lets a failing market yield', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_ETH, OKX_SOL]);
  target.startCoverage(OKX_ETH, 'INITIAL', START_MS, new Date(START_MS));
  target.startCoverage(OKX_SOL, 'INITIAL', START_MS, new Date(START_MS));
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new AutoAdvancingSleeper(clock);
  const gate = new FakeAsyncGate();
  const source = new FakeFundingRateSource(
    'okx',
    [
      {
        marketId: OKX_ETH.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [fundingRecord(OKX_ETH, START_MS - 1)])
      },
      {
        marketId: OKX_SOL.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        responseError: new Error('synthetic parse failure')
      },
      {
        marketId: OKX_ETH.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: START_MS - 1 },
        page: fakeOkxPage(START_MS - 1, []),
        parseGate: gate
      }
    ],
    [],
    [{ observations: [observation(OKX_ETH), observation(OKX_SOL)] }],
    clock.nowMs
  );
  const worker = startWorker(
    t,
    workerOptions(source, target, clock, sleeper.sleep)
  );

  await gate.entered;
  assert.deepEqual(
    source.fetchCalls.map(({ market }) => market.exchangeMarketId),
    [OKX_ETH.exchangeMarketId, OKX_SOL.exchangeMarketId, OKX_ETH.exchangeMarketId]
  );
  assert.equal(sleeper.calls.filter((delay) => delay === 250).length, 3);
  const stopping = worker.stop();
  gate.release();
  await stopping;
});

task8Test('drops duplicate timer ticks without a compensation discovery backlog', async (t) => {
  const intervals = installManualIntervals(t);
  const { target } = memoryRepository(t);
  const firstGate = new FakeAsyncGate();
  const secondGate = new FakeAsyncGate();
  const clock = new ManualClock();
  const sleeper = new AutoAdvancingSleeper(clock);
  const bitget = new FakeFundingRateSource(
    'bitget',
    [],
    [],
    [
      { observations: [], gate: firstGate },
      { observations: [], gate: secondGate }
    ],
    clock.nowMs
  );
  const okx = new FakeFundingRateSource(
    'okx',
    [],
    [],
    [{ observations: [] }],
    clock.nowMs
  );
  const { FundingRateSyncService } = task8Modules();
  const service = new FundingRateSyncService({
    bitgetSource: bitget,
    okxSource: okx,
    repository: target,
    events: new RecordingEventSink(),
    intervalMs: INTERVAL_MS,
    nowMs: clock.nowMs,
    sleep: sleeper.sleep
  });
  t.after(async () => service.stop().catch(() => undefined));
  service.start();
  service.start();
  assert.equal(intervals.intervals.length, 1);
  await firstGate.entered;
  intervals.tick();
  intervals.tick();
  intervals.tick();
  firstGate.release();
  await waitFor(() => bitget.discoveryCalls.length === 1, 'first discovery did not finish');
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.equal(bitget.discoveryCalls.length, 1);

  intervals.tick();
  await secondGate.entered;
  assert.equal(bitget.discoveryCalls.length, 2);
  const stopping = service.stop();
  secondGate.release();
  await stopping;
});

task8Test('rejects a missing known market atomically but continues known work and retries later', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC]);
  target.startCoverage(OKX_BTC, 'INITIAL', START_MS, new Date(START_MS));
  const pageGate = new FakeAsyncGate();
  const retryGate = new FakeAsyncGate();
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new AutoAdvancingSleeper(clock);
  const events = new RecordingEventSink();
  const source = new FakeFundingRateSource(
    'okx',
    [{
      marketId: OKX_BTC.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      page: fakeOkxPage(null, []),
      parseGate: pageGate
    }],
    [],
    [
      { observations: [] },
      { observations: [observation(OKX_BTC)], gate: retryGate }
    ],
    clock.nowMs
  );
  const worker = startWorker(
    t,
    workerOptions(source, target, clock, sleeper.sleep, events)
  );

  await pageGate.entered;
  assert.equal(target.listMarketStates('okx')[0]?.active, true);
  assert.ok(events.events.some(({ event }) => event === 'funding_market_discovery_incomplete'));
  worker.scheduleDiscovery();
  pageGate.release();
  await retryGate.entered;
  assert.equal(source.discoveryCalls.length, 2);
  const stopping = worker.stop();
  retryGate.release();
  await stopping;
});

task8Test('uses attempt-end and 24-hour due boundaries without hot-loop duplicates', async (t) => {
  interface DueCase {
    readonly name: string;
    readonly dueAtMs: number;
    readonly prepare: (repository: FundingRateRepository, endedAtMs: number) => void;
    readonly expectedMethod: 'startCoverage' | 'startIncremental';
  }
  const cases: DueCase[] = [
    {
      name: 'incremental attempt end plus interval',
      dueAtMs: START_MS + INTERVAL_MS,
      prepare(repository) {
        discover(repository, [OKX_BTC], START_MS - 10);
        completeOkxCoverage(repository, OKX_BTC, START_MS - 5);
        const lease = repository.startIncremental(OKX_BTC, new Date(START_MS - 1));
        repository.failIncremental(
          lease,
          fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
          new Date(START_MS)
        );
      },
      expectedMethod: 'startIncremental'
    },
    {
      name: 'last coverage success plus 24 hours',
      dueAtMs: START_MS + DAY_MS,
      prepare(repository) {
        discover(repository, [OKX_BTC], START_MS - 10);
        completeOkxCoverage(repository, OKX_BTC, START_MS);
        const incrementalEndedAtMs = START_MS + DAY_MS - INTERVAL_MS + 1;
        const incremental = repository.startIncremental(
          OKX_BTC,
          new Date(incrementalEndedAtMs - 1)
        );
        repository.completeIncremental(
          incremental,
          new Date(incrementalEndedAtMs)
        );
      },
      expectedMethod: 'startCoverage'
    },
    {
      name: 'failed periodic attempt end plus interval',
      dueAtMs: START_MS + INTERVAL_MS,
      prepare(repository) {
        discover(repository, [OKX_BTC], START_MS - DAY_MS - 10);
        completeOkxCoverage(repository, OKX_BTC, START_MS - DAY_MS);
        const lease = repository.startCoverage(
          OKX_BTC,
          'PERIODIC',
          START_MS - 1,
          new Date(START_MS - 1)
        );
        repository.failCoverage(
          lease,
          fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
          new Date(START_MS)
        );
        const incremental = repository.startIncremental(
          OKX_BTC,
          new Date(START_MS)
        );
        repository.completeIncremental(
          incremental,
          new Date(START_MS + 1)
        );
      },
      expectedMethod: 'startCoverage'
    }
  ];

  for (const dueCase of cases) {
    for (const offset of [-1, 0]) {
      const { target } = memoryRepository(t);
      dueCase.prepare(target, START_MS);
      const probe = observeRepository(target);
      const clock = new ManualClock(dueCase.dueAtMs + offset);
      const sleeper = new AutoAdvancingSleeper(clock);
      const pageGate = new FakeAsyncGate();
      const source = new FakeFundingRateSource(
        'okx',
        [{
          marketId: OKX_BTC.exchangeMarketId,
          cursor: { exchangeId: 'okx', afterMs: null },
          page: fakeOkxPage(null, []),
          parseGate: pageGate
        }],
        [],
        [{ observations: [observation(OKX_BTC)] }],
        clock.nowMs
      );
      const worker = startWorker(
        t,
        workerOptions(source, probe.repository, clock, sleeper.sleep)
      );
      await waitFor(() => source.discoveryCalls.length === 1, `${dueCase.name} discovery`);
      if (offset < 0) {
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
        assert.equal(callsNamed(probe.calls, dueCase.expectedMethod).length, 0, dueCase.name);
        await worker.stop();
      } else {
        await pageGate.entered;
        assert.equal(callsNamed(probe.calls, dueCase.expectedMethod).length, 1, dueCase.name);
        worker.scheduleDiscovery();
        await Promise.resolve();
        assert.equal(callsNamed(probe.calls, dueCase.expectedMethod).length, 1, dueCase.name);
        const stopping = worker.stop();
        pageGate.release();
        await stopping;
      }
    }
  }
});

task8Test('starts incremental immediately after the first coverage completes', async (t) => {
  const { target } = memoryRepository(t);
  const clock = new ManualClock(START_MS);
  const sleepCalls: number[] = [];
  const sleep: FundingSleep = async (delayMs, signal) => {
    assert.equal(signal.aborted, false);
    sleepCalls.push(delayMs);
  };
  const source = new FakeFundingRateSource(
    'okx',
    [
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [])
      },
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [])
      }
    ],
    [],
    [{ observations: [observation(OKX_BTC)] }],
    clock.nowMs
  );
  const probe = observeRepository(target);
  const worker = startWorker(
    t,
    workerOptions(source, probe.repository, clock, sleep)
  );

  try {
    await waitFor(
      () => source.fetchCalls.length === 2,
      'initial coverage did not immediately schedule incremental'
    );
    assert.equal(clock.nowMs(), START_MS);
    assert.equal(callsNamed(probe.calls, 'startCoverage').length, 1);
    assert.equal(callsNamed(probe.calls, 'startIncremental').length, 1);
    assert.deepEqual(
      source.operationCalls.map(({ kind, marketId }) => [kind, marketId]),
      [
        ['discovery', null],
        ['page', OKX_BTC.exchangeMarketId],
        ['page', OKX_BTC.exchangeMarketId]
      ]
    );
    assert.deepEqual(sleepCalls, [250, 250]);
  } finally {
    await worker.stop();
  }
});

task8Test('interleaves due incremental and periodic retry at page boundaries', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC], START_MS - DAY_MS - 10);
  completeOkxCoverage(target, OKX_BTC, START_MS - DAY_MS);
  const periodic = target.startCoverage(
    OKX_BTC,
    'PERIODIC',
    START_MS - INTERVAL_MS,
    new Date(START_MS - INTERVAL_MS - 1)
  );
  target.failCoverage(
    periodic,
    fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
    new Date(START_MS - INTERVAL_MS)
  );
  const incremental = target.startIncremental(
    OKX_BTC,
    new Date(START_MS - INTERVAL_MS - 1)
  );
  target.failIncremental(
    incremental,
    fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
    new Date(START_MS - INTERVAL_MS)
  );

  const clock = new ManualClock(START_MS);
  const sleep: FundingSleep = async (_delayMs, signal) => {
    assert.equal(signal.aborted, false);
  };
  const incrementalSecondPageGate = new FakeAsyncGate();
  const source = new FakeFundingRateSource(
    'okx',
    [
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [fundingRecord(OKX_BTC, START_MS - 1_000)])
      },
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [fundingRecord(OKX_BTC, START_MS - 2_000)])
      },
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: START_MS - 1_000 },
        page: fakeOkxPage(START_MS - 1_000, []),
        parseGate: incrementalSecondPageGate
      }
    ],
    [],
    [{ observations: [observation(OKX_BTC)] }],
    clock.nowMs
  );
  const probe = observeRepository(target);
  const worker = startWorker(
    t,
    workerOptions(source, probe.repository, clock, sleep)
  );

  try {
    await waitFor(
      () => probe.calls.some(({ method }) => (
        method === 'commitCoveragePage' || method === 'commitIncrementalPage'
      )),
      'neither due task committed its first page'
    );
    const firstCommit = probe.calls.find(({ method }) => (
      method === 'commitCoveragePage' || method === 'commitIncrementalPage'
    ));
    assert.equal(
      firstCommit?.method,
      'commitIncrementalPage',
      'due incremental must receive the first page turn before reconcile'
    );
    await waitFor(
      () => source.fetchCalls.length === 3,
      'incremental did not receive its next turn before periodic coverage completed'
    );
    const commitOrder = probe.calls
      .filter(({ method }) => (
        method === 'commitCoveragePage' || method === 'commitIncrementalPage'
      ))
      .map(({ method }) => method);
    assert.deepEqual(commitOrder, [
      'commitIncrementalPage',
      'commitCoveragePage'
    ]);
    assert.equal(callsNamed(probe.calls, 'startIncremental').length, 1);
    assert.equal(callsNamed(probe.calls, 'startCoverage').length, 1);
    const state = target.listMarketStates('okx')[0];
    assert.equal(state?.coverageStatus, 'BACKFILLING');
    assert.equal(state?.incrementalStatus, 'RUNNING');
  } finally {
    const stopping = worker.stop();
    incrementalSecondPageGate.release();
    await stopping.catch(() => undefined);
  }
});

task8Test('schedules new active, inactive-final, and reactivation coverage kinds', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC, OKX_ETH]);
  completeOkxCoverage(target, OKX_BTC, START_MS - 100);
  completeOkxCoverage(target, OKX_ETH, START_MS - 100);
  target.applyCompleteDiscovery('okx', [
    observation(OKX_BTC),
    observation(OKX_ETH, false)
  ], new Date(START_MS - 90));
  const inactiveLease = target.startCoverage(
    OKX_ETH,
    'INACTIVE_FINAL',
    START_MS - 80,
    new Date(START_MS - 80)
  );
  target.completeCoverage(
    inactiveLease,
    {
      exchangeId: 'okx',
      generation: inactiveLease.generation,
      cutoffMs: inactiveLease.cutoffMs,
      explicitEmpty: true,
      finalRequestAfterMs: null
    },
    new Date(START_MS - 70)
  );

  const clock = new ManualClock(START_MS);
  const sleeper = new AutoAdvancingSleeper(clock);
  const gate = new FakeAsyncGate();
  const source = new FakeFundingRateSource(
    'okx',
    [
      {
        marketId: OKX_SOL.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [])
      },
      {
        marketId: OKX_BTC.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [])
      },
      {
        marketId: OKX_SOL.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, [])
      },
      {
        marketId: OKX_ETH.exchangeMarketId,
        cursor: { exchangeId: 'okx', afterMs: null },
        page: fakeOkxPage(null, []),
        parseGate: gate
      }
    ],
    [],
    [{ observations: [
      observation(OKX_BTC, false),
      observation(OKX_ETH),
      observation(OKX_SOL)
    ] }],
    clock.nowMs
  );
  const probe = observeRepository(target);
  const worker = startWorker(
    t,
    workerOptions(source, probe.repository, clock, sleeper.sleep)
  );
  await gate.entered;

  const coverageKinds = callsNamed(probe.calls, 'startCoverage').map((call) => call.arguments[1]);
  assert.deepEqual(new Set(coverageKinds), new Set<FundingCoverageKind>([
    'INITIAL',
    'INACTIVE_FINAL',
    'REACTIVATION'
  ]));
  const stopping = worker.stop();
  gate.release();
  await stopping;
});

task8Test('cancels backoff without marking the task incomplete', async (t) => {
  const { target } = memoryRepository(t);
  const clock = new ManualClock();
  const sleeper = new ManualSleeper(clock);
  const events = new RecordingEventSink();
  const source = new FakeFundingRateSource(
    'bitget',
    [],
    [],
    [{ responseError: new ccxt.NetworkError('temporary') }],
    clock.nowMs
  );
  const worker = startWorker(
    t,
    workerOptions(source, target, clock, sleeper.sleep, events)
  );
  await waitFor(() => sleeper.calls.length === 1, 'backoff did not begin');

  await worker.stop();
  assert.equal(sleeper.calls[0]?.delayMs, 1_000);
  assert.equal(sleeper.calls[0]?.canceled, true);
  assert.equal(source.discoveryCalls.length, 1);
  assert.equal(events.events.some(({ event }) => event === 'funding_task_incomplete'), false);
});

task8Test('cancels pending exchange spacing before the unsent page attempt', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC]);
  target.startCoverage(OKX_BTC, 'INITIAL', START_MS, new Date(START_MS));
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new ManualSleeper(clock);
  const events = new RecordingEventSink();
  const source = new FakeFundingRateSource(
    'okx',
    [],
    [],
    [{ observations: [observation(OKX_BTC)] }],
    clock.nowMs
  );
  const worker = startWorker(
    t,
    workerOptions(source, target, clock, sleeper.sleep, events)
  );
  await waitFor(
    () => sleeper.calls.some(({ delayMs }) => delayMs === 250),
    'page spacing did not begin'
  );

  await worker.stop();
  const spacing = sleeper.calls.find(({ delayMs }) => delayMs === 250);
  assert.equal(spacing?.canceled, true);
  assert.equal(source.fetchCalls.length, 0);
  assert.equal(target.listMarketStates('okx')[0]?.coverageStatus, 'BACKFILLING');
  assert.equal(events.events.some(({ event }) => event === 'funding_task_incomplete'), false);
});

task8Test('waits for an in-flight success, commits it, and suppresses requeue after stop', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC]);
  target.startCoverage(OKX_BTC, 'INITIAL', START_MS, new Date(START_MS));
  const gate = new FakeAsyncGate();
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new AutoAdvancingSleeper(clock);
  const source = new FakeFundingRateSource(
    'okx',
    [{
      marketId: OKX_BTC.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      page: fakeOkxPage(null, [fundingRecord(OKX_BTC, START_MS - 1)]),
      parseGate: gate
    }],
    [],
    [{ observations: [observation(OKX_BTC)] }],
    clock.nowMs
  );
  const probe = observeRepository(target);
  const worker = startWorker(
    t,
    workerOptions(source, probe.repository, clock, sleeper.sleep)
  );
  await gate.entered;
  const stopping = worker.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.release();
  await stopping;

  assert.equal(callsNamed(probe.calls, 'commitCoveragePage').length, 1);
  assert.equal(source.fetchCalls.length, 1);
  const callsAfterStop = probe.calls.length;
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.equal(probe.calls.length, callsAfterStop);
});

task8Test('turns an in-flight failure after stop into nominal cancellation', async (t) => {
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC]);
  target.startCoverage(OKX_BTC, 'INITIAL', START_MS, new Date(START_MS));
  const gate = new FakeAsyncGate();
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new AutoAdvancingSleeper(clock);
  const events = new RecordingEventSink();
  const source = new FakeFundingRateSource(
    'okx',
    [{
      marketId: OKX_BTC.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      responseError: new Error('request failed after shutdown'),
      responseGate: gate
    }],
    [],
    [{ observations: [observation(OKX_BTC)] }],
    clock.nowMs
  );
  const probe = observeRepository(target);
  const worker = startWorker(
    t,
    workerOptions(source, probe.repository, clock, sleeper.sleep, events)
  );
  await waitFor(() => source.fetchCalls.length === 1, 'page request did not start');
  const stopping = worker.stop();
  gate.release();
  await stopping;

  assert.equal(callsNamed(probe.calls, 'failCoverage').length, 0);
  assert.equal(events.events.some(({ event }) => event === 'funding_task_incomplete'), false);
});

task8Test('stop before start is permanent and repeated lifecycle calls share one root', async (t) => {
  const intervals = installManualIntervals(t);
  const { target } = memoryRepository(t);
  const probe = observeRepository(target);
  const clock = new ManualClock();
  const sleeper = new AutoAdvancingSleeper(clock);
  const bitget = new FakeFundingRateSource('bitget', [], [], [], clock.nowMs);
  const okx = new FakeFundingRateSource('okx', [], [], [], clock.nowMs);
  const { FundingRateSyncService } = task8Modules();
  const service = new FundingRateSyncService({
    bitgetSource: bitget,
    okxSource: okx,
    repository: probe.repository,
    events: new RecordingEventSink(),
    intervalMs: INTERVAL_MS,
    nowMs: clock.nowMs,
    sleep: sleeper.sleep
  });

  const firstStop = service.stop();
  const secondStop = service.stop();
  assert.strictEqual(firstStop, secondStop);
  await firstStop;
  service.start();
  service.start();
  intervals.tick(true);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

  assert.equal(intervals.intervals.length, 0);
  assert.equal(probe.calls.length, 0);
  assert.equal(bitget.operationCalls.length, 0);
  assert.equal(okx.operationCalls.length, 0);
});

task8Test('stop during a transaction and a stale timer callback leaves repository calls fixed', async (t) => {
  const intervals = installManualIntervals(t);
  const { target } = memoryRepository(t);
  discover(target, [OKX_BTC]);
  target.startCoverage(OKX_BTC, 'INITIAL', START_MS, new Date(START_MS));
  const clock = new ManualClock(START_MS + 1);
  const sleeper = new AutoAdvancingSleeper(clock);
  let service!: Task8Service;
  let stopping: Promise<void> | null = null;
  const probe = observeRepository(target, {
    commitCoveragePage(): void {
      stopping = service.stop();
    }
  });
  const okx = new FakeFundingRateSource(
    'okx',
    [{
      marketId: OKX_BTC.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: null },
      page: fakeOkxPage(null, [fundingRecord(OKX_BTC, START_MS - 1)])
    }],
    [],
    [{ observations: [observation(OKX_BTC)] }],
    clock.nowMs
  );
  const bitget = new FakeFundingRateSource(
    'bitget',
    [],
    [],
    [{ observations: [] }],
    clock.nowMs
  );
  const { FundingRateSyncService } = task8Modules();
  service = new FundingRateSyncService({
    bitgetSource: bitget,
    okxSource: okx,
    repository: probe.repository,
    events: new RecordingEventSink(),
    intervalMs: INTERVAL_MS,
    nowMs: clock.nowMs,
    sleep: sleeper.sleep
  });
  t.after(async () => service.stop().catch(() => undefined));
  service.start();
  await waitFor(() => stopping !== null, 'stop was not requested inside commit');
  await stopping;
  const callCount = probe.calls.length;

  intervals.tick(true);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.equal(probe.calls.length, callCount);
  assert.equal(callsNamed(probe.calls, 'commitCoveragePage').length, 1);
});

task8Test('joins both fatal roots and deterministically reports Bitget first', async (t) => {
  const { target } = memoryRepository(t);
  const bitgetGate = new FakeAsyncGate();
  const okxGate = new FakeAsyncGate();
  const clock = new ManualClock();
  const sleeper = new AutoAdvancingSleeper(clock);
  const bitgetError = new Error('bitget internal fatal');
  const okxError = new Error('okx internal fatal');
  const probe = observeRepository(target, {
    applyCompleteDiscovery(arguments_): void {
      const exchangeId = arguments_[0];
      throw exchangeId === 'bitget' ? bitgetError : okxError;
    }
  });
  const bitget = new FakeFundingRateSource(
    'bitget',
    [],
    [],
    [{ observations: [], gate: bitgetGate }],
    clock.nowMs
  );
  const okx = new FakeFundingRateSource(
    'okx',
    [],
    [],
    [{ observations: [], gate: okxGate }],
    clock.nowMs
  );
  const { FundingRateSyncService } = task8Modules();
  const service = new FundingRateSyncService({
    bitgetSource: bitget,
    okxSource: okx,
    repository: probe.repository,
    events: new RecordingEventSink(),
    intervalMs: INTERVAL_MS,
    nowMs: clock.nowMs,
    sleep: sleeper.sleep
  });
  service.start();
  await Promise.all([bitgetGate.entered, okxGate.entered]);
  okxGate.release();
  await waitFor(
    () => callsNamed(probe.calls, 'applyCompleteDiscovery').length === 1,
    'OKX fatal did not reach the service root'
  );
  const stopping = service.stop();
  let settled = false;
  void stopping.catch(() => undefined).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  bitgetGate.release();
  await assert.rejects(stopping, (error: unknown) => error === bitgetError);
  assert.deepEqual(
    callsNamed(probe.calls, 'applyCompleteDiscovery').map((call) => call.arguments[0]).sort(),
    ['bitget', 'okx']
  );
});
