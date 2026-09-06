export type SqliteFundingRateSchemaScope = 'main' | 'temp';
export type SqliteFundingRateSchemaObjectType = 'table' | 'trigger';

export interface SqliteFundingRateSchemaObject {
  readonly scope: SqliteFundingRateSchemaScope;
  readonly type: SqliteFundingRateSchemaObjectType;
  readonly name: string;
  readonly tableName: string;
  readonly installSql: string;
  readonly storedSql: string;
}

interface FundingRateSchemaDefinition {
  readonly scope: SqliteFundingRateSchemaScope;
  readonly type: SqliteFundingRateSchemaObjectType;
  readonly name: string;
  readonly tableName: string;
  readonly installPrefix: string;
  readonly storedPrefix: string;
  readonly body: string;
}

function fundingRateSchemaObject(
  definition: FundingRateSchemaDefinition
): SqliteFundingRateSchemaObject {
  return Object.freeze({
    scope: definition.scope,
    type: definition.type,
    name: definition.name,
    tableName: definition.tableName,
    installSql:
      `${definition.installPrefix} ${definition.name}${definition.body};`,
    storedSql:
      `${definition.storedPrefix} ${definition.name}${definition.body}`
  });
}

const FUNDING_RATE_HISTORY_BODY = ` (
    exchange_id TEXT NOT NULL CHECK (exchange_id IN ('bitget', 'okx')),
    exchange_market_id TEXT NOT NULL CHECK (
      typeof(exchange_market_id) = 'text'
      AND length(exchange_market_id) > 0
      AND trim(exchange_market_id) = exchange_market_id
    ),
    symbol TEXT NOT NULL CHECK (
      typeof(symbol) = 'text'
      AND length(symbol) > 0
      AND trim(symbol) = symbol
    ),
    funding_timestamp_ms INTEGER NOT NULL CHECK (
      typeof(funding_timestamp_ms) = 'integer'
      AND funding_timestamp_ms BETWEEN 0 AND 8640000000000000
    ),
    funding_rate TEXT NOT NULL CHECK (
      typeof(funding_rate) = 'text'
      AND length(funding_rate) BETWEEN 1 AND 10000
      AND trim(funding_rate) = funding_rate
      AND funding_rate GLOB '*[0-9]*'
      AND funding_rate NOT GLOB '*[^0-9eE+.-]*'
      AND funding_rate NOT IN ('+', '-', '.', '+.', '-.')
    ),
    raw_json TEXT NOT NULL CHECK (
      typeof(raw_json) = 'text'
      AND CASE
        WHEN json_valid(raw_json) = 1 THEN json_type(raw_json) = 'object'
        ELSE 0
      END
    ),
    content_hash TEXT NOT NULL CHECK (
      typeof(content_hash) = 'text'
      AND length(content_hash) = 64
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    first_observed_at TEXT NOT NULL CHECK (
      typeof(first_observed_at) = 'text'
      AND length(first_observed_at) = 24
      AND first_observed_at GLOB '????-??-??T??:??:??.???Z'
    ),
    last_observed_at TEXT NOT NULL CHECK (
      typeof(last_observed_at) = 'text'
      AND length(last_observed_at) = 24
      AND last_observed_at GLOB '????-??-??T??:??:??.???Z'
    ),
    PRIMARY KEY (exchange_id, exchange_market_id, funding_timestamp_ms),
    CHECK (first_observed_at <= last_observed_at)
  )`;

const FUNDING_RATE_REVISIONS_BODY = ` (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id TEXT NOT NULL CHECK (exchange_id IN ('bitget', 'okx')),
    exchange_market_id TEXT NOT NULL CHECK (
      typeof(exchange_market_id) = 'text'
      AND length(exchange_market_id) > 0
      AND trim(exchange_market_id) = exchange_market_id
    ),
    symbol TEXT NOT NULL CHECK (
      typeof(symbol) = 'text'
      AND length(symbol) > 0
      AND trim(symbol) = symbol
    ),
    funding_timestamp_ms INTEGER NOT NULL CHECK (
      typeof(funding_timestamp_ms) = 'integer'
      AND funding_timestamp_ms BETWEEN 0 AND 8640000000000000
    ),
    funding_rate TEXT NOT NULL CHECK (
      typeof(funding_rate) = 'text'
      AND length(funding_rate) BETWEEN 1 AND 10000
      AND trim(funding_rate) = funding_rate
      AND funding_rate GLOB '*[0-9]*'
      AND funding_rate NOT GLOB '*[^0-9eE+.-]*'
      AND funding_rate NOT IN ('+', '-', '.', '+.', '-.')
    ),
    raw_json TEXT NOT NULL CHECK (
      typeof(raw_json) = 'text'
      AND CASE
        WHEN json_valid(raw_json) = 1 THEN json_type(raw_json) = 'object'
        ELSE 0
      END
    ),
    content_hash TEXT NOT NULL CHECK (
      typeof(content_hash) = 'text'
      AND length(content_hash) = 64
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    first_observed_at TEXT NOT NULL CHECK (
      typeof(first_observed_at) = 'text'
      AND length(first_observed_at) = 24
      AND first_observed_at GLOB '????-??-??T??:??:??.???Z'
    ),
    last_observed_at TEXT NOT NULL CHECK (
      typeof(last_observed_at) = 'text'
      AND length(last_observed_at) = 24
      AND last_observed_at GLOB '????-??-??T??:??:??.???Z'
    ),
    replaced_at TEXT NOT NULL CHECK (
      typeof(replaced_at) = 'text'
      AND length(replaced_at) = 24
      AND replaced_at GLOB '????-??-??T??:??:??.???Z'
    ),
    CHECK (first_observed_at <= last_observed_at),
    CHECK (last_observed_at <= replaced_at)
  )`;

const FUNDING_RATE_SYNC_STATE_BODY = ` (
    exchange_id TEXT NOT NULL CHECK (exchange_id IN ('bitget', 'okx')),
    exchange_market_id TEXT NOT NULL CHECK (
      typeof(exchange_market_id) = 'text'
      AND length(exchange_market_id) > 0
      AND trim(exchange_market_id) = exchange_market_id
    ),
    symbol TEXT NOT NULL CHECK (
      typeof(symbol) = 'text'
      AND length(symbol) > 0
      AND trim(symbol) = symbol
    ),
    active INTEGER NOT NULL CHECK (typeof(active) = 'integer' AND active IN (0, 1)),
    active_observed_at TEXT NOT NULL CHECK (
      typeof(active_observed_at) = 'text'
      AND length(active_observed_at) = 24
      AND active_observed_at GLOB '????-??-??T??:??:??.???Z'
    ),
    active_changed_at TEXT NOT NULL CHECK (
      typeof(active_changed_at) = 'text'
      AND length(active_changed_at) = 24
      AND active_changed_at GLOB '????-??-??T??:??:??.???Z'
    ),
    reactivation_required INTEGER NOT NULL DEFAULT 0 CHECK (
      typeof(reactivation_required) = 'integer'
      AND reactivation_required IN (0, 1)
    ),
    reactivation_after_generation INTEGER CHECK (
      reactivation_after_generation IS NULL
      OR (
        typeof(reactivation_after_generation) = 'integer'
        AND reactivation_after_generation BETWEEN 0 AND 9007199254740991
      )
    ),
    inactive_final_caught_up_at TEXT CHECK (
      inactive_final_caught_up_at IS NULL
      OR (
        typeof(inactive_final_caught_up_at) = 'text'
        AND length(inactive_final_caught_up_at) = 24
        AND inactive_final_caught_up_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    coverage_status TEXT NOT NULL CHECK (
      coverage_status IN ('PENDING', 'BACKFILLING', 'CAUGHT_UP', 'INCOMPLETE')
    ),
    coverage_generation INTEGER NOT NULL DEFAULT 0 CHECK (
      typeof(coverage_generation) = 'integer'
      AND coverage_generation BETWEEN 0 AND 9007199254740991
    ),
    coverage_task_kind TEXT CHECK (
      coverage_task_kind IS NULL
      OR coverage_task_kind IN ('INITIAL', 'PERIODIC', 'INACTIVE_FINAL', 'REACTIVATION')
    ),
    coverage_cutoff_ms INTEGER CHECK (
      coverage_cutoff_ms IS NULL
      OR (
        typeof(coverage_cutoff_ms) = 'integer'
        AND coverage_cutoff_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    coverage_required_bitget_boundary_ms INTEGER CHECK (
      coverage_required_bitget_boundary_ms IS NULL
      OR (
        typeof(coverage_required_bitget_boundary_ms) = 'integer'
        AND coverage_required_bitget_boundary_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    coverage_initial_okx_after_ms INTEGER CHECK (
      coverage_initial_okx_after_ms IS NULL
      OR (
        typeof(coverage_initial_okx_after_ms) = 'integer'
        AND coverage_initial_okx_after_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    last_caught_up_generation INTEGER CHECK (
      last_caught_up_generation IS NULL
      OR (
        typeof(last_caught_up_generation) = 'integer'
        AND last_caught_up_generation BETWEEN 0 AND 9007199254740991
      )
    ),
    last_caught_up_cutoff_ms INTEGER CHECK (
      last_caught_up_cutoff_ms IS NULL
      OR (
        typeof(last_caught_up_cutoff_ms) = 'integer'
        AND last_caught_up_cutoff_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    last_exhausted_at TEXT CHECK (
      last_exhausted_at IS NULL
      OR (
        typeof(last_exhausted_at) = 'text'
        AND length(last_exhausted_at) = 24
        AND last_exhausted_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    last_exhaustion_evidence_json TEXT CHECK (
      last_exhaustion_evidence_json IS NULL
      OR (
        typeof(last_exhaustion_evidence_json) = 'text'
        AND CASE
          WHEN json_valid(last_exhaustion_evidence_json) = 1
            THEN json_type(last_exhaustion_evidence_json) = 'object'
          ELSE 0
        END
      )
    ),
    okx_resume_after_ms INTEGER CHECK (
      okx_resume_after_ms IS NULL
      OR (
        typeof(okx_resume_after_ms) = 'integer'
        AND okx_resume_after_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    okx_resume_generation INTEGER CHECK (
      okx_resume_generation IS NULL
      OR (
        typeof(okx_resume_generation) = 'integer'
        AND okx_resume_generation BETWEEN 0 AND 9007199254740991
      )
    ),
    oldest_funding_timestamp_ms INTEGER CHECK (
      oldest_funding_timestamp_ms IS NULL
      OR (
        typeof(oldest_funding_timestamp_ms) = 'integer'
        AND oldest_funding_timestamp_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    latest_funding_timestamp_ms INTEGER CHECK (
      latest_funding_timestamp_ms IS NULL
      OR (
        typeof(latest_funding_timestamp_ms) = 'integer'
        AND latest_funding_timestamp_ms BETWEEN 0 AND 8640000000000000
      )
    ),
    coverage_started_at TEXT CHECK (
      coverage_started_at IS NULL
      OR (
        typeof(coverage_started_at) = 'text'
        AND length(coverage_started_at) = 24
        AND coverage_started_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    coverage_ended_at TEXT CHECK (
      coverage_ended_at IS NULL
      OR (
        typeof(coverage_ended_at) = 'text'
        AND length(coverage_ended_at) = 24
        AND coverage_ended_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    coverage_last_success_at TEXT CHECK (
      coverage_last_success_at IS NULL
      OR (
        typeof(coverage_last_success_at) = 'text'
        AND length(coverage_last_success_at) = 24
        AND coverage_last_success_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    coverage_error_code TEXT CHECK (
      coverage_error_code IS NULL
      OR coverage_error_code IN (
        'COVERAGE_CANCELED_BY_MARKET_STATE',
        'REQUEST_RETRY_EXHAUSTED',
        'SOURCE_RESPONSE_INVALID',
        'CURSOR_NOT_ADVANCING',
        'BITGET_BOUNDARY_NOT_SEEN',
        'BITGET_SCAN_NOT_CONVERGED',
        'DATABASE_WRITE_FAILED'
      )
    ),
    coverage_error_summary TEXT CHECK (
      coverage_error_summary IS NULL
      OR (
        typeof(coverage_error_summary) = 'text'
        AND length(CAST(coverage_error_summary AS BLOB)) BETWEEN 1 AND 512
        AND instr(coverage_error_summary, char(0)) = 0
        AND coverage_error_summary NOT GLOB '*[^ -~]*'
      )
    ),
    incremental_status TEXT NOT NULL DEFAULT 'IDLE' CHECK (
      incremental_status IN ('IDLE', 'RUNNING', 'INCOMPLETE')
    ),
    incremental_generation INTEGER NOT NULL DEFAULT 0 CHECK (
      typeof(incremental_generation) = 'integer'
      AND incremental_generation BETWEEN 0 AND 9007199254740991
    ),
    incremental_started_at TEXT CHECK (
      incremental_started_at IS NULL
      OR (
        typeof(incremental_started_at) = 'text'
        AND length(incremental_started_at) = 24
        AND incremental_started_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    incremental_ended_at TEXT CHECK (
      incremental_ended_at IS NULL
      OR (
        typeof(incremental_ended_at) = 'text'
        AND length(incremental_ended_at) = 24
        AND incremental_ended_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    incremental_last_success_at TEXT CHECK (
      incremental_last_success_at IS NULL
      OR (
        typeof(incremental_last_success_at) = 'text'
        AND length(incremental_last_success_at) = 24
        AND incremental_last_success_at GLOB '????-??-??T??:??:??.???Z'
      )
    ),
    incremental_error_code TEXT CHECK (
      incremental_error_code IS NULL
      OR incremental_error_code IN (
        'COVERAGE_CANCELED_BY_MARKET_STATE',
        'REQUEST_RETRY_EXHAUSTED',
        'SOURCE_RESPONSE_INVALID',
        'CURSOR_NOT_ADVANCING',
        'BITGET_BOUNDARY_NOT_SEEN',
        'BITGET_SCAN_NOT_CONVERGED',
        'DATABASE_WRITE_FAILED'
      )
    ),
    incremental_error_summary TEXT CHECK (
      incremental_error_summary IS NULL
      OR (
        typeof(incremental_error_summary) = 'text'
        AND length(CAST(incremental_error_summary AS BLOB)) BETWEEN 1 AND 512
        AND instr(incremental_error_summary, char(0)) = 0
        AND incremental_error_summary NOT GLOB '*[^ -~]*'
      )
    ),
    created_at TEXT NOT NULL CHECK (
      typeof(created_at) = 'text'
      AND length(created_at) = 24
      AND created_at GLOB '????-??-??T??:??:??.???Z'
    ),
    updated_at TEXT NOT NULL CHECK (
      typeof(updated_at) = 'text'
      AND length(updated_at) = 24
      AND updated_at GLOB '????-??-??T??:??:??.???Z'
    ),
    PRIMARY KEY (exchange_id, exchange_market_id),
    CHECK (
      (oldest_funding_timestamp_ms IS NULL AND latest_funding_timestamp_ms IS NULL)
      OR (
        oldest_funding_timestamp_ms IS NOT NULL
        AND latest_funding_timestamp_ms IS NOT NULL
        AND oldest_funding_timestamp_ms <= latest_funding_timestamp_ms
      )
    ),
    CHECK (
      (last_caught_up_generation IS NULL
        AND last_caught_up_cutoff_ms IS NULL
        AND last_exhausted_at IS NULL
        AND last_exhaustion_evidence_json IS NULL)
      OR (last_caught_up_generation IS NOT NULL
        AND last_caught_up_cutoff_ms IS NOT NULL
        AND last_exhausted_at IS NOT NULL
        AND last_exhaustion_evidence_json IS NOT NULL)
    ),
    CHECK (
      (okx_resume_after_ms IS NULL AND okx_resume_generation IS NULL)
      OR (
        okx_resume_after_ms IS NOT NULL
        AND okx_resume_generation IS NOT NULL
        AND exchange_id = 'okx'
        AND coverage_status = 'BACKFILLING'
        AND okx_resume_generation = coverage_generation
      )
    ),
    CHECK (
      (coverage_status = 'BACKFILLING'
        AND (
          (exchange_id = 'bitget'
            AND coverage_initial_okx_after_ms IS NULL)
          OR (exchange_id = 'okx'
            AND coverage_required_bitget_boundary_ms IS NULL
            AND (
              coverage_initial_okx_after_ms IS NULL
              OR (okx_resume_after_ms IS NOT NULL
                AND okx_resume_after_ms <= coverage_initial_okx_after_ms)
            ))
        ))
      OR (coverage_status <> 'BACKFILLING'
        AND coverage_required_bitget_boundary_ms IS NULL
        AND coverage_initial_okx_after_ms IS NULL)
    ),
    CHECK (
      (reactivation_required = 0 AND reactivation_after_generation IS NULL)
      OR (
        reactivation_required = 1
        AND active = 1
        AND reactivation_after_generation IS NOT NULL
        AND inactive_final_caught_up_at IS NULL
      )
    ),
    CHECK (
      inactive_final_caught_up_at IS NULL
      OR (active = 0 AND coverage_status = 'CAUGHT_UP')
    ),
    CHECK (
      (coverage_error_code IS NULL AND coverage_error_summary IS NULL)
      OR (coverage_error_code = 'COVERAGE_CANCELED_BY_MARKET_STATE'
        AND coverage_error_summary = 'coverage canceled after market state changed')
      OR (coverage_error_code = 'REQUEST_RETRY_EXHAUSTED'
        AND coverage_error_summary = 'public funding request retries exhausted')
      OR (coverage_error_code = 'SOURCE_RESPONSE_INVALID'
        AND coverage_error_summary = 'public funding response failed validation')
      OR (coverage_error_code = 'CURSOR_NOT_ADVANCING'
        AND coverage_error_summary = 'funding history cursor did not advance')
      OR (coverage_error_code = 'BITGET_BOUNDARY_NOT_SEEN'
        AND coverage_error_summary = 'saved Bitget boundary was not observed')
      OR (coverage_error_code = 'BITGET_SCAN_NOT_CONVERGED'
        AND coverage_error_summary = 'Bitget scans did not converge')
      OR (coverage_error_code = 'DATABASE_WRITE_FAILED'
        AND coverage_error_summary = 'funding page transaction failed')
    ),
    CHECK (
      (incremental_error_code IS NULL AND incremental_error_summary IS NULL)
      OR (incremental_error_code = 'COVERAGE_CANCELED_BY_MARKET_STATE'
        AND incremental_error_summary = 'coverage canceled after market state changed')
      OR (incremental_error_code = 'REQUEST_RETRY_EXHAUSTED'
        AND incremental_error_summary = 'public funding request retries exhausted')
      OR (incremental_error_code = 'SOURCE_RESPONSE_INVALID'
        AND incremental_error_summary = 'public funding response failed validation')
      OR (incremental_error_code = 'CURSOR_NOT_ADVANCING'
        AND incremental_error_summary = 'funding history cursor did not advance')
      OR (incremental_error_code = 'BITGET_BOUNDARY_NOT_SEEN'
        AND incremental_error_summary = 'saved Bitget boundary was not observed')
      OR (incremental_error_code = 'BITGET_SCAN_NOT_CONVERGED'
        AND incremental_error_summary = 'Bitget scans did not converge')
      OR (incremental_error_code = 'DATABASE_WRITE_FAILED'
        AND incremental_error_summary = 'funding page transaction failed')
    ),
    CHECK (
      (coverage_status = 'PENDING'
        AND coverage_task_kind IS NULL
        AND coverage_cutoff_ms IS NULL
        AND coverage_started_at IS NULL
        AND coverage_ended_at IS NULL
        AND coverage_error_code IS NULL)
      OR (coverage_status = 'BACKFILLING'
        AND coverage_task_kind IS NOT NULL
        AND coverage_cutoff_ms IS NOT NULL
        AND coverage_started_at IS NOT NULL
        AND coverage_ended_at IS NULL
        AND coverage_error_code IS NULL)
      OR (coverage_status = 'INCOMPLETE'
        AND coverage_task_kind IS NOT NULL
        AND coverage_cutoff_ms IS NOT NULL
        AND coverage_started_at IS NOT NULL
        AND coverage_ended_at IS NOT NULL
        AND coverage_error_code IS NOT NULL)
      OR (coverage_status = 'CAUGHT_UP'
        AND coverage_task_kind IS NOT NULL
        AND coverage_cutoff_ms IS NOT NULL
        AND coverage_started_at IS NOT NULL
        AND coverage_ended_at IS NOT NULL
        AND coverage_last_success_at IS NOT NULL
        AND coverage_error_code IS NULL
        AND coverage_generation = last_caught_up_generation
        AND coverage_cutoff_ms = last_caught_up_cutoff_ms)
    ),
    CHECK (
      (incremental_status = 'IDLE'
        AND incremental_error_code IS NULL)
      OR (incremental_status = 'RUNNING'
        AND incremental_started_at IS NOT NULL
        AND incremental_ended_at IS NULL
        AND incremental_error_code IS NULL)
      OR (incremental_status = 'INCOMPLETE'
        AND incremental_started_at IS NOT NULL
        AND incremental_ended_at IS NOT NULL
        AND incremental_error_code IS NOT NULL)
    )
  )`;

const FUNDING_RATE_REVISIONS_NO_UPDATE_BODY = `
  BEFORE UPDATE ON funding_rate_revisions
  BEGIN
    SELECT RAISE(ABORT, 'funding rate revisions are immutable');
  END`;

const FUNDING_RATE_REVISIONS_NO_DELETE_BODY = `
  BEFORE DELETE ON funding_rate_revisions
  BEGIN
    SELECT RAISE(ABORT, 'funding rate revisions are immutable');
  END`;

const FUNDING_RATE_BITGET_SCAN_BODY = ` (
        exchange_id TEXT NOT NULL CHECK (exchange_id = 'bitget'),
        exchange_market_id TEXT NOT NULL,
        coverage_generation INTEGER NOT NULL CHECK (
          coverage_generation BETWEEN 0 AND 9007199254740991
        ),
        scan_round INTEGER NOT NULL CHECK (scan_round IN (1, 2, 3)),
        funding_timestamp_ms INTEGER NOT NULL CHECK (
          funding_timestamp_ms BETWEEN 0 AND 8640000000000000
        ),
        symbol TEXT NOT NULL,
        funding_rate TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (
          exchange_id,
          exchange_market_id,
          coverage_generation,
          scan_round,
          funding_timestamp_ms
        )
      ) WITHOUT ROWID`;

export const SQLITE_FUNDING_RATE_SCHEMA_OBJECTS = Object.freeze([
  fundingRateSchemaObject({
    scope: 'main',
    type: 'table',
    name: 'funding_rate_history',
    tableName: 'funding_rate_history',
    installPrefix: 'CREATE TABLE IF NOT EXISTS',
    storedPrefix: 'CREATE TABLE',
    body: FUNDING_RATE_HISTORY_BODY
  }),
  fundingRateSchemaObject({
    scope: 'main',
    type: 'table',
    name: 'funding_rate_revisions',
    tableName: 'funding_rate_revisions',
    installPrefix: 'CREATE TABLE IF NOT EXISTS',
    storedPrefix: 'CREATE TABLE',
    body: FUNDING_RATE_REVISIONS_BODY
  }),
  fundingRateSchemaObject({
    scope: 'main',
    type: 'table',
    name: 'funding_rate_sync_state',
    tableName: 'funding_rate_sync_state',
    installPrefix: 'CREATE TABLE IF NOT EXISTS',
    storedPrefix: 'CREATE TABLE',
    body: FUNDING_RATE_SYNC_STATE_BODY
  }),
  fundingRateSchemaObject({
    scope: 'main',
    type: 'trigger',
    name: 'funding_rate_revisions_no_update',
    tableName: 'funding_rate_revisions',
    installPrefix: 'CREATE TRIGGER IF NOT EXISTS',
    storedPrefix: 'CREATE TRIGGER',
    body: FUNDING_RATE_REVISIONS_NO_UPDATE_BODY
  }),
  fundingRateSchemaObject({
    scope: 'main',
    type: 'trigger',
    name: 'funding_rate_revisions_no_delete',
    tableName: 'funding_rate_revisions',
    installPrefix: 'CREATE TRIGGER IF NOT EXISTS',
    storedPrefix: 'CREATE TRIGGER',
    body: FUNDING_RATE_REVISIONS_NO_DELETE_BODY
  }),
  fundingRateSchemaObject({
    scope: 'temp',
    type: 'table',
    name: 'funding_rate_bitget_scan',
    tableName: 'funding_rate_bitget_scan',
    installPrefix: 'CREATE TEMP TABLE IF NOT EXISTS',
    storedPrefix: 'CREATE TABLE',
    body: FUNDING_RATE_BITGET_SCAN_BODY
  })
] satisfies readonly SqliteFundingRateSchemaObject[]);

export const SQLITE_FUNDING_RATE_SCHEMA = SQLITE_FUNDING_RATE_SCHEMA_OBJECTS
  .filter(({ scope }) => scope === 'main')
  .map(({ installSql }) => installSql)
  .join('\n\n');
