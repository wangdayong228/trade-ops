/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  settledFundingRate,
  type FundingMarketIdentity,
  type FundingMarketObservation,
  type SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import { SQLITE_FUNDING_RATE_SCHEMA } from '../../src/storage/funding-rate-schema.js';
import * as fundingRateRepositoryModule from '../../src/storage/funding-rate-repository.js';
import {
  fundingTaskFailure,
  MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES,
  type CoverageLease,
  type FundingCoverageKind,
  type FundingExhaustionEvidence,
  type FundingMarketState,
  type FundingPageWriteResult,
  type FundingRateRepository,
  type FundingTaskFailure,
  type FundingTaskFailureCode,
  type IncrementalLease
} from '../../src/storage/funding-rate-repository.js';
import { SqliteFundingRateRepository } from '../../src/storage/sqlite-funding-rate-repository.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';

const OKX_MARKET = {
  exchangeId: 'okx',
  exchangeMarketId: 'BTC-USDT-SWAP',
  symbol: 'BTC/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const BITGET_MARKET = {
  exchangeId: 'bitget',
  exchangeMarketId: 'BTCUSDT',
  symbol: 'BTC/USDT:USDT'
} as const satisfies FundingMarketIdentity;
const DISCOVERED_AT = new Date('2026-09-06T00:00:00.000Z');
const STARTED_AT = new Date('2026-09-06T00:01:00.000Z');
const FIRST_OBSERVED_AT = new Date('2026-09-06T00:02:00.000Z');
const SECOND_OBSERVED_AT = new Date('2026-09-06T00:03:00.000Z');
const THIRD_OBSERVED_AT = new Date('2026-09-06T00:04:00.000Z');
const COMPLETED_AT = new Date('2026-09-06T00:05:00.000Z');
const TRANSITIONED_AT = new Date('2026-09-06T00:06:00.000Z');
const REACTIVATED_AT = new Date('2026-09-06T00:07:00.000Z');
const RESTARTED_AT = new Date('2026-09-06T00:08:00.000Z');
const FINALIZED_AT = new Date('2026-09-06T00:09:00.000Z');
const LATER_AT = new Date('2026-09-06T00:10:00.000Z');
const FUNDING_TIMESTAMP_MS = 1_788_649_200_000;
const COVERAGE_CUTOFF_MS = FUNDING_TIMESTAMP_MS + 60_000;
const MAX_SQLITE_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_UNIX_TIMESTAMP_MS = 8_640_000_000_000_000;

const FAILURE_SUMMARIES = {
  COVERAGE_CANCELED_BY_MARKET_STATE:
    'coverage canceled after market state changed',
  REQUEST_RETRY_EXHAUSTED:
    'public funding request retries exhausted',
  SOURCE_RESPONSE_INVALID:
    'public funding response failed validation',
  CURSOR_NOT_ADVANCING:
    'funding history cursor did not advance',
  BITGET_BOUNDARY_NOT_SEEN:
    'saved Bitget boundary was not observed',
  BITGET_SCAN_NOT_CONVERGED:
    'Bitget scans did not converge',
  DATABASE_WRITE_FAILED:
    'funding page transaction failed'
} as const satisfies Readonly<Record<FundingTaskFailureCode, string>>;

interface FundingTestContext {
  readonly database: Database.Database;
  readonly repository: FundingRateRepository;
}

interface Task5FundingRateRepository extends FundingRateRepository {
  isCoverageLeaseCurrent(lease: CoverageLease): boolean;
  bitgetRoundsEqual(
    lease: CoverageLease,
    left: 1 | 2,
    right: 2 | 3
  ): boolean;
  completeCoverage(
    lease: CoverageLease,
    evidence: FundingExhaustionEvidence,
    completedAt: Date
  ): void;
  failCoverage(
    lease: CoverageLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void;
  startIncremental(
    market: FundingMarketIdentity,
    startedAt: Date
  ): IncrementalLease;
  restartInterruptedIncremental(
    market: FundingMarketIdentity,
    restartedAt: Date
  ): IncrementalLease;
  isIncrementalLeaseEligible(lease: IncrementalLease): boolean;
  commitIncrementalPage(
    lease: IncrementalLease,
    records: readonly SettledFundingRate[],
    observedAt: Date
  ): FundingPageWriteResult;
  completeIncremental(lease: IncrementalLease, completedAt: Date): void;
  failIncremental(
    lease: IncrementalLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void;
  cancelIncremental(lease: IncrementalLease, canceledAt: Date): void;
}

interface CoverageProvenanceState extends FundingMarketState {
  readonly coverageRequiredBitgetBoundaryMs: number | null;
  readonly coverageInitialOkxAfterMs: number | null;
}

interface IncrementalProvenanceState extends FundingMarketState {
  readonly incrementalFrozenBoundaryMs: number | null;
}

interface HistoryDbRow {
  readonly exchange_id: unknown;
  readonly exchange_market_id: unknown;
  readonly symbol: unknown;
  readonly funding_timestamp_ms: unknown;
  readonly funding_rate: unknown;
  readonly raw_json: unknown;
  readonly content_hash: unknown;
  readonly first_observed_at: unknown;
  readonly last_observed_at: unknown;
}

interface RevisionDbRow extends HistoryDbRow {
  readonly id: unknown;
  readonly replaced_at: unknown;
}

interface TableInfoRow {
  readonly name: string;
  readonly type: string;
  readonly pk: number;
}

type Exactly<Left, Right> =
  Left extends Right
    ? Right extends Left
      ? true
      : false
    : false;

function setupFundingRepository(
  t: TestContext,
  safeIntegers = false
): FundingTestContext {
  const database = new Database(':memory:');
  t.after(() => database.close());
  if (safeIntegers) database.defaultSafeIntegers(true);
  return {
    database,
    repository: new SqliteFundingRateRepository(database)
  };
}

function observation(
  market: FundingMarketIdentity,
  active = true
): FundingMarketObservation {
  return { ...market, active };
}

function task5Repository(
  repository: FundingRateRepository
): Task5FundingRateRepository {
  // This narrow bridge keeps runtime RED evidence available before Task 5 expands production types.
  return repository as Task5FundingRateRepository;
}

function onlyMarketState(
  repository: FundingRateRepository,
  market: FundingMarketIdentity
): FundingMarketState {
  const states = repository.listMarketStates(market.exchangeId);
  const state = states.find(({ exchangeMarketId }) => (
    exchangeMarketId === market.exchangeMarketId
  ));
  if (state === undefined) assert.fail('expected one funding market state');
  return state;
}

function provenanceState(
  repository: FundingRateRepository,
  market: FundingMarketIdentity
): CoverageProvenanceState {
  return onlyMarketState(repository, market) as CoverageProvenanceState;
}

function incrementalProvenanceState(
  repository: FundingRateRepository,
  market: FundingMarketIdentity
): IncrementalProvenanceState {
  return onlyMarketState(repository, market) as IncrementalProvenanceState;
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

function okxEvidence(
  lease: CoverageLease,
  finalRequestAfterMs = lease.okxResumeAfterMs
): FundingExhaustionEvidence {
  if (lease.exchangeId !== 'okx') assert.fail('expected an OKX lease');
  return {
    exchangeId: 'okx',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    explicitEmpty: true,
    finalRequestAfterMs
  };
}

function bitgetEvidence(
  lease: CoverageLease,
  matchingRounds: readonly [1, 2] | readonly [2, 3] = [1, 2]
): FundingExhaustionEvidence {
  if (lease.exchangeId !== 'bitget') assert.fail('expected a Bitget lease');
  return {
    exchangeId: 'bitget',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    matchingRounds,
    emptyPageNo: 2
  };
}

function completeEmptyOkxCoverage(
  repository: Task5FundingRateRepository,
  market: FundingMarketIdentity = OKX_MARKET,
  kind: FundingCoverageKind = 'INITIAL',
  cutoffMs = COVERAGE_CUTOFF_MS,
  completedAt = COMPLETED_AT
): CoverageLease {
  repository.applyCompleteDiscovery(
    market.exchangeId,
    [observation(market)],
    DISCOVERED_AT
  );
  const lease = repository.startCoverage(market, kind, cutoffMs, STARTED_AT);
  repository.completeCoverage(lease, okxEvidence(lease), completedAt);
  return lease;
}

function setupIncrementalProvenance(
  t: TestContext,
  boundaryMs: number | null = 70
): FundingTestContext & {
  readonly lifecycle: Task5FundingRateRepository;
  readonly lease: IncrementalLease;
} {
  const context = setupFundingRepository(t);
  const lifecycle = task5Repository(context.repository);
  if (boundaryMs === null) {
    completeEmptyOkxCoverage(lifecycle);
  } else {
    context.repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET)],
      DISCOVERED_AT
    );
    const coverage = context.repository.startCoverage(
      OKX_MARKET,
      'INITIAL',
      COVERAGE_CUTOFF_MS,
      STARTED_AT
    );
    commitOkxPage(
      context.repository,
      coverage,
      [rateRecord(OKX_MARKET, '0.0001', boundaryMs)],
      FIRST_OBSERVED_AT,
      boundaryMs
    );
    lifecycle.completeCoverage(
      coverage,
      okxEvidence(coverage, boundaryMs),
      COMPLETED_AT
    );
  }
  return {
    ...context,
    lifecycle,
    lease: lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT)
  };
}

function persistedIncrementalBoundary(
  database: Database.Database,
  market: FundingMarketIdentity
): unknown {
  return database.prepare(`
    SELECT incremental_frozen_boundary_ms
    FROM funding_rate_sync_state
    WHERE exchange_id = ? AND exchange_market_id = ?
  `).pluck().get(market.exchangeId, market.exchangeMarketId);
}

function fundingPersistenceSnapshot(database: Database.Database): string {
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
    bitgetScan: database.prepare(`
      SELECT * FROM temp.funding_rate_bitget_scan
      ORDER BY exchange_id, exchange_market_id,
        coverage_generation, scan_round, funding_timestamp_ms
    `).all()
  });
}

function invocationError(invoke: () => unknown): unknown {
  try {
    invoke();
    return null;
  } catch (error) {
    return error;
  }
}

function errorContains(error: unknown, fragments: readonly string[]): boolean {
  return error instanceof Error && fragments.every((fragment) => (
    error.message.toLowerCase().includes(fragment.toLowerCase())
  ));
}

function rewritePriorProofGeneration(
  database: Database.Database,
  repository: FundingRateRepository,
  generation: number
): void {
  const state = onlyMarketState(repository, OKX_MARKET);
  if (state.lastCaughtUpCutoffMs === null) {
    assert.fail('expected prior caught-up proof');
  }
  const evidence: FundingExhaustionEvidence = {
    exchangeId: 'okx',
    generation,
    cutoffMs: state.lastCaughtUpCutoffMs,
    explicitEmpty: true,
    finalRequestAfterMs: null
  };
  const update = database.prepare(`
    UPDATE funding_rate_sync_state
    SET last_caught_up_generation = @generation,
        last_exhaustion_evidence_json = @evidenceJson
    WHERE exchange_id = 'okx'
      AND exchange_market_id = 'BTC-USDT-SWAP'
  `).run({
    generation,
    evidenceJson: JSON.stringify(evidence)
  });
  assert.equal(update.changes, 1);
}

function setStateIgnoringChecks(
  database: Database.Database,
  market: FundingMarketIdentity,
  assignmentSql: string
): void {
  database.pragma('ignore_check_constraints = ON');
  try {
    const result = database.prepare(`
      UPDATE funding_rate_sync_state
      SET ${assignmentSql}
      WHERE exchange_id = ? AND exchange_market_id = ?
    `).run(market.exchangeId, market.exchangeMarketId);
    assert.equal(result.changes, 1);
  } finally {
    database.pragma('ignore_check_constraints = OFF');
  }
}

function assertCorruptStateFailsClosed(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  field: string
): void {
  assert.throws(
    () => repository.listMarketStates(market.exchangeId),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      if (!(error instanceof Error)) return false;
      assert.match(error.message, new RegExp(market.exchangeId, 'i'));
      assert.match(error.message, new RegExp(market.exchangeMarketId, 'i'));
      assert.match(error.message, new RegExp(field, 'i'));
      return true;
    }
  );
}

function rateRecord(
  market: FundingMarketIdentity,
  rate: string,
  timestampMs = FUNDING_TIMESTAMP_MS,
  revision = 'A'
): SettledFundingRate {
  return settledFundingRate(market, rate, timestampMs, {
    fundingRate: rate,
    fundingTime: String(timestampMs),
    revision
  });
}

function startCoverage(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  cutoffMs = COVERAGE_CUTOFF_MS
): CoverageLease {
  repository.applyCompleteDiscovery(
    market.exchangeId,
    [observation(market)],
    DISCOVERED_AT
  );
  return repository.startCoverage(
    market,
    'INITIAL',
    cutoffMs,
    STARTED_AT
  );
}

function setupForgedCoverageLease(
  t: TestContext,
  exchangeId: 'bitget' | 'okx'
): FundingTestContext & {
  readonly lifecycle: Task5FundingRateRepository;
  readonly actual: CoverageLease;
  readonly forged: CoverageLease;
} {
  const context = setupFundingRepository(t);
  const { repository } = context;
  const lifecycle = task5Repository(repository);
  if (exchangeId === 'bitget') {
    const boundaryMs = 70;
    const initial = startCoverage(repository, BITGET_MARKET, 100);
    const record = rateRecord(BITGET_MARKET, '0.0001', boundaryMs);
    for (const round of [1, 2] as const) {
      repository.commitCoveragePage(
        initial,
        [record],
        { exchangeId: 'bitget', round },
        FIRST_OBSERVED_AT
      );
    }
    lifecycle.completeCoverage(initial, bitgetEvidence(initial), COMPLETED_AT);
    const actual = repository.startCoverage(
      BITGET_MARKET,
      'PERIODIC',
      101,
      RESTARTED_AT
    );
    return {
      ...context,
      lifecycle,
      actual,
      forged: { ...actual, requiredBitgetBoundaryMs: null }
    };
  }

  const interrupted = startCoverage(repository, OKX_MARKET, 100);
  commitOkxPage(
    repository,
    interrupted,
    [rateRecord(OKX_MARKET, '0.0001', 78)],
    FIRST_OBSERVED_AT,
    78
  );
  const actual = resumeCoverage(repository, OKX_MARKET, RESTARTED_AT);
  if (actual.exchangeId !== 'okx') assert.fail('expected an OKX coverage lease');
  return {
    ...context,
    lifecycle,
    actual,
    forged: { ...actual, okxResumeAfterMs: 0 }
  };
}

function commitOkxPage(
  repository: FundingRateRepository,
  lease: CoverageLease,
  records: readonly SettledFundingRate[],
  observedAt: Date,
  recoveryAnchorMs = FUNDING_TIMESTAMP_MS
) {
  return repository.commitCoveragePage(
    lease,
    records,
    { exchangeId: 'okx', recoveryAnchorMs },
    observedAt
  );
}

function persistentTableNames(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ readonly name: string }>).map(({ name }) => name);
}

function fundingSchemaObjects(database: Database.Database): unknown[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name LIKE 'funding_rate_%'
    ORDER BY type, name
  `).all();
}

function schemaCatalog(
  database: Database.Database,
  scope: 'main' | 'temp'
): unknown[] {
  const catalog = scope === 'main' ? 'sqlite_master' : 'sqlite_temp_master';
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM ${catalog}
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

function strategyFingerprint(database: Database.Database): string {
  return JSON.stringify({
    schema: database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE tbl_name IN ('strategies', 'strategy_orders', 'order_events')
      ORDER BY type, name
    `).all(),
    strategies: database.prepare('SELECT * FROM strategies ORDER BY id').all(),
    orders: database.prepare('SELECT * FROM strategy_orders ORDER BY id').all(),
    events: database.prepare('SELECT * FROM order_events ORDER BY id').all()
  });
}

function seedStrategyTables(database: Database.Database): void {
  database.prepare(`
    INSERT INTO strategies (
      id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
      requested_base_quantity, effective_base_quantity, preflight_json,
      failure_code, created_at, updated_at
    ) VALUES (
      'strategy-seed', 'PENDING_CONFIRMATION', 'CONCURRENT',
      'bitget', 'okx', 'BTC/USDT', '1.00000000000000000001',
      '1.00000000000000000000', '{}', NULL,
      '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
    )
  `).run();
  database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      submission_disposition, submission_failure_code,
      created_at, updated_at
    ) VALUES (
      'order-seed', 'strategy-seed', 'SPOT_MARKET', 'bitget',
      'seed-client-order', NULL, '{}', NULL, 'planned',
      'SUBMISSION_UNCERTAIN', NULL,
      '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
    )
  `).run();
  database.prepare(`
    INSERT INTO order_events (strategy_order_id, snapshot_json, recorded_at)
    VALUES ('order-seed', '{}', '2026-09-06T00:00:00.000Z')
  `).run();
}

function tableInfo(
  database: Database.Database,
  table: string
): TableInfoRow[] {
  return database.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function assertColumnContract(
  database: Database.Database,
  table: string,
  expected: readonly (readonly [string, string, number])[]
): void {
  assert.deepEqual(
    tableInfo(database, table).map(({ name, type, pk }) => [name, type, pk]),
    expected
  );
}

function historyRow(
  database: Database.Database,
  market: FundingMarketIdentity,
  timestampMs = FUNDING_TIMESTAMP_MS
): HistoryDbRow {
  const row = database.prepare(`
    SELECT *
    FROM funding_rate_history
    WHERE exchange_id = ?
      AND exchange_market_id = ?
      AND funding_timestamp_ms = ?
  `).get(market.exchangeId, market.exchangeMarketId, timestampMs);
  if (row === undefined) assert.fail('expected one funding history row');
  return row as HistoryDbRow;
}

function revisionRows(database: Database.Database): RevisionDbRow[] {
  return database.prepare(`
    SELECT * FROM funding_rate_revisions ORDER BY id
  `).all() as RevisionDbRow[];
}

function setIgnoringChecks(
  database: Database.Database,
  sql: string,
  value: string | number
): void {
  database.pragma('ignore_check_constraints = ON');
  try {
    const result = database.prepare(sql).run(value);
    assert.equal(result.changes, 1);
  } finally {
    database.pragma('ignore_check_constraints = OFF');
  }
}

function assertCorruptHistoryFailsClosed(
  repository: FundingRateRepository,
  market: FundingMarketIdentity,
  field: string,
  sensitiveCell: string
): void {
  assert.throws(
    () => repository.listHistory(market),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      if (!(error instanceof Error)) return false;
      assert.match(error.message, new RegExp(market.exchangeId, 'i'));
      assert.match(error.message, new RegExp(market.exchangeMarketId, 'i'));
      assert.match(error.message, new RegExp(field, 'i'));
      assert.equal(error.message.includes(sensitiveCell), false);
      return true;
    }
  );
}

test('adds only three funding tables without changing strategy schema, data, or journal mode', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  new SqliteStrategyRepository(database);
  seedStrategyTables(database);
  const beforeTables = persistentTableNames(database);
  const beforeFingerprint = strategyFingerprint(database);
  const journalMode = database.pragma('journal_mode', { simple: true });

  new SqliteFundingRateRepository(database);
  new SqliteFundingRateRepository(database);

  const addedTables = persistentTableNames(database)
    .filter((name) => !beforeTables.includes(name));
  assert.deepEqual(addedTables, [
    'funding_rate_history',
    'funding_rate_revisions',
    'funding_rate_sync_state'
  ]);
  assert.equal(strategyFingerprint(database), beforeFingerprint);
  assert.equal(
    database.pragma('journal_mode', { simple: true }),
    journalMode
  );
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(database.prepare(`
    SELECT name
    FROM sqlite_temp_master
    WHERE type = 'table'
    ORDER BY name
  `).all(), [{ name: 'funding_rate_bitget_scan' }]);
});

test('rejects construction inside an external transaction before creating any schema', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const journalMode = database.pragma('journal_mode', { simple: true });
  database.exec('BEGIN');
  try {
    assert.throws(
      () => new SqliteFundingRateRepository(database),
      /SQLite funding rate schema initialization failed/
    );
    assert.equal(database.inTransaction, true);
    assert.deepEqual(persistentTableNames(database), []);
    assert.deepEqual(database.prepare(`
      SELECT name FROM sqlite_temp_master WHERE type = 'table'
    `).all(), []);
    assert.equal(
      database.pragma('journal_mode', { simple: true }),
      journalMode
    );
  } finally {
    database.exec('ROLLBACK');
  }
});

test('rejects a column-compatible funding history table without required constraints', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE funding_rate_history (
      exchange_id TEXT,
      exchange_market_id TEXT,
      symbol TEXT,
      funding_timestamp_ms INTEGER,
      funding_rate TEXT,
      raw_json TEXT,
      content_hash TEXT,
      first_observed_at TEXT,
      last_observed_at TEXT,
      PRIMARY KEY (
        exchange_id,
        exchange_market_id,
        funding_timestamp_ms
      )
    );
  `);
  assertColumnContract(database, 'funding_rate_history', [
    ['exchange_id', 'TEXT', 1],
    ['exchange_market_id', 'TEXT', 2],
    ['symbol', 'TEXT', 0],
    ['funding_timestamp_ms', 'INTEGER', 3],
    ['funding_rate', 'TEXT', 0],
    ['raw_json', 'TEXT', 0],
    ['content_hash', 'TEXT', 0],
    ['first_observed_at', 'TEXT', 0],
    ['last_observed_at', 'TEXT', 0]
  ]);
  const before = fundingSchemaObjects(database);
  const weakTableSql = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'funding_rate_history'
  `).pluck().get();
  assert.equal(typeof weakTableSql, 'string');
  assert.doesNotMatch(String(weakTableSql), /\bNOT NULL\b|\bCHECK\b/i);

  assert.throws(
    () => new SqliteFundingRateRepository(database),
    /SQLite funding rate schema initialization failed/
  );

  assert.deepEqual(fundingSchemaObjects(database), before);
  assert.deepEqual(database.prepare(`
    SELECT type, name
    FROM sqlite_temp_master
    WHERE name LIKE 'funding_rate_%'
    ORDER BY type, name
  `).all(), []);
});

test('rejects immutable trigger names whose bodies do not abort mutations', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(SQLITE_FUNDING_RATE_SCHEMA);
  database.exec(`
    DROP TRIGGER funding_rate_revisions_no_update;
    DROP TRIGGER funding_rate_revisions_no_delete;

    CREATE TRIGGER funding_rate_revisions_no_update
    BEFORE UPDATE ON funding_rate_revisions
    BEGIN
      SELECT 'funding rate revisions are immutable';
    END;

    CREATE TRIGGER funding_rate_revisions_no_delete
    BEFORE DELETE ON funding_rate_revisions
    BEGIN
      SELECT 'funding rate revisions are immutable';
    END;
  `);
  const fakeTriggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'funding_rate_revisions'
    ORDER BY name
  `).all() as Array<{ readonly name: string; readonly sql: string }>;
  assert.deepEqual(fakeTriggers.map(({ name }) => name), [
    'funding_rate_revisions_no_delete',
    'funding_rate_revisions_no_update'
  ]);
  for (const { sql } of fakeTriggers) {
    assert.match(sql, /funding rate revisions are immutable/);
    assert.doesNotMatch(sql, /RAISE\s*\(/i);
  }
  const before = fundingSchemaObjects(database);

  assert.throws(
    () => new SqliteFundingRateRepository(database),
    /SQLite funding rate schema initialization failed/
  );

  assert.deepEqual(fundingSchemaObjects(database), before);
  assert.deepEqual(database.prepare(`
    SELECT type, name
    FROM sqlite_temp_master
    WHERE name LIKE 'funding_rate_%'
    ORDER BY type, name
  `).all(), []);
});

test('rejects an unexpected destructive trigger on a main funding table', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(SQLITE_FUNDING_RATE_SCHEMA);
  database.exec(`
    CREATE TRIGGER purge_inserted_history
    AFTER INSERT ON funding_rate_history
    BEGIN
      DELETE FROM funding_rate_history
      WHERE exchange_id = NEW.exchange_id
        AND exchange_market_id = NEW.exchange_market_id
        AND funding_timestamp_ms = NEW.funding_timestamp_ms;
    END;
  `);
  const unexpectedTrigger = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name = 'purge_inserted_history'
  `).get() as {
    readonly type: unknown;
    readonly name: unknown;
    readonly tbl_name: unknown;
    readonly sql: unknown;
  } | undefined;
  assert.notEqual(unexpectedTrigger, undefined);
  assert.equal(unexpectedTrigger?.type, 'trigger');
  assert.equal(unexpectedTrigger?.name, 'purge_inserted_history');
  assert.equal(unexpectedTrigger?.tbl_name, 'funding_rate_history');
  assert.match(String(unexpectedTrigger?.sql), /DELETE FROM funding_rate_history/i);
  const mainBefore = schemaCatalog(database, 'main');
  const tempBefore = schemaCatalog(database, 'temp');

  assert.throws(
    () => new SqliteFundingRateRepository(database),
    /SQLite funding rate schema initialization failed/
  );

  assert.deepEqual(schemaCatalog(database, 'main'), mainBefore);
  assert.deepEqual(schemaCatalog(database, 'temp'), tempBefore);
});

test('rejects an unexpected destructive TEMP trigger without leaving scan schema', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(SQLITE_FUNDING_RATE_SCHEMA);
  database.exec(`
    CREATE TEMP TRIGGER purge_inserted_history_temp
    AFTER INSERT ON main.funding_rate_history
    BEGIN
      DELETE FROM funding_rate_history
      WHERE exchange_id = NEW.exchange_id
        AND exchange_market_id = NEW.exchange_market_id
        AND funding_timestamp_ms = NEW.funding_timestamp_ms;
    END;
  `);
  const unexpectedTrigger = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_temp_master
    WHERE name = 'purge_inserted_history_temp'
  `).get() as {
    readonly type: unknown;
    readonly name: unknown;
    readonly tbl_name: unknown;
    readonly sql: unknown;
  } | undefined;
  assert.notEqual(unexpectedTrigger, undefined);
  assert.equal(unexpectedTrigger?.type, 'trigger');
  assert.equal(unexpectedTrigger?.name, 'purge_inserted_history_temp');
  assert.equal(unexpectedTrigger?.tbl_name, 'funding_rate_history');
  assert.match(String(unexpectedTrigger?.sql), /DELETE FROM funding_rate_history/i);
  const mainBefore = schemaCatalog(database, 'main');
  const tempBefore = schemaCatalog(database, 'temp');

  assert.throws(
    () => new SqliteFundingRateRepository(database),
    /SQLite funding rate schema initialization failed/
  );

  assert.deepEqual(schemaCatalog(database, 'main'), mainBefore);
  assert.deepEqual(schemaCatalog(database, 'temp'), tempBefore);
});

test('installs the locked columns, keys, immutable triggers, and basic constraints', (t) => {
  const { database, repository } = setupFundingRepository(t);
  assert.match(
    SQLITE_FUNDING_RATE_SCHEMA,
    /CREATE TABLE(?: IF NOT EXISTS)? funding_rate_history/i
  );
  assert.match(
    SQLITE_FUNDING_RATE_SCHEMA,
    /CREATE TABLE(?: IF NOT EXISTS)? funding_rate_revisions/i
  );
  assert.match(
    SQLITE_FUNDING_RATE_SCHEMA,
    /CREATE TABLE(?: IF NOT EXISTS)? funding_rate_sync_state/i
  );
  assertColumnContract(database, 'funding_rate_history', [
    ['exchange_id', 'TEXT', 1],
    ['exchange_market_id', 'TEXT', 2],
    ['symbol', 'TEXT', 0],
    ['funding_timestamp_ms', 'INTEGER', 3],
    ['funding_rate', 'TEXT', 0],
    ['raw_json', 'TEXT', 0],
    ['content_hash', 'TEXT', 0],
    ['first_observed_at', 'TEXT', 0],
    ['last_observed_at', 'TEXT', 0]
  ]);
  assertColumnContract(database, 'funding_rate_revisions', [
    ['id', 'INTEGER', 1],
    ['exchange_id', 'TEXT', 0],
    ['exchange_market_id', 'TEXT', 0],
    ['symbol', 'TEXT', 0],
    ['funding_timestamp_ms', 'INTEGER', 0],
    ['funding_rate', 'TEXT', 0],
    ['raw_json', 'TEXT', 0],
    ['content_hash', 'TEXT', 0],
    ['first_observed_at', 'TEXT', 0],
    ['last_observed_at', 'TEXT', 0],
    ['replaced_at', 'TEXT', 0]
  ]);
  assertColumnContract(database, 'funding_rate_sync_state', [
    ['exchange_id', 'TEXT', 1],
    ['exchange_market_id', 'TEXT', 2],
    ['symbol', 'TEXT', 0],
    ['active', 'INTEGER', 0],
    ['active_observed_at', 'TEXT', 0],
    ['active_changed_at', 'TEXT', 0],
    ['reactivation_required', 'INTEGER', 0],
    ['reactivation_after_generation', 'INTEGER', 0],
    ['inactive_final_caught_up_at', 'TEXT', 0],
    ['coverage_status', 'TEXT', 0],
    ['coverage_generation', 'INTEGER', 0],
    ['coverage_task_kind', 'TEXT', 0],
    ['coverage_cutoff_ms', 'INTEGER', 0],
    ['coverage_required_bitget_boundary_ms', 'INTEGER', 0],
    ['coverage_initial_okx_after_ms', 'INTEGER', 0],
    ['last_caught_up_generation', 'INTEGER', 0],
    ['last_caught_up_cutoff_ms', 'INTEGER', 0],
    ['last_exhausted_at', 'TEXT', 0],
    ['last_exhaustion_evidence_json', 'TEXT', 0],
    ['okx_resume_after_ms', 'INTEGER', 0],
    ['okx_resume_generation', 'INTEGER', 0],
    ['oldest_funding_timestamp_ms', 'INTEGER', 0],
    ['latest_funding_timestamp_ms', 'INTEGER', 0],
    ['coverage_started_at', 'TEXT', 0],
    ['coverage_ended_at', 'TEXT', 0],
    ['coverage_last_success_at', 'TEXT', 0],
    ['coverage_error_code', 'TEXT', 0],
    ['coverage_error_summary', 'TEXT', 0],
    ['incremental_status', 'TEXT', 0],
    ['incremental_generation', 'INTEGER', 0],
    ['incremental_frozen_boundary_ms', 'INTEGER', 0],
    ['incremental_started_at', 'TEXT', 0],
    ['incremental_ended_at', 'TEXT', 0],
    ['incremental_last_success_at', 'TEXT', 0],
    ['incremental_error_code', 'TEXT', 0],
    ['incremental_error_summary', 'TEXT', 0],
    ['created_at', 'TEXT', 0],
    ['updated_at', 'TEXT', 0]
  ]);

  const triggers = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'funding_rate_revisions'
    ORDER BY name
  `).pluck().all();
  assert.equal(triggers.length, 2);
  for (const sql of triggers) {
    assert.equal(typeof sql, 'string');
    assert.match(String(sql), /funding rate revisions are immutable/);
  }

  repository.applyCompleteDiscovery('okx', [observation(OKX_MARKET)], DISCOVERED_AT);
  const initialState = repository.listMarketStates('okx')[0];
  assert.equal(initialState?.coverageStatus, 'PENDING');
  assert.equal(initialState?.coverageCutoffMs, null);
  assert.equal(initialState?.lastCaughtUpGeneration, null);
  assert.equal(initialState?.lastCaughtUpCutoffMs, null);
  assert.equal(initialState?.lastExhaustionEvidenceJson, null);
  assert.equal(initialState?.oldestFundingTimestampMs, null);
  assert.equal(initialState?.latestFundingTimestampMs, null);
  assert.equal(
    (initialState as IncrementalProvenanceState | undefined)
      ?.incrementalFrozenBoundaryMs,
    null
  );
  assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), null);
  assert.throws(() => database.prepare(`
    UPDATE funding_rate_sync_state SET active = 2
  `).run(), /constraint/i);
  assert.throws(() => database.prepare(`
    UPDATE funding_rate_sync_state SET coverage_status = 'COMPLETE'
  `).run(), /constraint/i);
  assert.throws(() => database.prepare(`
    UPDATE funding_rate_sync_state
    SET oldest_funding_timestamp_ms = 2, latest_funding_timestamp_ms = 1
  `).run(), /constraint/i);
  assert.throws(() => database.prepare(`
    UPDATE funding_rate_sync_state
    SET coverage_generation = ${MAX_SQLITE_SAFE_INTEGER + 1}
  `).run(), /constraint/i);
  for (const invalidBoundary of [
    "'70'",
    '-1',
    String(MAX_UNIX_TIMESTAMP_MS + 1)
  ]) {
    assert.throws(() => database.prepare(`
      UPDATE funding_rate_sync_state
      SET incremental_frozen_boundary_ms = ${invalidBoundary}
    `).run(), /constraint/i);
  }
  assert.throws(() => database.prepare(`
    UPDATE funding_rate_sync_state
    SET incremental_frozen_boundary_ms = 0
  `).run(), /constraint/i);

  const lease = repository.startCoverage(
    OKX_MARKET,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001')],
    FIRST_OBSERVED_AT
  );
  const invalidHistoryUpdates = [
    "funding_rate = 'not-a-decimal'",
    'funding_timestamp_ms = -1',
    "raw_json = '{broken-json'",
    "content_hash = 'not-a-sha256'",
    `first_observed_at = '${SECOND_OBSERVED_AT.toISOString()}',
      last_observed_at = '${FIRST_OBSERVED_AT.toISOString()}'`
  ];
  for (const update of invalidHistoryUpdates) {
    assert.throws(
      () => database.prepare(`
        UPDATE funding_rate_history SET ${update}
      `).run(),
      /constraint/i
    );
  }
});

test('rejects a stale coverage lease without writing history or state', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const before = repository.listMarketStates('okx');
  const staleLease = { ...lease, generation: lease.generation - 1 };

  assert.throws(
    () => commitOkxPage(
      repository,
      staleLease,
      [rateRecord(OKX_MARKET, '0.0001')],
      FIRST_OBSERVED_AT
    ),
    /stale funding task/i
  );

  assert.equal(
    database.prepare('SELECT COUNT(*) FROM funding_rate_history').pluck().get(),
    0
  );
  assert.deepEqual(repository.listMarketStates('okx'), before);
});

test('preserves exact rate text, natural-key isolation, and descending market reads', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const otherBitgetMarket = {
    exchangeId: 'bitget',
    exchangeMarketId: 'ETHUSDT',
    symbol: 'ETH/USDT:USDT'
  } as const satisfies FundingMarketIdentity;
  const overlappingOkxRawId = {
    exchangeId: 'okx',
    exchangeMarketId: 'BTCUSDT',
    symbol: 'BTC/USDT:USDT'
  } as const satisfies FundingMarketIdentity;
  repository.applyCompleteDiscovery(
    'bitget',
    [observation(BITGET_MARKET), observation(otherBitgetMarket)],
    DISCOVERED_AT
  );
  repository.applyCompleteDiscovery(
    'okx',
    [observation(overlappingOkxRawId)],
    DISCOVERED_AT
  );
  const bitgetLease = repository.startCoverage(
    BITGET_MARKET,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  const otherBitgetLease = repository.startCoverage(
    otherBitgetMarket,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  const okxLease = repository.startCoverage(
    overlappingOkxRawId,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  const exactExponentRate =
    '-0.0000000000000000000000000000000000000000123456789e-120';
  const newerTimestamp = FUNDING_TIMESTAMP_MS + 1;
  repository.commitCoveragePage(
    bitgetLease,
    [
      rateRecord(BITGET_MARKET, '+0.0E+0', newerTimestamp),
      rateRecord(BITGET_MARKET, exactExponentRate)
    ],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  repository.commitCoveragePage(
    otherBitgetLease,
    [rateRecord(otherBitgetMarket, '0')],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  commitOkxPage(
    repository,
    okxLease,
    [rateRecord(overlappingOkxRawId, '0.0003')],
    FIRST_OBSERVED_AT
  );

  assert.deepEqual(
    repository.listHistory(BITGET_MARKET).map((record: SettledFundingRate) => ({
      timestamp: record.fundingTimestampMs,
      rate: record.fundingRate
    })),
    [
      { timestamp: newerTimestamp, rate: '+0.0E+0' },
      { timestamp: FUNDING_TIMESTAMP_MS, rate: exactExponentRate }
    ]
  );
  assert.equal(repository.listHistory(otherBitgetMarket)[0]?.fundingRate, '0');
  assert.equal(repository.listHistory(overlappingOkxRawId)[0]?.fundingRate, '0.0003');
  assert.equal(
    database.prepare(`
      SELECT typeof(funding_rate)
      FROM funding_rate_history
      WHERE exchange_id = 'bitget'
        AND exchange_market_id = 'BTCUSDT'
        AND funding_timestamp_ms = ?
    `).pluck().get(FUNDING_TIMESTAMP_MS),
    'text'
  );
});

test('re-observes identical content by changing only last_observed_at', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const record = rateRecord(OKX_MARKET, '0.000123456789012345678901234567890123456789');

  assert.deepEqual(
    commitOkxPage(repository, lease, [record], FIRST_OBSERVED_AT),
    { inserted: 1, unchanged: 0, revised: 0, revisedKeys: [] }
  );
  assert.deepEqual(
    commitOkxPage(repository, lease, [record], SECOND_OBSERVED_AT),
    { inserted: 0, unchanged: 1, revised: 0, revisedKeys: [] }
  );

  const row = historyRow(database, OKX_MARKET);
  assert.equal(row.first_observed_at, FIRST_OBSERVED_AT.toISOString());
  assert.equal(row.last_observed_at, SECOND_OBSERVED_AT.toISOString());
  assert.equal(revisionRows(database).length, 0);
});

test('archives every complete old version for an A to B to A revision sequence', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const recordA = rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A');
  const recordB = rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B');
  commitOkxPage(repository, lease, [recordA], FIRST_OBSERVED_AT);

  assert.deepEqual(
    commitOkxPage(repository, lease, [recordB], SECOND_OBSERVED_AT),
    {
      inserted: 0,
      unchanged: 0,
      revised: 1,
      revisedKeys: [{
        fundingTimestampMs: FUNDING_TIMESTAMP_MS,
        previousContentHash: recordA.contentHash,
        currentContentHash: recordB.contentHash
      }]
    }
  );
  assert.deepEqual(
    commitOkxPage(repository, lease, [recordA], THIRD_OBSERVED_AT),
    {
      inserted: 0,
      unchanged: 0,
      revised: 1,
      revisedKeys: [{
        fundingTimestampMs: FUNDING_TIMESTAMP_MS,
        previousContentHash: recordB.contentHash,
        currentContentHash: recordA.contentHash
      }]
    }
  );

  const revisions = revisionRows(database);
  assert.deepEqual(revisions.map((row) => ({
    exchangeId: row.exchange_id,
    marketId: row.exchange_market_id,
    symbol: row.symbol,
    timestamp: row.funding_timestamp_ms,
    rate: row.funding_rate,
    rawJson: row.raw_json,
    hash: row.content_hash,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    replacedAt: row.replaced_at
  })), [
    {
      exchangeId: recordA.exchangeId,
      marketId: recordA.exchangeMarketId,
      symbol: recordA.symbol,
      timestamp: recordA.fundingTimestampMs,
      rate: recordA.fundingRate,
      rawJson: recordA.rawJson,
      hash: recordA.contentHash,
      firstObservedAt: FIRST_OBSERVED_AT.toISOString(),
      lastObservedAt: FIRST_OBSERVED_AT.toISOString(),
      replacedAt: SECOND_OBSERVED_AT.toISOString()
    },
    {
      exchangeId: recordB.exchangeId,
      marketId: recordB.exchangeMarketId,
      symbol: recordB.symbol,
      timestamp: recordB.fundingTimestampMs,
      rate: recordB.fundingRate,
      rawJson: recordB.rawJson,
      hash: recordB.contentHash,
      firstObservedAt: SECOND_OBSERVED_AT.toISOString(),
      lastObservedAt: SECOND_OBSERVED_AT.toISOString(),
      replacedAt: THIRD_OBSERVED_AT.toISOString()
    }
  ]);
  const current = historyRow(database, OKX_MARKET);
  assert.equal(current.funding_rate, recordA.fundingRate);
  assert.equal(current.raw_json, recordA.rawJson);
  assert.equal(current.content_hash, recordA.contentHash);
  assert.equal(current.first_observed_at, THIRD_OBSERVED_AT.toISOString());
  assert.equal(current.last_observed_at, THIRD_OBSERVED_AT.toISOString());
});

test('rejects a semantic content hash mismatch before a coverage revision', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const recordA = rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A');
  const computedB = rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B');
  const syntheticCollision = {
    ...computedB,
    contentHash: recordA.contentHash
  };
  commitOkxPage(repository, lease, [recordA], FIRST_OBSERVED_AT);
  const before = fundingPersistenceSnapshot(database);

  const error = invocationError(() => commitOkxPage(
    repository,
    lease,
    [syntheticCollision],
    SECOND_OBSERVED_AT
  ));

  assert.deepEqual({
    rejectedForHash: errorContains(error, ['content', 'hash']),
    persistenceUnchanged: fundingPersistenceSnapshot(database) === before
  }, {
    rejectedForHash: true,
    persistenceUnchanged: true
  });
});

test('rejects both update and delete of an archived revision', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A')],
    FIRST_OBSERVED_AT
  );
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B')],
    SECOND_OBSERVED_AT
  );

  assert.throws(
    () => database.prepare(`
      UPDATE funding_rate_revisions SET funding_rate = '0' WHERE id = 1
    `).run(),
    /funding rate revisions are immutable/
  );
  assert.throws(
    () => database.prepare(`
      DELETE FROM funding_rate_revisions WHERE id = 1
    `).run(),
    /funding rate revisions are immutable/
  );
  assert.equal(revisionRows(database).length, 1);
});

test('rolls back a whole OKX page including revision, row, bounds, and checkpoint', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const recordA = rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A');
  commitOkxPage(repository, lease, [recordA], FIRST_OBSERVED_AT);
  const beforeState = repository.listMarketStates('okx');
  const secondTimestamp = FUNDING_TIMESTAMP_MS - 1;
  database.exec(`
    CREATE TRIGGER test_abort_second_funding_record
    BEFORE INSERT ON funding_rate_history
    WHEN NEW.funding_timestamp_ms = ${secondTimestamp}
    BEGIN
      SELECT RAISE(ABORT, 'test page second record failed');
    END;
  `);

  assert.throws(
    () => commitOkxPage(
      repository,
      lease,
      [
        rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B'),
        rateRecord(OKX_MARKET, '-0.0003', secondTimestamp, 'new')
      ],
      SECOND_OBSERVED_AT,
      FUNDING_TIMESTAMP_MS + 10
    ),
    /test page second record failed|funding page transaction failed/i
  );

  assert.deepEqual(repository.listMarketStates('okx'), beforeState);
  assert.equal(revisionRows(database).length, 0);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) FROM funding_rate_history
      WHERE funding_timestamp_ms = ?
    `).pluck().get(secondTimestamp),
    0
  );
  const current = historyRow(database, OKX_MARKET);
  assert.equal(current.funding_rate, recordA.fundingRate);
  assert.equal(current.raw_json, recordA.rawJson);
  assert.equal(current.content_hash, recordA.contentHash);
  assert.equal(current.last_observed_at, FIRST_OBSERVED_AT.toISOString());
});

test('converts validated SQLite safe integers back to domain numbers at both boundaries', (t) => {
  const { database, repository } = setupFundingRepository(t, true);
  const lease = startCoverage(
    repository,
    OKX_MARKET,
    MAX_UNIX_TIMESTAMP_MS
  );
  const records = [
    rateRecord(OKX_MARKET, '-1e-999', MAX_UNIX_TIMESTAMP_MS, 'maximum'),
    rateRecord(OKX_MARKET, '0', 0, 'zero')
  ];

  commitOkxPage(
    repository,
    lease,
    records,
    FIRST_OBSERVED_AT,
    MAX_UNIX_TIMESTAMP_MS
  );

  assert.equal(database.pragma('foreign_keys', { simple: true }), 1n);
  assert.deepEqual(
    repository.listHistory(OKX_MARKET).map((record: SettledFundingRate) => (
      record.fundingTimestampMs
    )),
    [MAX_UNIX_TIMESTAMP_MS, 0]
  );
  const state = repository.listMarketStates('okx')[0];
  assert.equal(state?.coverageGeneration, 1);
  assert.equal(state?.oldestFundingTimestampMs, 0);
  assert.equal(state?.latestFundingTimestampMs, MAX_UNIX_TIMESTAMP_MS);
});

const corruptHistoryCases = [
  {
    name: 'funding rate',
    column: 'funding_rate',
    value: 'apiKey=synthetic-secret-rate',
    field: 'funding_rate'
  },
  {
    name: 'funding timestamp',
    column: 'funding_timestamp_ms',
    value: -1,
    field: 'funding_timestamp_ms'
  },
  {
    name: 'raw JSON',
    column: 'raw_json',
    value: '{"secret":"synthetic-sensitive-json"',
    field: 'raw_json'
  },
  {
    name: 'content hash',
    column: 'content_hash',
    value: 'synthetic-sensitive-hash',
    field: 'content_hash'
  }
] as const;

for (const corruptCase of corruptHistoryCases) {
  test(`fails closed without echoing a corrupt ${corruptCase.name} cell`, (t) => {
    const { database, repository } = setupFundingRepository(t);
    const lease = startCoverage(repository, OKX_MARKET);
    commitOkxPage(
      repository,
      lease,
      [rateRecord(OKX_MARKET, '0.0001')],
      FIRST_OBSERVED_AT
    );
    setIgnoringChecks(
      database,
      `UPDATE funding_rate_history SET ${corruptCase.column} = ?`,
      corruptCase.value
    );

    assertCorruptHistoryFailsClosed(
      repository,
      OKX_MARKET,
      corruptCase.field,
      String(corruptCase.value)
    );
  });
}

test('attributes parseable non-canonical raw JSON corruption to raw_json', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001')],
    FIRST_OBSERVED_AT
  );
  const corruptRawJson = '{"value":1e999}';
  setIgnoringChecks(
    database,
    'UPDATE funding_rate_history SET raw_json = ?',
    corruptRawJson
  );

  assertCorruptHistoryFailsClosed(
    repository,
    OKX_MARKET,
    'raw_json',
    corruptRawJson
  );
});

test('maps the closed failure-code set to exact static ASCII summaries', () => {
  const acceptsExactlyOneCode:
    Exactly<Parameters<typeof fundingTaskFailure>, [FundingTaskFailureCode]> = true;
  assert.equal(acceptsExactlyOneCode, true);
  assert.equal(fundingTaskFailure.length, 1);
  assert.equal(MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES, 512);

  for (const [code, summary] of Object.entries(FAILURE_SUMMARIES) as Array<
    [FundingTaskFailureCode, string]
  >) {
    const failure = fundingTaskFailure(code);
    assert.deepEqual(failure, { code, summary });
    assert.match(failure.summary, /^[\x20-\x7e]+$/);
    assert.ok(Buffer.byteLength(failure.summary, 'utf8') <= 512);
  }
});

test('rejects prototype-chain failure codes at runtime with a fixed safe error', () => {
  const runtimeFundingTaskFailure = fundingTaskFailure as unknown as (
    code: unknown
  ) => FundingTaskFailure;
  const prototypeKeys = ['__proto__', 'constructor', 'toString'] as const;

  for (const key of prototypeKeys) {
    assert.throws(
      () => runtimeFundingTaskFailure(key),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        if (!(error instanceof Error)) return false;
        assert.equal(error.message, 'unsupported funding task failure code');
        assert.equal(error.message.includes(key), false);
        return true;
      }
    );
  }
});

test('rejects non-string failure codes without executing coercion', () => {
  const runtimeFundingTaskFailure = fundingTaskFailure as unknown as (
    code: unknown
  ) => FundingTaskFailure;
  let coercibleCalls = 0;
  let throwingCalls = 0;
  const coercible = {
    secret: 'synthetic-sensitive-coercible',
    [Symbol.toPrimitive](): string {
      coercibleCalls += 1;
      return 'DATABASE_WRITE_FAILED';
    }
  };
  const throwing = {
    [Symbol.toPrimitive](): never {
      throwingCalls += 1;
      throw new Error('synthetic-sensitive-coercion-error');
    }
  };
  const invoke = (value: unknown): unknown => {
    try {
      return runtimeFundingTaskFailure(value);
    } catch (error) {
      return error;
    }
  };
  const outcomes = [invoke(coercible), invoke(throwing)];

  assert.deepEqual({
    coercionCalls: [coercibleCalls, throwingCalls],
    fixedSafeErrors: outcomes.map((outcome) => (
      outcome instanceof Error
      && outcome.message === 'unsupported funding task failure code'
    ))
  }, {
    coercionCalls: [0, 0],
    fixedSafeErrors: [true, true]
  });
  for (const outcome of outcomes) {
    assert.equal(outcome instanceof Error, true);
    if (!(outcome instanceof Error)) continue;
    assert.equal(outcome.message, 'unsupported funding task failure code');
    assert.equal(outcome.message.includes('synthetic-sensitive'), false);
  }
});

test('rejects unsafe persisted failure summaries and accepts only normalized text', (t) => {
  const { database, repository } = setupFundingRepository(t);
  startCoverage(repository, BITGET_MARKET);
  const updateFailure = database.prepare(`
    UPDATE funding_rate_sync_state
    SET coverage_status = 'INCOMPLETE',
        coverage_ended_at = @endedAt,
        coverage_error_code = @code,
        coverage_error_summary = @summary,
        updated_at = @endedAt
    WHERE exchange_id = 'bitget' AND exchange_market_id = 'BTCUSDT'
  `);
  const unsafeSummaries = [
    'arbitrary upstream failure text',
    'apiKey=synthetic-key secret=synthetic-secret',
    'funding page transaction failed\0credential',
    'funding page transaction failed\ncredential',
    '界'.repeat(171)
  ];

  for (const summary of unsafeSummaries) {
    assert.throws(
      () => updateFailure.run({
        endedAt: SECOND_OBSERVED_AT.toISOString(),
        code: 'DATABASE_WRITE_FAILED',
        summary
      }),
      /constraint/i
    );
  }

  const normalized: FundingTaskFailure = fundingTaskFailure(
    'DATABASE_WRITE_FAILED'
  );
  assert.equal(
    updateFailure.run({
      endedAt: SECOND_OBSERVED_AT.toISOString(),
      code: normalized.code,
      summary: normalized.summary
    }).changes,
    1
  );
  assert.deepEqual(database.prepare(`
    SELECT coverage_error_code AS code, coverage_error_summary AS summary
    FROM funding_rate_sync_state
    WHERE exchange_id = 'bitget' AND exchange_market_id = 'BTCUSDT'
  `).get(), normalized);
  const persisted = JSON.stringify(database.prepare(`
    SELECT coverage_error_code, coverage_error_summary
    FROM funding_rate_sync_state
  `).all());
  assert.equal(persisted.includes('synthetic-key'), false);
  assert.equal(persisted.includes('synthetic-secret'), false);
  assert.equal(persisted.includes('\0'), false);
  assert.ok(Buffer.byteLength(normalized.summary, 'utf8') <= 512);
});

test('exposes the complete locked Task 5 lifecycle surface and exact discovery error', (t) => {
  const { repository } = setupFundingRepository(t);
  const requiredMethods = [
    'resumeInterruptedCoverage',
    'isCoverageLeaseCurrent',
    'bitgetRoundsEqual',
    'completeCoverage',
    'failCoverage',
    'startIncremental',
    'restartInterruptedIncremental',
    'isIncrementalLeaseEligible',
    'commitIncrementalPage',
    'completeIncremental',
    'failIncremental',
    'cancelIncremental'
  ] as const;
  const missingMethods = requiredMethods.filter((method) => (
    typeof Reflect.get(repository, method) !== 'function'
  ));
  const discoveryError = Reflect.get(
    fundingRateRepositoryModule,
    'IncompleteFundingDiscoveryError'
  );

  assert.deepEqual(missingMethods, []);
  assert.equal(typeof discoveryError, 'function');
  if (typeof discoveryError === 'function') {
    assert.equal(discoveryError.name, 'IncompleteFundingDiscoveryError');
  }
});

test('records a complete discovery deterministically and ignores newly inactive markets', (t) => {
  const { repository } = setupFundingRepository(t);
  const inactiveMarket = {
    exchangeId: 'okx',
    exchangeMarketId: 'ETH-USDT-SWAP',
    symbol: 'ETH/USDT:USDT'
  } as const satisfies FundingMarketIdentity;

  assert.deepEqual(repository.applyCompleteDiscovery(
    'okx',
    [observation(inactiveMarket, false), observation(OKX_MARKET)],
    DISCOVERED_AT
  ), {
    createdActiveMarketIds: [OKX_MARKET.exchangeMarketId],
    becameInactiveMarketIds: [],
    reactivatedMarketIds: [],
    observedActiveCount: 1,
    observedInactiveCount: 1
  });
  assert.deepEqual(repository.listMarketStates('okx').map((state) => ({
    marketId: state.exchangeMarketId,
    active: state.active,
    observedAt: state.activeObservedAt,
    changedAt: state.activeChangedAt
  })), [{
    marketId: OKX_MARKET.exchangeMarketId,
    active: true,
    observedAt: DISCOVERED_AT.toISOString(),
    changedAt: DISCOVERED_AT.toISOString()
  }]);

  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET), observation(inactiveMarket, false)],
    FIRST_OBSERVED_AT
  );
  const repeated = onlyMarketState(repository, OKX_MARKET);
  assert.equal(repeated.activeObservedAt, FIRST_OBSERVED_AT.toISOString());
  assert.equal(repeated.activeChangedAt, DISCOVERED_AT.toISOString());
});

test('rejects an incomplete discovery with the exact error and rolls back all observations', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const otherMarket = {
    exchangeId: 'okx',
    exchangeMarketId: 'ETH-USDT-SWAP',
    symbol: 'ETH/USDT:USDT'
  } as const satisfies FundingMarketIdentity;
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET), observation(otherMarket)],
    DISCOVERED_AT
  );
  const before = fundingPersistenceSnapshot(database);

  let caught: unknown;
  try {
    repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET)],
      FIRST_OBSERVED_AT
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught instanceof Error, true);
  if (caught instanceof Error) {
    assert.equal(caught.name, 'IncompleteFundingDiscoveryError');
    assert.match(caught.message, /incomplete funding discovery/i);
  }
  assert.equal(fundingPersistenceSnapshot(database), before);
});

const invalidDiscoveryCases = [
  {
    name: 'duplicate raw market ID',
    observations: [
      observation(OKX_MARKET),
      observation({ ...OKX_MARKET, symbol: 'XBT/USDT:USDT' })
    ]
  },
  {
    name: 'duplicate unified symbol',
    observations: [
      observation(OKX_MARKET),
      observation({ ...OKX_MARKET, exchangeMarketId: 'XBT-USDT-SWAP' })
    ]
  },
  {
    name: 'cross-exchange observation',
    observations: [observation(BITGET_MARKET)]
  },
  {
    name: 'known raw ID symbol conflict',
    observations: [observation({ ...OKX_MARKET, symbol: 'XBT/USDT:USDT' })]
  }
] as const;

for (const invalidDiscovery of invalidDiscoveryCases) {
  test(`rolls back discovery on ${invalidDiscovery.name}`, (t) => {
    const { database, repository } = setupFundingRepository(t);
    repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET)],
      DISCOVERED_AT
    );
    const before = fundingPersistenceSnapshot(database);

    assert.throws(
      () => repository.applyCompleteDiscovery(
        'okx',
        invalidDiscovery.observations,
        FIRST_OBSERVED_AT
      ),
      /funding discovery/i
    );
    assert.equal(fundingPersistenceSnapshot(database), before);
  });
}

test('fences fresh PENDING coverage across inactive and reactivation transitions', (t) => {
  const { repository } = setupFundingRepository(t);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    DISCOVERED_AT
  );

  assert.deepEqual(repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET, false)],
    TRANSITIONED_AT
  ), {
    createdActiveMarketIds: [],
    becameInactiveMarketIds: [OKX_MARKET.exchangeMarketId],
    reactivatedMarketIds: [],
    observedActiveCount: 0,
    observedInactiveCount: 1
  });
  const inactive = onlyMarketState(repository, OKX_MARKET);
  assert.deepEqual({
    active: inactive.active,
    observedAt: inactive.activeObservedAt,
    changedAt: inactive.activeChangedAt,
    status: inactive.coverageStatus,
    generation: inactive.coverageGeneration,
    kind: inactive.coverageTaskKind,
    cutoff: inactive.coverageCutoffMs,
    error: inactive.coverageErrorCode
  }, {
    active: false,
    observedAt: TRANSITIONED_AT.toISOString(),
    changedAt: TRANSITIONED_AT.toISOString(),
    status: 'PENDING',
    generation: 1,
    kind: null,
    cutoff: null,
    error: null
  });

  assert.deepEqual(repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    REACTIVATED_AT
  ), {
    createdActiveMarketIds: [],
    becameInactiveMarketIds: [],
    reactivatedMarketIds: [OKX_MARKET.exchangeMarketId],
    observedActiveCount: 1,
    observedInactiveCount: 0
  });
  const active = onlyMarketState(repository, OKX_MARKET);
  assert.deepEqual({
    active: active.active,
    changedAt: active.activeChangedAt,
    status: active.coverageStatus,
    generation: active.coverageGeneration,
    required: active.reactivationRequired,
    threshold: active.reactivationAfterGeneration,
    inactiveFinal: active.inactiveFinalCaughtUpAt
  }, {
    active: true,
    changedAt: REACTIVATED_AT.toISOString(),
    status: 'PENDING',
    generation: 2,
    required: true,
    threshold: 2,
    inactiveFinal: null
  });
});

test('inactive transition preserves prior coverage proof and cancels RUNNING incremental safely', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const completedLease = completeEmptyOkxCoverage(lifecycle);
  const successful = onlyMarketState(repository, OKX_MARKET);
  const incrementalLease = lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT);

  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET, false)],
    TRANSITIONED_AT
  );

  const inactive = onlyMarketState(repository, OKX_MARKET);
  assert.deepEqual({
    active: inactive.active,
    coverageStatus: inactive.coverageStatus,
    coverageGeneration: inactive.coverageGeneration,
    coverageErrorCode: inactive.coverageErrorCode,
    coverageErrorSummary: inactive.coverageErrorSummary,
    lastCaughtUpGeneration: inactive.lastCaughtUpGeneration,
    lastCaughtUpCutoffMs: inactive.lastCaughtUpCutoffMs,
    lastExhaustedAt: inactive.lastExhaustedAt,
    lastEvidence: inactive.lastExhaustionEvidenceJson,
    lastSuccessAt: inactive.coverageLastSuccessAt,
    incrementalStatus: inactive.incrementalStatus,
    incrementalGeneration: inactive.incrementalGeneration,
    incrementalEndedAt: inactive.incrementalEndedAt,
    incrementalLastSuccessAt: inactive.incrementalLastSuccessAt
  }, {
    active: false,
    coverageStatus: 'INCOMPLETE',
    coverageGeneration: completedLease.generation + 1,
    coverageErrorCode: 'COVERAGE_CANCELED_BY_MARKET_STATE',
    coverageErrorSummary: FAILURE_SUMMARIES.COVERAGE_CANCELED_BY_MARKET_STATE,
    lastCaughtUpGeneration: successful.lastCaughtUpGeneration,
    lastCaughtUpCutoffMs: successful.lastCaughtUpCutoffMs,
    lastExhaustedAt: successful.lastExhaustedAt,
    lastEvidence: successful.lastExhaustionEvidenceJson,
    lastSuccessAt: successful.coverageLastSuccessAt,
    incrementalStatus: 'IDLE',
    incrementalGeneration: incrementalLease.generation + 1,
    incrementalEndedAt: TRANSITIONED_AT.toISOString(),
    incrementalLastSuccessAt: null
  });
  assert.equal(lifecycle.isCoverageLeaseCurrent(completedLease), false);
  assert.equal(lifecycle.isIncrementalLeaseEligible(incrementalLease), false);
});

test('active transition fences in-flight coverage before any stale terminal or page write', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, OKX_MARKET);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET, false)],
    TRANSITIONED_AT
  );
  const transitioned = onlyMarketState(repository, OKX_MARKET);
  assert.equal(transitioned.coverageGeneration, lease.generation + 1);
  assert.equal(transitioned.coverageStatus, 'INCOMPLETE');
  assert.equal(
    transitioned.coverageErrorCode,
    'COVERAGE_CANCELED_BY_MARKET_STATE'
  );
  const before = fundingPersistenceSnapshot(database);
  const staleOperations: ReadonlyArray<readonly [string, () => unknown]> = [
    ['page', () => commitOkxPage(
      repository,
      lease,
      [rateRecord(OKX_MARKET, '0.0001')],
      COMPLETED_AT
    )],
    ['complete', () => lifecycle.completeCoverage(
      lease,
      okxEvidence(lease),
      COMPLETED_AT
    )],
    ['fail', () => lifecycle.failCoverage(
      lease,
      fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
      COMPLETED_AT
    )]
  ];
  for (const [operation, invoke] of staleOperations) {
    assert.throws(invoke, /stale funding task/i, operation);
    assert.equal(fundingPersistenceSnapshot(database), before, operation);
  }
});

test('reactivation records the post-transition generation threshold and requires a newer dedicated lease', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  completeEmptyOkxCoverage(lifecycle);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET, false)],
    TRANSITIONED_AT
  );
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    REACTIVATED_AT
  );
  const reactivated = onlyMarketState(repository, OKX_MARKET);
  assert.equal(reactivated.reactivationRequired, true);
  assert.equal(
    reactivated.reactivationAfterGeneration,
    reactivated.coverageGeneration
  );
  assert.throws(
    () => lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT),
    /reactivation|eligible/i
  );
  assert.throws(
    () => repository.startCoverage(
      OKX_MARKET,
      'PERIODIC',
      COVERAGE_CUTOFF_MS + 1,
      RESTARTED_AT
    ),
    /reactivation/i
  );

  const lease = repository.startCoverage(
    OKX_MARKET,
    'REACTIVATION',
    COVERAGE_CUTOFF_MS + 1,
    RESTARTED_AT
  );
  assert.ok(lease.generation > reactivated.coverageGeneration);
  assert.notEqual(reactivated.reactivationAfterGeneration, null);
  if (reactivated.reactivationAfterGeneration === null) {
    assert.fail('expected a persisted reactivation generation threshold');
  }
  assert.ok(lease.generation > reactivated.reactivationAfterGeneration);
  lifecycle.completeCoverage(lease, okxEvidence(lease), FINALIZED_AT);
  const completed = onlyMarketState(repository, OKX_MARKET);
  assert.equal(completed.reactivationRequired, false);
  assert.equal(completed.reactivationAfterGeneration, null);
  assert.equal(completed.coverageStatus, 'CAUGHT_UP');
});

test('rejects exhausted coverage generations without changing lifecycle state', (t) => {
  const { database, repository } = setupFundingRepository(t);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    DISCOVERED_AT
  );
  setStateIgnoringChecks(
    database,
    OKX_MARKET,
    `coverage_generation = ${MAX_SQLITE_SAFE_INTEGER}`
  );
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => repository.startCoverage(
      OKX_MARKET,
      'INITIAL',
      COVERAGE_CUTOFF_MS,
      STARTED_AT
    ),
    /generation exhausted/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
  assert.throws(
    () => repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET, false)],
      TRANSITIONED_AT
    ),
    /generation exhausted/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('OKX resume creates a new fenced generation and freezes its task-start anchor', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, OKX_MARKET);
  const olderTimestamp = FUNDING_TIMESTAMP_MS - 1;

  commitOkxPage(
    repository,
    lease,
    [
      rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS),
      rateRecord(OKX_MARKET, '-0.0002', olderTimestamp)
    ],
    FIRST_OBSERVED_AT,
    FUNDING_TIMESTAMP_MS
  );
  assert.equal(lifecycle.isCoverageLeaseCurrent(lease), true);

  const resumed = resumeCoverage(repository, OKX_MARKET, RESTARTED_AT);
  assert.deepEqual({
    generation: resumed.generation,
    kind: resumed.kind,
    cutoffMs: resumed.cutoffMs,
    okxResumeAfterMs: resumed.okxResumeAfterMs,
    requiredBitgetBoundaryMs: resumed.requiredBitgetBoundaryMs,
    recoveredPresent: Object.hasOwn(resumed, 'recovered')
  }, {
    generation: lease.generation + 1,
    kind: lease.kind,
    cutoffMs: lease.cutoffMs,
    okxResumeAfterMs: FUNDING_TIMESTAMP_MS,
    requiredBitgetBoundaryMs: null,
    recoveredPresent: false
  });
  let state = provenanceState(repository, OKX_MARKET);
  assert.deepEqual({
    generation: state.coverageGeneration,
    initialAfterMs: state.coverageInitialOkxAfterMs,
    mutableAfterMs: state.okxResumeAfterMs,
    mutableGeneration: state.okxResumeGeneration
  }, {
    generation: resumed.generation,
    initialAfterMs: FUNDING_TIMESTAMP_MS,
    mutableAfterMs: FUNDING_TIMESTAMP_MS,
    mutableGeneration: resumed.generation
  });
  assert.equal(database.prepare(`
    SELECT updated_at FROM funding_rate_sync_state
    WHERE exchange_id = ? AND exchange_market_id = ?
  `).pluck().get(OKX_MARKET.exchangeId, OKX_MARKET.exchangeMarketId), RESTARTED_AT.toISOString());
  assert.equal(lifecycle.isCoverageLeaseCurrent(lease), false);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumed), true);

  const nextAnchor = olderTimestamp - 1;
  commitOkxPage(
    repository,
    resumed,
    [rateRecord(OKX_MARKET, '0.0003', nextAnchor)],
    FINALIZED_AT,
    nextAnchor
  );
  state = provenanceState(repository, OKX_MARKET);
  assert.equal(state.coverageInitialOkxAfterMs, FUNDING_TIMESTAMP_MS);
  assert.equal(state.okxResumeAfterMs, nextAnchor);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumed), true);

  const resumedAgain = resumeCoverage(repository, OKX_MARKET, LATER_AT);
  assert.equal(resumedAgain.generation, resumed.generation + 1);
  assert.equal(resumedAgain.okxResumeAfterMs, nextAnchor);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumed), false);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumedAgain), true);
  state = provenanceState(repository, OKX_MARKET);
  assert.equal(state.coverageInitialOkxAfterMs, nextAnchor);
  assert.equal(state.okxResumeGeneration, resumedAgain.generation);
});

test('Bitget resume creates a new fenced generation and discards old TEMP rounds', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, BITGET_MARKET);
  const oldestTimestamp = FUNDING_TIMESTAMP_MS - 1;
  repository.commitCoveragePage(
    lease,
    [
      rateRecord(BITGET_MARKET, '0.0001', FUNDING_TIMESTAMP_MS),
      rateRecord(BITGET_MARKET, '-0.0002', oldestTimestamp)
    ],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  assert.equal(lifecycle.isCoverageLeaseCurrent(lease), true);
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
    WHERE coverage_generation = ?
  `).pluck().get(lease.generation), 2);

  const resumed = resumeCoverage(repository, BITGET_MARKET, RESTARTED_AT);
  assert.deepEqual({
    generation: resumed.generation,
    kind: resumed.kind,
    cutoffMs: resumed.cutoffMs,
    okxResumeAfterMs: resumed.okxResumeAfterMs,
    requiredBitgetBoundaryMs: resumed.requiredBitgetBoundaryMs,
    recoveredPresent: Object.hasOwn(resumed, 'recovered')
  }, {
    generation: lease.generation + 1,
    kind: lease.kind,
    cutoffMs: lease.cutoffMs,
    okxResumeAfterMs: null,
    requiredBitgetBoundaryMs: oldestTimestamp,
    recoveredPresent: false
  });
  assert.equal(lifecycle.isCoverageLeaseCurrent(lease), false);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumed), true);
  assert.equal(
    provenanceState(repository, BITGET_MARKET).coverageRequiredBitgetBoundaryMs,
    oldestTimestamp
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
    WHERE coverage_generation = ?
  `).pluck().get(lease.generation), 0);

  repository.commitCoveragePage(
    resumed,
    [rateRecord(BITGET_MARKET, '0.0001', oldestTimestamp)],
    { exchangeId: 'bitget', round: 1 },
    FINALIZED_AT
  );
  const resumedAgain = resumeCoverage(repository, BITGET_MARKET, LATER_AT);
  assert.equal(resumedAgain.generation, resumed.generation + 1);
  assert.equal(resumedAgain.requiredBitgetBoundaryMs, oldestTimestamp);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumed), false);
  assert.equal(lifecycle.isCoverageLeaseCurrent(resumedAgain), true);
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
    WHERE coverage_generation = ?
  `).pluck().get(resumed.generation), 0);
});

test('rolls back Bitget TEMP cleanup when the coverage resume update aborts', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, BITGET_MARKET);
  repository.commitCoveragePage(
    lease,
    [
      rateRecord(BITGET_MARKET, '0.0001', FUNDING_TIMESTAMP_MS),
      rateRecord(BITGET_MARKET, '-0.0002', FUNDING_TIMESTAMP_MS - 1)
    ],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  database.exec(`
    CREATE TEMP TRIGGER test_abort_coverage_resume
    BEFORE UPDATE OF coverage_generation ON funding_rate_sync_state
    WHEN OLD.exchange_market_id = '${BITGET_MARKET.exchangeMarketId}'
      AND NEW.coverage_generation = OLD.coverage_generation + 1
    BEGIN
      SELECT RAISE(ABORT, 'test coverage resume failed');
    END;
  `);
  const before = fundingPersistenceSnapshot(database);
  const tempRowsBefore = database.prepare(`
    SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
    WHERE exchange_id = ? AND exchange_market_id = ?
      AND coverage_generation = ?
  `).pluck().get(
    BITGET_MARKET.exchangeId,
    BITGET_MARKET.exchangeMarketId,
    lease.generation
  );

  const error = invocationError(() => resumeCoverage(
    repository,
    BITGET_MARKET,
    RESTARTED_AT
  ));

  assert.deepEqual({
    abortedAtStateUpdate:
      error instanceof Error
      && /test coverage resume failed/i.test(error.message),
    persistenceUnchanged: fundingPersistenceSnapshot(database) === before,
    tempRowsBefore,
    tempRowsAfter: database.prepare(`
      SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
      WHERE exchange_id = ? AND exchange_market_id = ?
        AND coverage_generation = ?
    `).pluck().get(
      BITGET_MARKET.exchangeId,
      BITGET_MARKET.exchangeMarketId,
      lease.generation
    ),
    oldLeaseCurrent: lifecycle.isCoverageLeaseCurrent(lease)
  }, {
    abortedAtStateUpdate: true,
    persistenceUnchanged: true,
    tempRowsBefore: 2,
    tempRowsAfter: 2,
    oldLeaseCurrent: true
  });
});

test('Bitget page advancement preserves the persisted task-start boundary', (t) => {
  const { repository, lifecycle, actual } = setupForgedCoverageLease(t, 'bitget');
  repository.commitCoveragePage(
    actual,
    [rateRecord(BITGET_MARKET, '0.0002', 69)],
    { exchangeId: 'bitget', round: 1 },
    FINALIZED_AT
  );
  const state = provenanceState(repository, BITGET_MARKET);

  assert.equal(state.coverageRequiredBitgetBoundaryMs, 70);
  assert.equal(state.coverageInitialOkxAfterMs, null);
  assert.equal(lifecycle.isCoverageLeaseCurrent(actual), true);
});

test('fresh OKX page advancement preserves a null task-start after', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, OKX_MARKET, 100);
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001', 78)],
    FIRST_OBSERVED_AT,
    78
  );
  const state = provenanceState(repository, OKX_MARKET);

  assert.equal(state.coverageInitialOkxAfterMs, null);
  assert.equal(state.okxResumeAfterMs, 78);
  assert.equal(lifecycle.isCoverageLeaseCurrent(lease), true);
});

test('coverage terminal transition clears task-start provenance', (t) => {
  const { repository, lifecycle, actual } = setupForgedCoverageLease(t, 'okx');
  lifecycle.failCoverage(
    actual,
    fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
    FINALIZED_AT
  );
  const state = provenanceState(repository, OKX_MARKET);

  assert.equal(state.coverageRequiredBitgetBoundaryMs, null);
  assert.equal(state.coverageInitialOkxAfterMs, null);
});

test('market transition clears task-start provenance', (t) => {
  const { repository, actual } = setupForgedCoverageLease(t, 'bitget');
  assert.equal(actual.requiredBitgetBoundaryMs, 70);
  repository.applyCompleteDiscovery(
    'bitget',
    [observation(BITGET_MARKET, false)],
    TRANSITIONED_AT
  );
  const state = provenanceState(repository, BITGET_MARKET);

  assert.equal(state.coverageRequiredBitgetBoundaryMs, null);
  assert.equal(state.coverageInitialOkxAfterMs, null);
});

test('fails closed when interrupted coverage recovery fields are inconsistent', (t) => {
  const corruptResumeCases = [
    {
      name: 'anchor generation',
      assignment: 'okx_resume_generation = coverage_generation + 1'
    },
    {
      name: 'missing cutoff',
      assignment: 'coverage_cutoff_ms = NULL'
    },
    {
      name: 'missing task kind',
      assignment: 'coverage_task_kind = NULL'
    },
    {
      name: 'missing start time',
      assignment: 'coverage_started_at = NULL'
    }
  ] as const;

  for (const corruptCase of corruptResumeCases) {
    const database = new Database(':memory:');
    try {
      const repository: FundingRateRepository = new SqliteFundingRateRepository(database);
      const lifecycle = task5Repository(repository);
      const lease = startCoverage(repository, OKX_MARKET);
      commitOkxPage(
        repository,
        lease,
        [rateRecord(OKX_MARKET, '0.0001')],
        FIRST_OBSERVED_AT
      );
      setStateIgnoringChecks(database, OKX_MARKET, corruptCase.assignment);
      const before = fundingPersistenceSnapshot(database);

      assert.throws(
        () => resumeCoverage(repository, OKX_MARKET, RESTARTED_AT),
        /invalid funding state|interrupted coverage/i,
        corruptCase.name
      );
      assert.equal(fundingPersistenceSnapshot(database), before);
    } finally {
      database.close();
    }
  }
});

const corruptCoverageProvenanceCases = [
  {
    name: 'OKX state carrying a Bitget task-start boundary',
    assignment:
      `coverage_required_bitget_boundary_ms = ${FUNDING_TIMESTAMP_MS}`,
    setup(repository: FundingRateRepository): CoverageLease {
      return startCoverage(repository, OKX_MARKET);
    }
  },
  {
    name: 'OKX initial after older than its mutable recovery anchor',
    assignment:
      `coverage_initial_okx_after_ms = ${FUNDING_TIMESTAMP_MS - 1}`,
    setup(repository: FundingRateRepository): CoverageLease {
      const interrupted = startCoverage(repository, OKX_MARKET);
      commitOkxPage(
        repository,
        interrupted,
        [rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS)],
        FIRST_OBSERVED_AT,
        FUNDING_TIMESTAMP_MS
      );
      return resumeCoverage(repository, OKX_MARKET, RESTARTED_AT);
    }
  }
] as const;

const corruptCoverageProvenanceOperations = [
  'read',
  'resume',
  'currency',
  'page',
  'complete',
  'fail'
] as const;

for (const corruptCase of corruptCoverageProvenanceCases) {
  test(`fails closed across coverage entries on corrupt provenance: ${corruptCase.name}`, () => {
    const results: Array<{
      readonly operation: typeof corruptCoverageProvenanceOperations[number];
      readonly rejectedForCorruptProvenance: boolean;
      readonly persistenceUnchanged: boolean;
    }> = [];
    for (const operation of corruptCoverageProvenanceOperations) {
      const database = new Database(':memory:');
      try {
        const repository: FundingRateRepository =
          new SqliteFundingRateRepository(database);
        const lifecycle = task5Repository(repository);
        const lease = corruptCase.setup(repository);
        setStateIgnoringChecks(
          database,
          OKX_MARKET,
          corruptCase.assignment
        );
        const before = fundingPersistenceSnapshot(database);
        const error = invocationError(() => {
          if (operation === 'read') {
            repository.listMarketStates('okx');
          } else if (operation === 'resume') {
            resumeCoverage(repository, OKX_MARKET, LATER_AT);
          } else if (operation === 'currency') {
            lifecycle.isCoverageLeaseCurrent(lease);
          } else if (operation === 'page') {
            commitOkxPage(
              repository,
              lease,
              [rateRecord(
                OKX_MARKET,
                '-0.0002',
                FUNDING_TIMESTAMP_MS - 1
              )],
              LATER_AT,
              FUNDING_TIMESTAMP_MS - 1
            );
          } else if (operation === 'complete') {
            lifecycle.completeCoverage(
              lease,
              okxEvidence(lease),
              LATER_AT
            );
          } else {
            lifecycle.failCoverage(
              lease,
              fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
              LATER_AT
            );
          }
        });
        results.push({
          operation,
          rejectedForCorruptProvenance: errorContains(error, [
            'invalid funding state',
            'coverage task-start provenance'
          ]),
          persistenceUnchanged: fundingPersistenceSnapshot(database) === before
        });
      } finally {
        database.close();
      }
    }

    assert.deepEqual(results, corruptCoverageProvenanceOperations.map(
      (operation) => ({
        operation,
        rejectedForCorruptProvenance: true,
        persistenceUnchanged: true
      })
    ));
  });
}

test('rejects an interrupted resume at the maximum coverage generation atomically', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001', 78)],
    FIRST_OBSERVED_AT,
    78
  );
  const update = database.prepare(`
    UPDATE funding_rate_sync_state
    SET coverage_generation = ?, okx_resume_generation = ?
    WHERE exchange_id = ? AND exchange_market_id = ?
  `).run(
    MAX_SQLITE_SAFE_INTEGER,
    MAX_SQLITE_SAFE_INTEGER,
    OKX_MARKET.exchangeId,
    OKX_MARKET.exchangeMarketId
  );
  assert.equal(update.changes, 1);
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => resumeCoverage(repository, OKX_MARKET, RESTARTED_AT),
    /generation exhausted/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('checks the full coverage lease identity and fences every stale mutation', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const oldLease = startCoverage(repository, OKX_MARKET);
  const currentLease = repository.startCoverage(
    OKX_MARKET,
    'PERIODIC',
    COVERAGE_CUTOFF_MS + 1,
    SECOND_OBSERVED_AT
  );
  const restarted = onlyMarketState(repository, OKX_MARKET);
  assert.equal(restarted.okxResumeAfterMs, null);
  assert.equal(restarted.okxResumeGeneration, null);
  assert.equal(restarted.coverageErrorCode, null);
  assert.equal(restarted.coverageEndedAt, null);
  assert.equal(lifecycle.isCoverageLeaseCurrent(currentLease), true);
  const mismatchedLeases: CoverageLease[] = [
    oldLease,
    { ...currentLease, symbol: 'XBT/USDT:USDT' },
    { ...currentLease, kind: 'INITIAL' },
    { ...currentLease, cutoffMs: currentLease.cutoffMs - 1 }
  ];
  for (const lease of mismatchedLeases) {
    assert.equal(lifecycle.isCoverageLeaseCurrent(lease), false);
  }

  const before = fundingPersistenceSnapshot(database);
  const staleOperations: ReadonlyArray<readonly [string, () => unknown]> = [
    ['page', () => commitOkxPage(
      repository,
      oldLease,
      [rateRecord(OKX_MARKET, '0.0001')],
      FIRST_OBSERVED_AT
    )],
    ['complete', () => lifecycle.completeCoverage(
      oldLease,
      okxEvidence(oldLease),
      COMPLETED_AT
    )],
    ['fail', () => lifecycle.failCoverage(
      oldLease,
      fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
      COMPLETED_AT
    )]
  ];
  for (const [operation, invoke] of staleOperations) {
    assert.throws(invoke, /stale funding task/i, operation);
    assert.equal(fundingPersistenceSnapshot(database), before, operation);
  }
});

for (const exchangeId of ['bitget', 'okx'] as const) {
  test(`${exchangeId} task-start provenance is part of lease currency`, (t) => {
    const { lifecycle, actual, forged } = setupForgedCoverageLease(t, exchangeId);

    assert.equal(lifecycle.isCoverageLeaseCurrent(actual), true);
    assert.equal(lifecycle.isCoverageLeaseCurrent(forged), false);
  });
}

for (const operation of ['page', 'complete', 'fail'] as const) {
  for (const exchangeId of ['bitget', 'okx'] as const) {
    test(`${exchangeId} ${operation} rejects forged task-start provenance with zero writes`, (t) => {
      const {
        database,
        repository,
        lifecycle,
        actual,
        forged
      } = setupForgedCoverageLease(t, exchangeId);
      if (operation === 'complete' && actual.exchangeId === 'bitget') {
        const record = rateRecord(BITGET_MARKET, '0.0001', 70);
        for (const round of [1, 2] as const) {
          repository.commitCoveragePage(
            actual,
            [record],
            { exchangeId: 'bitget', round },
            FINALIZED_AT
          );
        }
      }
      const before = fundingPersistenceSnapshot(database);
      const invoke = operation === 'page'
        ? (): unknown => repository.commitCoveragePage(
            forged,
            [rateRecord(
              exchangeId === 'bitget' ? BITGET_MARKET : OKX_MARKET,
              '0.0002',
              69
            )],
            exchangeId === 'bitget'
              ? { exchangeId: 'bitget', round: 1 }
              : { exchangeId: 'okx', recoveryAnchorMs: 69 },
            LATER_AT
          )
        : operation === 'complete'
          ? (): unknown => lifecycle.completeCoverage(
              forged,
              exchangeId === 'bitget'
                ? bitgetEvidence(forged)
                : okxEvidence(forged, 0),
              LATER_AT
            )
          : (): unknown => lifecycle.failCoverage(
              forged,
              fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
              LATER_AT
            );

      assert.throws(invoke, /stale funding task/i);
      assert.equal(fundingPersistenceSnapshot(database), before);
    });
  }
}

test('Bitget round comparison rejects forged task-start provenance', (t) => {
  const { database, lifecycle, forged } = setupForgedCoverageLease(t, 'bitget');
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => lifecycle.bitgetRoundsEqual(forged, 1, 2),
    /stale funding task/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('requires an OKX checkpoint to equal the committed page maximum before any write', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const olderTimestamp = FUNDING_TIMESTAMP_MS - 1;
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => commitOkxPage(
      repository,
      lease,
      [
        rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS),
        rateRecord(OKX_MARKET, '-0.0002', olderTimestamp)
      ],
      FIRST_OBSERVED_AT,
      olderTimestamp
    ),
    /OKX.*anchor.*page maximum|checkpoint/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('commits an OKX page, bounds, and maximum-time recovery anchor atomically', (t) => {
  const { repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const oldestTimestamp = FUNDING_TIMESTAMP_MS - 2;

  assert.deepEqual(commitOkxPage(
    repository,
    lease,
    [
      rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS),
      rateRecord(OKX_MARKET, '-0.0002', oldestTimestamp)
    ],
    FIRST_OBSERVED_AT,
    FUNDING_TIMESTAMP_MS
  ), {
    inserted: 2,
    unchanged: 0,
    revised: 0,
    revisedKeys: []
  });
  const state = onlyMarketState(repository, OKX_MARKET);
  assert.equal(state.oldestFundingTimestampMs, oldestTimestamp);
  assert.equal(state.latestFundingTimestampMs, FUNDING_TIMESTAMP_MS);
  assert.equal(state.okxResumeAfterMs, FUNDING_TIMESTAMP_MS);
  assert.equal(state.okxResumeGeneration, lease.generation);
});

test('persists canonical caught-up evidence and clears the OKX recovery anchor', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, OKX_MARKET);
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001')],
    FIRST_OBSERVED_AT
  );
  const evidence: FundingExhaustionEvidence = {
    exchangeId: 'okx',
    generation: lease.generation,
    cutoffMs: lease.cutoffMs,
    explicitEmpty: true,
    finalRequestAfterMs: FUNDING_TIMESTAMP_MS - 1
  };

  lifecycle.completeCoverage(lease, evidence, COMPLETED_AT);

  const state = onlyMarketState(repository, OKX_MARKET);
  assert.deepEqual({
    status: state.coverageStatus,
    generation: state.lastCaughtUpGeneration,
    cutoff: state.lastCaughtUpCutoffMs,
    exhaustedAt: state.lastExhaustedAt,
    evidence: state.lastExhaustionEvidenceJson,
    endedAt: state.coverageEndedAt,
    successAt: state.coverageLastSuccessAt,
    errorCode: state.coverageErrorCode,
    anchor: state.okxResumeAfterMs,
    anchorGeneration: state.okxResumeGeneration
  }, {
    status: 'CAUGHT_UP',
    generation: lease.generation,
    cutoff: lease.cutoffMs,
    exhaustedAt: COMPLETED_AT.toISOString(),
    evidence: JSON.stringify(evidence),
    endedAt: COMPLETED_AT.toISOString(),
    successAt: COMPLETED_AT.toISOString(),
    errorCode: null,
    anchor: null,
    anchorGeneration: null
  });
});

const invalidOkxEvidenceCases = [
  {
    name: 'exchange',
    mutate: (evidence: FundingExhaustionEvidence) => ({
      ...evidence,
      exchangeId: 'bitget',
      matchingRounds: [1, 2],
      emptyPageNo: 1
    })
  },
  {
    name: 'generation',
    mutate: (evidence: FundingExhaustionEvidence) => ({
      ...evidence,
      generation: evidence.generation + 1
    })
  },
  {
    name: 'cutoff',
    mutate: (evidence: FundingExhaustionEvidence) => ({
      ...evidence,
      cutoffMs: evidence.cutoffMs - 1
    })
  },
  {
    name: 'explicit-empty proof',
    mutate: (evidence: FundingExhaustionEvidence) => ({
      ...evidence,
      explicitEmpty: false
    })
  }
] as const;

for (const invalidEvidence of invalidOkxEvidenceCases) {
  test(`rejects OKX exhaustion evidence with mismatched ${invalidEvidence.name}`, (t) => {
    const { database, repository } = setupFundingRepository(t);
    const lifecycle = task5Repository(repository);
    const lease = startCoverage(repository, OKX_MARKET);
    const evidence = invalidEvidence.mutate(okxEvidence(lease));
    const before = fundingPersistenceSnapshot(database);

    assert.throws(
      () => lifecycle.completeCoverage(
        lease,
        evidence as unknown as FundingExhaustionEvidence,
        COMPLETED_AT
      ),
      /exhaustion evidence|stale funding task/i
    );
    assert.equal(fundingPersistenceSnapshot(database), before);
  });
}

test('records a normalized coverage failure without overwriting prior success proof', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  completeEmptyOkxCoverage(lifecycle);
  const successful = onlyMarketState(repository, OKX_MARKET);
  const periodic = repository.startCoverage(
    OKX_MARKET,
    'PERIODIC',
    COVERAGE_CUTOFF_MS + 1,
    RESTARTED_AT
  );
  const failure = fundingTaskFailure('REQUEST_RETRY_EXHAUSTED');

  lifecycle.failCoverage(periodic, failure, FINALIZED_AT);

  const failed = onlyMarketState(repository, OKX_MARKET);
  assert.deepEqual({
    status: failed.coverageStatus,
    endedAt: failed.coverageEndedAt,
    errorCode: failed.coverageErrorCode,
    errorSummary: failed.coverageErrorSummary,
    lastCaughtUpGeneration: failed.lastCaughtUpGeneration,
    lastCaughtUpCutoffMs: failed.lastCaughtUpCutoffMs,
    lastExhaustedAt: failed.lastExhaustedAt,
    lastEvidence: failed.lastExhaustionEvidenceJson,
    lastSuccessAt: failed.coverageLastSuccessAt,
    anchor: failed.okxResumeAfterMs
  }, {
    status: 'INCOMPLETE',
    endedAt: FINALIZED_AT.toISOString(),
    errorCode: failure.code,
    errorSummary: failure.summary,
    lastCaughtUpGeneration: successful.lastCaughtUpGeneration,
    lastCaughtUpCutoffMs: successful.lastCaughtUpCutoffMs,
    lastExhaustedAt: successful.lastExhaustedAt,
    lastEvidence: successful.lastExhaustionEvidenceJson,
    lastSuccessAt: successful.coverageLastSuccessAt,
    anchor: null
  });
});

test('rejects tampered coverage failures without ending or mutating the task', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, OKX_MARKET);
  const before = fundingPersistenceSnapshot(database);
  const tampered = {
    ...fundingTaskFailure('DATABASE_WRITE_FAILED'),
    summary: 'synthetic arbitrary failure text'
  } as FundingTaskFailure;

  assert.throws(
    () => lifecycle.failCoverage(lease, tampered, COMPLETED_AT),
    /failure summary|normalized/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('a new coverage generation clears prior terminal errors and freezes new task fields', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const failedLease = startCoverage(repository, OKX_MARKET);
  lifecycle.failCoverage(
    failedLease,
    fundingTaskFailure('DATABASE_WRITE_FAILED'),
    COMPLETED_AT
  );

  const retry = repository.startCoverage(
    OKX_MARKET,
    'PERIODIC',
    COVERAGE_CUTOFF_MS + 1,
    RESTARTED_AT
  );
  const state = onlyMarketState(repository, OKX_MARKET);
  assert.equal(retry.generation, failedLease.generation + 1);
  assert.equal(state.coverageStatus, 'BACKFILLING');
  assert.equal(state.coverageTaskKind, 'PERIODIC');
  assert.equal(state.coverageCutoffMs, COVERAGE_CUTOFF_MS + 1);
  assert.equal(state.coverageStartedAt, RESTARTED_AT.toISOString());
  assert.equal(state.coverageEndedAt, null);
  assert.equal(state.coverageErrorCode, null);
  assert.equal(state.coverageErrorSummary, null);
  assert.equal(state.okxResumeAfterMs, null);
  assert.equal(state.okxResumeGeneration, null);
});

test('stages only cutoff-bounded Bitget records and compares every normalized field', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const cutoffMs = FUNDING_TIMESTAMP_MS;
  const lease = startCoverage(repository, BITGET_MARKET, cutoffMs);
  const bounded = rateRecord(
    BITGET_MARKET,
    '0.0001',
    FUNDING_TIMESTAMP_MS - 1,
    'bounded'
  );
  const afterCutoff = rateRecord(
    BITGET_MARKET,
    '0.0002',
    FUNDING_TIMESTAMP_MS + 1,
    'after-cutoff'
  );
  repository.commitCoveragePage(
    lease,
    [bounded, afterCutoff],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  repository.commitCoveragePage(
    lease,
    [bounded, afterCutoff],
    { exchangeId: 'bitget', round: 2 },
    SECOND_OBSERVED_AT
  );

  assert.deepEqual(database.prepare(`
    SELECT scan_round, funding_timestamp_ms
    FROM temp.funding_rate_bitget_scan
    ORDER BY scan_round, funding_timestamp_ms
  `).all(), [
    { scan_round: 1, funding_timestamp_ms: bounded.fundingTimestampMs },
    { scan_round: 2, funding_timestamp_ms: bounded.fundingTimestampMs }
  ]);
  assert.equal(repository.listHistory(BITGET_MARKET).length, 2);
  assert.equal(lifecycle.bitgetRoundsEqual(lease, 1, 2), true);

  const changedFields = rateRecord(
    BITGET_MARKET,
    '-0.0001',
    bounded.fundingTimestampMs,
    'changed-fields'
  );
  repository.commitCoveragePage(
    lease,
    [changedFields],
    { exchangeId: 'bitget', round: 3 },
    THIRD_OBSERVED_AT
  );
  assert.equal(lifecycle.bitgetRoundsEqual(lease, 2, 3), false);
});

test('uses bidirectional Bitget set differences and isolates markets and generations', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const otherMarket = {
    exchangeId: 'bitget',
    exchangeMarketId: 'ETHUSDT',
    symbol: 'ETH/USDT:USDT'
  } as const satisfies FundingMarketIdentity;
  repository.applyCompleteDiscovery(
    'bitget',
    [observation(BITGET_MARKET), observation(otherMarket)],
    DISCOVERED_AT
  );
  const lease = repository.startCoverage(
    BITGET_MARKET,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  const otherLease = repository.startCoverage(
    otherMarket,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  const first = rateRecord(BITGET_MARKET, '0.0001', FUNDING_TIMESTAMP_MS);
  const second = rateRecord(BITGET_MARKET, '0.0002', FUNDING_TIMESTAMP_MS - 1);
  const third = rateRecord(BITGET_MARKET, '0.0003', FUNDING_TIMESTAMP_MS - 2);
  repository.commitCoveragePage(
    lease,
    [first, second],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  repository.commitCoveragePage(
    lease,
    [first],
    { exchangeId: 'bitget', round: 2 },
    SECOND_OBSERVED_AT
  );
  repository.commitCoveragePage(
    lease,
    [first, third],
    { exchangeId: 'bitget', round: 3 },
    THIRD_OBSERVED_AT
  );
  repository.commitCoveragePage(
    otherLease,
    [rateRecord(otherMarket, '9.9')],
    { exchangeId: 'bitget', round: 2 },
    FIRST_OBSERVED_AT
  );

  assert.equal(lifecycle.bitgetRoundsEqual(lease, 1, 2), false);
  assert.equal(lifecycle.bitgetRoundsEqual(lease, 2, 3), false);
  assert.equal(
    database.prepare(`
      SELECT COUNT(DISTINCT exchange_market_id)
      FROM temp.funding_rate_bitget_scan
    `).pluck().get(),
    2
  );

  const nextGeneration = repository.startCoverage(
    BITGET_MARKET,
    'PERIODIC',
    COVERAGE_CUTOFF_MS + 1,
    COMPLETED_AT
  );
  assert.equal(nextGeneration.generation, lease.generation + 1);
  assert.equal(lifecycle.bitgetRoundsEqual(nextGeneration, 1, 2), true);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
      WHERE exchange_market_id = ? AND coverage_generation = ?
    `).pluck().get(BITGET_MARKET.exchangeMarketId, lease.generation),
    0
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
      WHERE exchange_market_id = ?
    `).pluck().get(otherMarket.exchangeMarketId),
    1
  );
});

test('cleans only the terminal Bitget lease staging set on completion and failure', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, BITGET_MARKET);
  const record = rateRecord(BITGET_MARKET, '0.0001');
  for (const round of [1, 2] as const) {
    repository.commitCoveragePage(
      lease,
      [record],
      { exchangeId: 'bitget', round },
      FIRST_OBSERVED_AT
    );
  }
  lifecycle.completeCoverage(lease, bitgetEvidence(lease), COMPLETED_AT);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
      WHERE exchange_market_id = ? AND coverage_generation = ?
    `).pluck().get(BITGET_MARKET.exchangeMarketId, lease.generation),
    0
  );

  const retry = repository.startCoverage(
    BITGET_MARKET,
    'PERIODIC',
    COVERAGE_CUTOFF_MS + 1,
    RESTARTED_AT
  );
  repository.commitCoveragePage(
    retry,
    [record],
    { exchangeId: 'bitget', round: 1 },
    RESTARTED_AT
  );
  lifecycle.failCoverage(
    retry,
    fundingTaskFailure('BITGET_SCAN_NOT_CONVERGED'),
    FINALIZED_AT
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) FROM temp.funding_rate_bitget_scan
      WHERE exchange_market_id = ? AND coverage_generation = ?
    `).pluck().get(BITGET_MARKET.exchangeMarketId, retry.generation),
    0
  );
});

test('rejects Bitget completion when the claimed consecutive rounds are not equal', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, BITGET_MARKET);
  const first = rateRecord(BITGET_MARKET, '0.0001', FUNDING_TIMESTAMP_MS);
  const second = rateRecord(BITGET_MARKET, '0.0002', FUNDING_TIMESTAMP_MS - 1);
  repository.commitCoveragePage(
    lease,
    [first, second],
    { exchangeId: 'bitget', round: 1 },
    FIRST_OBSERVED_AT
  );
  repository.commitCoveragePage(
    lease,
    [first],
    { exchangeId: 'bitget', round: 2 },
    SECOND_OBSERVED_AT
  );
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => lifecycle.completeCoverage(
      lease,
      bitgetEvidence(lease, [1, 2]),
      COMPLETED_AT
    ),
    /rounds.*not.*equal|exhaustion evidence/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('allows only inactive final coverage to establish the inactive terminal proof', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    DISCOVERED_AT
  );
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET, false)],
    TRANSITIONED_AT
  );
  assert.throws(
    () => repository.startCoverage(
      OKX_MARKET,
      'INITIAL',
      COVERAGE_CUTOFF_MS,
      STARTED_AT
    ),
    /inactive|eligible/i
  );

  const lease = repository.startCoverage(
    OKX_MARKET,
    'INACTIVE_FINAL',
    COVERAGE_CUTOFF_MS,
    REACTIVATED_AT
  );
  lifecycle.completeCoverage(lease, okxEvidence(lease), RESTARTED_AT);
  const inactive = onlyMarketState(repository, OKX_MARKET);
  assert.equal(inactive.active, false);
  assert.equal(inactive.coverageStatus, 'CAUGHT_UP');
  assert.equal(inactive.inactiveFinalCaughtUpAt, RESTARTED_AT.toISOString());
  assert.throws(
    () => lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT),
    /inactive|eligible/i
  );
});

test('starts incremental only after successful coverage and freezes the pre-task latest key', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    DISCOVERED_AT
  );
  assert.throws(
    () => lifecycle.startIncremental(OKX_MARKET, STARTED_AT),
    /coverage|eligible/i
  );
  const coverage = repository.startCoverage(
    OKX_MARKET,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  commitOkxPage(
    repository,
    coverage,
    [rateRecord(OKX_MARKET, '0.0001')],
    FIRST_OBSERVED_AT
  );
  lifecycle.completeCoverage(
    coverage,
    okxEvidence(coverage, FUNDING_TIMESTAMP_MS),
    COMPLETED_AT
  );

  const lease = lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT);
  assert.deepEqual(lease, {
    ...OKX_MARKET,
    generation: 1,
    frozenBoundaryMs: FUNDING_TIMESTAMP_MS
  });
  assert.equal(lifecycle.isIncrementalLeaseEligible(lease), true);
  const running = onlyMarketState(repository, OKX_MARKET);
  assert.equal(running.incrementalStatus, 'RUNNING');
  assert.equal(running.incrementalStartedAt, RESTARTED_AT.toISOString());
  assert.equal(running.incrementalEndedAt, null);
  assert.equal(running.incrementalErrorCode, null);
});

test('incremental pages revise and insert records without mutating coverage state', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    DISCOVERED_AT
  );
  const coverage = repository.startCoverage(
    OKX_MARKET,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  commitOkxPage(
    repository,
    coverage,
    [rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A')],
    FIRST_OBSERVED_AT
  );
  lifecycle.completeCoverage(
    coverage,
    okxEvidence(coverage, FUNDING_TIMESTAMP_MS),
    COMPLETED_AT
  );
  const before = onlyMarketState(repository, OKX_MARKET);
  const incremental = lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT);
  const earlierUnknown = FUNDING_TIMESTAMP_MS - 1;

  assert.deepEqual(lifecycle.commitIncrementalPage(
    incremental,
    [
      rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B'),
      rateRecord(OKX_MARKET, '-0.0003', earlierUnknown, 'late')
    ],
    RESTARTED_AT
  ), {
    inserted: 1,
    unchanged: 0,
    revised: 1,
    revisedKeys: [{
      fundingTimestampMs: FUNDING_TIMESTAMP_MS,
      previousContentHash: rateRecord(
        OKX_MARKET,
        '0.0001',
        FUNDING_TIMESTAMP_MS,
        'A'
      ).contentHash,
      currentContentHash: rateRecord(
        OKX_MARKET,
        '0.0002',
        FUNDING_TIMESTAMP_MS,
        'B'
      ).contentHash
    }]
  });
  const after = onlyMarketState(repository, OKX_MARKET);
  assert.deepEqual({
    coverageStatus: after.coverageStatus,
    coverageGeneration: after.coverageGeneration,
    coverageCutoffMs: after.coverageCutoffMs,
    lastCaughtUpGeneration: after.lastCaughtUpGeneration,
    lastCaughtUpCutoffMs: after.lastCaughtUpCutoffMs,
    lastExhaustedAt: after.lastExhaustedAt,
    lastEvidence: after.lastExhaustionEvidenceJson,
    coverageErrorCode: after.coverageErrorCode
  }, {
    coverageStatus: before.coverageStatus,
    coverageGeneration: before.coverageGeneration,
    coverageCutoffMs: before.coverageCutoffMs,
    lastCaughtUpGeneration: before.lastCaughtUpGeneration,
    lastCaughtUpCutoffMs: before.lastCaughtUpCutoffMs,
    lastExhaustedAt: before.lastExhaustedAt,
    lastEvidence: before.lastExhaustionEvidenceJson,
    coverageErrorCode: before.coverageErrorCode
  });
  assert.deepEqual(
    repository.listHistory(OKX_MARKET).map(({ fundingTimestampMs }) => (
      fundingTimestampMs
    )),
    [FUNDING_TIMESTAMP_MS, earlierUnknown]
  );
});

test('incremental failure and later success never clear coverage INCOMPLETE', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  completeEmptyOkxCoverage(lifecycle);
  const periodic = repository.startCoverage(
    OKX_MARKET,
    'PERIODIC',
    COVERAGE_CUTOFF_MS + 1,
    RESTARTED_AT
  );
  lifecycle.failCoverage(
    periodic,
    fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
    FINALIZED_AT
  );
  const coverageFailure = onlyMarketState(repository, OKX_MARKET);
  const firstIncremental = lifecycle.startIncremental(OKX_MARKET, LATER_AT);
  lifecycle.failIncremental(
    firstIncremental,
    fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
    new Date('2026-09-06T00:11:00.000Z')
  );
  const failedIncremental = onlyMarketState(repository, OKX_MARKET);
  assert.equal(failedIncremental.coverageStatus, 'INCOMPLETE');
  assert.equal(
    failedIncremental.coverageErrorCode,
    coverageFailure.coverageErrorCode
  );
  assert.equal(failedIncremental.incrementalStatus, 'INCOMPLETE');
  assert.equal(failedIncremental.incrementalErrorCode, 'SOURCE_RESPONSE_INVALID');

  const retry = lifecycle.startIncremental(
    OKX_MARKET,
    new Date('2026-09-06T00:12:00.000Z')
  );
  const incrementalCompletedAt = new Date('2026-09-06T00:13:00.000Z');
  lifecycle.completeIncremental(retry, incrementalCompletedAt);
  const completed = onlyMarketState(repository, OKX_MARKET);
  assert.equal(completed.incrementalStatus, 'IDLE');
  assert.equal(completed.incrementalErrorCode, null);
  assert.equal(
    completed.incrementalLastSuccessAt,
    incrementalCompletedAt.toISOString()
  );
  assert.equal(completed.coverageStatus, 'INCOMPLETE');
  assert.equal(completed.coverageErrorCode, coverageFailure.coverageErrorCode);
  assert.equal(completed.lastCaughtUpCutoffMs, coverageFailure.lastCaughtUpCutoffMs);
});

test('restart fences the old incremental lease and refreezes the persisted latest key', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const coverage = completeEmptyOkxCoverage(lifecycle);
  const oldLease = lifecycle.startIncremental(OKX_MARKET, REACTIVATED_AT);
  const newLatest = FUNDING_TIMESTAMP_MS + 2;
  lifecycle.commitIncrementalPage(
    oldLease,
    [rateRecord(OKX_MARKET, '0.0004', newLatest)],
    REACTIVATED_AT
  );
  const restarted = lifecycle.restartInterruptedIncremental(
    OKX_MARKET,
    RESTARTED_AT
  );
  assert.deepEqual(restarted, {
    ...OKX_MARKET,
    generation: oldLease.generation + 1,
    frozenBoundaryMs: newLatest
  });
  assert.equal(lifecycle.isIncrementalLeaseEligible(oldLease), false);
  assert.equal(lifecycle.isIncrementalLeaseEligible(restarted), true);
  const before = fundingPersistenceSnapshot(database);
  const staleOperations: ReadonlyArray<readonly [string, () => unknown]> = [
    ['page', () => lifecycle.commitIncrementalPage(
      oldLease,
      [rateRecord(OKX_MARKET, '0.0005', newLatest, 'stale-revision')],
      RESTARTED_AT
    )],
    ['complete', () => lifecycle.completeIncremental(oldLease, RESTARTED_AT)],
    ['fail', () => lifecycle.failIncremental(
      oldLease,
      fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
      RESTARTED_AT
    )],
    ['cancel', () => lifecycle.cancelIncremental(oldLease, RESTARTED_AT)]
  ];
  for (const [operation, invoke] of staleOperations) {
    assert.throws(invoke, /stale funding task/i, operation);
    assert.equal(fundingPersistenceSnapshot(database), before, operation);
  }
  assert.equal(onlyMarketState(repository, OKX_MARKET).coverageGeneration, coverage.generation);
});

test('restart accepts only an eligible legacy RUNNING incremental task', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  completeEmptyOkxCoverage(lifecycle);
  let before = fundingPersistenceSnapshot(database);
  assert.throws(
    () => lifecycle.restartInterruptedIncremental(OKX_MARKET, RESTARTED_AT),
    /RUNNING|interrupted incremental/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);

  const lease = lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT);
  lifecycle.failIncremental(
    lease,
    fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
    FINALIZED_AT
  );
  before = fundingPersistenceSnapshot(database);
  assert.throws(
    () => lifecycle.restartInterruptedIncremental(OKX_MARKET, LATER_AT),
    /RUNNING|interrupted incremental/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('canceling incremental work ends it without recording success or changing coverage', (t) => {
  const { repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  completeEmptyOkxCoverage(lifecycle);
  const coverage = onlyMarketState(repository, OKX_MARKET);
  const lease = lifecycle.startIncremental(OKX_MARKET, REACTIVATED_AT);

  lifecycle.cancelIncremental(lease, RESTARTED_AT);

  const canceled = onlyMarketState(repository, OKX_MARKET);
  assert.equal(canceled.incrementalStatus, 'IDLE');
  assert.equal(canceled.incrementalEndedAt, RESTARTED_AT.toISOString());
  assert.equal(canceled.incrementalLastSuccessAt, null);
  assert.equal(canceled.incrementalErrorCode, null);
  assert.equal(canceled.coverageStatus, coverage.coverageStatus);
  assert.equal(canceled.coverageGeneration, coverage.coverageGeneration);
  assert.equal(canceled.lastExhaustionEvidenceJson, coverage.lastExhaustionEvidenceJson);
});

test('rejects exhausted incremental generations without changing eligible state', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  completeEmptyOkxCoverage(lifecycle);
  setStateIgnoringChecks(
    database,
    OKX_MARKET,
    `incremental_generation = ${MAX_SQLITE_SAFE_INTEGER}`
  );
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT),
    /generation exhausted/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

for (const boundaryCase of [
  { name: 'non-empty history', boundaryMs: 70 },
  { name: 'empty history', boundaryMs: null },
  { name: 'timestamp zero', boundaryMs: 0 }
] as const) {
  test(`incremental start persists the exact frozen boundary for ${boundaryCase.name}`, (t) => {
    const { database, repository, lifecycle, lease } = setupIncrementalProvenance(
      t,
      boundaryCase.boundaryMs
    );
    const state = incrementalProvenanceState(repository, OKX_MARKET);

    assert.equal(lease.frozenBoundaryMs, boundaryCase.boundaryMs);
    assert.equal(
      state.incrementalFrozenBoundaryMs,
      boundaryCase.boundaryMs
    );
    assert.equal(
      persistedIncrementalBoundary(database, OKX_MARKET),
      boundaryCase.boundaryMs
    );
    assert.equal(lifecycle.isIncrementalLeaseEligible(lease), true);
  });
}

test('incremental page advancement never moves persisted frozen provenance', (t) => {
  const { database, repository, lifecycle, lease } = setupIncrementalProvenance(t);
  lifecycle.commitIncrementalPage(
    lease,
    [rateRecord(OKX_MARKET, '0.0002', 90)],
    FINALIZED_AT
  );
  const state = incrementalProvenanceState(repository, OKX_MARKET);

  assert.equal(state.latestFundingTimestampMs, 90);
  assert.equal(lease.frozenBoundaryMs, 70);
  assert.equal(state.incrementalFrozenBoundaryMs, 70);
  assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), 70);
  assert.equal(lifecycle.isIncrementalLeaseEligible(lease), true);
});

test('incremental restart atomically fences and rebinds provenance to persisted latest', (t) => {
  const { database, repository, lifecycle, lease } = setupIncrementalProvenance(t);
  lifecycle.commitIncrementalPage(
    lease,
    [rateRecord(OKX_MARKET, '0.0002', 90)],
    FINALIZED_AT
  );

  const restarted = lifecycle.restartInterruptedIncremental(
    OKX_MARKET,
    LATER_AT
  );

  const state = incrementalProvenanceState(repository, OKX_MARKET);
  assert.equal(restarted.generation, lease.generation + 1);
  assert.equal(restarted.frozenBoundaryMs, 90);
  assert.equal(state.incrementalGeneration, restarted.generation);
  assert.equal(state.incrementalFrozenBoundaryMs, 90);
  assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), 90);
  assert.equal(lifecycle.isIncrementalLeaseEligible(lease), false);
  assert.equal(lifecycle.isIncrementalLeaseEligible(restarted), true);
});

for (const terminal of ['complete', 'fail', 'cancel'] as const) {
  test(`incremental ${terminal} clears persisted frozen provenance`, (t) => {
    const { database, repository, lifecycle, lease } = setupIncrementalProvenance(t);
    if (terminal === 'complete') {
      lifecycle.completeIncremental(lease, FINALIZED_AT);
    } else if (terminal === 'fail') {
      lifecycle.failIncremental(
        lease,
        fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
        FINALIZED_AT
      );
    } else {
      lifecycle.cancelIncremental(lease, FINALIZED_AT);
    }

    const state = incrementalProvenanceState(repository, OKX_MARKET);
    assert.equal(
      state.incrementalStatus,
      terminal === 'fail' ? 'INCOMPLETE' : 'IDLE'
    );
    assert.equal(state.incrementalFrozenBoundaryMs, null);
    assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), null);
    assert.equal(lifecycle.isIncrementalLeaseEligible(lease), false);
  });
}

for (const transition of ['inactive', 'reactivation'] as const) {
  test(`${transition} transition clears and fences incremental frozen provenance`, (t) => {
    const { database, repository, lifecycle, lease } = setupIncrementalProvenance(t);
    repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET, false)],
      TRANSITIONED_AT
    );
    if (transition === 'reactivation') {
      repository.applyCompleteDiscovery(
        'okx',
        [observation(OKX_MARKET)],
        REACTIVATED_AT
      );
    }

    const state = incrementalProvenanceState(repository, OKX_MARKET);
    assert.equal(state.incrementalStatus, 'IDLE');
    assert.equal(state.incrementalFrozenBoundaryMs, null);
    assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), null);
    assert.equal(lifecycle.isIncrementalLeaseEligible(lease), false);
  });
}

const forgedIncrementalBoundaryCases = [
  { name: 'different non-null boundary', frozenBoundaryMs: 100 },
  { name: 'null instead of non-null', frozenBoundaryMs: null },
  { name: 'zero instead of non-zero', frozenBoundaryMs: 0 }
] as const;

const forgedIncrementalOperations = [
  'currentness',
  'page',
  'complete',
  'fail',
  'cancel'
] as const;

for (const boundaryCase of forgedIncrementalBoundaryCases) {
  for (const operation of forgedIncrementalOperations) {
    test(`incremental ${operation} rejects ${boundaryCase.name} with zero writes`, (t) => {
      const { database, lifecycle, lease } = setupIncrementalProvenance(t);
      const forged = {
        ...lease,
        frozenBoundaryMs: boundaryCase.frozenBoundaryMs
      };
      const before = fundingPersistenceSnapshot(database);

      if (operation === 'currentness') {
        assert.deepEqual({
          eligible: lifecycle.isIncrementalLeaseEligible(forged),
          persistenceUnchanged: fundingPersistenceSnapshot(database) === before
        }, {
          eligible: false,
          persistenceUnchanged: true
        });
      } else {
        const error = invocationError(() => {
          if (operation === 'page') {
            lifecycle.commitIncrementalPage(
              forged,
              [rateRecord(OKX_MARKET, '0.0002', 90)],
              FINALIZED_AT
            );
          } else if (operation === 'complete') {
            lifecycle.completeIncremental(forged, FINALIZED_AT);
          } else if (operation === 'fail') {
            lifecycle.failIncremental(
              forged,
              fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
              FINALIZED_AT
            );
          } else {
            lifecycle.cancelIncremental(forged, FINALIZED_AT);
          }
        });
        assert.deepEqual({
          staleError:
            error instanceof fundingRateRepositoryModule.StaleFundingTaskError,
          persistenceUnchanged: fundingPersistenceSnapshot(database) === before
        }, {
          staleError: true,
          persistenceUnchanged: true
        }, `${operation} must fail specifically as stale provenance`);
      }
    });
  }
}

test('schema constrains incremental provenance type, range, state, and latest relation', (t) => {
  const { database } = setupIncrementalProvenance(t);
  const invalidAssignments = [
    "incremental_frozen_boundary_ms = 'broken'",
    'incremental_frozen_boundary_ms = -1',
    `incremental_frozen_boundary_ms = ${MAX_UNIX_TIMESTAMP_MS + 1}`,
    'incremental_frozen_boundary_ms = 71',
    "incremental_status = 'IDLE', incremental_ended_at = '2026-09-06T00:09:00.000Z'"
  ];

  for (const assignment of invalidAssignments) {
    const before = fundingPersistenceSnapshot(database);
    assert.throws(() => database.prepare(`
      UPDATE funding_rate_sync_state SET ${assignment}
      WHERE exchange_id = ? AND exchange_market_id = ?
    `).run(OKX_MARKET.exchangeId, OKX_MARKET.exchangeMarketId), /constraint/i);
    assert.equal(fundingPersistenceSnapshot(database), before);
  }
});

test('an aborted incremental restart preserves generation and frozen provenance atomically', (t) => {
  const { database, lifecycle, lease } = setupIncrementalProvenance(t);
  assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), 70);
  database.exec(`
    CREATE TRIGGER test_abort_incremental_restart
    BEFORE UPDATE OF incremental_generation ON funding_rate_sync_state
    WHEN OLD.exchange_market_id = '${OKX_MARKET.exchangeMarketId}'
      AND NEW.incremental_generation = OLD.incremental_generation + 1
    BEGIN
      SELECT RAISE(ABORT, 'test incremental restart failed');
    END;
  `);
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => lifecycle.restartInterruptedIncremental(OKX_MARKET, LATER_AT),
    /test incremental restart failed|funding incremental/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
  assert.equal(lifecycle.isIncrementalLeaseEligible(lease), true);
  assert.equal(persistedIncrementalBoundary(database, OKX_MARKET), 70);
});

const corruptIncrementalProvenanceCases = [
  {
    name: 'terminal state retaining a boundary',
    prepare: (lifecycle: Task5FundingRateRepository, lease: IncrementalLease) => {
      lifecycle.cancelIncremental(lease, FINALIZED_AT);
    },
    assignment: 'incremental_frozen_boundary_ms = 70'
  },
  {
    name: 'RUNNING boundary beyond persisted latest',
    prepare: () => {},
    assignment: 'incremental_frozen_boundary_ms = 71'
  },
  {
    name: 'non-integer boundary',
    prepare: () => {},
    assignment: "incremental_frozen_boundary_ms = 'broken'"
  },
  {
    name: 'negative boundary',
    prepare: () => {},
    assignment: 'incremental_frozen_boundary_ms = -1'
  },
  {
    name: 'out-of-range boundary',
    prepare: () => {},
    assignment: `incremental_frozen_boundary_ms = ${MAX_UNIX_TIMESTAMP_MS + 1}`
  }
] as const;

for (const corruptCase of corruptIncrementalProvenanceCases) {
  test(`fails closed across incremental entries on corrupt provenance: ${corruptCase.name}`, (t) => {
    const { database, repository, lifecycle, lease } = setupIncrementalProvenance(t);
    corruptCase.prepare(lifecycle, lease);
    setStateIgnoringChecks(database, OKX_MARKET, corruptCase.assignment);
    const before = fundingPersistenceSnapshot(database);
    const operations: ReadonlyArray<readonly [string, () => unknown]> = [
      ['read', () => repository.listMarketStates('okx')],
      ['restart', () => lifecycle.restartInterruptedIncremental(
        OKX_MARKET,
        LATER_AT
      )],
      ['currentness', () => lifecycle.isIncrementalLeaseEligible(lease)],
      ['page', () => lifecycle.commitIncrementalPage(
        lease,
        [rateRecord(OKX_MARKET, '0.0002', 69)],
        LATER_AT
      )],
      ['complete', () => lifecycle.completeIncremental(lease, LATER_AT)],
      ['fail', () => lifecycle.failIncremental(
        lease,
        fundingTaskFailure('SOURCE_RESPONSE_INVALID'),
        LATER_AT
      )],
      ['cancel', () => lifecycle.cancelIncremental(lease, LATER_AT)]
    ];

    for (const [operation, invoke] of operations) {
      const error = invocationError(invoke);
      assert.equal(error instanceof Error, true, operation);
      if (!(error instanceof Error)) assert.fail(operation);
      assert.match(error.message, /okx/i, operation);
      assert.match(error.message, /BTC-USDT-SWAP/i, operation);
      assert.match(
        error.message,
        /incremental.*(?:frozen.*boundary|provenance)|incremental_frozen_boundary_ms/i,
        operation
      );
      assert.equal(fundingPersistenceSnapshot(database), before, operation);
    }
  });
}

const corruptFundingStateCases = [
  {
    name: 'coverage status enum',
    market: OKX_MARKET,
    assignment: "coverage_status = 'BROKEN'",
    field: 'coverage.*status'
  },
  {
    name: 'incremental status enum',
    market: OKX_MARKET,
    assignment: "incremental_status = 'BROKEN'",
    field: 'incremental.*status'
  },
  {
    name: 'coverage task kind enum',
    market: OKX_MARKET,
    assignment: "coverage_task_kind = 'BROKEN'",
    field: 'coverage.*kind'
  },
  {
    name: 'negative coverage token',
    market: OKX_MARKET,
    assignment: 'coverage_generation = -1',
    field: 'coverage.*generation'
  },
  {
    name: 'unsafe incremental token',
    market: OKX_MARKET,
    assignment: `incremental_generation = ${MAX_SQLITE_SAFE_INTEGER + 1}`,
    field: 'incremental.*generation'
  },
  {
    name: 'BACKFILLING without frozen fields',
    market: OKX_MARKET,
    assignment: "coverage_status = 'BACKFILLING'",
    field: 'coverage'
  },
  {
    name: 'INCOMPLETE without terminal failure',
    market: OKX_MARKET,
    assignment: "coverage_status = 'INCOMPLETE'",
    field: 'coverage'
  },
  {
    name: 'CAUGHT_UP with mismatched cutoff',
    market: OKX_MARKET,
    assignment: `
      coverage_status = 'CAUGHT_UP',
      coverage_task_kind = 'INITIAL',
      coverage_cutoff_ms = 10,
      last_caught_up_generation = 0,
      last_caught_up_cutoff_ms = 11,
      last_exhausted_at = '${COMPLETED_AT.toISOString()}',
      last_exhaustion_evidence_json =
        '{"exchangeId":"okx","generation":0,"cutoffMs":11,"explicitEmpty":true,"finalRequestAfterMs":null}',
      coverage_started_at = '${STARTED_AT.toISOString()}',
      coverage_ended_at = '${COMPLETED_AT.toISOString()}',
      coverage_last_success_at = '${COMPLETED_AT.toISOString()}'
    `,
    field: 'cutoff'
  },
  {
    name: 'PENDING with forged success evidence',
    market: OKX_MARKET,
    assignment: `
      last_caught_up_generation = 0,
      last_caught_up_cutoff_ms = 10,
      last_exhausted_at = '${COMPLETED_AT.toISOString()}',
      last_exhaustion_evidence_json =
        '{"exchangeId":"okx","generation":0,"cutoffMs":10,"explicitEmpty":true,"finalRequestAfterMs":null}',
      coverage_last_success_at = '${COMPLETED_AT.toISOString()}'
    `,
    field: 'PENDING|evidence'
  },
  {
    name: 'OKX anchor generation mismatch',
    market: OKX_MARKET,
    assignment: `
      coverage_status = 'BACKFILLING',
      coverage_generation = 2,
      coverage_task_kind = 'INITIAL',
      coverage_cutoff_ms = 10,
      coverage_started_at = '${STARTED_AT.toISOString()}',
      okx_resume_after_ms = 9,
      okx_resume_generation = 1
    `,
    field: 'anchor|okx.*generation'
  },
  {
    name: 'Bitget state carrying an OKX anchor',
    market: BITGET_MARKET,
    assignment: `
      coverage_status = 'BACKFILLING',
      coverage_generation = 1,
      coverage_task_kind = 'INITIAL',
      coverage_cutoff_ms = 10,
      coverage_started_at = '${STARTED_AT.toISOString()}',
      okx_resume_after_ms = 9,
      okx_resume_generation = 1
    `,
    field: 'anchor|okx'
  },
  {
    name: 'reactivation marker without threshold',
    market: OKX_MARKET,
    assignment: 'reactivation_required = 1, reactivation_after_generation = NULL',
    field: 'reactivation'
  },
  {
    name: 'orphan reactivation threshold',
    market: OKX_MARKET,
    assignment: 'reactivation_required = 0, reactivation_after_generation = 1',
    field: 'reactivation'
  },
  {
    name: 'active market with inactive final proof',
    market: OKX_MARKET,
    assignment: `inactive_final_caught_up_at = '${COMPLETED_AT.toISOString()}'`,
    field: 'inactive.*final'
  },
  {
    name: 'RUNNING incremental without start time',
    market: OKX_MARKET,
    assignment: "incremental_status = 'RUNNING'",
    field: 'incremental'
  },
  {
    name: 'INCOMPLETE incremental without failure',
    market: OKX_MARKET,
    assignment: "incremental_status = 'INCOMPLETE'",
    field: 'incremental'
  },
  {
    name: 'semantically mismatched exhaustion evidence',
    market: OKX_MARKET,
    assignment: `
      coverage_status = 'CAUGHT_UP',
      coverage_task_kind = 'INITIAL',
      coverage_cutoff_ms = 10,
      last_caught_up_generation = 0,
      last_caught_up_cutoff_ms = 10,
      last_exhausted_at = '${COMPLETED_AT.toISOString()}',
      last_exhaustion_evidence_json =
        '{"exchangeId":"bitget","generation":1,"cutoffMs":12,"matchingRounds":[1,2],"emptyPageNo":1}',
      coverage_started_at = '${STARTED_AT.toISOString()}',
      coverage_ended_at = '${COMPLETED_AT.toISOString()}',
      coverage_last_success_at = '${COMPLETED_AT.toISOString()}'
    `,
    field: 'evidence'
  }
] as const;

for (const corruptCase of corruptFundingStateCases) {
  test(`fails closed on corrupt funding state: ${corruptCase.name}`, (t) => {
    const { database, repository } = setupFundingRepository(t);
    repository.applyCompleteDiscovery(
      corruptCase.market.exchangeId,
      [observation(corruptCase.market)],
      DISCOVERED_AT
    );
    setStateIgnoringChecks(
      database,
      corruptCase.market,
      corruptCase.assignment
    );

    assertCorruptStateFailsClosed(
      repository,
      corruptCase.market,
      corruptCase.field
    );
  });
}

test('rolls back all repeated discovery observations when a later state update fails', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const otherMarket = {
    exchangeId: 'okx',
    exchangeMarketId: 'ETH-USDT-SWAP',
    symbol: 'ETH/USDT:USDT'
  } as const satisfies FundingMarketIdentity;
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET), observation(otherMarket)],
    DISCOVERED_AT
  );
  database.exec(`
    CREATE TRIGGER test_abort_second_discovery_update
    BEFORE UPDATE ON funding_rate_sync_state
    WHEN OLD.exchange_market_id = '${otherMarket.exchangeMarketId}'
    BEGIN
      SELECT RAISE(ABORT, 'test discovery update failed');
    END;
  `);
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET), observation(otherMarket)],
      FIRST_OBSERVED_AT
    ),
    /test discovery update failed|discovery transaction failed/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('rolls back Bitget TEMP cleanup when coverage completion state update fails', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const lease = startCoverage(repository, BITGET_MARKET);
  const record = rateRecord(BITGET_MARKET, '0.0001');
  for (const round of [1, 2] as const) {
    repository.commitCoveragePage(
      lease,
      [record],
      { exchangeId: 'bitget', round },
      FIRST_OBSERVED_AT
    );
  }
  database.exec(`
    CREATE TRIGGER test_abort_coverage_terminal
    BEFORE UPDATE ON funding_rate_sync_state
    WHEN OLD.exchange_market_id = '${BITGET_MARKET.exchangeMarketId}'
    BEGIN
      SELECT RAISE(ABORT, 'test coverage terminal failed');
    END;
  `);
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => lifecycle.completeCoverage(
      lease,
      bitgetEvidence(lease),
      COMPLETED_AT
    ),
    /test coverage terminal failed|funding page transaction failed/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

test('rolls back an incremental revision, insert, bounds, and state on page failure', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    DISCOVERED_AT
  );
  const coverage = repository.startCoverage(
    OKX_MARKET,
    'INITIAL',
    COVERAGE_CUTOFF_MS,
    STARTED_AT
  );
  const original = rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A');
  commitOkxPage(
    repository,
    coverage,
    [original],
    FIRST_OBSERVED_AT
  );
  lifecycle.completeCoverage(
    coverage,
    okxEvidence(coverage, FUNDING_TIMESTAMP_MS),
    COMPLETED_AT
  );
  const incremental = lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT);
  const failingTimestamp = FUNDING_TIMESTAMP_MS - 1;
  database.exec(`
    CREATE TRIGGER test_abort_incremental_second_record
    BEFORE INSERT ON funding_rate_history
    WHEN NEW.funding_timestamp_ms = ${failingTimestamp}
    BEGIN
      SELECT RAISE(ABORT, 'test incremental page failed');
    END;
  `);
  const before = fundingPersistenceSnapshot(database);

  assert.throws(
    () => lifecycle.commitIncrementalPage(
      incremental,
      [
        rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B'),
        rateRecord(OKX_MARKET, '-0.0003', failingTimestamp, 'new')
      ],
      FINALIZED_AT
    ),
    /test incremental page failed|funding page transaction failed/i
  );
  assert.equal(fundingPersistenceSnapshot(database), before);
});

const invalidOkxCompletionRelationCases = [
  {
    name: 'non-null final after without a committed anchor',
    commitAnchor: false,
    finalRequestAfterMs: FUNDING_TIMESTAMP_MS
  },
  {
    name: 'null final after with a committed anchor',
    commitAnchor: true,
    finalRequestAfterMs: null
  },
  {
    name: 'final after greater than the committed anchor',
    commitAnchor: true,
    finalRequestAfterMs: FUNDING_TIMESTAMP_MS + 1
  }
] as const;

for (const relationCase of invalidOkxCompletionRelationCases) {
  test(`rejects OKX completion evidence with ${relationCase.name}`, (t) => {
    const { database, repository } = setupFundingRepository(t);
    const lifecycle = task5Repository(repository);
    const lease = startCoverage(repository, OKX_MARKET);
    if (relationCase.commitAnchor) {
      commitOkxPage(
        repository,
        lease,
        [rateRecord(OKX_MARKET, '0.0001')],
        FIRST_OBSERVED_AT,
        FUNDING_TIMESTAMP_MS
      );
    }
    const before = fundingPersistenceSnapshot(database);

    const error = invocationError(() => lifecycle.completeCoverage(
      lease,
      okxEvidence(lease, relationCase.finalRequestAfterMs),
      COMPLETED_AT
    ));

    assert.deepEqual({
      rejectedForEvidenceRelation:
        error instanceof Error
        && /evidence|final request|anchor/i.test(error.message),
      persistenceUnchanged: fundingPersistenceSnapshot(database) === before
    }, {
      rejectedForEvidenceRelation: true,
      persistenceUnchanged: true
    });
  });
}

test('accepts every legal OKX final-after and committed-anchor boundary', (t) => {
  const legalCases = [
    { name: 'null/null', timestamps: [] as number[], finalRequestAfterMs: null },
    {
      name: 'equal',
      timestamps: [FUNDING_TIMESTAMP_MS],
      finalRequestAfterMs: FUNDING_TIMESTAMP_MS
    },
    {
      name: 'strict-less',
      timestamps: [FUNDING_TIMESTAMP_MS, FUNDING_TIMESTAMP_MS - 2],
      finalRequestAfterMs: FUNDING_TIMESTAMP_MS - 2
    }
  ] as const;

  for (const legalCase of legalCases) {
    const { repository } = setupFundingRepository(t);
    const lifecycle = task5Repository(repository);
    const lease = startCoverage(repository, OKX_MARKET);
    if (legalCase.timestamps.length > 0) {
      const records = legalCase.timestamps.map((timestampMs, index) => (
        rateRecord(OKX_MARKET, `0.000${index + 1}`, timestampMs)
      ));
      commitOkxPage(
        repository,
        lease,
        records,
        FIRST_OBSERVED_AT,
        FUNDING_TIMESTAMP_MS
      );
    }

    lifecycle.completeCoverage(
      lease,
      okxEvidence(lease, legalCase.finalRequestAfterMs),
      COMPLETED_AT
    );
    const state = onlyMarketState(repository, OKX_MARKET);
    assert.equal(state.coverageStatus, 'CAUGHT_UP', legalCase.name);
    assert.equal(
      state.lastExhaustionEvidenceJson,
      JSON.stringify(okxEvidence(lease, legalCase.finalRequestAfterMs)),
      legalCase.name
    );
  }
});

const invalidPriorProofGenerationCases = [
  { status: 'BACKFILLING', relation: 'equal' },
  { status: 'BACKFILLING', relation: 'future' },
  { status: 'INCOMPLETE', relation: 'equal' },
  { status: 'INCOMPLETE', relation: 'future' }
] as const;

for (const proofCase of invalidPriorProofGenerationCases) {
  test(`rejects ${proofCase.relation} prior proof generation in ${proofCase.status}`, (t) => {
    const { database, repository } = setupFundingRepository(t);
    const lifecycle = task5Repository(repository);
    completeEmptyOkxCoverage(lifecycle);
    const currentLease = repository.startCoverage(
      OKX_MARKET,
      'PERIODIC',
      COVERAGE_CUTOFF_MS + 1,
      RESTARTED_AT
    );
    if (proofCase.status === 'INCOMPLETE') {
      lifecycle.failCoverage(
        currentLease,
        fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
        FINALIZED_AT
      );
    }
    const invalidGeneration = proofCase.relation === 'equal'
      ? currentLease.generation
      : currentLease.generation + 1;
    rewritePriorProofGeneration(database, repository, invalidGeneration);
    const before = fundingPersistenceSnapshot(database);

    const listError = invocationError(() => repository.listMarketStates('okx'));
    const startError = invocationError(() => lifecycle.startIncremental(
      OKX_MARKET,
      LATER_AT
    ));

    assert.deepEqual({
      listRejectedWithContext: errorContains(listError, [
        'okx',
        OKX_MARKET.exchangeMarketId,
        'generation'
      ]),
      leaseRejectedWithContext: errorContains(startError, [
        'okx',
        OKX_MARKET.exchangeMarketId,
        'generation'
      ]),
      persistenceUnchanged: fundingPersistenceSnapshot(database) === before
    }, {
      listRejectedWithContext: true,
      leaseRejectedWithContext: true,
      persistenceUnchanged: true
    });
  });
}

test('allows incremental work when retained proof generation is strictly prior', (t) => {
  for (const status of ['BACKFILLING', 'INCOMPLETE'] as const) {
    const { repository } = setupFundingRepository(t);
    const lifecycle = task5Repository(repository);
    completeEmptyOkxCoverage(lifecycle);
    const coverage = repository.startCoverage(
      OKX_MARKET,
      'PERIODIC',
      COVERAGE_CUTOFF_MS + 1,
      RESTARTED_AT
    );
    if (status === 'INCOMPLETE') {
      lifecycle.failCoverage(
        coverage,
        fundingTaskFailure('REQUEST_RETRY_EXHAUSTED'),
        FINALIZED_AT
      );
    }
    const state = onlyMarketState(repository, OKX_MARKET);
    assert.equal(state.coverageStatus, status);
    assert.notEqual(state.lastCaughtUpGeneration, null);
    if (state.lastCaughtUpGeneration === null) {
      assert.fail('expected retained prior coverage proof');
    }
    assert.ok(state.lastCaughtUpGeneration < state.coverageGeneration);

    const incremental = lifecycle.startIncremental(OKX_MARKET, LATER_AT);
    assert.equal(incremental.generation, 1);
    assert.equal(
      onlyMarketState(repository, OKX_MARKET).incrementalStatus,
      'RUNNING'
    );
  }
});

test('rejects a semantic content hash mismatch before an incremental revision', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lifecycle = task5Repository(repository);
  const coverage = startCoverage(repository, OKX_MARKET);
  const recordA = rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A');
  commitOkxPage(repository, coverage, [recordA], FIRST_OBSERVED_AT);
  lifecycle.completeCoverage(
    coverage,
    okxEvidence(coverage, FUNDING_TIMESTAMP_MS),
    COMPLETED_AT
  );
  const incremental = lifecycle.startIncremental(OKX_MARKET, RESTARTED_AT);
  const recordB = rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B');
  const forged = { ...recordB, contentHash: recordA.contentHash };
  const before = fundingPersistenceSnapshot(database);

  const error = invocationError(() => lifecycle.commitIncrementalPage(
    incremental,
    [forged],
    FINALIZED_AT
  ));

  assert.deepEqual({
    rejectedForHash: errorContains(error, ['content', 'hash']),
    persistenceUnchanged: fundingPersistenceSnapshot(database) === before
  }, {
    rejectedForHash: true,
    persistenceUnchanged: true
  });
});

test('fails closed when a stored content hash disagrees with canonical content', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  commitOkxPage(
    repository,
    lease,
    [rateRecord(OKX_MARKET, '0.0001')],
    FIRST_OBSERVED_AT
  );
  const forgedHash = '0'.repeat(64);
  const update = database.prepare(`
    UPDATE funding_rate_history
    SET content_hash = ?
    WHERE exchange_id = 'okx'
      AND exchange_market_id = 'BTC-USDT-SWAP'
  `).run(forgedHash);
  assert.equal(update.changes, 1);

  const error = invocationError(() => repository.listHistory(OKX_MARKET));

  assert.equal(errorContains(error, [
    'okx',
    OKX_MARKET.exchangeMarketId,
    'hash'
  ]), true);
});

test('rejects an active accessor without executing it or writing discovery state', (t) => {
  const { database, repository } = setupFundingRepository(t);
  let accessorReads = 0;
  const accessorObservation = Object.defineProperty(
    { ...OKX_MARKET },
    'active',
    {
      enumerable: true,
      get(): unknown {
        accessorReads += 1;
        return accessorReads === 1 ? true : 'not-a-boolean';
      }
    }
  ) as unknown as FundingMarketObservation;
  const before = fundingPersistenceSnapshot(database);

  const error = invocationError(() => repository.applyCompleteDiscovery(
    'okx',
    [accessorObservation],
    DISCOVERED_AT
  ));

  assert.deepEqual({
    rejectedForActive: errorContains(error, ['active']),
    accessorReads,
    persistenceUnchanged: fundingPersistenceSnapshot(database) === before
  }, {
    rejectedForActive: true,
    accessorReads: 0,
    persistenceUnchanged: true
  });
});

test('uses the intrinsic Date value without calling toISOString overrides', (t) => {
  class OverriddenDate extends Date {
    overrideCalls = 0;

    override toISOString(): string {
      this.overrideCalls += 1;
      return '2026-99-99T99:99:99.999Z';
    }
  }

  let ownOverrideCalls = 0;
  const ownOverrideDate = new Date(DISCOVERED_AT.getTime());
  Object.defineProperty(ownOverrideDate, 'toISOString', {
    value(): string {
      ownOverrideCalls += 1;
      return '2026-99-99T99:99:99.999Z';
    }
  });
  const subclassDate = new OverriddenDate(DISCOVERED_AT.getTime());
  const dateCases = [
    {
      name: 'subclass override',
      date: subclassDate,
      calls: (): number => subclassDate.overrideCalls
    },
    {
      name: 'instance override',
      date: ownOverrideDate,
      calls: (): number => ownOverrideCalls
    }
  ] as const;

  for (const dateCase of dateCases) {
    const { database, repository } = setupFundingRepository(t);
    const error = invocationError(() => repository.applyCompleteDiscovery(
      'okx',
      [observation(OKX_MARKET)],
      dateCase.date
    ));
    const persisted = database.prepare(`
      SELECT active_observed_at
      FROM funding_rate_sync_state
      WHERE exchange_id = 'okx'
        AND exchange_market_id = 'BTC-USDT-SWAP'
    `).pluck().get();

    assert.deepEqual({
      accepted: error === null,
      overrideCalls: dateCase.calls(),
      persisted
    }, {
      accepted: true,
      overrideCalls: 0,
      persisted: DISCOVERED_AT.toISOString()
    }, dateCase.name);
  }
});

test('rejects an intrinsically invalid Date without calling its valid-looking override', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const invalidDate = new Date(Number.NaN);
  let overrideCalls = 0;
  Object.defineProperty(invalidDate, 'toISOString', {
    value(): string {
      overrideCalls += 1;
      return DISCOVERED_AT.toISOString();
    }
  });
  const before = fundingPersistenceSnapshot(database);

  const error = invocationError(() => repository.applyCompleteDiscovery(
    'okx',
    [observation(OKX_MARKET)],
    invalidDate
  ));

  assert.deepEqual({
    rejectedForDate: errorContains(error, ['valid', 'date']),
    overrideCalls,
    persistenceUnchanged: fundingPersistenceSnapshot(database) === before
  }, {
    rejectedForDate: true,
    overrideCalls: 0,
    persistenceUnchanged: true
  });
});
