import Database from 'better-sqlite3';
import {
  settledFundingRate,
  type FundingExchangeId,
  type FundingMarketIdentity,
  type FundingMarketObservation,
  type SettledFundingRate
} from '../funding-rates/funding-rate-record.js';
import {
  SQLITE_FUNDING_RATE_SCHEMA,
  SQLITE_FUNDING_RATE_SCHEMA_OBJECTS,
  type SqliteFundingRateSchemaScope
} from './funding-rate-schema.js';
import {
  IncompleteFundingDiscoveryError,
  MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES,
  StaleFundingTaskError,
  fundingTaskFailure,
  type CoverageLease,
  type CoveragePageCheckpoint,
  type FundingCoverageKind,
  type FundingCoverageStatus,
  type FundingDiscoveryResult,
  type FundingExhaustionEvidence,
  type FundingIncrementalStatus,
  type FundingMarketState,
  type FundingPageWriteResult,
  type FundingRateRepository,
  type FundingTaskFailure,
  type FundingTaskFailureCode,
  type IncrementalLease
} from './funding-rate-repository.js';

const FUNDING_SCHEMA_ERROR = 'SQLite funding rate schema initialization failed';
const MAX_UNIX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const COVERAGE_STATUSES = new Set<FundingCoverageStatus>([
  'PENDING',
  'BACKFILLING',
  'CAUGHT_UP',
  'INCOMPLETE'
]);
const INCREMENTAL_STATUSES = new Set<FundingIncrementalStatus>([
  'IDLE',
  'RUNNING',
  'INCOMPLETE'
]);
const COVERAGE_KINDS = new Set<FundingCoverageKind>([
  'INITIAL',
  'PERIODIC',
  'INACTIVE_FINAL',
  'REACTIVATION'
]);
const FAILURE_CODES = new Set<FundingTaskFailureCode>([
  'COVERAGE_CANCELED_BY_MARKET_STATE',
  'REQUEST_RETRY_EXHAUSTED',
  'SOURCE_RESPONSE_INVALID',
  'CURSOR_NOT_ADVANCING',
  'BITGET_BOUNDARY_NOT_SEEN',
  'BITGET_SCAN_NOT_CONVERGED',
  'DATABASE_WRITE_FAILED'
]);

interface TableInfoDbRow {
  readonly name: unknown;
  readonly type: unknown;
  readonly pk: unknown;
}

interface SqliteMasterDbRow {
  readonly type: unknown;
  readonly name: unknown;
  readonly tbl_name: unknown;
  readonly sql: unknown;
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

interface FundingStateDbRow {
  readonly exchange_id: unknown;
  readonly exchange_market_id: unknown;
  readonly symbol: unknown;
  readonly active: unknown;
  readonly active_observed_at: unknown;
  readonly active_changed_at: unknown;
  readonly reactivation_required: unknown;
  readonly reactivation_after_generation: unknown;
  readonly inactive_final_caught_up_at: unknown;
  readonly coverage_status: unknown;
  readonly coverage_generation: unknown;
  readonly coverage_task_kind: unknown;
  readonly coverage_cutoff_ms: unknown;
  readonly last_caught_up_generation: unknown;
  readonly last_caught_up_cutoff_ms: unknown;
  readonly last_exhausted_at: unknown;
  readonly last_exhaustion_evidence_json: unknown;
  readonly okx_resume_after_ms: unknown;
  readonly okx_resume_generation: unknown;
  readonly oldest_funding_timestamp_ms: unknown;
  readonly latest_funding_timestamp_ms: unknown;
  readonly coverage_started_at: unknown;
  readonly coverage_ended_at: unknown;
  readonly coverage_last_success_at: unknown;
  readonly coverage_error_code: unknown;
  readonly coverage_error_summary: unknown;
  readonly incremental_status: unknown;
  readonly incremental_generation: unknown;
  readonly incremental_started_at: unknown;
  readonly incremental_ended_at: unknown;
  readonly incremental_last_success_at: unknown;
  readonly incremental_error_code: unknown;
  readonly incremental_error_summary: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ValidatedHistoryRow extends SettledFundingRate {
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

function schemaError(): Error {
  return new Error(FUNDING_SCHEMA_ERROR);
}

function sqliteIntegerEquals(value: unknown, expected: number): boolean {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value === expected
  ) || (
    typeof value === 'bigint'
    && value === BigInt(expected)
  );
}

function sqliteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number {
  if (typeof value === 'number') {
    if (
      Number.isSafeInteger(value)
      && value >= minimum
      && value <= maximum
    ) {
      return value;
    }
  } else if (typeof value === 'bigint') {
    const minimumBigInt = BigInt(minimum);
    const maximumBigInt = BigInt(maximum);
    if (value >= minimumBigInt && value <= maximumBigInt) {
      const converted = Number(value);
      if (Number.isSafeInteger(converted)) return converted;
    }
  }
  throw new Error(`invalid ${context}: expected a safe SQLite integer`);
}

function nullableSqliteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number | null {
  return value === null
    ? null
    : sqliteInteger(value, minimum, maximum, context);
}

function exchangeId(value: unknown, context: string): FundingExchangeId {
  if (value !== 'bitget' && value !== 'okx') {
    throw new Error(`invalid ${context}: unsupported exchange`);
  }
  return value;
}

function nonEmptyString(value: unknown, context: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
  ) {
    throw new Error(`invalid ${context}: expected a non-empty string`);
  }
  return value;
}

function isoTimestamp(value: unknown, context: string): string {
  const timestamp = nonEmptyString(value, context);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      throw new Error('not canonical');
    }
  } catch {
    throw new Error(`invalid ${context}: expected a canonical UTC timestamp`);
  }
  return timestamp;
}

function nullableIsoTimestamp(value: unknown, context: string): string | null {
  return value === null ? null : isoTimestamp(value, context);
}

function dateTimestamp(value: Date, context: string): string {
  if (!(value instanceof Date)) {
    throw new Error(`invalid ${context}: expected a Date`);
  }
  try {
    return value.toISOString();
  } catch {
    throw new Error(`invalid ${context}: expected a valid Date`);
  }
}

function timestampMs(value: unknown, context: string): number {
  const result = sqliteInteger(value, 0, MAX_UNIX_TIMESTAMP_MS, context);
  if (Number.isNaN(new Date(result).getTime())) {
    throw new Error(`invalid ${context}: expected a valid Unix millisecond timestamp`);
  }
  return result;
}

function nullableTimestampMs(value: unknown, context: string): number | null {
  return value === null ? null : timestampMs(value, context);
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  context: string
): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    throw new Error(`invalid ${context}: unsupported value`);
  }
  return value as T;
}

function nullableEnumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  context: string
): T | null {
  return value === null ? null : enumValue(value, values, context);
}

function sqliteBoolean(value: unknown, context: string): boolean {
  const integer = sqliteInteger(value, 0, 1, context);
  return integer === 1;
}

function parsedObjectJson(value: unknown, context: string): object {
  if (typeof value !== 'string') {
    throw new Error(`invalid ${context}: expected JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`invalid ${context}: expected valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid ${context}: expected a JSON object`);
  }
  return parsed;
}

function marketIdentity(market: FundingMarketIdentity): FundingMarketIdentity {
  return {
    exchangeId: exchangeId(market.exchangeId, 'funding market exchange_id'),
    exchangeMarketId: nonEmptyString(
      market.exchangeMarketId,
      'funding market exchange_market_id'
    ),
    symbol: nonEmptyString(market.symbol, 'funding market symbol')
  };
}

function contentHash(value: unknown, context: string): string {
  if (typeof value !== 'string' || !CONTENT_HASH_PATTERN.test(value)) {
    throw new Error(`invalid ${context}: expected a lowercase SHA-256 hash`);
  }
  return value;
}

function corruptHistory(
  market: FundingMarketIdentity,
  field: string
): never {
  throw new Error(
    `invalid funding history for ${market.exchangeId}/${market.exchangeMarketId}: ${field}`
  );
}

function validateHistoryRow(
  row: HistoryDbRow,
  market: FundingMarketIdentity
): ValidatedHistoryRow {
  let storedExchangeId: FundingExchangeId;
  let storedMarketId: string;
  let symbol: string;
  try {
    storedExchangeId = exchangeId(row.exchange_id, 'history exchange_id');
  } catch {
    return corruptHistory(market, 'exchange_id');
  }
  try {
    storedMarketId = nonEmptyString(
      row.exchange_market_id,
      'history exchange_market_id'
    );
  } catch {
    return corruptHistory(market, 'exchange_market_id');
  }
  if (
    storedExchangeId !== market.exchangeId
    || storedMarketId !== market.exchangeMarketId
  ) {
    return corruptHistory(market, 'market_identity');
  }
  try {
    symbol = nonEmptyString(row.symbol, 'history symbol');
  } catch {
    return corruptHistory(market, 'symbol');
  }
  if (symbol !== market.symbol) return corruptHistory(market, 'symbol');

  let fundingTimestampMs: number;
  try {
    fundingTimestampMs = timestampMs(
      row.funding_timestamp_ms,
      'history funding_timestamp_ms'
    );
  } catch {
    return corruptHistory(market, 'funding_timestamp_ms');
  }
  if (typeof row.funding_rate !== 'string') {
    return corruptHistory(market, 'funding_rate');
  }
  try {
    settledFundingRate(
      { exchangeId: storedExchangeId, exchangeMarketId: storedMarketId, symbol },
      row.funding_rate,
      fundingTimestampMs,
      {}
    );
  } catch {
    return corruptHistory(market, 'funding_rate');
  }

  let raw: object;
  try {
    raw = parsedObjectJson(row.raw_json, 'history raw_json');
  } catch {
    return corruptHistory(market, 'raw_json');
  }

  let normalized: SettledFundingRate;
  try {
    normalized = settledFundingRate(
      { exchangeId: storedExchangeId, exchangeMarketId: storedMarketId, symbol },
      row.funding_rate,
      fundingTimestampMs,
      raw
    );
  } catch {
    return corruptHistory(market, 'raw_json');
  }
  if (normalized.rawJson !== row.raw_json) {
    return corruptHistory(market, 'raw_json');
  }

  let hash: string;
  try {
    hash = contentHash(row.content_hash, 'history content_hash');
  } catch {
    return corruptHistory(market, 'content_hash');
  }

  let firstObservedAt: string;
  let lastObservedAt: string;
  try {
    firstObservedAt = isoTimestamp(
      row.first_observed_at,
      'history first_observed_at'
    );
    lastObservedAt = isoTimestamp(
      row.last_observed_at,
      'history last_observed_at'
    );
  } catch {
    return corruptHistory(market, 'observation_timestamp');
  }
  if (firstObservedAt > lastObservedAt) {
    return corruptHistory(market, 'observation_timestamp');
  }

  return {
    exchangeId: storedExchangeId,
    exchangeMarketId: storedMarketId,
    symbol,
    fundingTimestampMs,
    fundingRate: normalized.fundingRate,
    rawJson: normalized.rawJson,
    contentHash: hash,
    firstObservedAt,
    lastObservedAt
  };
}

function validatePageRecord(
  record: SettledFundingRate,
  market: FundingMarketIdentity
): SettledFundingRate {
  const recordMarket = marketIdentity(record);
  if (
    recordMarket.exchangeId !== market.exchangeId
    || recordMarket.exchangeMarketId !== market.exchangeMarketId
    || recordMarket.symbol !== market.symbol
  ) {
    throw new Error('invalid funding page record: market identity mismatch');
  }
  const fundingTimestampMs = timestampMs(
    record.fundingTimestampMs,
    'funding page funding_timestamp_ms'
  );
  const raw = parsedObjectJson(record.rawJson, 'funding page raw_json');
  const normalized = settledFundingRate(
    recordMarket,
    record.fundingRate,
    fundingTimestampMs,
    raw
  );
  if (normalized.rawJson !== record.rawJson) {
    throw new Error('invalid funding page record: raw_json is not canonical');
  }
  return {
    ...normalized,
    contentHash: contentHash(
      record.contentHash,
      'funding page content_hash'
    )
  };
}

function recordsEqual(
  left: SettledFundingRate,
  right: SettledFundingRate
): boolean {
  return left.exchangeId === right.exchangeId
    && left.exchangeMarketId === right.exchangeMarketId
    && left.symbol === right.symbol
    && left.fundingTimestampMs === right.fundingTimestampMs
    && left.fundingRate === right.fundingRate
    && left.rawJson === right.rawJson
    && left.contentHash === right.contentHash;
}

function deduplicatePageRecords(
  records: readonly SettledFundingRate[],
  market: FundingMarketIdentity
): SettledFundingRate[] {
  if (records.length === 0) {
    throw new Error('invalid funding page: expected at least one record');
  }
  const result: SettledFundingRate[] = [];
  const byTimestamp = new Map<number, SettledFundingRate>();
  for (const untrustedRecord of records) {
    const record = validatePageRecord(untrustedRecord, market);
    const previous = byTimestamp.get(record.fundingTimestampMs);
    if (previous === undefined) {
      byTimestamp.set(record.fundingTimestampMs, record);
      result.push(record);
    } else if (!recordsEqual(previous, record)) {
      throw new Error('invalid funding page: conflicting natural key');
    }
  }
  return result;
}

function assertTableContract(
  database: Database.Database,
  table: string,
  expected: readonly (readonly [string, string, number])[]
): void {
  const pragma = table.startsWith('temp.')
    ? `PRAGMA temp.table_info(${table.slice('temp.'.length)})`
    : `PRAGMA table_info(${table})`;
  const rows = database.prepare(pragma).all() as unknown as TableInfoDbRow[];
  if (rows.length !== expected.length) throw schemaError();
  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index];
    const contract = expected[index];
    if (
      row === undefined
      || contract === undefined
      || row.name !== contract[0]
      || row.type !== contract[1]
      || !sqliteIntegerEquals(row.pk, contract[2])
    ) {
      throw schemaError();
    }
  }
}

function assertFundingSchemaCatalog(
  database: Database.Database,
  scope: SqliteFundingRateSchemaScope
): void {
  const catalog = scope === 'main'
    ? 'sqlite_master'
    : 'sqlite_temp_master';
  const expected = SQLITE_FUNDING_RATE_SCHEMA_OBJECTS
    .filter((object) => object.scope === scope)
    .slice()
    .sort((left, right) => (
      left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type.localeCompare(right.type)
    ));
  const expectedNames = expected.map(({ name }) => name);
  const managedTableNames = SQLITE_FUNDING_RATE_SCHEMA_OBJECTS
    .filter(({ type }) => type === 'table')
    .map(({ name }) => name);
  const placeholders = (values: readonly string[]): string => (
    values.map(() => '?').join(', ')
  );
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM ${catalog}
    WHERE sql IS NOT NULL
      AND (
        name IN (${placeholders(expectedNames)})
        OR tbl_name IN (${placeholders(managedTableNames)})
      )
    ORDER BY type, name
  `).all(...expectedNames, ...managedTableNames) as unknown as SqliteMasterDbRow[];
  if (rows.length !== expected.length) throw schemaError();
  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index];
    const object = expected[index];
    if (
      row === undefined
      || object === undefined
      || row.type !== object.type
      || row.name !== object.name
      || row.tbl_name !== object.tableName
      || row.sql !== object.storedSql
    ) {
      throw schemaError();
    }
  }
}

function assertFundingSchema(database: Database.Database): void {
  assertTableContract(database, 'funding_rate_history', [
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
  assertTableContract(database, 'funding_rate_revisions', [
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
  assertTableContract(database, 'funding_rate_sync_state', [
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
  assertFundingSchemaCatalog(database, 'main');
}

function prepareFundingSchema(database: Database.Database): void {
  if (database.inTransaction) throw schemaError();
  try {
    database.pragma('foreign_keys = ON');
    if (!sqliteIntegerEquals(
      database.pragma('foreign_keys', { simple: true }),
      1
    )) {
      throw schemaError();
    }
    database.transaction(() => {
      database.exec(SQLITE_FUNDING_RATE_SCHEMA);
      assertFundingSchema(database);
      if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
        throw schemaError();
      }
    })();
    assertFundingSchema(database);
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw schemaError();
    }
  } catch {
    throw schemaError();
  }
}

function createBitgetScanTable(database: Database.Database): void {
  try {
    const scanSchema = SQLITE_FUNDING_RATE_SCHEMA_OBJECTS.find((object) => (
      object.scope === 'temp'
      && object.type === 'table'
      && object.name === 'funding_rate_bitget_scan'
    ));
    if (scanSchema === undefined) throw schemaError();
    database.transaction(() => {
      database.exec(scanSchema.installSql);
      assertFundingSchemaCatalog(database, 'temp');
      assertTableContract(database, 'temp.funding_rate_bitget_scan', [
        ['exchange_id', 'TEXT', 1],
        ['exchange_market_id', 'TEXT', 2],
        ['coverage_generation', 'INTEGER', 3],
        ['scan_round', 'INTEGER', 4],
        ['funding_timestamp_ms', 'INTEGER', 5],
        ['symbol', 'TEXT', 0],
        ['funding_rate', 'TEXT', 0],
        ['raw_json', 'TEXT', 0],
        ['content_hash', 'TEXT', 0]
      ]);
    })();
  } catch {
    throw schemaError();
  }
}

function nullableFailure(
  codeValue: unknown,
  summaryValue: unknown,
  context: string
): {
  readonly code: FundingTaskFailureCode | null;
  readonly summary: string | null;
} {
  if (codeValue === null && summaryValue === null) {
    return { code: null, summary: null };
  }
  const code = enumValue(codeValue, FAILURE_CODES, `${context} code`);
  if (typeof summaryValue !== 'string') {
    throw new Error(`invalid ${context} summary: expected text`);
  }
  if (fundingTaskFailure(code).summary !== summaryValue) {
    throw new Error(`invalid ${context} summary: does not match code`);
  }
  return { code, summary: summaryValue };
}

function normalizedFailure(untrusted: FundingTaskFailure): FundingTaskFailure {
  if (typeof untrusted !== 'object' || untrusted === null) {
    throw new Error('invalid funding task failure: expected normalized failure');
  }
  const record = untrusted as unknown as Record<string, unknown>;
  const code = enumValue(
    record.code,
    FAILURE_CODES,
    'funding task failure code'
  );
  const expected = fundingTaskFailure(code);
  if (
    typeof record.summary !== 'string'
    || record.summary !== expected.summary
    || Buffer.byteLength(record.summary, 'utf8') < 1
    || Buffer.byteLength(record.summary, 'utf8')
      > MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES
    || !/^[\x20-\x7e]+$/.test(record.summary)
  ) {
    throw new Error('invalid funding task failure: failure summary is not normalized');
  }
  return expected;
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = expected.slice().sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function normalizedExhaustionEvidence(
  untrusted: unknown,
  context: string
): FundingExhaustionEvidence {
  if (typeof untrusted !== 'object' || untrusted === null || Array.isArray(untrusted)) {
    throw new Error(`invalid ${context}: expected an exhaustion evidence object`);
  }
  const record = untrusted as Readonly<Record<string, unknown>>;
  if (record.exchangeId === 'bitget') {
    if (!hasExactKeys(record, [
      'exchangeId',
      'generation',
      'cutoffMs',
      'matchingRounds',
      'emptyPageNo'
    ])) {
      throw new Error(`invalid ${context}: unexpected Bitget evidence fields`);
    }
    const matchingRounds = record.matchingRounds;
    if (
      !Array.isArray(matchingRounds)
      || matchingRounds.length !== 2
      || !(
        (matchingRounds[0] === 1 && matchingRounds[1] === 2)
        || (matchingRounds[0] === 2 && matchingRounds[1] === 3)
      )
    ) {
      throw new Error(`invalid ${context}: invalid Bitget matching rounds`);
    }
    return {
      exchangeId: 'bitget',
      generation: sqliteInteger(
        record.generation,
        0,
        MAX_SAFE_INTEGER,
        `${context} generation`
      ),
      cutoffMs: timestampMs(record.cutoffMs, `${context} cutoff_ms`),
      matchingRounds: matchingRounds[0] === 1 ? [1, 2] : [2, 3],
      emptyPageNo: sqliteInteger(
        record.emptyPageNo,
        1,
        MAX_SAFE_INTEGER,
        `${context} empty page number`
      )
    };
  }
  if (record.exchangeId === 'okx') {
    if (!hasExactKeys(record, [
      'exchangeId',
      'generation',
      'cutoffMs',
      'explicitEmpty',
      'finalRequestAfterMs'
    ])) {
      throw new Error(`invalid ${context}: unexpected OKX evidence fields`);
    }
    if (record.explicitEmpty !== true) {
      throw new Error(`invalid ${context}: OKX explicit-empty proof is required`);
    }
    return {
      exchangeId: 'okx',
      generation: sqliteInteger(
        record.generation,
        0,
        MAX_SAFE_INTEGER,
        `${context} generation`
      ),
      cutoffMs: timestampMs(record.cutoffMs, `${context} cutoff_ms`),
      explicitEmpty: true,
      finalRequestAfterMs: nullableTimestampMs(
        record.finalRequestAfterMs,
        `${context} final request after_ms`
      )
    };
  }
  throw new Error(`invalid ${context}: unsupported evidence exchange`);
}

function corruptState(context: string, field: string): never {
  throw new Error(`invalid funding state ${context}: ${field}`);
}

function validateStateRow(row: FundingStateDbRow): FundingMarketState {
  const stateExchangeId = exchangeId(row.exchange_id, 'funding state exchange_id');
  const stateMarketId = nonEmptyString(
    row.exchange_market_id,
    'funding state exchange_market_id'
  );
  const stateContext = `${stateExchangeId}/${stateMarketId}`;
  const symbol = nonEmptyString(row.symbol, `${stateContext} symbol`);
  const active = sqliteBoolean(row.active, `${stateContext} active`);
  const activeObservedAt = isoTimestamp(
    row.active_observed_at,
    `${stateContext} active_observed_at`
  );
  const activeChangedAt = isoTimestamp(
    row.active_changed_at,
    `${stateContext} active_changed_at`
  );
  const reactivationRequired = sqliteBoolean(
    row.reactivation_required,
    `${stateContext} reactivation_required`
  );
  const reactivationAfterGeneration = nullableSqliteInteger(
    row.reactivation_after_generation,
    0,
    MAX_SAFE_INTEGER,
    `${stateContext} reactivation_after_generation`
  );
  const inactiveFinalCaughtUpAt = nullableIsoTimestamp(
    row.inactive_final_caught_up_at,
    `${stateContext} inactive_final_caught_up_at`
  );
  const coverageStatus = enumValue(
    row.coverage_status,
    COVERAGE_STATUSES,
    `${stateContext} coverage_status`
  );
  const coverageGeneration = sqliteInteger(
    row.coverage_generation,
    0,
    MAX_SAFE_INTEGER,
    `${stateContext} coverage_generation`
  );
  const coverageTaskKind = nullableEnumValue(
    row.coverage_task_kind,
    COVERAGE_KINDS,
    `${stateContext} coverage_task_kind`
  );
  const coverageCutoffMs = nullableTimestampMs(
    row.coverage_cutoff_ms,
    `${stateContext} coverage_cutoff_ms`
  );
  const lastCaughtUpGeneration = nullableSqliteInteger(
    row.last_caught_up_generation,
    0,
    MAX_SAFE_INTEGER,
    `${stateContext} last_caught_up_generation`
  );
  const lastCaughtUpCutoffMs = nullableTimestampMs(
    row.last_caught_up_cutoff_ms,
    `${stateContext} last_caught_up_cutoff_ms`
  );
  const lastExhaustedAt = nullableIsoTimestamp(
    row.last_exhausted_at,
    `${stateContext} last_exhausted_at`
  );
  const lastExhaustionEvidenceJson = row.last_exhaustion_evidence_json === null
    ? null
    : nonEmptyString(
        row.last_exhaustion_evidence_json,
        `${stateContext} last_exhaustion_evidence_json`
      );
  const okxResumeAfterMs = nullableTimestampMs(
    row.okx_resume_after_ms,
    `${stateContext} okx_resume_after_ms`
  );
  const okxResumeGeneration = nullableSqliteInteger(
    row.okx_resume_generation,
    0,
    MAX_SAFE_INTEGER,
    `${stateContext} okx_resume_generation`
  );
  const oldest = nullableTimestampMs(
    row.oldest_funding_timestamp_ms,
    `${stateContext} oldest_funding_timestamp_ms`
  );
  const latest = nullableTimestampMs(
    row.latest_funding_timestamp_ms,
    `${stateContext} latest_funding_timestamp_ms`
  );
  if ((oldest === null) !== (latest === null) || (
    oldest !== null && latest !== null && oldest > latest
  )) {
    return corruptState(stateContext, 'funding bounds');
  }
  const coverageStartedAt = nullableIsoTimestamp(
    row.coverage_started_at,
    `${stateContext} coverage_started_at`
  );
  const coverageEndedAt = nullableIsoTimestamp(
    row.coverage_ended_at,
    `${stateContext} coverage_ended_at`
  );
  const coverageLastSuccessAt = nullableIsoTimestamp(
    row.coverage_last_success_at,
    `${stateContext} coverage_last_success_at`
  );
  const coverageFailure = nullableFailure(
    row.coverage_error_code,
    row.coverage_error_summary,
    `${stateContext} coverage failure`
  );
  const incrementalFailure = nullableFailure(
    row.incremental_error_code,
    row.incremental_error_summary,
    `${stateContext} incremental failure`
  );
  const incrementalStatus = enumValue(
    row.incremental_status,
    INCREMENTAL_STATUSES,
    `${stateContext} incremental_status`
  );
  const incrementalGeneration = sqliteInteger(
    row.incremental_generation,
    0,
    MAX_SAFE_INTEGER,
    `${stateContext} incremental_generation`
  );
  const incrementalStartedAt = nullableIsoTimestamp(
    row.incremental_started_at,
    `${stateContext} incremental_started_at`
  );
  const incrementalEndedAt = nullableIsoTimestamp(
    row.incremental_ended_at,
    `${stateContext} incremental_ended_at`
  );
  const incrementalLastSuccessAt = nullableIsoTimestamp(
    row.incremental_last_success_at,
    `${stateContext} incremental_last_success_at`
  );

  const proofValues = [
    lastCaughtUpGeneration,
    lastCaughtUpCutoffMs,
    lastExhaustedAt,
    lastExhaustionEvidenceJson,
    coverageLastSuccessAt
  ];
  const presentProofValues = proofValues.filter((value) => value !== null).length;
  if (presentProofValues !== 0 && presentProofValues !== proofValues.length) {
    return corruptState(stateContext, 'coverage evidence fields');
  }
  if (
    lastExhaustionEvidenceJson !== null
    && lastCaughtUpGeneration !== null
    && lastCaughtUpCutoffMs !== null
  ) {
    let evidence: FundingExhaustionEvidence;
    try {
      evidence = normalizedExhaustionEvidence(
        parsedObjectJson(
          lastExhaustionEvidenceJson,
          `${stateContext} last_exhaustion_evidence_json`
        ),
        `${stateContext} exhaustion evidence`
      );
    } catch {
      return corruptState(stateContext, 'exhaustion evidence');
    }
    if (
      evidence.exchangeId !== stateExchangeId
      || evidence.generation !== lastCaughtUpGeneration
      || evidence.cutoffMs !== lastCaughtUpCutoffMs
      || JSON.stringify(evidence) !== lastExhaustionEvidenceJson
    ) {
      return corruptState(stateContext, 'exhaustion evidence');
    }
  }

  if ((okxResumeAfterMs === null) !== (okxResumeGeneration === null)) {
    return corruptState(stateContext, 'OKX anchor fields');
  }
  if (
    okxResumeAfterMs !== null
    && (
      stateExchangeId !== 'okx'
      || coverageStatus !== 'BACKFILLING'
      || okxResumeGeneration !== coverageGeneration
    )
  ) {
    return corruptState(stateContext, 'OKX anchor generation');
  }

  if (reactivationRequired !== (reactivationAfterGeneration !== null)) {
    return corruptState(stateContext, 'reactivation fields');
  }
  if (
    reactivationRequired
    && (
      !active
      || inactiveFinalCaughtUpAt !== null
      || reactivationAfterGeneration === null
      || reactivationAfterGeneration > coverageGeneration
    )
  ) {
    return corruptState(stateContext, 'reactivation fields');
  }
  if (
    inactiveFinalCaughtUpAt !== null
    && (
      active
      || coverageStatus !== 'CAUGHT_UP'
      || coverageTaskKind !== 'INACTIVE_FINAL'
      || inactiveFinalCaughtUpAt !== coverageLastSuccessAt
    )
  ) {
    return corruptState(stateContext, 'inactive final proof');
  }

  if (coverageStatus === 'PENDING') {
    if (
      coverageTaskKind !== null
      || coverageCutoffMs !== null
      || coverageStartedAt !== null
      || coverageEndedAt !== null
      || coverageFailure.code !== null
      || presentProofValues !== 0
    ) {
      return corruptState(stateContext, 'PENDING coverage evidence');
    }
  } else if (coverageStatus === 'BACKFILLING') {
    if (
      coverageTaskKind === null
      || coverageCutoffMs === null
      || coverageStartedAt === null
      || coverageEndedAt !== null
      || coverageFailure.code !== null
    ) {
      return corruptState(stateContext, 'coverage BACKFILLING fields');
    }
  } else if (coverageStatus === 'INCOMPLETE') {
    if (
      coverageTaskKind === null
      || coverageCutoffMs === null
      || coverageStartedAt === null
      || coverageEndedAt === null
      || coverageFailure.code === null
    ) {
      return corruptState(stateContext, 'coverage INCOMPLETE fields');
    }
  } else if (
    coverageTaskKind === null
    || coverageCutoffMs === null
    || coverageStartedAt === null
    || coverageEndedAt === null
    || coverageLastSuccessAt === null
    || coverageFailure.code !== null
    || lastCaughtUpGeneration !== coverageGeneration
    || lastCaughtUpCutoffMs !== coverageCutoffMs
    || presentProofValues !== proofValues.length
  ) {
    return corruptState(stateContext, 'coverage CAUGHT_UP cutoff evidence');
  }
  if (
    reactivationRequired
    && coverageStatus === 'CAUGHT_UP'
  ) {
    return corruptState(stateContext, 'reactivation coverage status');
  }
  if (
    coverageStatus === 'CAUGHT_UP'
    && !active
    && (
      coverageTaskKind !== 'INACTIVE_FINAL'
      || inactiveFinalCaughtUpAt === null
    )
  ) {
    return corruptState(stateContext, 'inactive final coverage proof');
  }
  if (
    coverageStatus === 'CAUGHT_UP'
    && active
    && coverageTaskKind === 'INACTIVE_FINAL'
  ) {
    return corruptState(stateContext, 'inactive final coverage state');
  }

  if (incrementalStatus === 'IDLE') {
    if (incrementalFailure.code !== null) {
      return corruptState(stateContext, 'incremental IDLE fields');
    }
  } else if (incrementalStatus === 'RUNNING') {
    if (
      incrementalStartedAt === null
      || incrementalEndedAt !== null
      || incrementalFailure.code !== null
    ) {
      return corruptState(stateContext, 'incremental RUNNING fields');
    }
  } else if (
    incrementalStartedAt === null
    || incrementalEndedAt === null
    || incrementalFailure.code === null
  ) {
    return corruptState(stateContext, 'incremental INCOMPLETE fields');
  }
  isoTimestamp(row.created_at, `${stateContext} created_at`);
  isoTimestamp(row.updated_at, `${stateContext} updated_at`);

  return {
    exchangeId: stateExchangeId,
    exchangeMarketId: stateMarketId,
    symbol,
    active,
    activeObservedAt,
    activeChangedAt,
    reactivationRequired,
    reactivationAfterGeneration,
    inactiveFinalCaughtUpAt,
    coverageStatus,
    coverageGeneration,
    coverageTaskKind,
    coverageCutoffMs,
    lastCaughtUpGeneration,
    lastCaughtUpCutoffMs,
    lastExhaustedAt,
    lastExhaustionEvidenceJson,
    okxResumeAfterMs,
    okxResumeGeneration,
    oldestFundingTimestampMs: oldest,
    latestFundingTimestampMs: latest,
    coverageStartedAt,
    coverageEndedAt,
    coverageLastSuccessAt,
    coverageErrorCode: coverageFailure.code,
    coverageErrorSummary: coverageFailure.summary,
    incrementalStatus,
    incrementalGeneration,
    incrementalStartedAt,
    incrementalEndedAt,
    incrementalLastSuccessAt,
    incrementalErrorCode: incrementalFailure.code,
    incrementalErrorSummary: incrementalFailure.summary
  };
}

function coverageLease(lease: CoverageLease): CoverageLease {
  const market = marketIdentity(lease);
  const generation = sqliteInteger(
    lease.generation,
    0,
    MAX_SAFE_INTEGER,
    'coverage lease generation'
  );
  const kind = enumValue(lease.kind, COVERAGE_KINDS, 'coverage lease kind');
  const cutoffMs = timestampMs(lease.cutoffMs, 'coverage lease cutoff_ms');
  if (typeof lease.recovered !== 'boolean') {
    throw new Error('invalid coverage lease recovered flag');
  }
  if (market.exchangeId === 'bitget') {
    if (lease.okxResumeAfterMs !== null) {
      throw new Error('invalid Bitget coverage lease OKX anchor');
    }
    const requiredBitgetBoundaryMs = lease.requiredBitgetBoundaryMs === null
      ? null
      : timestampMs(
          lease.requiredBitgetBoundaryMs,
          'coverage lease Bitget boundary'
        );
    return {
      exchangeId: 'bitget',
      exchangeMarketId: market.exchangeMarketId,
      symbol: market.symbol,
      generation,
      kind,
      cutoffMs,
      recovered: lease.recovered,
      okxResumeAfterMs: null,
      requiredBitgetBoundaryMs
    };
  }
  if (lease.requiredBitgetBoundaryMs !== null) {
    throw new Error('invalid OKX coverage lease Bitget boundary');
  }
  return {
    exchangeId: 'okx',
    exchangeMarketId: market.exchangeMarketId,
    symbol: market.symbol,
    generation,
    kind,
    cutoffMs,
    recovered: lease.recovered,
    okxResumeAfterMs: lease.okxResumeAfterMs === null
      ? null
      : timestampMs(lease.okxResumeAfterMs, 'coverage lease OKX anchor'),
    requiredBitgetBoundaryMs: null
  };
}

function incrementalLease(lease: IncrementalLease): IncrementalLease {
  const market = marketIdentity(lease);
  return {
    ...market,
    generation: sqliteInteger(
      lease.generation,
      0,
      MAX_SAFE_INTEGER,
      'incremental lease generation'
    ),
    frozenBoundaryMs: nullableTimestampMs(
      lease.frozenBoundaryMs,
      'incremental lease frozen boundary'
    )
  };
}

function coverageStateMatchesLease(
  state: FundingMarketState,
  lease: CoverageLease
): boolean {
  return state.exchangeId === lease.exchangeId
    && state.exchangeMarketId === lease.exchangeMarketId
    && state.symbol === lease.symbol
    && state.coverageStatus === 'BACKFILLING'
    && state.coverageGeneration === lease.generation
    && state.coverageTaskKind === lease.kind
    && state.coverageCutoffMs === lease.cutoffMs;
}

function coverageStateAllowsLease(
  state: FundingMarketState,
  lease: CoverageLease
): boolean {
  if (lease.kind === 'INACTIVE_FINAL') return !state.active;
  if (lease.kind === 'REACTIVATION') {
    return state.active
      && state.reactivationRequired
      && state.reactivationAfterGeneration !== null
      && lease.generation > state.reactivationAfterGeneration;
  }
  return state.active && !state.reactivationRequired;
}

function stateAllowsIncremental(state: FundingMarketState): boolean {
  return state.active
    && !state.reactivationRequired
    && state.lastCaughtUpGeneration !== null
    && state.lastCaughtUpCutoffMs !== null
    && state.lastExhaustedAt !== null
    && state.lastExhaustionEvidenceJson !== null
    && state.coverageLastSuccessAt !== null;
}

function incrementalStateMatchesLease(
  state: FundingMarketState,
  lease: IncrementalLease
): boolean {
  return state.exchangeId === lease.exchangeId
    && state.exchangeMarketId === lease.exchangeMarketId
    && state.symbol === lease.symbol
    && state.incrementalStatus === 'RUNNING'
    && state.incrementalGeneration === lease.generation
    && stateAllowsIncremental(state);
}

export class SqliteFundingRateRepository implements FundingRateRepository {
  private readonly selectState;
  private readonly selectStates;
  private readonly insertState;
  private readonly updateObservedActiveState;
  private readonly updateDiscoveryTransition;
  private readonly updateCoverageStart;
  private readonly selectHistoryRecord;
  private readonly selectHistory;
  private readonly insertHistory;
  private readonly updateUnchangedHistory;
  private readonly insertRevision;
  private readonly updateRevisedHistory;
  private readonly updateCoverageCheckpoint;
  private readonly upsertBitgetScanRecord;
  private readonly deleteBitgetScansForMarket;
  private readonly deleteBitgetScansForLease;
  private readonly selectBitgetRoundDifference;
  private readonly updateCoverageComplete;
  private readonly updateCoverageFailure;
  private readonly updateIncrementalStart;
  private readonly updateIncrementalCheckpoint;
  private readonly updateIncrementalTerminal;
  private readonly applyDiscoveryTransaction;
  private readonly startCoverageTransaction;
  private readonly commitCoveragePageTransaction;

  constructor(private readonly database: Database.Database) {
    prepareFundingSchema(this.database);
    createBitgetScanTable(this.database);

    this.selectState = this.database.prepare(`
      SELECT * FROM funding_rate_sync_state
      WHERE exchange_id = ? AND exchange_market_id = ?
    `);
    this.selectStates = this.database.prepare(`
      SELECT * FROM funding_rate_sync_state
      WHERE exchange_id = ?
      ORDER BY exchange_market_id
    `);
    this.insertState = this.database.prepare(`
      INSERT INTO funding_rate_sync_state (
        exchange_id, exchange_market_id, symbol,
        active, active_observed_at, active_changed_at,
        reactivation_required, reactivation_after_generation,
        inactive_final_caught_up_at,
        coverage_status, coverage_generation, coverage_task_kind,
        coverage_cutoff_ms, last_caught_up_generation,
        last_caught_up_cutoff_ms, last_exhausted_at,
        last_exhaustion_evidence_json,
        okx_resume_after_ms, okx_resume_generation,
        oldest_funding_timestamp_ms, latest_funding_timestamp_ms,
        coverage_started_at, coverage_ended_at, coverage_last_success_at,
        coverage_error_code, coverage_error_summary,
        incremental_status, incremental_generation,
        incremental_started_at, incremental_ended_at,
        incremental_last_success_at,
        incremental_error_code, incremental_error_summary,
        created_at, updated_at
      ) VALUES (
        @exchangeId, @exchangeMarketId, @symbol,
        1, @observedAt, @observedAt,
        0, NULL, NULL,
        'PENDING', 0, NULL,
        NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL,
        NULL, NULL,
        'IDLE', 0,
        NULL, NULL, NULL,
        NULL, NULL,
        @observedAt, @observedAt
      )
    `);
    this.updateObservedActiveState = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET active_observed_at = @observedAt, updated_at = @observedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND active = @active
    `);
    this.updateDiscoveryTransition = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET active = @active,
          active_observed_at = @observedAt,
          active_changed_at = @observedAt,
          reactivation_required = @reactivationRequired,
          reactivation_after_generation = @reactivationAfterGeneration,
          inactive_final_caught_up_at = NULL,
          coverage_status = @coverageStatus,
          coverage_generation = @coverageGeneration,
          coverage_task_kind = @coverageTaskKind,
          coverage_cutoff_ms = @coverageCutoffMs,
          okx_resume_after_ms = NULL,
          okx_resume_generation = NULL,
          coverage_started_at = @coverageStartedAt,
          coverage_ended_at = @coverageEndedAt,
          coverage_error_code = @coverageErrorCode,
          coverage_error_summary = @coverageErrorSummary,
          incremental_status = @incrementalStatus,
          incremental_generation = @incrementalGeneration,
          incremental_ended_at = @incrementalEndedAt,
          incremental_error_code = @incrementalErrorCode,
          incremental_error_summary = @incrementalErrorSummary,
          updated_at = @observedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND active = @previousActive
        AND coverage_generation = @previousCoverageGeneration
        AND incremental_generation = @previousIncrementalGeneration
    `);
    this.updateCoverageStart = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET coverage_status = 'BACKFILLING',
          coverage_generation = @generation,
          coverage_task_kind = @kind,
          coverage_cutoff_ms = @cutoffMs,
          okx_resume_after_ms = NULL,
          okx_resume_generation = NULL,
          coverage_started_at = @startedAt,
          coverage_ended_at = NULL,
          coverage_error_code = NULL,
          coverage_error_summary = NULL,
          updated_at = @startedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND coverage_generation = @previousGeneration
    `);
    this.selectHistoryRecord = this.database.prepare(`
      SELECT * FROM funding_rate_history
      WHERE exchange_id = ?
        AND exchange_market_id = ?
        AND funding_timestamp_ms = ?
    `);
    this.selectHistory = this.database.prepare(`
      SELECT * FROM funding_rate_history
      WHERE exchange_id = ? AND exchange_market_id = ?
      ORDER BY funding_timestamp_ms DESC
    `);
    this.insertHistory = this.database.prepare(`
      INSERT INTO funding_rate_history (
        exchange_id, exchange_market_id, symbol,
        funding_timestamp_ms, funding_rate, raw_json, content_hash,
        first_observed_at, last_observed_at
      ) VALUES (
        @exchangeId, @exchangeMarketId, @symbol,
        @fundingTimestampMs, @fundingRate, @rawJson, @contentHash,
        @observedAt, @observedAt
      )
    `);
    this.updateUnchangedHistory = this.database.prepare(`
      UPDATE funding_rate_history
      SET last_observed_at = @observedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND funding_timestamp_ms = @fundingTimestampMs
    `);
    this.insertRevision = this.database.prepare(`
      INSERT INTO funding_rate_revisions (
        exchange_id, exchange_market_id, symbol,
        funding_timestamp_ms, funding_rate, raw_json, content_hash,
        first_observed_at, last_observed_at, replaced_at
      ) VALUES (
        @exchangeId, @exchangeMarketId, @symbol,
        @fundingTimestampMs, @fundingRate, @rawJson, @contentHash,
        @firstObservedAt, @lastObservedAt, @replacedAt
      )
    `);
    this.updateRevisedHistory = this.database.prepare(`
      UPDATE funding_rate_history
      SET symbol = @symbol,
          funding_rate = @fundingRate,
          raw_json = @rawJson,
          content_hash = @contentHash,
          first_observed_at = @observedAt,
          last_observed_at = @observedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND funding_timestamp_ms = @fundingTimestampMs
    `);
    this.updateCoverageCheckpoint = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET oldest_funding_timestamp_ms = CASE
            WHEN oldest_funding_timestamp_ms IS NULL
              OR @pageOldestMs < oldest_funding_timestamp_ms
            THEN @pageOldestMs
            ELSE oldest_funding_timestamp_ms
          END,
          latest_funding_timestamp_ms = CASE
            WHEN latest_funding_timestamp_ms IS NULL
              OR @pageLatestMs > latest_funding_timestamp_ms
            THEN @pageLatestMs
            ELSE latest_funding_timestamp_ms
          END,
          okx_resume_after_ms = @okxResumeAfterMs,
          okx_resume_generation = @okxResumeGeneration,
          updated_at = @observedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND coverage_status = 'BACKFILLING'
        AND coverage_generation = @generation
        AND coverage_task_kind = @kind
        AND coverage_cutoff_ms = @cutoffMs
    `);
    this.upsertBitgetScanRecord = this.database.prepare(`
      INSERT INTO funding_rate_bitget_scan (
        exchange_id, exchange_market_id, coverage_generation,
        scan_round, funding_timestamp_ms, symbol,
        funding_rate, raw_json, content_hash
      ) VALUES (
        @exchangeId, @exchangeMarketId, @generation,
        @round, @fundingTimestampMs, @symbol,
        @fundingRate, @rawJson, @contentHash
      )
      ON CONFLICT (
        exchange_id, exchange_market_id, coverage_generation,
        scan_round, funding_timestamp_ms
      ) DO UPDATE SET
        symbol = excluded.symbol,
        funding_rate = excluded.funding_rate,
        raw_json = excluded.raw_json,
        content_hash = excluded.content_hash
    `);
    this.deleteBitgetScansForMarket = this.database.prepare(`
      DELETE FROM funding_rate_bitget_scan
      WHERE exchange_id = ? AND exchange_market_id = ?
    `);
    this.deleteBitgetScansForLease = this.database.prepare(`
      DELETE FROM funding_rate_bitget_scan
      WHERE exchange_id = ?
        AND exchange_market_id = ?
        AND coverage_generation = ?
    `);
    this.selectBitgetRoundDifference = this.database.prepare(`
      SELECT (
        EXISTS (
          SELECT funding_timestamp_ms, symbol, funding_rate, raw_json, content_hash
          FROM funding_rate_bitget_scan
          WHERE exchange_id = @exchangeId
            AND exchange_market_id = @exchangeMarketId
            AND coverage_generation = @generation
            AND scan_round = @leftRound
          EXCEPT
          SELECT funding_timestamp_ms, symbol, funding_rate, raw_json, content_hash
          FROM funding_rate_bitget_scan
          WHERE exchange_id = @exchangeId
            AND exchange_market_id = @exchangeMarketId
            AND coverage_generation = @generation
            AND scan_round = @rightRound
        )
        OR EXISTS (
          SELECT funding_timestamp_ms, symbol, funding_rate, raw_json, content_hash
          FROM funding_rate_bitget_scan
          WHERE exchange_id = @exchangeId
            AND exchange_market_id = @exchangeMarketId
            AND coverage_generation = @generation
            AND scan_round = @rightRound
          EXCEPT
          SELECT funding_timestamp_ms, symbol, funding_rate, raw_json, content_hash
          FROM funding_rate_bitget_scan
          WHERE exchange_id = @exchangeId
            AND exchange_market_id = @exchangeMarketId
            AND coverage_generation = @generation
            AND scan_round = @leftRound
        )
      ) AS different
    `);
    this.updateCoverageComplete = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET coverage_status = 'CAUGHT_UP',
          last_caught_up_generation = @generation,
          last_caught_up_cutoff_ms = @cutoffMs,
          last_exhausted_at = @completedAt,
          last_exhaustion_evidence_json = @evidenceJson,
          okx_resume_after_ms = NULL,
          okx_resume_generation = NULL,
          coverage_ended_at = @completedAt,
          coverage_last_success_at = @completedAt,
          coverage_error_code = NULL,
          coverage_error_summary = NULL,
          inactive_final_caught_up_at = @inactiveFinalCaughtUpAt,
          reactivation_required = @reactivationRequired,
          reactivation_after_generation = @reactivationAfterGeneration,
          updated_at = @completedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND coverage_status = 'BACKFILLING'
        AND coverage_generation = @generation
        AND coverage_task_kind = @kind
        AND coverage_cutoff_ms = @cutoffMs
    `);
    this.updateCoverageFailure = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET coverage_status = 'INCOMPLETE',
          okx_resume_after_ms = NULL,
          okx_resume_generation = NULL,
          coverage_ended_at = @failedAt,
          coverage_error_code = @failureCode,
          coverage_error_summary = @failureSummary,
          updated_at = @failedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND coverage_status = 'BACKFILLING'
        AND coverage_generation = @generation
        AND coverage_task_kind = @kind
        AND coverage_cutoff_ms = @cutoffMs
    `);
    this.updateIncrementalStart = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET incremental_status = 'RUNNING',
          incremental_generation = @generation,
          incremental_started_at = @startedAt,
          incremental_ended_at = NULL,
          incremental_error_code = NULL,
          incremental_error_summary = NULL,
          updated_at = @startedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND incremental_status = @previousStatus
        AND incremental_generation = @previousGeneration
    `);
    this.updateIncrementalCheckpoint = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET oldest_funding_timestamp_ms = CASE
            WHEN oldest_funding_timestamp_ms IS NULL
              OR @pageOldestMs < oldest_funding_timestamp_ms
            THEN @pageOldestMs
            ELSE oldest_funding_timestamp_ms
          END,
          latest_funding_timestamp_ms = CASE
            WHEN latest_funding_timestamp_ms IS NULL
              OR @pageLatestMs > latest_funding_timestamp_ms
            THEN @pageLatestMs
            ELSE latest_funding_timestamp_ms
          END,
          updated_at = @observedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND active = 1
        AND reactivation_required = 0
        AND incremental_status = 'RUNNING'
        AND incremental_generation = @generation
    `);
    this.updateIncrementalTerminal = this.database.prepare(`
      UPDATE funding_rate_sync_state
      SET incremental_status = @status,
          incremental_ended_at = @endedAt,
          incremental_last_success_at = @lastSuccessAt,
          incremental_error_code = @failureCode,
          incremental_error_summary = @failureSummary,
          updated_at = @endedAt
      WHERE exchange_id = @exchangeId
        AND exchange_market_id = @exchangeMarketId
        AND symbol = @symbol
        AND incremental_status = 'RUNNING'
        AND incremental_generation = @generation
    `);

    this.applyDiscoveryTransaction = this.database.transaction((
      discoveryExchangeId: FundingExchangeId,
      observations: readonly FundingMarketObservation[],
      observedAt: string
    ) => this.applyDiscoveryInsideTransaction(
      discoveryExchangeId,
      observations,
      observedAt
    ));
    this.startCoverageTransaction = this.database.transaction((
      market: FundingMarketIdentity,
      kind: FundingCoverageKind,
      cutoffMs: number,
      startedAt: string
    ) => this.startCoverageInsideTransaction(
      market,
      kind,
      cutoffMs,
      startedAt
    ));
    this.commitCoveragePageTransaction = this.database.transaction((
      lease: CoverageLease,
      records: readonly SettledFundingRate[],
      checkpoint: CoveragePageCheckpoint,
      observedAt: string
    ) => this.commitCoveragePageInsideTransaction(
      lease,
      records,
      checkpoint,
      observedAt
    ));
  }

  applyCompleteDiscovery(
    untrustedExchangeId: FundingExchangeId,
    untrustedObservations: readonly FundingMarketObservation[],
    observedAt: Date
  ): FundingDiscoveryResult {
    const discoveryExchangeId = exchangeId(
      untrustedExchangeId,
      'funding discovery exchange_id'
    );
    const observedAtText = dateTimestamp(observedAt, 'funding discovery time');
    const observations: FundingMarketObservation[] = [];
    const marketIds = new Set<string>();
    const symbols = new Set<string>();
    for (const untrusted of untrustedObservations) {
      const market = marketIdentity(untrusted);
      if (market.exchangeId !== discoveryExchangeId) {
        throw new Error('invalid funding discovery: exchange identity mismatch');
      }
      if (typeof untrusted.active !== 'boolean') {
        throw new Error('invalid funding discovery: active must be boolean');
      }
      if (marketIds.has(market.exchangeMarketId) || symbols.has(market.symbol)) {
        throw new Error('invalid funding discovery: duplicate market identity');
      }
      marketIds.add(market.exchangeMarketId);
      symbols.add(market.symbol);
      observations.push({ ...market, active: untrusted.active });
    }
    return this.applyDiscoveryTransaction(
      discoveryExchangeId,
      observations,
      observedAtText
    );
  }

  listMarketStates(untrustedExchangeId: FundingExchangeId): FundingMarketState[] {
    const requestedExchangeId = exchangeId(
      untrustedExchangeId,
      'funding state exchange_id'
    );
    const rows = this.selectStates.all(requestedExchangeId) as FundingStateDbRow[];
    return rows.map((row) => {
      const state = validateStateRow(row);
      if (state.exchangeId !== requestedExchangeId) {
        throw new Error('invalid funding state: exchange scope mismatch');
      }
      return state;
    });
  }

  listHistory(untrustedMarket: FundingMarketIdentity): SettledFundingRate[] {
    const market = marketIdentity(untrustedMarket);
    const rows = this.selectHistory.all(
      market.exchangeId,
      market.exchangeMarketId
    ) as HistoryDbRow[];
    return rows.map((row) => {
      const validated = validateHistoryRow(row, market);
      return {
        exchangeId: validated.exchangeId,
        exchangeMarketId: validated.exchangeMarketId,
        symbol: validated.symbol,
        fundingTimestampMs: validated.fundingTimestampMs,
        fundingRate: validated.fundingRate,
        rawJson: validated.rawJson,
        contentHash: validated.contentHash
      };
    });
  }

  startCoverage(
    untrustedMarket: FundingMarketIdentity,
    untrustedKind: FundingCoverageKind,
    untrustedCutoffMs: number,
    startedAt: Date
  ): CoverageLease {
    const market = marketIdentity(untrustedMarket);
    const kind = enumValue(
      untrustedKind,
      COVERAGE_KINDS,
      'funding coverage kind'
    );
    const cutoffMs = timestampMs(
      untrustedCutoffMs,
      'funding coverage cutoff_ms'
    );
    const startedAtText = dateTimestamp(startedAt, 'funding coverage start time');
    return this.startCoverageTransaction(
      market,
      kind,
      cutoffMs,
      startedAtText
    );
  }

  resumeInterruptedCoverage(
    untrustedMarket: FundingMarketIdentity
  ): CoverageLease {
    const market = marketIdentity(untrustedMarket);
    return this.database.transaction((): CoverageLease => {
      const state = this.stateForMarket(market);
      if (
        state === null
        || state.symbol !== market.symbol
        || state.coverageStatus !== 'BACKFILLING'
        || state.coverageTaskKind === null
        || state.coverageCutoffMs === null
      ) {
        throw new Error('funding market has no interrupted coverage task');
      }
      const common = {
        exchangeMarketId: state.exchangeMarketId,
        symbol: state.symbol,
        generation: state.coverageGeneration,
        kind: state.coverageTaskKind,
        cutoffMs: state.coverageCutoffMs,
        recovered: true
      } as const;
      const lease: CoverageLease = state.exchangeId === 'bitget'
        ? {
            ...common,
            exchangeId: 'bitget',
            okxResumeAfterMs: null,
            requiredBitgetBoundaryMs: state.oldestFundingTimestampMs
          }
        : {
            ...common,
            exchangeId: 'okx',
            okxResumeAfterMs: state.okxResumeAfterMs,
            requiredBitgetBoundaryMs: null
          };
      if (!coverageStateAllowsLease(state, lease)) {
        throw new Error('interrupted coverage task is no longer eligible');
      }
      return lease;
    })();
  }

  isCoverageLeaseCurrent(untrustedLease: CoverageLease): boolean {
    const lease = coverageLease(untrustedLease);
    const state = this.stateForMarket(lease);
    return state !== null
      && coverageStateMatchesLease(state, lease)
      && coverageStateAllowsLease(state, lease);
  }

  commitCoveragePage(
    untrustedLease: CoverageLease,
    untrustedRecords: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint,
    observedAt: Date
  ): FundingPageWriteResult {
    const lease = coverageLease(untrustedLease);
    const records = deduplicatePageRecords(untrustedRecords, lease);
    const observedAtText = dateTimestamp(observedAt, 'funding page observation time');
    const validatedCheckpoint = this.validateCheckpoint(lease, checkpoint);
    return this.commitCoveragePageTransaction(
      lease,
      records,
      validatedCheckpoint,
      observedAtText
    );
  }

  bitgetRoundsEqual(
    untrustedLease: CoverageLease,
    left: 1 | 2,
    right: 2 | 3
  ): boolean {
    const lease = coverageLease(untrustedLease);
    if (
      lease.exchangeId !== 'bitget'
      || (left !== 1 && left !== 2)
      || (right !== 2 && right !== 3)
      || right !== left + 1
    ) {
      throw new Error('invalid Bitget funding scan round comparison');
    }
    return this.database.transaction((): boolean => {
      this.requireCurrentCoverageState(lease);
      return this.bitgetRoundsEqualInsideCurrentTransaction(lease, left, right);
    })();
  }

  completeCoverage(
    untrustedLease: CoverageLease,
    untrustedEvidence: FundingExhaustionEvidence,
    completedAt: Date
  ): void {
    const lease = coverageLease(untrustedLease);
    const evidence = normalizedExhaustionEvidence(
      untrustedEvidence,
      'funding exhaustion evidence'
    );
    if (
      evidence.exchangeId !== lease.exchangeId
      || evidence.generation !== lease.generation
      || evidence.cutoffMs !== lease.cutoffMs
    ) {
      throw new Error('invalid funding exhaustion evidence: lease mismatch');
    }
    const completedAtText = dateTimestamp(
      completedAt,
      'funding coverage completion time'
    );
    this.database.transaction(() => {
      const state = this.requireCurrentCoverageState(lease);
      if (evidence.exchangeId === 'bitget') {
        if (lease.exchangeId !== 'bitget') {
          throw new Error('invalid funding exhaustion evidence: lease mismatch');
        }
        const [left, right] = evidence.matchingRounds;
        if (!this.bitgetRoundsEqualInsideCurrentTransaction(
          lease,
          left,
          right
        )) {
          throw new Error('invalid funding exhaustion evidence: Bitget rounds are not equal');
        }
      }
      this.deleteBitgetScansForLease.run(
        lease.exchangeId,
        lease.exchangeMarketId,
        lease.generation
      );
      const clearsReactivation = lease.kind === 'REACTIVATION';
      const update = this.updateCoverageComplete.run({
        ...lease,
        completedAt: completedAtText,
        evidenceJson: JSON.stringify(evidence),
        inactiveFinalCaughtUpAt: lease.kind === 'INACTIVE_FINAL'
          ? completedAtText
          : state.inactiveFinalCaughtUpAt,
        reactivationRequired: clearsReactivation
          ? 0
          : state.reactivationRequired ? 1 : 0,
        reactivationAfterGeneration: clearsReactivation
          ? null
          : state.reactivationAfterGeneration
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new StaleFundingTaskError();
      }
    })();
  }

  failCoverage(
    untrustedLease: CoverageLease,
    untrustedFailure: FundingTaskFailure,
    failedAt: Date
  ): void {
    const lease = coverageLease(untrustedLease);
    const failure = normalizedFailure(untrustedFailure);
    const failedAtText = dateTimestamp(failedAt, 'funding coverage failure time');
    this.database.transaction(() => {
      this.requireCurrentCoverageState(lease);
      this.deleteBitgetScansForLease.run(
        lease.exchangeId,
        lease.exchangeMarketId,
        lease.generation
      );
      const update = this.updateCoverageFailure.run({
        ...lease,
        failedAt: failedAtText,
        failureCode: failure.code,
        failureSummary: failure.summary
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new StaleFundingTaskError();
      }
    })();
  }

  startIncremental(
    untrustedMarket: FundingMarketIdentity,
    startedAt: Date
  ): IncrementalLease {
    const market = marketIdentity(untrustedMarket);
    const startedAtText = dateTimestamp(startedAt, 'funding incremental start time');
    return this.database.transaction((): IncrementalLease => {
      const state = this.stateForMarket(market);
      if (
        state === null
        || state.symbol !== market.symbol
        || !stateAllowsIncremental(state)
      ) {
        throw new Error('funding market is not eligible for incremental sync');
      }
      if (state.incrementalStatus === 'RUNNING') {
        throw new Error('funding incremental task is already RUNNING');
      }
      if (state.incrementalGeneration === MAX_SAFE_INTEGER) {
        throw new Error('funding incremental generation exhausted');
      }
      const generation = state.incrementalGeneration + 1;
      const update = this.updateIncrementalStart.run({
        ...market,
        generation,
        previousGeneration: state.incrementalGeneration,
        previousStatus: state.incrementalStatus,
        startedAt: startedAtText
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new StaleFundingTaskError();
      }
      return {
        ...market,
        generation,
        frozenBoundaryMs: state.latestFundingTimestampMs
      };
    })();
  }

  restartInterruptedIncremental(
    untrustedMarket: FundingMarketIdentity,
    restartedAt: Date
  ): IncrementalLease {
    const market = marketIdentity(untrustedMarket);
    const restartedAtText = dateTimestamp(
      restartedAt,
      'funding incremental restart time'
    );
    return this.database.transaction((): IncrementalLease => {
      const state = this.stateForMarket(market);
      if (
        state === null
        || state.symbol !== market.symbol
        || state.incrementalStatus !== 'RUNNING'
      ) {
        throw new Error('funding market has no interrupted RUNNING incremental task');
      }
      if (!stateAllowsIncremental(state)) {
        throw new Error('interrupted incremental task is no longer eligible');
      }
      if (state.incrementalGeneration === MAX_SAFE_INTEGER) {
        throw new Error('funding incremental generation exhausted');
      }
      const generation = state.incrementalGeneration + 1;
      const update = this.updateIncrementalStart.run({
        ...market,
        generation,
        previousGeneration: state.incrementalGeneration,
        previousStatus: 'RUNNING',
        startedAt: restartedAtText
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new StaleFundingTaskError();
      }
      return {
        ...market,
        generation,
        frozenBoundaryMs: state.latestFundingTimestampMs
      };
    })();
  }

  isIncrementalLeaseEligible(untrustedLease: IncrementalLease): boolean {
    const lease = incrementalLease(untrustedLease);
    const state = this.stateForMarket(lease);
    return state !== null && incrementalStateMatchesLease(state, lease);
  }

  commitIncrementalPage(
    untrustedLease: IncrementalLease,
    untrustedRecords: readonly SettledFundingRate[],
    observedAt: Date
  ): FundingPageWriteResult {
    const lease = incrementalLease(untrustedLease);
    const records = deduplicatePageRecords(untrustedRecords, lease);
    const observedAtText = dateTimestamp(
      observedAt,
      'funding incremental page observation time'
    );
    return this.database.transaction((): FundingPageWriteResult => {
      this.requireCurrentIncrementalState(lease);
      const result = this.writeRecordsInCurrentTransaction(
        lease,
        records,
        observedAtText
      );
      const pageOldestMs = Math.min(...records.map(
        ({ fundingTimestampMs }) => fundingTimestampMs
      ));
      const pageLatestMs = Math.max(...records.map(
        ({ fundingTimestampMs }) => fundingTimestampMs
      ));
      const update = this.updateIncrementalCheckpoint.run({
        ...lease,
        pageOldestMs,
        pageLatestMs,
        observedAt: observedAtText
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new StaleFundingTaskError();
      }
      return result;
    })();
  }

  completeIncremental(
    untrustedLease: IncrementalLease,
    completedAt: Date
  ): void {
    const lease = incrementalLease(untrustedLease);
    const completedAtText = dateTimestamp(
      completedAt,
      'funding incremental completion time'
    );
    this.finishIncremental(
      lease,
      'IDLE',
      completedAtText,
      null,
      true
    );
  }

  failIncremental(
    untrustedLease: IncrementalLease,
    untrustedFailure: FundingTaskFailure,
    failedAt: Date
  ): void {
    const lease = incrementalLease(untrustedLease);
    const failure = normalizedFailure(untrustedFailure);
    const failedAtText = dateTimestamp(failedAt, 'funding incremental failure time');
    this.finishIncremental(
      lease,
      'INCOMPLETE',
      failedAtText,
      failure,
      false
    );
  }

  cancelIncremental(
    untrustedLease: IncrementalLease,
    canceledAt: Date
  ): void {
    const lease = incrementalLease(untrustedLease);
    const canceledAtText = dateTimestamp(
      canceledAt,
      'funding incremental cancellation time'
    );
    this.finishIncremental(lease, 'IDLE', canceledAtText, null, false);
  }

  private stateForMarket(
    market: FundingMarketIdentity
  ): FundingMarketState | null {
    const row = this.selectState.get(
      market.exchangeId,
      market.exchangeMarketId
    ) as FundingStateDbRow | undefined;
    return row === undefined ? null : validateStateRow(row);
  }

  private requireCurrentCoverageState(
    lease: CoverageLease
  ): FundingMarketState {
    const state = this.stateForMarket(lease);
    if (
      state === null
      || !coverageStateMatchesLease(state, lease)
      || !coverageStateAllowsLease(state, lease)
    ) {
      throw new StaleFundingTaskError();
    }
    return state;
  }

  private requireCurrentIncrementalState(
    lease: IncrementalLease
  ): FundingMarketState {
    const state = this.stateForMarket(lease);
    if (state === null || !incrementalStateMatchesLease(state, lease)) {
      throw new StaleFundingTaskError();
    }
    return state;
  }

  private bitgetRoundsEqualInsideCurrentTransaction(
    lease: Extract<CoverageLease, { readonly exchangeId: 'bitget' }>,
    left: 1 | 2,
    right: 2 | 3
  ): boolean {
    const row = this.selectBitgetRoundDifference.get({
      ...lease,
      leftRound: left,
      rightRound: right
    }) as { readonly different: unknown };
    return !sqliteBoolean(row.different, 'Bitget scan round difference');
  }

  private finishIncremental(
    lease: IncrementalLease,
    status: 'IDLE' | 'INCOMPLETE',
    endedAt: string,
    failure: FundingTaskFailure | null,
    successful: boolean
  ): void {
    this.database.transaction(() => {
      const state = this.requireCurrentIncrementalState(lease);
      const update = this.updateIncrementalTerminal.run({
        ...lease,
        status,
        endedAt,
        lastSuccessAt: successful ? endedAt : state.incrementalLastSuccessAt,
        failureCode: failure?.code ?? null,
        failureSummary: failure?.summary ?? null
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new StaleFundingTaskError();
      }
    })();
  }

  private applyDiscoveryInsideTransaction(
    discoveryExchangeId: FundingExchangeId,
    observations: readonly FundingMarketObservation[],
    observedAt: string
  ): FundingDiscoveryResult {
    const existingRows = this.selectStates.all(
      discoveryExchangeId
    ) as FundingStateDbRow[];
    const existingByMarketId = new Map<string, FundingMarketState>();
    for (const row of existingRows) {
      const state = validateStateRow(row);
      existingByMarketId.set(state.exchangeMarketId, state);
    }
    const observationByMarketId = new Map(observations.map((observation) => (
      [observation.exchangeMarketId, observation] as const
    )));
    for (const state of existingByMarketId.values()) {
      const observation = observationByMarketId.get(state.exchangeMarketId);
      if (observation === undefined) {
        throw new IncompleteFundingDiscoveryError();
      }
      if (state.symbol !== observation.symbol) {
        throw new Error('invalid funding discovery: known market symbol changed');
      }
      if (state.active !== observation.active) {
        if (state.coverageGeneration === MAX_SAFE_INTEGER) {
          throw new Error('funding coverage generation exhausted');
        }
        if (
          state.incrementalStatus === 'RUNNING'
          && state.incrementalGeneration === MAX_SAFE_INTEGER
        ) {
          throw new Error('funding incremental generation exhausted');
        }
      }
    }

    const createdActiveMarketIds: string[] = [];
    const becameInactiveMarketIds: string[] = [];
    const reactivatedMarketIds: string[] = [];
    for (const observation of observations) {
      const existing = existingByMarketId.get(observation.exchangeMarketId);
      if (existing === undefined) {
        if (!observation.active) continue;
        this.insertState.run({ ...observation, observedAt });
        createdActiveMarketIds.push(observation.exchangeMarketId);
        continue;
      }
      if (existing.active === observation.active) {
        const update = this.updateObservedActiveState.run({
          ...observation,
          active: observation.active ? 1 : 0,
          observedAt
        });
        if (!sqliteIntegerEquals(update.changes, 1)) {
          throw new Error('funding discovery state changed during update');
        }
        continue;
      }

      const coverageGeneration = existing.coverageGeneration + 1;
      const remainsPending = existing.coverageStatus === 'PENDING'
        && existing.lastCaughtUpGeneration === null;
      const coverageFailure = remainsPending
        ? null
        : fundingTaskFailure('COVERAGE_CANCELED_BY_MARKET_STATE');
      const cancelIncremental = existing.incrementalStatus === 'RUNNING';
      const incrementalGeneration = cancelIncremental
        ? existing.incrementalGeneration + 1
        : existing.incrementalGeneration;
      const reactivated = observation.active;
      this.deleteBitgetScansForMarket.run(
        observation.exchangeId,
        observation.exchangeMarketId
      );
      const update = this.updateDiscoveryTransition.run({
        ...observation,
        active: observation.active ? 1 : 0,
        observedAt,
        previousActive: existing.active ? 1 : 0,
        previousCoverageGeneration: existing.coverageGeneration,
        previousIncrementalGeneration: existing.incrementalGeneration,
        reactivationRequired: reactivated ? 1 : 0,
        reactivationAfterGeneration: reactivated ? coverageGeneration : null,
        coverageStatus: remainsPending ? 'PENDING' : 'INCOMPLETE',
        coverageGeneration,
        coverageTaskKind: remainsPending ? null : existing.coverageTaskKind,
        coverageCutoffMs: remainsPending ? null : existing.coverageCutoffMs,
        coverageStartedAt: remainsPending ? null : existing.coverageStartedAt,
        coverageEndedAt: remainsPending ? null : observedAt,
        coverageErrorCode: coverageFailure?.code ?? null,
        coverageErrorSummary: coverageFailure?.summary ?? null,
        incrementalStatus: cancelIncremental
          ? 'IDLE'
          : existing.incrementalStatus,
        incrementalGeneration,
        incrementalEndedAt: cancelIncremental
          ? observedAt
          : existing.incrementalEndedAt,
        incrementalErrorCode: cancelIncremental
          ? null
          : existing.incrementalErrorCode,
        incrementalErrorSummary: cancelIncremental
          ? null
          : existing.incrementalErrorSummary
      });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new Error('funding discovery state changed during transition');
      }
      if (reactivated) {
        reactivatedMarketIds.push(observation.exchangeMarketId);
      } else {
        becameInactiveMarketIds.push(observation.exchangeMarketId);
      }
    }
    return {
      createdActiveMarketIds,
      becameInactiveMarketIds,
      reactivatedMarketIds,
      observedActiveCount: observations.filter(({ active }) => active).length,
      observedInactiveCount: observations.filter(({ active }) => !active).length
    };
  }

  private startCoverageInsideTransaction(
    market: FundingMarketIdentity,
    kind: FundingCoverageKind,
    cutoffMs: number,
    startedAt: string
  ): CoverageLease {
    const row = this.selectState.get(
      market.exchangeId,
      market.exchangeMarketId
    ) as FundingStateDbRow | undefined;
    if (row === undefined) {
      throw new Error('unknown funding market');
    }
    const state = validateStateRow(row);
    if (state.symbol !== market.symbol) {
      throw new Error('funding market is not eligible for coverage');
    }
    if (kind === 'INACTIVE_FINAL') {
      if (state.active) {
        throw new Error('active funding market is not eligible for inactive final coverage');
      }
      if (state.inactiveFinalCaughtUpAt !== null) {
        throw new Error('inactive funding market already completed final coverage');
      }
    } else if (kind === 'REACTIVATION') {
      if (!state.active || !state.reactivationRequired) {
        throw new Error('funding market is not eligible for reactivation coverage');
      }
    } else if (!state.active) {
      throw new Error('inactive funding market is not eligible for coverage');
    } else if (state.reactivationRequired) {
      throw new Error('funding market requires reactivation coverage');
    }
    if (state.coverageGeneration === MAX_SAFE_INTEGER) {
      throw new Error('funding coverage generation exhausted');
    }
    const generation = state.coverageGeneration + 1;
    if (
      kind === 'REACTIVATION'
      && (
        state.reactivationAfterGeneration === null
        || generation <= state.reactivationAfterGeneration
      )
    ) {
      throw new Error('funding reactivation coverage generation is not newer');
    }
    this.deleteBitgetScansForMarket.run(
      market.exchangeId,
      market.exchangeMarketId
    );
    const update = this.updateCoverageStart.run({
      ...market,
      kind,
      cutoffMs,
      startedAt,
      generation,
      previousGeneration: state.coverageGeneration
    });
    if (!sqliteIntegerEquals(update.changes, 1)) {
      throw new StaleFundingTaskError();
    }
    if (market.exchangeId === 'bitget') {
      return {
        exchangeId: 'bitget',
        exchangeMarketId: market.exchangeMarketId,
        symbol: market.symbol,
        generation,
        kind,
        cutoffMs,
        recovered: false,
        okxResumeAfterMs: null,
        requiredBitgetBoundaryMs: state.oldestFundingTimestampMs
      };
    }
    return {
      exchangeId: 'okx',
      exchangeMarketId: market.exchangeMarketId,
      symbol: market.symbol,
      generation,
      kind,
      cutoffMs,
      recovered: false,
      okxResumeAfterMs: null,
      requiredBitgetBoundaryMs: null
    };
  }

  private validateCheckpoint(
    lease: CoverageLease,
    checkpoint: CoveragePageCheckpoint
  ): CoveragePageCheckpoint {
    if (lease.exchangeId === 'bitget') {
      if (
        checkpoint.exchangeId !== 'bitget'
        || (checkpoint.round !== 1
          && checkpoint.round !== 2
          && checkpoint.round !== 3)
      ) {
        throw new Error('invalid Bitget funding coverage checkpoint');
      }
      return { exchangeId: 'bitget', round: checkpoint.round };
    }
    if (checkpoint.exchangeId !== 'okx') {
      throw new Error('invalid OKX funding coverage checkpoint');
    }
    return {
      exchangeId: 'okx',
      recoveryAnchorMs: timestampMs(
        checkpoint.recoveryAnchorMs,
        'OKX funding recovery anchor'
      )
    };
  }

  private commitCoveragePageInsideTransaction(
    lease: CoverageLease,
    records: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint,
    observedAt: string
  ): FundingPageWriteResult {
    this.requireCurrentCoverageState(lease);
    const pageLatestMs = Math.max(...records.map(
      ({ fundingTimestampMs }) => fundingTimestampMs
    ));
    if (
      checkpoint.exchangeId === 'okx'
      && checkpoint.recoveryAnchorMs !== pageLatestMs
    ) {
      throw new Error(
        'funding page transaction failed validation: '
        + 'invalid OKX funding checkpoint; anchor must equal page maximum'
      );
    }

    const result = this.writeRecordsInCurrentTransaction(
      lease,
      records,
      observedAt
    );
    if (checkpoint.exchangeId === 'bitget') {
      for (const record of records) {
        if (record.fundingTimestampMs <= lease.cutoffMs) {
          this.upsertBitgetScanRecord.run({
            ...record,
            generation: lease.generation,
            round: checkpoint.round
          });
        }
      }
    }

    const pageOldestMs = Math.min(...records.map(
      ({ fundingTimestampMs }) => fundingTimestampMs
    ));
    const update = this.updateCoverageCheckpoint.run({
      ...lease,
      pageOldestMs,
      pageLatestMs,
      okxResumeAfterMs: checkpoint.exchangeId === 'okx'
        ? checkpoint.recoveryAnchorMs
        : null,
      okxResumeGeneration: checkpoint.exchangeId === 'okx'
        ? lease.generation
        : null,
      observedAt
    });
    if (!sqliteIntegerEquals(update.changes, 1)) {
      throw new StaleFundingTaskError();
    }
    return result;
  }

  private writeRecordsInCurrentTransaction(
    market: FundingMarketIdentity,
    records: readonly SettledFundingRate[],
    observedAt: string
  ): FundingPageWriteResult {
    let inserted = 0;
    let unchanged = 0;
    let revised = 0;
    const revisedKeys: Array<{
      readonly fundingTimestampMs: number;
      readonly previousContentHash: string;
      readonly currentContentHash: string;
    }> = [];

    for (const record of records) {
      const row = this.selectHistoryRecord.get(
        record.exchangeId,
        record.exchangeMarketId,
        record.fundingTimestampMs
      ) as HistoryDbRow | undefined;
      if (row === undefined) {
        this.insertHistory.run({ ...record, observedAt });
        inserted += 1;
        continue;
      }

      const existing = validateHistoryRow(row, market);
      if (observedAt < existing.lastObservedAt) {
        throw new Error('funding page observation time moved backwards');
      }
      if (recordsEqual(existing, record)) {
        const update = this.updateUnchangedHistory.run({
          ...record,
          observedAt
        });
        if (!sqliteIntegerEquals(update.changes, 1)) {
          throw new Error('funding history changed during observation update');
        }
        unchanged += 1;
        continue;
      }

      this.insertRevision.run({
        ...existing,
        replacedAt: observedAt
      });
      const update = this.updateRevisedHistory.run({ ...record, observedAt });
      if (!sqliteIntegerEquals(update.changes, 1)) {
        throw new Error('funding history changed during revision update');
      }
      revised += 1;
      revisedKeys.push({
        fundingTimestampMs: record.fundingTimestampMs,
        previousContentHash: existing.contentHash,
        currentContentHash: record.contentHash
      });
    }
    return { inserted, unchanged, revised, revisedKeys };
  }
}
