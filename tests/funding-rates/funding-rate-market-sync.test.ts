/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  type FundingRateEvent,
  type FundingRateEventSink,
  NOOP_FUNDING_RATE_EVENT_SINK
} from '../../src/funding-rates/funding-rate-events.js';
import {
  FundingRateMarketSync,
  type FundingPageTask
} from '../../src/funding-rates/funding-rate-market-sync.js';
import * as fundingRequestContracts from '../../src/funding-rates/funding-rate-source.js';
import {
  settledFundingRate,
  type FundingMarketIdentity,
  type SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import type {
  FundingPageCursor,
  FundingRatePage,
  FundingRateSource,
  FundingRequestExecutor,
  FundingRequestMetadata
} from '../../src/funding-rates/funding-rate-source.js';
import {
  StaleFundingTaskError,
  fundingTaskFailure,
  type CoverageLease,
  type CoveragePageCheckpoint,
  type FundingCoverageKind,
  type FundingDiscoveryResult,
  type FundingExhaustionEvidence,
  type FundingMarketState,
  type FundingPageWriteResult,
  type FundingRateRepository,
  type FundingTaskFailure,
  type FundingTaskFailureCode,
  type IncrementalLease
} from '../../src/storage/funding-rate-repository.js';
import { SqliteFundingRateRepository } from '../../src/storage/sqlite-funding-rate-repository.js';
import {
  FakeAsyncGate,
  FakeFundingRateSource,
  FakeFundingRequestExecutor,
  fakeBitgetPage,
  fakeOkxPage,
  type FakeFundingPageStep
} from '../support/fake-funding-rate-source.js';

const BITGET_MARKET = {
  exchangeId: 'bitget',
  exchangeMarketId: 'BTCUSDT',
  symbol: 'BTC/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const BITGET_ETH_MARKET = {
  exchangeId: 'bitget',
  exchangeMarketId: 'ETHUSDT',
  symbol: 'ETH/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const OKX_MARKET = {
  exchangeId: 'okx',
  exchangeMarketId: 'BTC-USDT-SWAP',
  symbol: 'BTC/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const STARTED_AT = new Date('2026-09-06T01:00:00.000Z');
const NOW = new Date('2026-09-06T01:01:00.000Z');
const LATER_AT = new Date('2026-09-06T01:02:00.000Z');
const CUTOFF_MS = 80;

interface RepositoryHooks {
  readonly trace?: string[];
  readonly beforeCommit?: (
    lease: CoverageLease,
    records: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint
  ) => void;
  readonly commitError?: unknown;
  readonly beforeIncrementalCommit?: (
    lease: IncrementalLease,
    records: readonly SettledFundingRate[]
  ) => void;
  readonly incrementalCommitError?: unknown;
}

class ObservedFundingRateRepository implements FundingRateRepository {
  readonly coverageCommits: Array<{
    readonly lease: CoverageLease;
    readonly records: readonly SettledFundingRate[];
    readonly checkpoint: CoveragePageCheckpoint;
  }> = [];
  readonly roundComparisons: Array<readonly [1 | 2, 2 | 3]> = [];
  readonly incrementalCommits: Array<{
    readonly lease: IncrementalLease;
    readonly records: readonly SettledFundingRate[];
  }> = [];
  readonly incrementalCompletions: IncrementalLease[] = [];
  readonly incrementalFailures: Array<{
    readonly lease: IncrementalLease;
    readonly failure: FundingTaskFailure;
  }> = [];
  readonly incrementalCancellations: IncrementalLease[] = [];

  constructor(
    private readonly target: FundingRateRepository,
    private readonly hooks: RepositoryHooks = {}
  ) {}

  applyCompleteDiscovery(
    exchangeId: 'bitget' | 'okx',
    observations: Parameters<FundingRateRepository['applyCompleteDiscovery']>[1],
    observedAt: Date
  ): FundingDiscoveryResult {
    return this.target.applyCompleteDiscovery(exchangeId, observations, observedAt);
  }

  listMarketStates(exchangeId: 'bitget' | 'okx'): FundingMarketState[] {
    return this.target.listMarketStates(exchangeId);
  }

  listHistory(market: FundingMarketIdentity): SettledFundingRate[] {
    return this.target.listHistory(market);
  }

  startCoverage(
    market: FundingMarketIdentity,
    kind: FundingCoverageKind,
    cutoffMs: number,
    startedAt: Date
  ): CoverageLease {
    return this.target.startCoverage(market, kind, cutoffMs, startedAt);
  }

  resumeInterruptedCoverage(
    market: FundingMarketIdentity,
    resumedAt?: Date
  ): CoverageLease {
    return resumeCoverage(this.target, market, resumedAt ?? LATER_AT);
  }

  isCoverageLeaseCurrent(lease: CoverageLease): boolean {
    this.hooks.trace?.push('eligibility');
    return this.target.isCoverageLeaseCurrent(lease);
  }

  commitCoveragePage(
    lease: CoverageLease,
    records: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint,
    observedAt: Date
  ): FundingPageWriteResult {
    this.hooks.trace?.push('commit');
    this.coverageCommits.push({ lease, records, checkpoint });
    this.hooks.beforeCommit?.(lease, records, checkpoint);
    if (this.hooks.commitError !== undefined) {
      throw this.hooks.commitError;
    }
    return this.target.commitCoveragePage(lease, records, checkpoint, observedAt);
  }

  bitgetRoundsEqual(
    lease: CoverageLease,
    left: 1 | 2,
    right: 2 | 3
  ): boolean {
    this.roundComparisons.push([left, right]);
    return this.target.bitgetRoundsEqual(lease, left, right);
  }

  completeCoverage(
    lease: CoverageLease,
    evidence: FundingExhaustionEvidence,
    completedAt: Date
  ): void {
    this.target.completeCoverage(lease, evidence, completedAt);
  }

  failCoverage(
    lease: CoverageLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void {
    this.target.failCoverage(lease, failure, failedAt);
  }

  startIncremental(
    market: FundingMarketIdentity,
    startedAt: Date
  ): IncrementalLease {
    return this.target.startIncremental(market, startedAt);
  }

  restartInterruptedIncremental(
    market: FundingMarketIdentity,
    restartedAt: Date
  ): IncrementalLease {
    return this.target.restartInterruptedIncremental(market, restartedAt);
  }

  isIncrementalLeaseEligible(lease: IncrementalLease): boolean {
    return this.target.isIncrementalLeaseEligible(lease);
  }

  commitIncrementalPage(
    lease: IncrementalLease,
    records: readonly SettledFundingRate[],
    observedAt: Date
  ): FundingPageWriteResult {
    this.incrementalCommits.push({ lease, records });
    this.hooks.beforeIncrementalCommit?.(lease, records);
    if (this.hooks.incrementalCommitError !== undefined) {
      throw this.hooks.incrementalCommitError;
    }
    return this.target.commitIncrementalPage(lease, records, observedAt);
  }

  completeIncremental(lease: IncrementalLease, completedAt: Date): void {
    this.incrementalCompletions.push(lease);
    this.target.completeIncremental(lease, completedAt);
  }

  failIncremental(
    lease: IncrementalLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void {
    this.incrementalFailures.push({ lease, failure });
    this.target.failIncremental(lease, failure, failedAt);
  }

  cancelIncremental(lease: IncrementalLease, canceledAt: Date): void {
    this.incrementalCancellations.push(lease);
    this.target.cancelIncremental(lease, canceledAt);
  }
}

class RecordingEventSink implements FundingRateEventSink {
  readonly events: FundingRateEvent[] = [];

  record(event: Readonly<FundingRateEvent>): void {
    this.events.push(event);
  }
}

function setupRepository(
  t: TestContext,
  markets: readonly FundingMarketIdentity[]
): {
  readonly database: Database.Database;
  readonly repository: SqliteFundingRateRepository;
} {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new SqliteFundingRateRepository(database);
  const byExchange = new Map<'bitget' | 'okx', FundingMarketIdentity[]>();
  for (const market of markets) {
    const grouped = byExchange.get(market.exchangeId) ?? [];
    grouped.push(market);
    byExchange.set(market.exchangeId, grouped);
  }
  for (const [exchangeId, exchangeMarkets] of byExchange) {
    repository.applyCompleteDiscovery(
      exchangeId,
      exchangeMarkets.map((market) => ({ ...market, active: true })),
      STARTED_AT
    );
  }
  return { database, repository };
}

function fundingRecord(
  market: FundingMarketIdentity,
  timestampMs: number,
  rate = '0.0001',
  revision = 'A'
): SettledFundingRate {
  const raw = market.exchangeId === 'bitget'
    ? {
        symbol: market.exchangeMarketId,
        fundingRate: rate,
        fundingTime: String(timestampMs),
        revision
      }
    : {
        instId: market.exchangeMarketId,
        realizedRate: rate,
        fundingTime: String(timestampMs),
        revision
      };
  return settledFundingRate(market, rate, timestampMs, raw);
}

function startCoverage(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  kind: FundingCoverageKind = 'INITIAL',
  cutoffMs = CUTOFF_MS
): CoverageLease {
  return repository.startCoverage(market, kind, cutoffMs, STARTED_AT);
}

function resumeCoverage(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  resumedAt: Date
): CoverageLease {
  const resume = repository.resumeInterruptedCoverage as unknown as (
    market: FundingMarketIdentity,
    resumedAt: Date
  ) => CoverageLease;
  return resume.call(repository, market, resumedAt);
}

function coverageTask(
  source: FundingRateSource,
  repository: FundingRateRepository,
  requestExecutor: FundingRequestExecutor,
  lease: CoverageLease,
  events: FundingRateEventSink = NOOP_FUNDING_RATE_EVENT_SINK
): FundingPageTask {
  const sync = new FundingRateMarketSync({
    source,
    repository,
    requestExecutor,
    events,
    now: () => new Date(NOW.getTime())
  });
  return sync.createCoverageTask(lease);
}

interface TaskSevenFundingRateMarketSync {
  createIncrementalTask(lease: IncrementalLease): FundingPageTask;
}

interface TaskSevenRequestContracts {
  readonly FundingRequestCanceledError: new () => Error;
  readonly FundingRequestRetryExhaustedError: new () => Error;
}

function incrementalTask(
  source: FundingRateSource,
  repository: FundingRateRepository,
  requestExecutor: FundingRequestExecutor,
  lease: IncrementalLease,
  events: FundingRateEventSink = NOOP_FUNDING_RATE_EVENT_SINK
): FundingPageTask {
  const sync = new FundingRateMarketSync({
    source,
    repository,
    requestExecutor,
    events,
    now: () => new Date(NOW.getTime())
  });
  const createIncrementalTask = (
    sync as unknown as Partial<TaskSevenFundingRateMarketSync>
  ).createIncrementalTask;
  if (typeof createIncrementalTask !== 'function') {
    assert.fail('FundingRateMarketSync.createIncrementalTask must be implemented');
  }
  return createIncrementalTask.call(sync, lease);
}

function nominalRequestError(
  exportName:
    | 'FundingRequestCanceledError'
    | 'FundingRequestRetryExhaustedError'
): Error {
  const ErrorType = (
    fundingRequestContracts as unknown as Partial<TaskSevenRequestContracts>
  )[exportName];
  if (typeof ErrorType !== 'function') {
    assert.fail(`${exportName} must be exported as a runtime constructor`);
  }
  return new ErrorType();
}

async function drainTask(
  task: FundingPageTask,
  maximumPages = 20
): Promise<readonly ('requeue' | 'done')[]> {
  const results: Array<'requeue' | 'done'> = [];
  for (let page = 0; page < maximumPages; page += 1) {
    const result = await task.runNextPage();
    results.push(result);
    if (result === 'done') return results;
  }
  assert.fail(`funding page task exceeded ${maximumPages} pages`);
}

async function promiseError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function invocationError(invoke: () => unknown): unknown {
  try {
    invoke();
    return null;
  } catch (error) {
    return error;
  }
}

function stateFor(
  repository: FundingRateRepository,
  market: FundingMarketIdentity
): FundingMarketState {
  const state = repository.listMarketStates(market.exchangeId).find(
    ({ exchangeMarketId }) => exchangeMarketId === market.exchangeMarketId
  );
  if (state === undefined) assert.fail('expected funding market state');
  return state;
}

function assertCoverageFailure(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  code: FundingTaskFailureCode,
  expectedCaughtUpCutoff: number | null = null
): void {
  const state = stateFor(repository, market);
  const expected = fundingTaskFailure(code);
  assert.deepEqual({
    status: state.coverageStatus,
    errorCode: state.coverageErrorCode,
    errorSummary: state.coverageErrorSummary,
    caughtUpCutoff: state.lastCaughtUpCutoffMs
  }, {
    status: 'INCOMPLETE',
    errorCode: expected.code,
    errorSummary: expected.summary,
    caughtUpCutoff: expectedCaughtUpCutoff
  });
}

function persistenceSnapshot(database: Database.Database): string {
  return JSON.stringify({
    state: database.prepare(`
      SELECT * FROM funding_rate_sync_state
      ORDER BY exchange_id, exchange_market_id
    `).all(),
    history: database.prepare(`
      SELECT * FROM funding_rate_history
      ORDER BY exchange_id, exchange_market_id, funding_timestamp_ms
    `).all(),
    revisions: database.prepare(`
      SELECT * FROM funding_rate_revisions ORDER BY id
    `).all(),
    scans: database.prepare(`
      SELECT * FROM temp.funding_rate_bitget_scan
      ORDER BY exchange_id, exchange_market_id,
        coverage_generation, scan_round, funding_timestamp_ms
    `).all()
  });
}

function bitgetStep(
  market: FundingMarketIdentity,
  pageNo: number,
  records: readonly SettledFundingRate[]
): FakeFundingPageStep {
  return {
    marketId: market.exchangeMarketId,
    cursor: { exchangeId: 'bitget', pageNo },
    page: fakeBitgetPage(pageNo, records)
  };
}

function okxStep(
  market: FundingMarketIdentity,
  afterMs: number | null,
  records: readonly SettledFundingRate[]
): FakeFundingPageStep {
  return {
    marketId: market.exchangeMarketId,
    cursor: { exchangeId: 'okx', afterMs },
    page: fakeOkxPage(afterMs, records)
  };
}

function seedCaughtUpBitget(
  repository: FundingRateRepository,
  boundaryMs: number
): void {
  const lease = startCoverage(repository, BITGET_MARKET, 'INITIAL', 100);
  const record = fundingRecord(BITGET_MARKET, boundaryMs);
  repository.commitCoveragePage(
    lease,
    [record],
    { exchangeId: 'bitget', round: 1 },
    NOW
  );
  repository.commitCoveragePage(
    lease,
    [record],
    { exchangeId: 'bitget', round: 2 },
    NOW
  );
  repository.completeCoverage(lease, {
    exchangeId: 'bitget',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    matchingRounds: [1, 2],
    emptyPageNo: 2
  }, NOW);
}

function seedCaughtUpHistory(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  records: readonly SettledFundingRate[]
): void {
  const lease = startCoverage(repository, market, 'INITIAL', 100);
  if (market.exchangeId === 'bitget') {
    if (records.length > 0) {
      repository.commitCoveragePage(
        lease,
        records,
        { exchangeId: 'bitget', round: 1 },
        NOW
      );
      repository.commitCoveragePage(
        lease,
        records,
        { exchangeId: 'bitget', round: 2 },
        NOW
      );
    }
    repository.completeCoverage(lease, {
      exchangeId: 'bitget',
      generation: lease.generation,
      cutoffMs: lease.cutoffMs,
      matchingRounds: [1, 2],
      emptyPageNo: 2
    }, NOW);
    return;
  }

  if (records.length > 0) {
    const recoveryAnchorMs = Math.max(
      ...records.map(({ fundingTimestampMs }) => fundingTimestampMs)
    );
    repository.commitCoveragePage(
      lease,
      records,
      { exchangeId: 'okx', recoveryAnchorMs },
      NOW
    );
  }
  repository.completeCoverage(lease, {
    exchangeId: 'okx',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    explicitEmpty: true,
    finalRequestAfterMs: records.length === 0
      ? null
      : Math.min(...records.map(({ fundingTimestampMs }) => fundingTimestampMs))
  }, NOW);
}

function coverageProof(state: FundingMarketState): unknown {
  return {
    coverageStatus: state.coverageStatus,
    coverageErrorCode: state.coverageErrorCode,
    coverageErrorSummary: state.coverageErrorSummary,
    coverageCutoffMs: state.coverageCutoffMs,
    lastCaughtUpCutoffMs: state.lastCaughtUpCutoffMs,
    lastCaughtUpGeneration: state.lastCaughtUpGeneration,
    lastExhaustedAt: state.lastExhaustedAt,
    lastExhaustionEvidenceJson: state.lastExhaustionEvidenceJson
  };
}

function forgedTaskStartLease(
  repository: FundingRateRepository,
  exchangeId: 'bitget' | 'okx'
): {
  readonly actual: CoverageLease;
  readonly forged: CoverageLease;
} {
  if (exchangeId === 'bitget') {
    seedCaughtUpBitget(repository, 70);
    const actual = startCoverage(repository, BITGET_MARKET, 'PERIODIC', 101);
    return {
      actual,
      forged: { ...actual, requiredBitgetBoundaryMs: null }
    };
  }

  const interrupted = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  repository.commitCoveragePage(
    interrupted,
    [fundingRecord(OKX_MARKET, 78)],
    { exchangeId: 'okx', recoveryAnchorMs: 78 },
    NOW
  );
  const actual = resumeCoverage(repository, OKX_MARKET, LATER_AT);
  if (actual.exchangeId !== 'okx') assert.fail('expected an OKX coverage lease');
  return {
    actual,
    forged: { ...actual, okxResumeAfterMs: 0 }
  };
}

function pageCursors(source: FakeFundingRateSource): FundingPageCursor[] {
  return source.fetchCalls.map(({ cursor }) => cursor);
}

function throwingOwnAccessor<ObjectType extends object>(
  value: ObjectType,
  property: keyof ObjectType,
  onRead: () => void
): ObjectType {
  const output = { ...value };
  Object.defineProperty(output, property, {
    configurable: true,
    enumerable: true,
    get(): never {
      onRead();
      throw new Error(`synthetic ${String(property)} accessor execution`);
    }
  });
  return output;
}

test('Bitget advances one page per run and completes only after two explicit empty pages', async (t) => {
  const { repository: target } = setupRepository(t, [BITGET_MARKET]);
  const repository = new ObservedFundingRateRepository(target);
  const lease = startCoverage(repository, BITGET_MARKET);
  const record = fundingRecord(BITGET_MARKET, 79);
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [record]),
    bitgetStep(BITGET_MARKET, 2, []),
    bitgetStep(BITGET_MARKET, 1, [record]),
    bitgetStep(BITGET_MARKET, 2, [])
  ]);
  const executor = new FakeFundingRequestExecutor();
  const task = coverageTask(source, repository, executor, lease);

  assert.equal(task.category, 'backfill');
  assert.equal(typeof task.key, 'string');
  assert.notEqual(task.key.trim(), '');
  assert.equal(await task.runNextPage(), 'requeue');
  assert.equal(source.fetchCalls.length, 1);
  assert.equal(await task.runNextPage(), 'requeue');
  assert.equal(stateFor(repository, BITGET_MARKET).coverageStatus, 'BACKFILLING');
  assert.equal(await task.runNextPage(), 'requeue');
  assert.equal(await task.runNextPage(), 'done');

  const state = stateFor(repository, BITGET_MARKET);
  assert.equal(state.coverageStatus, 'CAUGHT_UP');
  assert.deepEqual(JSON.parse(state.lastExhaustionEvidenceJson ?? ''), {
    exchangeId: 'bitget',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    matchingRounds: [1, 2],
    emptyPageNo: 2
  });
  assert.equal(repository.coverageCommits.length, 2);
  assert.deepEqual(repository.roundComparisons, [[1, 2]]);
  assert.equal(executor.calls.length, 4);
});

test('Bitget requires two explicit empty first pages for an empty market', async (t) => {
  const { repository: target } = setupRepository(t, [BITGET_MARKET]);
  const repository = new ObservedFundingRateRepository(target);
  const lease = startCoverage(repository, BITGET_MARKET);
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, []),
    bitgetStep(BITGET_MARKET, 1, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.deepEqual(await drainTask(task), ['requeue', 'done']);
  assert.equal(repository.coverageCommits.length, 0);
  assert.deepEqual(repository.roundComparisons, [[1, 2]]);
  assert.equal(stateFor(repository, BITGET_MARKET).coverageStatus, 'CAUGHT_UP');
  assert.deepEqual(pageCursors(source), [
    { exchangeId: 'bitget', pageNo: 1 },
    { exchangeId: 'bitget', pageNo: 1 }
  ]);
});

test('Bitget accepts convergence in rounds two and three after rounds one and two differ', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const lease = startCoverage(repository, BITGET_MARKET);
  const first = fundingRecord(BITGET_MARKET, 79, '0.0001', 'first');
  const stable = fundingRecord(BITGET_MARKET, 79, '0.0002', 'stable');
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [first]),
    bitgetStep(BITGET_MARKET, 2, []),
    bitgetStep(BITGET_MARKET, 1, [stable]),
    bitgetStep(BITGET_MARKET, 2, []),
    bitgetStep(BITGET_MARKET, 1, [stable]),
    bitgetStep(BITGET_MARKET, 2, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.equal((await drainTask(task)).length, 6);
  const state = stateFor(repository, BITGET_MARKET);
  assert.equal(state.coverageStatus, 'CAUGHT_UP');
  assert.deepEqual(
    JSON.parse(state.lastExhaustionEvidenceJson ?? '').matchingRounds,
    [2, 3]
  );
});

test('Bitget fails closed after three non-converging rounds', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const lease = startCoverage(repository, BITGET_MARKET);
  const rounds = ['first', 'second', 'third'].flatMap((revision, index) => [
    bitgetStep(BITGET_MARKET, 1, [
      fundingRecord(BITGET_MARKET, 79, `0.000${index + 1}`, revision)
    ]),
    bitgetStep(BITGET_MARKET, 2, [])
  ]);
  const task = coverageTask(
    new FakeFundingRateSource('bitget', rounds),
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.equal((await drainTask(task)).length, 6);
  assertCoverageFailure(
    repository,
    BITGET_MARKET,
    'BITGET_SCAN_NOT_CONVERGED'
  );
});

test('Bitget requires matching empty page numbers even when staged sets match', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const lease = startCoverage(repository, BITGET_MARKET);
  const record = fundingRecord(BITGET_MARKET, 79);
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [record]),
    bitgetStep(BITGET_MARKET, 2, []),
    bitgetStep(BITGET_MARKET, 1, [record]),
    bitgetStep(BITGET_MARKET, 2, [record]),
    bitgetStep(BITGET_MARKET, 3, []),
    bitgetStep(BITGET_MARKET, 1, [record]),
    bitgetStep(BITGET_MARKET, 2, [record]),
    bitgetStep(BITGET_MARKET, 3, [record]),
    bitgetStep(BITGET_MARKET, 4, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.equal((await drainTask(task)).length, 9);
  assertCoverageFailure(
    repository,
    BITGET_MARKET,
    'BITGET_SCAN_NOT_CONVERGED'
  );
});

test('Bitget saves post-cutoff records but excludes them from convergence and claims only the cutoff', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const lease = startCoverage(repository, BITGET_MARKET);
  const inRange = fundingRecord(
    BITGET_MARKET,
    79,
    '0.123456789012345678901234567890123456789'
  );
  const firstAfter = fundingRecord(BITGET_MARKET, 81, '0.0002');
  const secondAfter = fundingRecord(BITGET_MARKET, 82, '0.0003');
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [firstAfter, inRange]),
    bitgetStep(BITGET_MARKET, 2, []),
    bitgetStep(BITGET_MARKET, 1, [secondAfter, inRange]),
    bitgetStep(BITGET_MARKET, 2, [])
  ]);
  const events = new RecordingEventSink();
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease,
    events
  );

  await drainTask(task);

  assert.deepEqual(
    repository.listHistory(BITGET_MARKET).map(({ fundingTimestampMs }) => (
      fundingTimestampMs
    )),
    [82, 81, 79]
  );
  assert.equal(
    repository.listHistory(BITGET_MARKET).find(
      ({ fundingTimestampMs }) => fundingTimestampMs === 79
    )?.fundingRate,
    inRange.fundingRate
  );
  const completed = events.events.find(
    ({ event }) => event === 'funding_coverage_completed'
  );
  assert.ok(completed?.event === 'funding_coverage_completed');
  assert.equal(completed.coverageCutoffMs, CUTOFF_MS);
  assert.equal(completed.lastCaughtUpCutoffMs, CUTOFF_MS);
});

for (const resumeInterrupted of [false, true] as const) {
  test(`Bitget ${resumeInterrupted ? 'resumed' : 'new'} coverage fails when the required oldest boundary is absent`, async (t) => {
    const { repository } = setupRepository(t, [BITGET_MARKET]);
    seedCaughtUpBitget(repository, 70);
    const started = startCoverage(repository, BITGET_MARKET, 'PERIODIC', 100);
    const lease = resumeInterrupted
      ? resumeCoverage(repository, BITGET_MARKET, LATER_AT)
      : started;
    assert.equal(lease.requiredBitgetBoundaryMs, 70);
    assert.equal(
      lease.generation,
      started.generation + (resumeInterrupted ? 1 : 0)
    );
    assert.equal(Object.hasOwn(lease, 'recovered'), false);
    const source = new FakeFundingRateSource('bitget', [
      bitgetStep(BITGET_MARKET, 1, [fundingRecord(BITGET_MARKET, 79)]),
      bitgetStep(BITGET_MARKET, 2, [])
    ]);
    const task = coverageTask(
      source,
      repository,
      new FakeFundingRequestExecutor(),
      lease
    );

    assert.deepEqual(await drainTask(task), ['requeue', 'done']);
    assertCoverageFailure(
      repository,
      BITGET_MARKET,
      'BITGET_BOUNDARY_NOT_SEEN',
      100
    );
    assert.deepEqual(pageCursors(source), [
      { exchangeId: 'bitget', pageNo: 1 },
      { exchangeId: 'bitget', pageNo: 2 }
    ]);
  });
}

test('Bitget recovery discards the old page number and rescans from page one', async (t) => {
  const { database, repository } = setupRepository(t, [BITGET_MARKET]);
  seedCaughtUpBitget(repository, 70);
  const interrupted = startCoverage(repository, BITGET_MARKET, 'PERIODIC', 100);
  repository.commitCoveragePage(
    interrupted,
    [fundingRecord(BITGET_MARKET, 75)],
    { exchangeId: 'bitget', round: 1 },
    NOW
  );
  database.exec('DELETE FROM temp.funding_rate_bitget_scan');
  const lease = resumeCoverage(repository, BITGET_MARKET, LATER_AT);
  const page = [
    fundingRecord(BITGET_MARKET, 75),
    fundingRecord(BITGET_MARKET, 70)
  ];
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, page),
    bitgetStep(BITGET_MARKET, 2, []),
    bitgetStep(BITGET_MARKET, 1, page),
    bitgetStep(BITGET_MARKET, 2, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  await drainTask(task);

  assert.deepEqual(pageCursors(source)[0], {
    exchangeId: 'bitget',
    pageNo: 1
  });
  assert.equal(stateFor(repository, BITGET_MARKET).coverageStatus, 'CAUGHT_UP');
});

interface InvalidBitgetCase {
  readonly name: string;
  readonly step: (record: SettledFundingRate) => FakeFundingPageStep;
  readonly code: FundingTaskFailureCode;
}

const invalidBitgetCases: readonly InvalidBitgetCase[] = [
  {
    name: 'page request construction failure',
    step: () => ({
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      pageRequestError: new Error('synthetic request metadata failure')
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'response failure',
    step: () => ({
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      responseError: new Error('synthetic response failure')
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'parse failure',
    step: () => ({
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      parseError: new Error('synthetic parse failure')
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'mismatched response cursor',
    step: (record) => ({
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      page: fakeBitgetPage(2, [record])
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'non-explicit empty response',
    step: () => ({
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      page: {
        cursor: { exchangeId: 'bitget', pageNo: 1 },
        records: [],
        nextCursor: { exchangeId: 'bitget', pageNo: 2 },
        recoveryAnchorMs: null
      }
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'unsafe next page number',
    step: (record) => ({
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      page: {
        cursor: { exchangeId: 'bitget', pageNo: 1 },
        records: [record],
        nextCursor: {
          exchangeId: 'bitget',
          pageNo: Number.MAX_SAFE_INTEGER + 1
        },
        recoveryAnchorMs: null
      }
    }),
    code: 'CURSOR_NOT_ADVANCING'
  }
];

for (const invalidCase of invalidBitgetCases) {
  test(`Bitget rejects ${invalidCase.name} without claiming coverage`, async (t) => {
    const { repository } = setupRepository(t, [BITGET_MARKET]);
    const lease = startCoverage(repository, BITGET_MARKET);
    const record = fundingRecord(BITGET_MARKET, 79);
    const source = new FakeFundingRateSource('bitget', [
      invalidCase.step(record)
    ]);
    const executor = new FakeFundingRequestExecutor();
    const task = coverageTask(source, repository, executor, lease);

    assert.equal(await task.runNextPage(), 'done');
    assertCoverageFailure(repository, BITGET_MARKET, invalidCase.code);
    assert.equal(repository.listHistory(BITGET_MARKET).length, 0);
    if (invalidCase.name === 'page request construction failure') {
      assert.equal(executor.calls.length, 0);
      assert.equal(source.fetchCalls.length, 0);
    }
  });
}

test('a Bitget page larger than the requested page size fails before commit', async (t) => {
  const { repository: target } = setupRepository(t, [BITGET_MARKET]);
  const repository = new ObservedFundingRateRepository(target);
  const lease = startCoverage(repository, BITGET_MARKET, 'INITIAL', 1_000);
  const oversized = Array.from({ length: 101 }, (_, index) => (
    fundingRecord(BITGET_MARKET, index + 1)
  ));
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, oversized)
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.equal(await task.runNextPage(), 'done');
  assertCoverageFailure(repository, BITGET_MARKET, 'SOURCE_RESPONSE_INVALID');
  assert.equal(repository.coverageCommits.length, 0);
});

test('uses persistent eligibility, request metadata, executor, parse, and commit in order', async (t) => {
  const { database, repository: target } = setupRepository(t, [BITGET_MARKET]);
  const trace: string[] = [];
  const repository = new ObservedFundingRateRepository(target, { trace });
  const lease = startCoverage(repository, BITGET_MARKET);
  const requestGate = new FakeAsyncGate();
  const parseGate = new FakeAsyncGate();
  const source = new FakeFundingRateSource('bitget', [{
    ...bitgetStep(BITGET_MARKET, 1, [fundingRecord(BITGET_MARKET, 79)]),
    parseGate
  }], trace);
  const executor = new FakeFundingRequestExecutor([{
    gate: requestGate,
    onExecute: () => assert.equal(database.inTransaction, false)
  }], trace);
  const task = coverageTask(source, repository, executor, lease);

  const pending = task.runNextPage();
  await requestGate.entered;
  assert.deepEqual(trace, [
    'eligibility',
    'eligibility',
    'pageRequest:BTCUSDT:bitget:1',
    'execute:/api/v2/mix/market/history-fund-rate'
  ]);
  assert.equal(source.fetchCalls.length, 0);
  assert.equal(repository.coverageCommits.length, 0);

  requestGate.release();
  await parseGate.entered;
  assert.deepEqual(trace.slice(-2), [
    'fetch:BTCUSDT:bitget:1',
    'parse:BTCUSDT:bitget:1'
  ]);
  assert.equal(repository.coverageCommits.length, 0);

  parseGate.release();
  assert.equal(await pending, 'requeue');
  assert.equal(trace.at(-1), 'commit');
  assert.equal(repository.coverageCommits.length, 1);
});

test('a coverage commit failure writes no page and never requests the next cursor', async (t) => {
  const { repository: target } = setupRepository(t, [BITGET_MARKET]);
  const repository = new ObservedFundingRateRepository(target, {
    commitError: new Error('synthetic SQLite commit failure')
  });
  const lease = startCoverage(repository, BITGET_MARKET);
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [fundingRecord(BITGET_MARKET, 79)])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.equal(await task.runNextPage(), 'done');
  assertCoverageFailure(repository, BITGET_MARKET, 'DATABASE_WRITE_FAILED');
  assert.equal(target.listHistory(BITGET_MARKET).length, 0);
  assert.deepEqual(pageCursors(source), [
    { exchangeId: 'bitget', pageNo: 1 }
  ]);
});

test('OKX enforces strict after progress, continues short pages, and completes only on explicit empty', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  const lease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [
      fundingRecord(OKX_MARKET, 80),
      fundingRecord(OKX_MARKET, 79)
    ]),
    okxStep(OKX_MARKET, 79, [fundingRecord(OKX_MARKET, 78)]),
    okxStep(OKX_MARKET, 78, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.deepEqual(await drainTask(task), ['requeue', 'requeue', 'done']);
  assert.deepEqual(pageCursors(source), [
    { exchangeId: 'okx', afterMs: null },
    { exchangeId: 'okx', afterMs: 79 },
    { exchangeId: 'okx', afterMs: 78 }
  ]);
  const state = stateFor(repository, OKX_MARKET);
  assert.equal(state.coverageStatus, 'CAUGHT_UP');
  assert.deepEqual(JSON.parse(state.lastExhaustionEvidenceJson ?? ''), {
    exchangeId: 'okx',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    explicitEmpty: true,
    finalRequestAfterMs: 78
  });
});

interface InvalidOkxCase {
  readonly name: string;
  readonly requestAfterMs: number | null;
  readonly page: (record: SettledFundingRate) => FundingRatePage;
  readonly code: FundingTaskFailureCode;
}

const invalidOkxCases: readonly InvalidOkxCase[] = [
  {
    name: 'mismatched response cursor',
    requestAfterMs: null,
    page: (record) => fakeOkxPage(90, [record]),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'non-minimum next after',
    requestAfterMs: null,
    page: (record) => ({
      cursor: { exchangeId: 'okx', afterMs: null },
      records: [record, fundingRecord(OKX_MARKET, 78)],
      nextCursor: { exchangeId: 'okx', afterMs: 79 },
      recoveryAnchorMs: 79
    }),
    code: 'CURSOR_NOT_ADVANCING'
  },
  {
    name: 'non-maximum recovery anchor',
    requestAfterMs: null,
    page: (record) => ({
      cursor: { exchangeId: 'okx', afterMs: null },
      records: [record, fundingRecord(OKX_MARKET, 78)],
      nextCursor: { exchangeId: 'okx', afterMs: 78 },
      recoveryAnchorMs: 78
    }),
    code: 'CURSOR_NOT_ADVANCING'
  },
  {
    name: 'record equal to request after',
    requestAfterMs: 79,
    page: (record) => fakeOkxPage(79, [record]),
    code: 'CURSOR_NOT_ADVANCING'
  },
  {
    name: 'next after that does not strictly decrease',
    requestAfterMs: 79,
    page: () => ({
      cursor: { exchangeId: 'okx', afterMs: 79 },
      records: [fundingRecord(OKX_MARKET, 78)],
      nextCursor: { exchangeId: 'okx', afterMs: 79 },
      recoveryAnchorMs: 78
    }),
    code: 'CURSOR_NOT_ADVANCING'
  },
  {
    name: 'non-null next cursor on an empty page',
    requestAfterMs: null,
    page: () => ({
      cursor: { exchangeId: 'okx', afterMs: null },
      records: [],
      nextCursor: { exchangeId: 'okx', afterMs: 79 },
      recoveryAnchorMs: null
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  },
  {
    name: 'non-null recovery anchor on an empty page',
    requestAfterMs: null,
    page: () => ({
      cursor: { exchangeId: 'okx', afterMs: null },
      records: [],
      nextCursor: null,
      recoveryAnchorMs: 79
    }),
    code: 'SOURCE_RESPONSE_INVALID'
  }
];

for (const invalidCase of invalidOkxCases) {
  test(`OKX rejects ${invalidCase.name} before any page commit`, async (t) => {
    const { repository: target } = setupRepository(t, [OKX_MARKET]);
    let lease = startCoverage(target, OKX_MARKET, 'INITIAL', 100);
    if (invalidCase.requestAfterMs !== null) {
      target.commitCoveragePage(
        lease,
        [fundingRecord(OKX_MARKET, invalidCase.requestAfterMs)],
        { exchangeId: 'okx', recoveryAnchorMs: invalidCase.requestAfterMs },
        NOW
      );
      lease = resumeCoverage(target, OKX_MARKET, LATER_AT);
    }
    const repository = new ObservedFundingRateRepository(target);
    const record = fundingRecord(OKX_MARKET, invalidCase.requestAfterMs ?? 79);
    const cursor: FundingPageCursor = {
      exchangeId: 'okx',
      afterMs: invalidCase.requestAfterMs
    };
    const source = new FakeFundingRateSource('okx', [{
      marketId: OKX_MARKET.exchangeMarketId,
      cursor,
      page: invalidCase.page(record)
    }]);
    const task = coverageTask(
      source,
      repository,
      new FakeFundingRequestExecutor(),
      lease
    );
    const beforeHistoryCount = target.listHistory(OKX_MARKET).length;

    assert.equal(await task.runNextPage(), 'done');
    assertCoverageFailure(repository, OKX_MARKET, invalidCase.code);
    assert.equal(repository.coverageCommits.length, 0);
    assert.equal(target.listHistory(OKX_MARKET).length, beforeHistoryCount);
  });
}

test('OKX recovery accepts an all-duplicate overlap page and continues to older data and empty', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  const interrupted = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  const initialSource = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [78, 77, 76, 75].map((timestamp) => (
      fundingRecord(OKX_MARKET, timestamp)
    )))
  ]);
  const initialTask = coverageTask(
    initialSource,
    repository,
    new FakeFundingRequestExecutor(),
    interrupted
  );
  assert.equal(await initialTask.runNextPage(), 'requeue');
  assert.equal(stateFor(repository, OKX_MARKET).okxResumeAfterMs, 78);

  const recovered = resumeCoverage(repository, OKX_MARKET, LATER_AT);
  assert.equal(recovered.okxResumeAfterMs, 78);
  const recoveredSource = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, 78, [77, 76, 75].map((timestamp) => (
      fundingRecord(OKX_MARKET, timestamp)
    ))),
    okxStep(OKX_MARKET, 75, [fundingRecord(OKX_MARKET, 74)]),
    okxStep(OKX_MARKET, 74, [])
  ]);
  const recoveredTask = coverageTask(
    recoveredSource,
    repository,
    new FakeFundingRequestExecutor(),
    recovered
  );

  assert.deepEqual(
    await drainTask(recoveredTask),
    ['requeue', 'requeue', 'done']
  );
  assert.deepEqual(pageCursors(recoveredSource), [
    { exchangeId: 'okx', afterMs: 78 },
    { exchangeId: 'okx', afterMs: 75 },
    { exchangeId: 'okx', afterMs: 74 }
  ]);
  assert.deepEqual(
    repository.listHistory(OKX_MARKET).map(({ fundingTimestampMs }) => (
      fundingTimestampMs
    )),
    [78, 77, 76, 75, 74]
  );
  assert.equal(stateFor(repository, OKX_MARKET).coverageStatus, 'CAUGHT_UP');
});

test('a new OKX generation clears the old anchor and recovers from the unpaged first request', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  const oldLease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  repository.commitCoveragePage(
    oldLease,
    [fundingRecord(OKX_MARKET, 78)],
    { exchangeId: 'okx', recoveryAnchorMs: 78 },
    NOW
  );
  assert.equal(stateFor(repository, OKX_MARKET).okxResumeAfterMs, 78);

  const newLease = startCoverage(repository, OKX_MARKET, 'PERIODIC', 101);
  assert.equal(newLease.okxResumeAfterMs, null);
  const recovered = resumeCoverage(repository, OKX_MARKET, LATER_AT);
  assert.equal(recovered.okxResumeAfterMs, null);
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    recovered
  );

  assert.equal(task.category, 'reconcile');
  assert.equal(await task.runNextPage(), 'done');
  assert.deepEqual(pageCursors(source), [
    { exchangeId: 'okx', afterMs: null }
  ]);
  assert.equal(stateFor(repository, OKX_MARKET).coverageStatus, 'CAUGHT_UP');
});

test('a stale generation is discarded before constructing or executing its next request', async (t) => {
  const { database, repository } = setupRepository(t, [OKX_MARKET]);
  const oldLease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 79)])
  ]);
  const executor = new FakeFundingRequestExecutor();
  const oldTask = coverageTask(source, repository, executor, oldLease);
  const newLease = startCoverage(repository, OKX_MARKET, 'PERIODIC', 101);
  const before = persistenceSnapshot(database);

  assert.equal(await oldTask.runNextPage(), 'done');
  assert.equal(source.pageRequestCalls.length, 0);
  assert.equal(source.fetchCalls.length, 0);
  assert.equal(executor.calls.length, 0);
  assert.equal(persistenceSnapshot(database), before);
  assert.equal(stateFor(repository, OKX_MARKET).coverageGeneration, newLease.generation);
  assert.equal(stateFor(repository, OKX_MARKET).coverageStatus, 'BACKFILLING');
});

test('a response that becomes stale before commit performs zero writes and does not fail the new generation', async (t) => {
  const { database, repository } = setupRepository(t, [OKX_MARKET]);
  const oldLease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  const parseGate = new FakeAsyncGate();
  const source = new FakeFundingRateSource('okx', [{
    ...okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 79)]),
    parseGate
  }]);
  const oldTask = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    oldLease
  );

  const pending = oldTask.runNextPage();
  await parseGate.entered;
  const newLease = startCoverage(repository, OKX_MARKET, 'PERIODIC', 101);
  const before = persistenceSnapshot(database);
  parseGate.release();

  assert.equal(await pending, 'done');
  assert.equal(persistenceSnapshot(database), before);
  const state = stateFor(repository, OKX_MARKET);
  assert.equal(state.coverageGeneration, newLease.generation);
  assert.equal(state.coverageStatus, 'BACKFILLING');
  assert.equal(state.coverageErrorCode, null);
});

test('a stale error raised at the commit gate is discarded without overwriting the new generation', async (t) => {
  const { database, repository: target } = setupRepository(t, [OKX_MARKET]);
  const oldLease = startCoverage(target, OKX_MARKET, 'INITIAL', 100);
  const newLeases: CoverageLease[] = [];
  const repository = new ObservedFundingRateRepository(target, {
    beforeCommit: () => {
      newLeases.push(startCoverage(target, OKX_MARKET, 'PERIODIC', 101));
    }
  });
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 79)])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    oldLease
  );

  assert.equal(await task.runNextPage(), 'done');
  const newLease = newLeases[0];
  if (newLease === undefined) assert.fail('expected a superseding coverage lease');
  const state = stateFor(target, OKX_MARKET);
  assert.equal(state.coverageGeneration, newLease.generation);
  assert.equal(state.coverageStatus, 'BACKFILLING');
  assert.equal(state.coverageErrorCode, null);
  assert.equal(target.listHistory(OKX_MARKET).length, 0);
  assert.equal(
    JSON.parse(persistenceSnapshot(database)).history.length,
    0
  );
});

test('one market failure does not block another market from reaching caught up', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET, BITGET_ETH_MARKET]);
  const failedLease = startCoverage(repository, BITGET_MARKET);
  const healthyLease = startCoverage(repository, BITGET_ETH_MARKET);
  const source = new FakeFundingRateSource('bitget', [
    {
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 },
      parseError: new Error('synthetic malformed BTC response')
    },
    bitgetStep(BITGET_ETH_MARKET, 1, []),
    bitgetStep(BITGET_ETH_MARKET, 1, [])
  ]);
  const executor = new FakeFundingRequestExecutor();
  const failedTask = coverageTask(source, repository, executor, failedLease);
  const healthyTask = coverageTask(source, repository, executor, healthyLease);

  assert.equal(await failedTask.runNextPage(), 'done');
  assert.deepEqual(await drainTask(healthyTask), ['requeue', 'done']);
  assertCoverageFailure(
    repository,
    BITGET_MARKET,
    'SOURCE_RESPONSE_INVALID'
  );
  assert.equal(
    stateFor(repository, BITGET_ETH_MARKET).coverageStatus,
    'CAUGHT_UP'
  );
});

test('event sink failures cannot reverse a successful coverage transition', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  const lease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  let eventCalls = 0;
  const throwingEvents: FundingRateEventSink = {
    record(): void {
      eventCalls += 1;
      throw new Error('synthetic event sink failure');
    }
  };
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [])
  ]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease,
    throwingEvents
  );

  assert.equal(await task.runNextPage(), 'done');
  assert.ok(eventCalls > 0);
  assert.equal(stateFor(repository, OKX_MARKET).coverageStatus, 'CAUGHT_UP');
});

interface SingleFlightCase {
  readonly name: string;
  readonly market: FundingMarketIdentity;
  readonly steps: (
    gate: FakeAsyncGate
  ) => readonly FakeFundingPageStep[];
  readonly continuation: readonly ('requeue' | 'done')[];
}

const singleFlightCases: readonly SingleFlightCase[] = [
  {
    name: 'Bitget empty then empty',
    market: BITGET_MARKET,
    steps: (gate) => [{
      ...bitgetStep(BITGET_MARKET, 1, []),
      parseGate: gate
    }, bitgetStep(BITGET_MARKET, 1, [])],
    continuation: ['done']
  },
  {
    name: 'Bitget non-empty then empty',
    market: BITGET_MARKET,
    steps: (gate) => {
      const record = fundingRecord(BITGET_MARKET, 79);
      return [{
        ...bitgetStep(BITGET_MARKET, 1, [record]),
        parseGate: gate
      },
      bitgetStep(BITGET_MARKET, 2, []),
      bitgetStep(BITGET_MARKET, 1, [record]),
      bitgetStep(BITGET_MARKET, 2, [])];
    },
    continuation: ['requeue', 'requeue', 'done']
  },
  {
    name: 'OKX non-empty then empty',
    market: OKX_MARKET,
    steps: (gate) => [{
      ...okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 79)]),
      parseGate: gate
    }, okxStep(OKX_MARKET, 79, [])],
    continuation: ['done']
  }
];

for (const singleFlightCase of singleFlightCases) {
  test(`${singleFlightCase.name} rejects a concurrent run without an extra request or commit`, async (t) => {
    const { repository: target } = setupRepository(t, [singleFlightCase.market]);
    const repository = new ObservedFundingRateRepository(target);
    const lease = startCoverage(repository, singleFlightCase.market, 'INITIAL', 100);
    const gate = new FakeAsyncGate();
    const source = new FakeFundingRateSource(
      singleFlightCase.market.exchangeId,
      singleFlightCase.steps(gate)
    );
    const executor = new FakeFundingRequestExecutor();
    const task = coverageTask(source, repository, executor, lease);

    const first = task.runNextPage();
    await gate.entered;
    const concurrentErrorPromise = promiseError(task.runNextPage());
    await Promise.resolve();
    await Promise.resolve();
    const callsWhileFirstIsPaused = {
      pageRequests: source.pageRequestCalls.length,
      fetches: source.fetchCalls.length,
      executions: executor.calls.length,
      commits: repository.coverageCommits.length
    };
    gate.release();
    const [firstResult, concurrentError] = await Promise.all([
      first,
      concurrentErrorPromise
    ]);
    const continuation = concurrentError instanceof Error
      ? await drainTask(task)
      : null;

    assert.ok(concurrentError instanceof Error);
    assert.match(concurrentError.message, /already running/i);
    assert.deepEqual(callsWhileFirstIsPaused, {
      pageRequests: 1,
      fetches: 1,
      executions: 1,
      commits: 0
    });
    assert.equal(firstResult, 'requeue');
    assert.deepEqual(continuation, singleFlightCase.continuation);
    assert.equal(
      stateFor(repository, singleFlightCase.market).coverageStatus,
      'CAUGHT_UP'
    );
  });
}

test('mutating a caller-owned lease cannot turn an old response into a current-generation write', async (t) => {
  const { database, repository } = setupRepository(t, [OKX_MARKET]);
  const oldLease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  const gate = new FakeAsyncGate();
  const source = new FakeFundingRateSource('okx', [{
    ...okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 79)]),
    parseGate: gate
  }]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    oldLease
  );

  const pending = task.runNextPage();
  await gate.entered;
  const newLease = startCoverage(repository, OKX_MARKET, 'PERIODIC', 101);
  Object.assign(oldLease, newLease);
  const before = persistenceSnapshot(database);
  gate.release();

  assert.equal(await pending, 'done');
  assert.equal(persistenceSnapshot(database), before);
  assert.equal(repository.listHistory(OKX_MARKET).length, 0);
  const state = stateFor(repository, OKX_MARKET);
  assert.equal(state.coverageGeneration, newLease.generation);
  assert.equal(state.coverageStatus, 'BACKFILLING');
  assert.equal(state.coverageErrorCode, null);
});

test('createCoverageTask rejects a lease accessor without executing it', (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const lease = startCoverage(repository, BITGET_MARKET);
  let getterCalls = 0;
  const hostileLease = throwingOwnAccessor(
    { ...lease },
    'generation',
    () => { getterCalls += 1; }
  ) as CoverageLease;
  const source = new FakeFundingRateSource('bitget', []);
  const sync = new FundingRateMarketSync({
    source,
    repository,
    requestExecutor: new FakeFundingRequestExecutor(),
    events: NOOP_FUNDING_RATE_EVENT_SINK,
    now: () => new Date(NOW.getTime())
  });
  let error: unknown = null;

  try {
    sync.createCoverageTask(hostileLease);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.match(error.message, /coverage lease|accessor|data property/i);
  assert.equal(getterCalls, 0);
  assert.equal(source.pageRequestCalls.length, 0);
  assert.equal(source.fetchCalls.length, 0);
});

for (const exchangeId of ['bitget', 'okx'] as const) {
  test(`createCoverageTask rejects forged ${exchangeId} task-start provenance before side effects`, (t) => {
    const { database, repository } = setupRepository(
      t,
      [exchangeId === 'bitget' ? BITGET_MARKET : OKX_MARKET]
    );
    const { actual, forged } = forgedTaskStartLease(repository, exchangeId);
    const source = new FakeFundingRateSource(exchangeId, []);
    const executor = new FakeFundingRequestExecutor();
    const events = new RecordingEventSink();
    const sync = new FundingRateMarketSync({
      source,
      repository,
      requestExecutor: executor,
      events,
      now: () => new Date(NOW.getTime())
    });
    const before = persistenceSnapshot(database);
    let task: FundingPageTask | null = null;
    const error = invocationError(() => {
      task = sync.createCoverageTask(forged);
    });

    assert.equal(
      exchangeId === 'bitget'
        ? actual.requiredBitgetBoundaryMs
        : actual.okxResumeAfterMs,
      exchangeId === 'bitget' ? 70 : 78
    );
    assert.deepEqual({
      rejected: error instanceof Error,
      taskCreated: task !== null,
      events: events.events.length,
      pageRequests: source.pageRequestCalls.length,
      fetches: source.fetchCalls.length,
      executions: executor.calls.length,
      persistenceUnchanged: persistenceSnapshot(database) === before
    }, {
      rejected: true,
      taskCreated: false,
      events: 0,
      pageRequests: 0,
      fetches: 0,
      executions: 0,
      persistenceUnchanged: true
    });
    assert.match((error as Error).message, /stale funding task/i);
  });
}

interface HostilePageCase {
  readonly name: string;
  readonly market: FundingMarketIdentity;
  readonly page: (
    record: SettledFundingRate,
    onRead: () => void
  ) => FundingRatePage;
}

const hostilePageCases: readonly HostilePageCase[] = [
  {
    name: 'Bitget top-level cursor accessor',
    market: BITGET_MARKET,
    page: (record, onRead) => throwingOwnAccessor(
      fakeBitgetPage(1, [record]),
      'cursor',
      onRead
    )
  },
  {
    name: 'OKX top-level records accessor',
    market: OKX_MARKET,
    page: (record, onRead) => throwingOwnAccessor(
      fakeOkxPage(null, [record]),
      'records',
      onRead
    )
  },
  {
    name: 'Bitget top-level recovery anchor accessor',
    market: BITGET_MARKET,
    page: (record, onRead) => throwingOwnAccessor(
      fakeBitgetPage(1, [record]),
      'recoveryAnchorMs',
      onRead
    )
  },
  {
    name: 'OKX top-level next cursor accessor',
    market: OKX_MARKET,
    page: (record, onRead) => throwingOwnAccessor(
      fakeOkxPage(null, [record]),
      'nextCursor',
      onRead
    )
  },
  {
    name: 'Bitget response cursor page number accessor',
    market: BITGET_MARKET,
    page: (record, onRead) => ({
      ...fakeBitgetPage(1, [record]),
      cursor: throwingOwnAccessor(
        { exchangeId: 'bitget', pageNo: 1 } as const,
        'pageNo',
        onRead
      )
    })
  },
  {
    name: 'OKX next cursor after accessor',
    market: OKX_MARKET,
    page: (record, onRead) => ({
      ...fakeOkxPage(null, [record]),
      nextCursor: throwingOwnAccessor(
        { exchangeId: 'okx', afterMs: record.fundingTimestampMs } as const,
        'afterMs',
        onRead
      )
    })
  },
  {
    name: 'Bitget records element accessor',
    market: BITGET_MARKET,
    page: (record, onRead) => {
      const records = [record];
      Object.defineProperty(records, 0, {
        configurable: true,
        enumerable: true,
        get(): never {
          onRead();
          throw new Error('synthetic records element accessor execution');
        }
      });
      return { ...fakeBitgetPage(1, [record]), records };
    }
  },
  {
    name: 'OKX record timestamp accessor',
    market: OKX_MARKET,
    page: (record, onRead) => ({
      ...fakeOkxPage(null, [record]),
      records: [throwingOwnAccessor(
        { ...record },
        'fundingTimestampMs',
        onRead
      )]
    })
  }
];

for (const hostilePageCase of hostilePageCases) {
  test(`${hostilePageCase.name} is rejected without executing the getter`, async (t) => {
    const { repository: target } = setupRepository(t, [hostilePageCase.market]);
    const repository = new ObservedFundingRateRepository(target);
    const lease = startCoverage(repository, hostilePageCase.market, 'INITIAL', 100);
    const record = fundingRecord(hostilePageCase.market, 79);
    let getterCalls = 0;
    const cursor: FundingPageCursor = hostilePageCase.market.exchangeId === 'bitget'
      ? { exchangeId: 'bitget', pageNo: 1 }
      : { exchangeId: 'okx', afterMs: null };
    const source = new FakeFundingRateSource(
      hostilePageCase.market.exchangeId,
      [{
        marketId: hostilePageCase.market.exchangeMarketId,
        cursor,
        page: hostilePageCase.page(record, () => { getterCalls += 1; })
      }]
    );
    const task = coverageTask(
      source,
      repository,
      new FakeFundingRequestExecutor(),
      lease
    );

    assert.equal(await task.runNextPage(), 'done');
    assert.equal(getterCalls, 0);
    assertCoverageFailure(
      repository,
      hostilePageCase.market,
      'SOURCE_RESPONSE_INVALID'
    );
    assert.equal(repository.coverageCommits.length, 0);
    assert.equal(target.listHistory(hostilePageCase.market).length, 0);
  });
}

test('a sparse records array is rejected before any coverage commit', async (t) => {
  const { repository: target } = setupRepository(t, [BITGET_MARKET]);
  const repository = new ObservedFundingRateRepository(target);
  const lease = startCoverage(repository, BITGET_MARKET, 'INITIAL', 100);
  const sparseRecords = new Array<SettledFundingRate>(1);
  const source = new FakeFundingRateSource('bitget', [{
    marketId: BITGET_MARKET.exchangeMarketId,
    cursor: { exchangeId: 'bitget', pageNo: 1 },
    page: {
      ...fakeBitgetPage(1, []),
      records: sparseRecords,
      nextCursor: { exchangeId: 'bitget', pageNo: 2 }
    }
  }]);
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease
  );

  assert.equal(await task.runNextPage(), 'done');
  assertCoverageFailure(repository, BITGET_MARKET, 'SOURCE_RESPONSE_INVALID');
  assert.equal(repository.coverageCommits.length, 0);
  assert.equal(target.listHistory(BITGET_MARKET).length, 0);
});

interface RequestConstructionFailureCase {
  readonly market: FundingMarketIdentity;
  readonly expectedRequest: FundingRequestMetadata;
}

const requestConstructionFailureCases: readonly RequestConstructionFailureCase[] = [
  {
    market: BITGET_MARKET,
    expectedRequest: {
      method: 'GET',
      path: '/api/v2/mix/market/history-fund-rate',
      query: {
        symbol: BITGET_MARKET.exchangeMarketId,
        productType: 'USDT-FUTURES',
        pageNo: 1,
        pageSize: 100
      },
      body: null
    }
  },
  {
    market: OKX_MARKET,
    expectedRequest: {
      method: 'GET',
      path: '/api/v5/public/funding-rate-history',
      query: {
        instId: OKX_MARKET.exchangeMarketId,
        limit: 400
      },
      body: null
    }
  }
];

for (const failureCase of requestConstructionFailureCases) {
  test(`${failureCase.market.exchangeId} request construction failure emits a static safe incomplete event`, async (t) => {
    const { repository } = setupRepository(t, [failureCase.market]);
    const lease = startCoverage(repository, failureCase.market, 'INITIAL', 100);
    const rawErrorText = `synthetic ${failureCase.market.exchangeId} request construction detail`;
    const cursor: FundingPageCursor = failureCase.market.exchangeId === 'bitget'
      ? { exchangeId: 'bitget', pageNo: 1 }
      : { exchangeId: 'okx', afterMs: null };
    const source = new FakeFundingRateSource(failureCase.market.exchangeId, [{
      marketId: failureCase.market.exchangeMarketId,
      cursor,
      pageRequestError: new Error(rawErrorText)
    }]);
    const executor = new FakeFundingRequestExecutor();
    const events = new RecordingEventSink();
    const task = coverageTask(source, repository, executor, lease, events);

    assert.equal(await task.runNextPage(), 'done');
    assertCoverageFailure(
      repository,
      failureCase.market,
      'SOURCE_RESPONSE_INVALID'
    );
    assert.equal(source.pageRequestCalls.length, 1);
    assert.equal(executor.calls.length, 0);
    assert.equal(source.fetchCalls.length, 0);
    const state = stateFor(repository, failureCase.market);
    assert.equal(state.coverageErrorSummary?.includes(rawErrorText), false);
    const incomplete = events.events.find(
      ({ event }) => event === 'funding_task_incomplete'
    );
    assert.ok(incomplete?.event === 'funding_task_incomplete');
    assert.deepEqual({
      exchangeId: incomplete.exchangeId,
      exchangeMarketId: incomplete.exchangeMarketId,
      symbol: incomplete.symbol,
      cursor: incomplete.cursor,
      request: incomplete.request
    }, {
      exchangeId: failureCase.market.exchangeId,
      exchangeMarketId: failureCase.market.exchangeMarketId,
      symbol: failureCase.market.symbol,
      cursor,
      request: failureCase.expectedRequest
    });
    assert.equal(incomplete.error.message.includes(rawErrorText), true);
  });
}

test('OKX request construction failure after a committed page reports the string after cursor', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  const lease = startCoverage(repository, OKX_MARKET, 'INITIAL', 100);
  const rawErrorText = 'synthetic OKX after request construction detail';
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 79)]),
    {
      marketId: OKX_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'okx', afterMs: 79 },
      pageRequestError: new Error(rawErrorText)
    }
  ]);
  const executor = new FakeFundingRequestExecutor();
  const events = new RecordingEventSink();
  const task = coverageTask(source, repository, executor, lease, events);

  assert.equal(await task.runNextPage(), 'requeue');
  assert.equal(repository.listHistory(OKX_MARKET).length, 1);
  assert.equal(await task.runNextPage(), 'done');

  assertCoverageFailure(repository, OKX_MARKET, 'SOURCE_RESPONSE_INVALID');
  assert.equal(source.pageRequestCalls.length, 2);
  assert.equal(executor.calls.length, 1);
  assert.equal(source.fetchCalls.length, 1);
  const state = stateFor(repository, OKX_MARKET);
  assert.equal(state.coverageErrorSummary?.includes(rawErrorText), false);
  const incomplete = events.events.find(
    ({ event }) => event === 'funding_task_incomplete'
  );
  assert.ok(incomplete?.event === 'funding_task_incomplete');
  assert.deepEqual({
    exchangeId: incomplete.exchangeId,
    exchangeMarketId: incomplete.exchangeMarketId,
    symbol: incomplete.symbol,
    cursor: incomplete.cursor,
    request: incomplete.request
  }, {
    exchangeId: OKX_MARKET.exchangeId,
    exchangeMarketId: OKX_MARKET.exchangeMarketId,
    symbol: OKX_MARKET.symbol,
    cursor: { exchangeId: 'okx', afterMs: 79 },
    request: {
      method: 'GET',
      path: '/api/v5/public/funding-rate-history',
      query: {
        instId: OKX_MARKET.exchangeMarketId,
        after: '79',
        limit: 400
      },
      body: null
    }
  });
  assert.equal(incomplete.error.message.includes(rawErrorText), true);
});

test('the approved failure set remains finite and summaries never contain source errors', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const lease = startCoverage(repository, BITGET_MARKET);
  const secretLikeText = 'synthetic-response-header=do-not-persist';
  const source = new FakeFundingRateSource('bitget', [{
    marketId: BITGET_MARKET.exchangeMarketId,
    cursor: { exchangeId: 'bitget', pageNo: 1 },
    parseError: new Error(secretLikeText)
  }]);
  const events = new RecordingEventSink();
  const task = coverageTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease,
    events
  );

  assert.equal(await task.runNextPage(), 'done');
  const state = stateFor(repository, BITGET_MARKET);
  assert.deepEqual({
    code: state.coverageErrorCode,
    summary: state.coverageErrorSummary
  }, fundingTaskFailure('SOURCE_RESPONSE_INVALID'));
  assert.equal(state.coverageErrorSummary?.includes(secretLikeText), false);
  const incomplete = events.events.find(
    ({ event }) => event === 'funding_task_incomplete'
  );
  assert.ok(incomplete?.event === 'funding_task_incomplete');
  assert.deepEqual({
    exchangeId: incomplete.exchangeId,
    exchangeMarketId: incomplete.exchangeMarketId,
    symbol: incomplete.symbol,
    taskCategory: incomplete.taskCategory,
    cursor: incomplete.cursor
  }, {
    exchangeId: BITGET_MARKET.exchangeId,
    exchangeMarketId: BITGET_MARKET.exchangeMarketId,
    symbol: BITGET_MARKET.symbol,
    taskCategory: 'coverage',
    cursor: { exchangeId: 'bitget', pageNo: 1 }
  });
});

for (const market of [BITGET_MARKET, OKX_MARKET] as const) {
  test(`${market.exchangeId} incremental freezes the boundary and commits the overlap page before completion`, async (t) => {
    const { repository: target } = setupRepository(t, [market]);
    const boundary = fundingRecord(market, 70);
    seedCaughtUpHistory(target, market, [boundary]);
    const repository = new ObservedFundingRateRepository(target);
    const coverageBefore = coverageProof(stateFor(repository, market));
    const lease = repository.startIncremental(market, STARTED_AT);
    const newer = fundingRecord(market, 90);
    const olderUnknown = fundingRecord(
      market,
      69,
      '-0.0000000000000001234500'
    );
    const steps = market.exchangeId === 'bitget'
      ? [
          bitgetStep(market, 1, [newer, boundary]),
          bitgetStep(market, 2, [olderUnknown])
        ]
      : [
          okxStep(market, null, [newer, boundary]),
          okxStep(market, 70, [olderUnknown])
        ];
    const source = new FakeFundingRateSource(market.exchangeId, steps);
    const events = new RecordingEventSink();
    const task = incrementalTask(
      source,
      repository,
      new FakeFundingRequestExecutor(),
      lease,
      events
    );

    assert.equal(task.category, 'incremental');
    assert.equal(lease.frozenBoundaryMs, 70);
    assert.equal(await task.runNextPage(), 'requeue');
    assert.equal(stateFor(repository, market).latestFundingTimestampMs, 90);
    assert.equal(lease.frozenBoundaryMs, 70);
    assert.equal(await task.runNextPage(), 'done');

    assert.deepEqual(pageCursors(source), market.exchangeId === 'bitget'
      ? [
          { exchangeId: 'bitget', pageNo: 1 },
          { exchangeId: 'bitget', pageNo: 2 }
        ]
      : [
          { exchangeId: 'okx', afterMs: null },
          { exchangeId: 'okx', afterMs: 70 }
        ]);
    assert.deepEqual(
      repository.listHistory(market)
        .map(({ fundingTimestampMs }) => fundingTimestampMs)
        .sort((left, right) => right - left),
      [90, 70, 69]
    );
    assert.equal(
      repository.listHistory(market).find(
        ({ fundingTimestampMs }) => fundingTimestampMs === 69
      )?.fundingRate,
      '-0.0000000000000001234500'
    );
    assert.equal(repository.incrementalCommits.length, 2);
    assert.equal(stateFor(repository, market).incrementalStatus, 'IDLE');
    assert.deepEqual(coverageProof(stateFor(repository, market)), coverageBefore);
    const completed = events.events.find(
      ({ event }) => event === 'funding_incremental_completed'
    );
    assert.ok(completed?.event === 'funding_incremental_completed');
    assert.deepEqual({
      exchangeId: completed.exchangeId,
      generation: completed.generation,
      inserted: completed.inserted,
      unchanged: completed.unchanged,
      revised: completed.revised
    }, {
      exchangeId: market.exchangeId,
      generation: lease.generation,
      inserted: 2,
      unchanged: 1,
      revised: 0
    });
  });
}

for (const scenario of [
  {
    name: 'empty local history',
    market: BITGET_MARKET,
    seed: [] as readonly SettledFundingRate[],
    records: [fundingRecord(BITGET_MARKET, 50)],
    steps: (records: readonly SettledFundingRate[]) => [
      bitgetStep(BITGET_MARKET, 1, records),
      bitgetStep(BITGET_MARKET, 2, [])
    ]
  },
  {
    name: 'frozen boundary absent from the response',
    market: OKX_MARKET,
    seed: [fundingRecord(OKX_MARKET, 70)],
    records: [fundingRecord(OKX_MARKET, 90), fundingRecord(OKX_MARKET, 80)],
    steps: (records: readonly SettledFundingRate[]) => [
      okxStep(OKX_MARKET, null, records),
      okxStep(OKX_MARKET, 80, [])
    ]
  }
] as const) {
  test(`incremental ${scenario.name} scans through an explicit empty page`, async (t) => {
    const { repository: target } = setupRepository(t, [scenario.market]);
    seedCaughtUpHistory(target, scenario.market, scenario.seed);
    const coverageBefore = coverageProof(stateFor(target, scenario.market));
    const lease = target.startIncremental(scenario.market, STARTED_AT);
    const source = new FakeFundingRateSource(
      scenario.market.exchangeId,
      scenario.steps(scenario.records)
    );
    const events = new RecordingEventSink();
    const task = incrementalTask(
      source,
      target,
      new FakeFundingRequestExecutor(),
      lease,
      events
    );

    assert.equal(await task.runNextPage(), 'requeue');
    assert.equal(await task.runNextPage(), 'done');

    assert.equal(source.fetchCalls.length, 2);
    assert.equal(stateFor(target, scenario.market).incrementalStatus, 'IDLE');
    assert.deepEqual(coverageProof(stateFor(target, scenario.market)), coverageBefore);
    const completed = events.events.find(
      ({ event }) => event === 'funding_incremental_completed'
    );
    assert.ok(completed?.event === 'funding_incremental_completed');
    assert.deepEqual({
      inserted: completed.inserted,
      unchanged: completed.unchanged,
      revised: completed.revised
    }, {
      inserted: scenario.records.length,
      unchanged: 0,
      revised: 0
    });
  });
}

test('incremental commits an older revision in full and reports cumulative page results', async (t) => {
  const { database, repository: target } = setupRepository(t, [OKX_MARKET]);
  const boundary = fundingRecord(OKX_MARKET, 70);
  const previous = fundingRecord(OKX_MARKET, 60, '0.0001', 'A');
  seedCaughtUpHistory(target, OKX_MARKET, [boundary, previous]);
  const lease = target.startIncremental(OKX_MARKET, STARTED_AT);
  const revised = fundingRecord(OKX_MARKET, 60, '0.0002', 'B');
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [boundary]),
    okxStep(OKX_MARKET, 70, [revised])
  ]);
  const events = new RecordingEventSink();
  const task = incrementalTask(
    source,
    target,
    new FakeFundingRequestExecutor(),
    lease,
    events
  );

  assert.deepEqual(await drainTask(task), ['requeue', 'done']);

  assert.equal(
    target.listHistory(OKX_MARKET).find(
      ({ fundingTimestampMs }) => fundingTimestampMs === 60
    )?.fundingRate,
    '0.0002'
  );
  const revisionCount = database.prepare(`
    SELECT COUNT(*) AS count FROM funding_rate_revisions
  `).get() as { readonly count: number };
  assert.equal(revisionCount.count, 1);
  const completed = events.events.find(
    ({ event }) => event === 'funding_incremental_completed'
  );
  assert.ok(completed?.event === 'funding_incremental_completed');
  assert.deepEqual({
    inserted: completed.inserted,
    unchanged: completed.unchanged,
    revised: completed.revised
  }, {
    inserted: 0,
    unchanged: 1,
    revised: 1
  });
});

for (const failureCase of [
  {
    name: 'request construction',
    code: 'SOURCE_RESPONSE_INVALID' as const,
    step: {
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 } as const,
      pageRequestError: new Error('synthetic incremental request failure')
    },
    databaseError: undefined
  },
  {
    name: 'response parsing',
    code: 'SOURCE_RESPONSE_INVALID' as const,
    step: {
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 } as const,
      parseError: new Error('synthetic incremental parse failure')
    },
    databaseError: undefined
  },
  {
    name: 'non-advancing cursor',
    code: 'CURSOR_NOT_ADVANCING' as const,
    step: {
      marketId: BITGET_MARKET.exchangeMarketId,
      cursor: { exchangeId: 'bitget', pageNo: 1 } as const,
      page: {
        ...fakeBitgetPage(1, [fundingRecord(BITGET_MARKET, 90)]),
        nextCursor: { exchangeId: 'bitget', pageNo: 1 } as const
      }
    },
    databaseError: undefined
  },
  {
    name: 'database commit',
    code: 'DATABASE_WRITE_FAILED' as const,
    step: bitgetStep(
      BITGET_MARKET,
      1,
      [fundingRecord(BITGET_MARKET, 90)]
    ),
    databaseError: new Error('synthetic incremental sqlite failure')
  }
] as const) {
  test(`incremental ${failureCase.name} failure marks only incremental incomplete`, async (t) => {
    const { database, repository: target } = setupRepository(t, [BITGET_MARKET]);
    seedCaughtUpHistory(target, BITGET_MARKET, [fundingRecord(BITGET_MARKET, 70)]);
    const coverageBefore = coverageProof(stateFor(target, BITGET_MARKET));
    const repository = new ObservedFundingRateRepository(target, {
      incrementalCommitError: failureCase.databaseError
    });
    const lease = repository.startIncremental(BITGET_MARKET, STARTED_AT);
    const beforeRun = persistenceSnapshot(database);
    const source = new FakeFundingRateSource('bitget', [failureCase.step]);
    const events = new RecordingEventSink();
    const task = incrementalTask(
      source,
      repository,
      new FakeFundingRequestExecutor(),
      lease,
      events
    );

    assert.equal(await task.runNextPage(), 'done');

    const state = stateFor(repository, BITGET_MARKET);
    const expectedFailure = fundingTaskFailure(failureCase.code);
    assert.deepEqual({
      status: state.incrementalStatus,
      errorCode: state.incrementalErrorCode,
      errorSummary: state.incrementalErrorSummary
    }, {
      status: 'INCOMPLETE',
      errorCode: expectedFailure.code,
      errorSummary: expectedFailure.summary
    });
    assert.deepEqual(coverageProof(state), coverageBefore);
    assert.deepEqual(
      repository.listHistory(BITGET_MARKET).map(
        ({ fundingTimestampMs }) => fundingTimestampMs
      ),
      [70]
    );
    assert.notEqual(persistenceSnapshot(database), beforeRun);
    const incomplete = events.events.find(
      ({ event }) => event === 'funding_task_incomplete'
    );
    assert.ok(incomplete?.event === 'funding_task_incomplete');
    assert.equal(incomplete.taskCategory, 'incremental');
    assert.equal(incomplete.generation, lease.generation);
    assert.equal(incomplete.frozenBoundaryMs, 70);
  });
}

test('incremental success preserves an existing incomplete coverage state and proof', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  seedCaughtUpHistory(repository, OKX_MARKET, [fundingRecord(OKX_MARKET, 70)]);
  const periodic = startCoverage(repository, OKX_MARKET, 'PERIODIC', 110);
  repository.failCoverage(
    periodic,
    fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
    LATER_AT
  );
  const coverageBefore = coverageProof(stateFor(repository, OKX_MARKET));
  const lease = repository.startIncremental(OKX_MARKET, STARTED_AT);
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [])
  ]);
  const events = new RecordingEventSink();
  const task = incrementalTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease,
    events
  );

  assert.equal(await task.runNextPage(), 'done');

  const state = stateFor(repository, OKX_MARKET);
  assert.deepEqual(coverageProof(state), coverageBefore);
  assert.equal(state.coverageStatus, 'INCOMPLETE');
  assert.equal(state.incrementalStatus, 'IDLE');
  assert.ok(events.events.some(
    ({ event }) => event === 'funding_incremental_completed'
  ));
});

for (const transition of ['inactive', 'reactivation', 'generation'] as const) {
  test(`incremental ${transition} fencing cancels before the next request`, async (t) => {
    const { database, repository: target } = setupRepository(t, [BITGET_MARKET]);
    seedCaughtUpHistory(target, BITGET_MARKET, [fundingRecord(BITGET_MARKET, 70)]);
    const repository = new ObservedFundingRateRepository(target);
    const lease = repository.startIncremental(BITGET_MARKET, STARTED_AT);
    const source = new FakeFundingRateSource('bitget', [
      bitgetStep(BITGET_MARKET, 1, [fundingRecord(BITGET_MARKET, 90)])
    ]);
    const executor = new FakeFundingRequestExecutor();
    const task = incrementalTask(source, repository, executor, lease);
    assert.equal(await task.runNextPage(), 'requeue');

    if (transition === 'generation') {
      repository.restartInterruptedIncremental(BITGET_MARKET, LATER_AT);
    } else {
      repository.applyCompleteDiscovery(
        'bitget',
        [{ ...BITGET_MARKET, active: false }],
        LATER_AT
      );
      if (transition === 'reactivation') {
        repository.applyCompleteDiscovery(
          'bitget',
          [{ ...BITGET_MARKET, active: true }],
          new Date(LATER_AT.getTime() + 1_000)
        );
      }
    }
    const beforeOldRun = persistenceSnapshot(database);

    assert.equal(await task.runNextPage(), 'done');

    assert.equal(source.pageRequestCalls.length, 1);
    assert.equal(source.fetchCalls.length, 1);
    assert.equal(executor.calls.length, 1);
    assert.equal(repository.incrementalCancellations.length, 1);
    assert.equal(persistenceSnapshot(database), beforeOldRun);
    const state = stateFor(repository, BITGET_MARKET);
    assert.equal(
      state.incrementalStatus,
      transition === 'generation' ? 'RUNNING' : 'IDLE'
    );
  });
}

test('a returned-stale incremental commit performs zero writes and preserves the replacement generation', async (t) => {
  const { database, repository: target } = setupRepository(t, [OKX_MARKET]);
  seedCaughtUpHistory(target, OKX_MARKET, [fundingRecord(OKX_MARKET, 70)]);
  let replacement: IncrementalLease | undefined;
  let snapshotAfterReplacement = '';
  const repository = new ObservedFundingRateRepository(target, {
    beforeIncrementalCommit: () => {
      replacement = target.restartInterruptedIncremental(OKX_MARKET, LATER_AT);
      snapshotAfterReplacement = persistenceSnapshot(database);
    }
  });
  const lease = repository.startIncremental(OKX_MARKET, STARTED_AT);
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [fundingRecord(OKX_MARKET, 90)])
  ]);
  const events = new RecordingEventSink();
  const task = incrementalTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    lease,
    events
  );

  assert.equal(await task.runNextPage(), 'done');

  assert.ok(replacement !== undefined);
  assert.equal(persistenceSnapshot(database), snapshotAfterReplacement);
  assert.deepEqual(
    repository.listHistory(OKX_MARKET).map(
      ({ fundingTimestampMs }) => fundingTimestampMs
    ),
    [70]
  );
  const state = stateFor(repository, OKX_MARKET);
  assert.equal(state.incrementalGeneration, replacement.generation);
  assert.equal(state.incrementalStatus, 'RUNNING');
  assert.equal(events.events.some(
    ({ event }) => event === 'funding_task_incomplete'
      || event === 'funding_incremental_completed'
  ), false);
});

test('incremental restart resets its cursor and counters and refreezes persisted latest', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  seedCaughtUpHistory(repository, BITGET_MARKET, [fundingRecord(BITGET_MARKET, 70)]);
  const firstLease = repository.startIncremental(BITGET_MARKET, STARTED_AT);
  const firstSource = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [fundingRecord(BITGET_MARKET, 90)])
  ]);
  const firstTask = incrementalTask(
    firstSource,
    repository,
    new FakeFundingRequestExecutor(),
    firstLease
  );
  assert.equal(await firstTask.runNextPage(), 'requeue');

  const restarted = repository.restartInterruptedIncremental(
    BITGET_MARKET,
    LATER_AT
  );
  assert.equal(restarted.frozenBoundaryMs, 90);
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [fundingRecord(BITGET_MARKET, 90)]),
    bitgetStep(BITGET_MARKET, 2, [fundingRecord(BITGET_MARKET, 89)])
  ]);
  const events = new RecordingEventSink();
  const task = incrementalTask(
    source,
    repository,
    new FakeFundingRequestExecutor(),
    restarted,
    events
  );

  assert.deepEqual(await drainTask(task), ['requeue', 'done']);

  assert.deepEqual(pageCursors(source), [
    { exchangeId: 'bitget', pageNo: 1 },
    { exchangeId: 'bitget', pageNo: 2 }
  ]);
  const completed = events.events.find(
    ({ event }) => event === 'funding_incremental_completed'
  );
  assert.ok(completed?.event === 'funding_incremental_completed');
  assert.deepEqual({
    inserted: completed.inserted,
    unchanged: completed.unchanged,
    revised: completed.revised
  }, {
    inserted: 1,
    unchanged: 1,
    revised: 0
  });
});

for (const taskCategory of ['coverage', 'incremental'] as const) {
  for (const outcome of ['canceled', 'retry exhausted'] as const) {
    test(`${taskCategory} handles nominal request ${outcome} without guessing`, async (t) => {
      const { database, repository } = setupRepository(t, [OKX_MARKET]);
      if (taskCategory === 'incremental') {
        seedCaughtUpHistory(repository, OKX_MARKET, []);
      }
      const events = new RecordingEventSink();
      const error = nominalRequestError(
        outcome === 'canceled'
          ? 'FundingRequestCanceledError'
          : 'FundingRequestRetryExhaustedError'
      );
      const executor = new FakeFundingRequestExecutor([{ error }]);
      const source = new FakeFundingRateSource('okx', [
        okxStep(OKX_MARKET, null, [])
      ]);
      const task = taskCategory === 'coverage'
        ? coverageTask(
            source,
            repository,
            executor,
            startCoverage(repository, OKX_MARKET),
            events
          )
        : incrementalTask(
            source,
            repository,
            executor,
            repository.startIncremental(OKX_MARKET, STARTED_AT),
            events
          );
      const beforeRun = persistenceSnapshot(database);

      if (outcome === 'canceled') {
        assert.equal(await promiseError(task.runNextPage()), error);
        assert.equal(persistenceSnapshot(database), beforeRun);
        const state = stateFor(repository, OKX_MARKET);
        assert.equal(
          taskCategory === 'coverage'
            ? state.coverageStatus
            : state.incrementalStatus,
          taskCategory === 'coverage' ? 'BACKFILLING' : 'RUNNING'
        );
        assert.equal(events.events.some(
          ({ event }) => event === 'funding_task_incomplete'
            || event === 'funding_coverage_completed'
            || event === 'funding_incremental_completed'
        ), false);
        return;
      }

      assert.equal(await task.runNextPage(), 'done');
      const state = stateFor(repository, OKX_MARKET);
      assert.deepEqual({
        status: taskCategory === 'coverage'
          ? state.coverageStatus
          : state.incrementalStatus,
        code: taskCategory === 'coverage'
          ? state.coverageErrorCode
          : state.incrementalErrorCode,
        summary: taskCategory === 'coverage'
          ? state.coverageErrorSummary
          : state.incrementalErrorSummary
      }, {
        status: 'INCOMPLETE',
        ...fundingTaskFailure('REQUEST_RETRY_EXHAUSTED')
      });
      const incomplete = events.events.find(
        ({ event }) => event === 'funding_task_incomplete'
      );
      assert.ok(incomplete?.event === 'funding_task_incomplete');
      assert.equal(incomplete.taskCategory, taskCategory);
    });
  }
}

for (const taskCategory of ['coverage', 'incremental'] as const) {
  test(`${taskCategory} maps an ordinary executor rejection to source invalid`, async (t) => {
    const { repository } = setupRepository(t, [OKX_MARKET]);
    if (taskCategory === 'incremental') {
      seedCaughtUpHistory(repository, OKX_MARKET, []);
    }
    const source = new FakeFundingRateSource('okx', [
      okxStep(OKX_MARKET, null, [])
    ]);
    const executor = new FakeFundingRequestExecutor([{
      error: new Error('synthetic ordinary executor rejection')
    }]);
    const task = taskCategory === 'coverage'
      ? coverageTask(
          source,
          repository,
          executor,
          startCoverage(repository, OKX_MARKET)
        )
      : incrementalTask(
          source,
          repository,
          executor,
          repository.startIncremental(OKX_MARKET, STARTED_AT)
        );

    assert.equal(await task.runNextPage(), 'done');

    const state = stateFor(repository, OKX_MARKET);
    assert.deepEqual({
      code: taskCategory === 'coverage'
        ? state.coverageErrorCode
        : state.incrementalErrorCode,
      summary: taskCategory === 'coverage'
        ? state.coverageErrorSummary
        : state.incrementalErrorSummary
    }, fundingTaskFailure('SOURCE_RESPONSE_INVALID'));
  });
}

test('an error with cancel name and message is still an ordinary rejection', async (t) => {
  const { repository } = setupRepository(t, [BITGET_MARKET]);
  const nominal = nominalRequestError('FundingRequestCanceledError');
  const lookalike = new Error(nominal.message);
  lookalike.name = nominal.name;
  const lease = startCoverage(repository, BITGET_MARKET);
  const task = coverageTask(
    new FakeFundingRateSource('bitget', [
      bitgetStep(BITGET_MARKET, 1, [])
    ]),
    repository,
    new FakeFundingRequestExecutor([{ error: lookalike }]),
    lease
  );

  assert.equal(await task.runNextPage(), 'done');
  assertCoverageFailure(repository, BITGET_MARKET, 'SOURCE_RESPONSE_INVALID');
});

for (const taskCategory of ['coverage', 'incremental'] as const) {
  test(`${taskCategory} emits one safe event for each real request retry`, async (t) => {
    const { database, repository } = setupRepository(t, [OKX_MARKET]);
    if (taskCategory === 'incremental') {
      seedCaughtUpHistory(repository, OKX_MARKET, []);
    }
    const rawErrors = [
      new Error('synthetic retry-one credential=alpha'),
      new Error('synthetic retry-two credential=beta'),
      new Error('synthetic retry-three credential=gamma')
    ];
    const executor = new FakeFundingRequestExecutor([{
      retryNotices: [
        { retryAttempt: 1, retryDelayMs: 1_000, error: rawErrors[0] },
        { retryAttempt: 2, retryDelayMs: 2_000, error: rawErrors[1] },
        { retryAttempt: 3, retryDelayMs: 4_000, error: rawErrors[2] }
      ]
    }]);
    const source = new FakeFundingRateSource('okx', [
      okxStep(OKX_MARKET, null, [])
    ]);
    const events = new RecordingEventSink();
    const lease = taskCategory === 'coverage'
      ? startCoverage(repository, OKX_MARKET)
      : repository.startIncremental(OKX_MARKET, STARTED_AT);
    const task = taskCategory === 'coverage'
      ? coverageTask(source, repository, executor, lease as CoverageLease, events)
      : incrementalTask(
          source,
          repository,
          executor,
          lease as IncrementalLease,
          events
        );

    assert.equal(await task.runNextPage(), 'done');

    assert.notEqual(executor.retryObserverCalls[0], undefined);
    const retries = events.events.filter(
      ({ event }) => event === 'funding_request_retry'
    );
    assert.equal(retries.length, 3);
    for (const [index, retry] of retries.entries()) {
      assert.ok(retry.event === 'funding_request_retry');
      if (retry.taskCategory === 'discovery') {
        assert.fail('market page retries must not be discovery retries');
      }
      assert.equal(retry.taskCategory, taskCategory);
      assert.equal(retry.exchangeId, OKX_MARKET.exchangeId);
      assert.equal(retry.exchangeMarketId, OKX_MARKET.exchangeMarketId);
      assert.equal(retry.generation, lease.generation);
      assert.equal(retry.retryAttempt, index + 1);
      assert.equal(retry.retryDelayMs, (2 ** index) * 1_000);
      assert.deepEqual(retry.cursor, { exchangeId: 'okx', afterMs: null });
      assert.deepEqual(retry.request, {
        method: 'GET',
        path: '/api/v5/public/funding-rate-history',
        query: { instId: OKX_MARKET.exchangeMarketId, limit: 400 },
        body: null
      });
      assert.equal(retry.error.type, 'Error');
      assert.equal(retry.error.message, rawErrors[index]?.message);
      if (retry.taskCategory === 'coverage') {
        assert.equal(retry.coverageCutoffMs, CUTOFF_MS);
        assert.equal(retry.taskKind, 'INITIAL');
      } else if (retry.taskCategory === 'incremental') {
        assert.equal(retry.frozenBoundaryMs, null);
      }
    }
    const databaseState = persistenceSnapshot(database);
    assert.equal(databaseState.includes('credential=alpha'), false);
    assert.equal(databaseState.includes('credential=beta'), false);
    assert.equal(databaseState.includes('credential=gamma'), false);
  });
}

test('a retry observer uses the nonthrowing event sink', async (t) => {
  const { repository } = setupRepository(t, [OKX_MARKET]);
  seedCaughtUpHistory(repository, OKX_MARKET, []);
  const lease = repository.startIncremental(OKX_MARKET, STARTED_AT);
  const executor = new FakeFundingRequestExecutor([{
    retryNotices: [{
      retryAttempt: 1,
      retryDelayMs: 1_000,
      error: new Error('synthetic retry before success')
    }]
  }]);
  const task = incrementalTask(
    new FakeFundingRateSource('okx', [okxStep(OKX_MARKET, null, [])]),
    repository,
    executor,
    lease,
    {
      record(): void {
        throw new Error('synthetic retry event sink failure');
      }
    }
  );

  assert.equal(await task.runNextPage(), 'done');
  assert.equal(stateFor(repository, OKX_MARKET).incrementalStatus, 'IDLE');
  assert.notEqual(executor.retryObserverCalls[0], undefined);
});

test('Bitget forged incremental boundary is rejected before it can skip the true overlap page', async (t) => {
  const { database, repository } = setupRepository(t, [BITGET_MARKET]);
  seedCaughtUpHistory(
    repository,
    BITGET_MARKET,
    [fundingRecord(BITGET_MARKET, 70)]
  );
  const actual = repository.startIncremental(BITGET_MARKET, STARTED_AT);
  const forged = { ...actual, frozenBoundaryMs: 100 };
  const source = new FakeFundingRateSource('bitget', [
    bitgetStep(BITGET_MARKET, 1, [
      fundingRecord(BITGET_MARKET, 110),
      fundingRecord(BITGET_MARKET, 100)
    ]),
    bitgetStep(BITGET_MARKET, 2, [
      fundingRecord(BITGET_MARKET, 90),
      fundingRecord(BITGET_MARKET, 80)
    ]),
    bitgetStep(BITGET_MARKET, 3, [
      fundingRecord(BITGET_MARKET, 70),
      fundingRecord(BITGET_MARKET, 60)
    ])
  ]);
  const executor = new FakeFundingRequestExecutor();
  const events = new RecordingEventSink();
  const before = persistenceSnapshot(database);
  let task: FundingPageTask | undefined;
  let creationError: unknown = null;
  try {
    task = incrementalTask(
      source,
      repository,
      executor,
      forged,
      events
    );
  } catch (error) {
    creationError = error;
  }

  if (creationError !== null) {
    assert.equal(creationError instanceof StaleFundingTaskError, true);
    assert.equal(source.pageRequestCalls.length, 0);
    assert.equal(source.fetchCalls.length, 0);
    assert.equal(executor.calls.length, 0);
    assert.equal(events.events.length, 0);
    assert.equal(persistenceSnapshot(database), before);
    return;
  }
  if (task === undefined) assert.fail('expected the unsafely accepted forged task');

  assert.deepEqual(await drainTask(task), ['requeue', 'done']);
  const persistedTimestamps = repository.listHistory(BITGET_MARKET).map(
    ({ fundingTimestampMs }) => fundingTimestampMs
  );
  assert.deepEqual({
    requestedPages: pageCursors(source),
    trueBoundaryStillPresent: persistedTimestamps.includes(70),
    skippedOlderUnknown: !persistedTimestamps.includes(60),
    incrementalStatus: stateFor(repository, BITGET_MARKET).incrementalStatus
  }, {
    requestedPages: [
      { exchangeId: 'bitget', pageNo: 1 },
      { exchangeId: 'bitget', pageNo: 2 }
    ],
    trueBoundaryStillPresent: true,
    skippedOlderUnknown: true,
    incrementalStatus: 'IDLE'
  });
  assert.fail(
    'forged boundary was accepted and completed before the true boundary page'
  );
});

test('OKX createIncrementalTask rejects forged boundary with zero side effects', (t) => {
  const { database, repository } = setupRepository(t, [OKX_MARKET]);
  seedCaughtUpHistory(
    repository,
    OKX_MARKET,
    [fundingRecord(OKX_MARKET, 70)]
  );
  const actual = repository.startIncremental(OKX_MARKET, STARTED_AT);
  const forged = { ...actual, frozenBoundaryMs: 0 };
  const source = new FakeFundingRateSource('okx', [
    okxStep(OKX_MARKET, null, [])
  ]);
  const executor = new FakeFundingRequestExecutor();
  const events = new RecordingEventSink();
  const before = persistenceSnapshot(database);

  const error = invocationError(() => incrementalTask(
    source,
    repository,
    executor,
    forged,
    events
  ));

  assert.deepEqual({
    staleError: error instanceof StaleFundingTaskError,
    pageRequests: source.pageRequestCalls.length,
    fetches: source.fetchCalls.length,
    executions: executor.calls.length,
    events: events.events.length,
    persistenceUnchanged: persistenceSnapshot(database) === before
  }, {
    staleError: true,
    pageRequests: 0,
    fetches: 0,
    executions: 0,
    events: 0,
    persistenceUnchanged: true
  });
});
