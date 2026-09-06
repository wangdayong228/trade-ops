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
import {
  fundingTaskFailure,
  MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES,
  type CoverageLease,
  type FundingRateRepository,
  type FundingTaskFailure,
  type FundingTaskFailureCode
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
  market: FundingMarketIdentity
): FundingMarketObservation {
  return { ...market, active: true };
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

test('revises canonical field changes even when supplied content hashes are equal', (t) => {
  const { database, repository } = setupFundingRepository(t);
  const lease = startCoverage(repository, OKX_MARKET);
  const recordA = rateRecord(OKX_MARKET, '0.0001', FUNDING_TIMESTAMP_MS, 'A');
  const computedB = rateRecord(OKX_MARKET, '0.0002', FUNDING_TIMESTAMP_MS, 'B');
  const syntheticCollision = {
    ...computedB,
    contentHash: recordA.contentHash
  };
  commitOkxPage(repository, lease, [recordA], FIRST_OBSERVED_AT);

  const result = commitOkxPage(
    repository,
    lease,
    [syntheticCollision],
    SECOND_OBSERVED_AT
  );

  assert.deepEqual(result, {
    inserted: 0,
    unchanged: 0,
    revised: 1,
    revisedKeys: [{
      fundingTimestampMs: FUNDING_TIMESTAMP_MS,
      previousContentHash: recordA.contentHash,
      currentContentHash: recordA.contentHash
    }]
  });
  assert.equal(revisionRows(database).length, 1);
  assert.equal(historyRow(database, OKX_MARKET).funding_rate, '0.0002');
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
