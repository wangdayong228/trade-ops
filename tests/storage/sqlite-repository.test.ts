/// <reference types="node" />

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../../src/domain/client-order-id.js';
import {
  createTradeOpsError,
  TradeOpsError,
  type ErrorCode,
  type ErrorDetail
} from '../../src/errors/trade-ops-error.js';
import type {
  ExecutionMode,
  MarketKind,
  OrderRequest,
  OrderRole,
  OrderSnapshot,
  StrategyState
} from '../../src/domain/types.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { SQLITE_FUNDING_RATE_SCHEMA } from '../../src/storage/funding-rate-schema.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  OrderSnapshotValidationError,
  OrderSnapshotWriteConflictError,
  type StrategyRecord
} from '../../src/storage/strategy-repository.js';

const SYMBOL = 'BTC/USDT';
const CONFIRMATION_OCCURRED_AT = '2026-10-03T00:00:00.000Z';

type Task3StrategyState = StrategyState | 'PREFLIGHT_INVALIDATED';

interface Task3StrategyRecord extends Omit<StrategyRecord, 'state'> {
  readonly state: Task3StrategyState;
  readonly preflightFailure: ErrorDetail | null;
}

interface Task3Repository {
  confirmPreflight(expected: Readonly<StrategyRecord>): void;
  invalidatePreflight(
    expected: Readonly<StrategyRecord>,
    failure: ErrorDetail
  ): void;
}

interface Task3RepositoryInternals {
  confirmPreflightTransaction?: (expected: Readonly<StrategyRecord>) => void;
  selectStrategy?: {
    get(...parameters: unknown[]): unknown;
  };
}

function task3Repository(
  repository: SqliteStrategyRepository
): Task3Repository {
  const candidate = repository as unknown as Partial<Task3Repository>;
  assert.equal(
    typeof candidate.confirmPreflight,
    'function',
    'Task 3 requires confirmPreflight'
  );
  assert.equal(
    typeof candidate.invalidatePreflight,
    'function',
    'Task 3 requires invalidatePreflight'
  );
  return candidate as Task3Repository;
}

function task3Record(record: StrategyRecord): Task3StrategyRecord {
  assert.equal(
    Object.hasOwn(record, 'preflightFailure'),
    true,
    'Task 3 strategy records require preflightFailure'
  );
  return record as Task3StrategyRecord;
}

function confirmationFailure(
  overrides: Partial<ErrorDetail> = {}
): ErrorDetail {
  const source = createTradeOpsError({
    code: 'BALANCE_INSUFFICIENT',
    phase: 'confirmation',
    subject: {
      type: 'account',
      exchangeId: 'bitget',
      symbol: SYMBOL,
      field: 'freeUsdt'
    },
    expected: 'at least 60060 USDT',
    actual: '50000 USDT',
    occurredAt: CONFIRMATION_OCCURRED_AT
  }).detail;
  return Object.freeze({ ...source, ...overrides });
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to throw');
}

function assertTrustedStorageError(
  error: unknown,
  code: Extract<ErrorCode,
    | 'STORAGE_OPERATION_FAILED'
    | 'STORAGE_RECORD_INVALID'
    | 'STORAGE_TRANSITION_REJECTED'>,
  subject: 'strategy' | 'database',
  strategyId: string,
  secretMarkers: readonly string[] = []
): asserts error is TradeOpsError {
  assert.ok(error instanceof TradeOpsError);
  assert.equal(error.detail.code, code);
  assert.equal(error.detail.phase, 'storage');
  assert.equal(error.detail.subject.type, subject);
  if (error.detail.subject.type === 'strategy') {
    assert.equal(error.detail.subject.strategyId, strategyId);
  } else if (error.detail.subject.type === 'database') {
    assert.equal(error.detail.subject.table, 'strategies');
    assert.equal(error.detail.subject.recordId, strategyId);
  }
  assert.notEqual(error.detail.actual, null);
  const rendered = JSON.stringify({
    name: error.name,
    message: error.message,
    detail: error.detail
  });
  for (const marker of secretMarkers) {
    assert.equal(rendered.includes(marker), false);
  }
}

function assertSchemaMismatch(action: () => unknown): TradeOpsError {
  const error = captureError(action);
  assert.ok(error instanceof TradeOpsError);
  assert.equal(error.detail.code, 'DATABASE_SCHEMA_VERSION_MISMATCH');
  assert.equal(error.detail.phase, 'startup');
  assert.equal(error.detail.subject.type, 'database');
  if (error.detail.subject.type === 'database') {
    assert.equal(error.detail.subject.table, 'strategies');
    assert.equal(error.detail.subject.operation, 'prepare strategy schema');
  }
  assert.notEqual(error.detail.actual, null);
  return error;
}

function assertStartupStorageError(
  error: unknown,
  operation: RegExp,
  secretMarkers: readonly string[] = [],
  expectedActual?: string
): asserts error is TradeOpsError {
  assert.ok(error instanceof TradeOpsError);
  assert.equal(error.detail.code, 'STORAGE_OPERATION_FAILED');
  assert.equal(error.detail.phase, 'startup');
  assert.equal(error.detail.subject.type, 'database');
  if (error.detail.subject.type === 'database') {
    assert.equal(error.detail.subject.table, 'strategies');
    assert.match(error.detail.subject.operation ?? '', operation);
  }
  assert.notEqual(error.detail.actual, null);
  if (expectedActual !== undefined) {
    assert.equal(error.detail.actual, expectedActual);
  }
  const exposed = [
    error.message,
    JSON.stringify(error.detail),
    error.stack ?? '',
    String((error as Error & { cause?: unknown }).cause ?? '')
  ].join('\n');
  for (const marker of secretMarkers) {
    assert.equal(exposed.includes(marker), false);
  }
}

function preflight(
  overrides: Partial<PreflightResult> = {}
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1.001',
    effectiveBaseQuantity: '1',
    mode: 'CONTRACT_FIRST',
    spotMarket: {
      exchangeId: 'bitget',
      symbol: SYMBOL,
      marketId: 'BTCUSDT',
      kind: 'spot',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '0.001',
      contractSize: '1',
      minBaseAmount: '0.001',
      minQuoteNotional: '5',
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
      contractSize: '0.001',
      minBaseAmount: '0.001',
      minQuoteNotional: '5',
      priceStep: '0.1'
    },
    accountSettings: {
      marginMode: 'isolated',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  };
}

function setup(t: TestContext): {
  database: Database.Database;
  repository: SqliteStrategyRepository;
} {
  const database = new Database(':memory:');
  t.after(() => database.close());
  return {
    database,
    repository: new SqliteStrategyRepository(database)
  };
}

function createExecutingStrategy(
  repository: SqliteStrategyRepository,
  preview: PreflightResult = preflight()
): string {
  const id = repository.createPending(preview).id;
  assert.equal(repository.claimForExecution(id), true);
  return id;
}

function requestFor(
  strategyId: string,
  role: OrderRole,
  overrides: Partial<OrderRequest> = {}
): OrderRequest {
  const common = {
    symbol: SYMBOL,
    baseQuantity: '1',
    clientOrderId: makeClientOrderId(strategyId, role)
  };
  let request: OrderRequest;
  switch (role) {
    case 'SPOT_MARKET':
      request = {
        ...common,
        kind: 'spot',
        type: 'market',
        side: 'buy'
      };
      break;
    case 'CONTRACT_MARKET':
      request = {
        ...common,
        kind: 'swap',
        type: 'market',
        side: 'sell',
        positionSide: 'SHORT',
        marginMode: 'isolated'
      };
      break;
    case 'SPOT_HEDGE_GTC':
      request = {
        ...common,
        kind: 'spot',
        type: 'limit',
        side: 'buy',
        price: '60000',
        timeInForce: 'GTC'
      };
      break;
    case 'CONTRACT_HEDGE_GTC':
      request = {
        ...common,
        kind: 'swap',
        type: 'limit',
        side: 'sell',
        price: '60000',
        timeInForce: 'GTC',
        positionSide: 'SHORT',
        marginMode: 'isolated'
      };
      break;
  }
  return { ...request, ...overrides };
}

function snapshotFor(
  request: OrderRequest,
  exchangeId: string,
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  return {
    exchangeId,
    exchangeOrderId: 'exchange-order-1',
    clientOrderId: request.clientOrderId,
    symbol: request.symbol,
    kind: request.kind,
    type: request.type,
    side: request.side,
    requestedBaseQuantity: request.baseQuantity,
    filledBaseQuantity: '0',
    remainingBaseQuantity: request.baseQuantity,
    averagePrice: null,
    status: 'open',
    updatedAt: '2026-07-26T00:01:00.000Z',
    ...overrides
  };
}

const LEGACY_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE strategies (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN (
      'PENDING_CONFIRMATION', 'EXECUTING', 'WAITING_HEDGE',
      'HEDGED', 'HEDGE_INCOMPLETE', 'FAILED'
    )),
    mode TEXT NOT NULL CHECK (mode IN (
      'CONCURRENT', 'CONTRACT_FIRST', 'SPOT_FIRST'
    )),
    spot_exchange_id TEXT NOT NULL,
    contract_exchange_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    requested_base_quantity TEXT NOT NULL,
    effective_base_quantity TEXT NOT NULL,
    preflight_json TEXT NOT NULL,
    failure_code TEXT CHECK (
      failure_code IS NULL OR failure_code IN (
        'ORDER_SUBMISSION_FAILED', 'ORDER_SUBMISSION_UNKNOWN',
        'ORDER_NOT_FOUND', 'NO_FILL', 'MISSING_AVERAGE_PRICE',
        'HEDGE_ORDER_REJECTED', 'HEDGE_ORDER_CANCELED',
        'ORDER_RECONCILIATION_FAILED', 'INCONSISTENT_ORDER_STATE'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state IN ('HEDGE_INCOMPLETE', 'FAILED') AND failure_code IS NOT NULL)
      OR
      (state NOT IN ('HEDGE_INCOMPLETE', 'FAILED') AND failure_code IS NULL)
    )
  );
  CREATE TABLE strategy_orders (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    role TEXT NOT NULL CHECK (role IN (
      'SPOT_MARKET', 'CONTRACT_MARKET',
      'SPOT_HEDGE_GTC', 'CONTRACT_HEDGE_GTC'
    )),
    exchange_id TEXT NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    exchange_order_id TEXT,
    request_json TEXT NOT NULL,
    snapshot_json TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'planned', 'open', 'closed', 'canceled', 'rejected', 'unknown'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(strategy_id, role),
    CHECK (
      (status = 'planned' AND snapshot_json IS NULL
        AND exchange_order_id IS NULL)
      OR
      (status <> 'planned' AND snapshot_json IS NOT NULL
        AND exchange_order_id IS NOT NULL)
    )
  );
  CREATE TABLE order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_order_id TEXT NOT NULL REFERENCES strategy_orders(id),
    snapshot_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX strategies_recoverable_idx
    ON strategies(state, created_at);
  CREATE INDEX strategy_orders_strategy_idx
    ON strategy_orders(strategy_id, created_at);
  CREATE INDEX order_events_order_idx
    ON order_events(strategy_order_id, id);
  CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;
  CREATE TRIGGER order_events_no_delete
  BEFORE DELETE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;
`;

const V2_STRATEGIES_TABLE_SQL = `
  CREATE TABLE strategies (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN (
      'PENDING_CONFIRMATION',
      'EXECUTING',
      'WAITING_HEDGE',
      'HEDGED',
      'HEDGE_INCOMPLETE',
      'FAILED'
    )),
    mode TEXT NOT NULL CHECK (mode IN (
      'CONCURRENT',
      'CONTRACT_FIRST',
      'SPOT_FIRST'
    )),
    spot_exchange_id TEXT NOT NULL,
    contract_exchange_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    requested_base_quantity TEXT NOT NULL,
    effective_base_quantity TEXT NOT NULL,
    preflight_json TEXT NOT NULL,
    failure_code TEXT CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'ORDER_SUBMISSION_FAILED',
        'ORDER_SUBMISSION_UNKNOWN',
        'ORDER_NOT_FOUND',
        'NO_FILL',
        'MISSING_AVERAGE_PRICE',
        'HEDGE_ORDER_REJECTED',
        'HEDGE_ORDER_CANCELED',
        'HEDGE_RESIDUAL_NOT_TRADABLE',
        'ORDER_RECONCILIATION_FAILED',
        'INCONSISTENT_ORDER_STATE'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (
        state IN ('HEDGE_INCOMPLETE', 'FAILED')
        AND failure_code IS NOT NULL
      )
      OR
      (
        state NOT IN ('HEDGE_INCOMPLETE', 'FAILED')
        AND failure_code IS NULL
      )
    )
  );
`;

const V2_FRESH_ORDERS_TABLE_SQL = `
  CREATE TABLE strategy_orders (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    role TEXT NOT NULL CHECK (role IN (
      'SPOT_MARKET',
      'CONTRACT_MARKET',
      'SPOT_HEDGE_GTC',
      'CONTRACT_HEDGE_GTC'
    )),
    exchange_id TEXT NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    exchange_order_id TEXT,
    request_json TEXT NOT NULL,
    snapshot_json TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'planned',
      'open',
      'closed',
      'canceled',
      'rejected',
      'unknown'
    )),
    submission_disposition TEXT NOT NULL DEFAULT 'SUBMISSION_UNCERTAIN' CHECK (
      submission_disposition IN (
        'SUBMISSION_UNCERTAIN',
        'DEFINITELY_NOT_SUBMITTED',
        'REMOTE_OBSERVED'
      )
    ),
    submission_failure_code TEXT CHECK (
      submission_failure_code IS NULL
      OR submission_failure_code IN (
        'ORDER_SUBMISSION_FAILED',
        'HEDGE_RESIDUAL_NOT_TRADABLE'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(strategy_id, role),
    CHECK (
      (
        status = 'planned'
        AND snapshot_json IS NULL
        AND exchange_order_id IS NULL
      )
      OR
      (
        status <> 'planned'
        AND snapshot_json IS NOT NULL
        AND exchange_order_id IS NOT NULL
      )
    ),
    CHECK (
      (
        submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
        AND submission_failure_code IS NOT NULL
      )
      OR
      (
        submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'
        AND submission_failure_code IS NULL
      )
    ),
    CHECK (
      (
        status = 'planned'
        AND submission_disposition IN (
          'SUBMISSION_UNCERTAIN',
          'DEFINITELY_NOT_SUBMITTED'
        )
      )
      OR
      (
        status <> 'planned'
        AND submission_disposition = 'REMOTE_OBSERVED'
      )
    )
  );
`;

const V2_MIGRATED_ORDERS_TABLE_SQL = `
  CREATE TABLE strategy_orders (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    role TEXT NOT NULL CHECK (role IN (
      'SPOT_MARKET',
      'CONTRACT_MARKET',
      'SPOT_HEDGE_GTC',
      'CONTRACT_HEDGE_GTC'
    )),
    exchange_id TEXT NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    exchange_order_id TEXT,
    request_json TEXT NOT NULL,
    snapshot_json TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'planned',
      'open',
      'closed',
      'canceled',
      'rejected',
      'unknown'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submission_disposition TEXT NOT NULL DEFAULT 'SUBMISSION_UNCERTAIN' CHECK (
      submission_disposition IN (
        'SUBMISSION_UNCERTAIN',
        'DEFINITELY_NOT_SUBMITTED',
        'REMOTE_OBSERVED'
      )
    ),
    submission_failure_code TEXT CHECK (
      submission_failure_code IS NULL
      OR submission_failure_code IN (
        'ORDER_SUBMISSION_FAILED',
        'HEDGE_RESIDUAL_NOT_TRADABLE'
      )
    ),
    UNIQUE(strategy_id, role),
    CHECK (
      (
        status = 'planned'
        AND snapshot_json IS NULL
        AND exchange_order_id IS NULL
      )
      OR
      (
        status <> 'planned'
        AND snapshot_json IS NOT NULL
        AND exchange_order_id IS NOT NULL
      )
    )
  );
`;

const V2_SUBMISSION_EVIDENCE_CONDITION = `
  (
    (
      (
        NEW.submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
        AND NEW.submission_failure_code IS NOT NULL
      )
      OR
      (
        NEW.submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'
        AND NEW.submission_failure_code IS NULL
      )
    )
    AND
    (
      (
        NEW.status = 'planned'
        AND NEW.snapshot_json IS NULL
        AND NEW.exchange_order_id IS NULL
        AND NEW.submission_disposition IN (
          'SUBMISSION_UNCERTAIN', 'DEFINITELY_NOT_SUBMITTED'
        )
      )
      OR
      (
        NEW.status <> 'planned'
        AND NEW.snapshot_json IS NOT NULL
        AND NEW.exchange_order_id IS NOT NULL
        AND NEW.submission_disposition = 'REMOTE_OBSERVED'
      )
    )
  )
`;

const V2_SUBMISSION_EVIDENCE_TRIGGERS_SQL = `
  CREATE TRIGGER strategy_orders_submission_evidence_insert
  BEFORE INSERT ON strategy_orders
  WHEN NOT ${V2_SUBMISSION_EVIDENCE_CONDITION}
  BEGIN
    SELECT RAISE(ABORT, 'invalid submission evidence');
  END;

  CREATE TRIGGER strategy_orders_submission_evidence_update
  BEFORE UPDATE OF
    status,
    snapshot_json,
    exchange_order_id,
    submission_disposition,
    submission_failure_code
  ON strategy_orders
  WHEN NOT ${V2_SUBMISSION_EVIDENCE_CONDITION}
  BEGIN
    SELECT RAISE(ABORT, 'invalid submission evidence');
  END;
`;

const V2_COMMON_SCHEMA_SQL = `
  CREATE TABLE order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_order_id TEXT NOT NULL REFERENCES strategy_orders(id),
    snapshot_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX strategies_recoverable_idx
    ON strategies(state, created_at);
  CREATE INDEX strategy_orders_strategy_idx
    ON strategy_orders(strategy_id, created_at);
  CREATE INDEX order_events_order_idx
    ON order_events(strategy_order_id, id);

  CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;

  CREATE TRIGGER order_events_no_delete
  BEFORE DELETE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;

  CREATE TABLE strategy_schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 2)
  );
  INSERT INTO strategy_schema_metadata (singleton, version)
  VALUES (1, 2);
`;

const V2_FRESH_SCHEMA_SQL = `
  ${V2_STRATEGIES_TABLE_SQL}
  ${V2_FRESH_ORDERS_TABLE_SQL}
  ${V2_COMMON_SCHEMA_SQL}
`;

const V2_MIGRATED_SCHEMA_SQL = `
  ${V2_STRATEGIES_TABLE_SQL}
  ${V2_MIGRATED_ORDERS_TABLE_SQL}
  ${V2_SUBMISSION_EVIDENCE_TRIGGERS_SQL}
  ${V2_COMMON_SCHEMA_SQL}
`;

function legacyDatabase(t: TestContext): Database.Database {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(LEGACY_SCHEMA);
  return database;
}

function seedLegacyExecutingStrategy(
  database: Database.Database,
  strategyId: string
): void {
  const preview = preflight();
  database.prepare(`
    INSERT INTO strategies (
      id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
      requested_base_quantity, effective_base_quantity, preflight_json,
      failure_code, created_at, updated_at
    ) VALUES (?, 'EXECUTING', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    strategyId,
    preview.mode,
    preview.spotExchangeId,
    preview.contractExchangeId,
    preview.symbol,
    preview.requestedBaseQuantity,
    preview.effectiveBaseQuantity,
    JSON.stringify(preview),
    preview.createdAt,
    preview.createdAt
  );
}

function seedLegacyPlannedOrder(
  database: Database.Database,
  strategyId: string,
  orderId: string
): void {
  const request = requestFor(strategyId, 'CONTRACT_MARKET');
  database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      created_at, updated_at
    ) VALUES (?, ?, 'CONTRACT_MARKET', 'okx', ?, NULL, ?, NULL,
      'planned', ?, ?)
  `).run(
    orderId,
    strategyId,
    request.clientOrderId,
    JSON.stringify(request),
    '2026-07-26T00:00:00.000Z',
    '2026-07-26T00:00:00.000Z'
  );
}

function seedLegacyObservedOrder(
  database: Database.Database,
  strategyId: string,
  orderId: string
): void {
  const request = requestFor(strategyId, 'SPOT_HEDGE_GTC', {
    baseQuantity: '0.4'
  });
  const snapshot = snapshotFor(request, 'bitget', {
    exchangeOrderId: 'legacy-observed-exchange-order',
    requestedBaseQuantity: '0.4',
    remainingBaseQuantity: '0.4'
  });
  database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      created_at, updated_at
    ) VALUES (?, ?, 'SPOT_HEDGE_GTC', 'bitget', ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    orderId,
    strategyId,
    request.clientOrderId,
    snapshot.exchangeOrderId,
    JSON.stringify(request),
    JSON.stringify(snapshot),
    '2026-07-26T00:00:00.000Z',
    snapshot.updatedAt
  );
  database.prepare(`
    INSERT INTO order_events (strategy_order_id, snapshot_json, recorded_at)
    VALUES (?, ?, ?)
  `).run(orderId, JSON.stringify(snapshot), snapshot.updatedAt);
}

function seedV2Strategy(
  database: Database.Database,
  strategyId: string,
  state: StrategyState,
  failureCode: string | null,
  preview: PreflightResult = preflight()
): void {
  database.prepare(`
    INSERT INTO strategies (
      id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
      requested_base_quantity, effective_base_quantity, preflight_json,
      failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategyId,
    state,
    preview.mode,
    preview.spotExchangeId,
    preview.contractExchangeId,
    preview.symbol,
    preview.requestedBaseQuantity,
    preview.effectiveBaseQuantity,
    JSON.stringify(preview),
    failureCode,
    preview.createdAt,
    preview.createdAt
  );
}

function seedFundingMigrationCoverage(database: Database.Database): void {
  database.exec(SQLITE_FUNDING_RATE_SCHEMA);
  database.prepare(`
    INSERT INTO funding_rate_history (
      exchange_id, exchange_market_id, symbol, funding_timestamp_ms,
      funding_rate, raw_json, content_hash,
      first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'okx',
    'BTC-USDT-SWAP',
    'BTC/USDT:USDT',
    1_788_649_200_000,
    '0.0001',
    '{"fundingRate":"0.0001"}',
    'a'.repeat(64),
    '2026-09-06T00:02:00.000Z',
    '2026-09-06T00:03:00.000Z'
  );
  database.prepare(`
    INSERT INTO funding_rate_revisions (
      exchange_id, exchange_market_id, symbol, funding_timestamp_ms,
      funding_rate, raw_json, content_hash,
      first_observed_at, last_observed_at, replaced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'okx',
    'BTC-USDT-SWAP',
    'BTC/USDT:USDT',
    1_788_649_200_000,
    '0.00009',
    '{"fundingRate":"0.00009"}',
    'b'.repeat(64),
    '2026-09-06T00:01:00.000Z',
    '2026-09-06T00:02:00.000Z',
    '2026-09-06T00:03:00.000Z'
  );
}

function seedV2MigrationCoverage(database: Database.Database): void {
  const base = preflight();
  const precise = preflight({
    requestedBaseQuantity: '12345678901234567890123456789012345678901.9',
    effectiveBaseQuantity: '12345678901234567890123456789012345678901.9',
    spotMarket: {
      ...base.spotMarket,
      amountStep: '0.00000001',
      contractSize: '3',
      minBaseAmount: '1e-8',
      maxBaseAmount: '9.999999999999999999999999999999999999999e50',
      minQuoteNotional: '5.0000000000000000001',
      maxQuoteNotional: '9.99e80',
      priceStep: '1e-8'
    },
    contractMarket: {
      ...base.contractMarket,
      amountStep: '0.00000003',
      contractSize: '0.00000003',
      minBaseAmount: '3e-8',
      maxBaseAmount: '9.999999999999999999999999999999999999999e50',
      minQuoteNotional: '7.0000000000000000001',
      maxQuoteNotional: '8.88e80',
      priceStep: '5e-9'
    },
    spotReferencePrice: '6.000000000000000000000000000000000000001e4',
    contractReferencePrice: '6.001000000000000000000000000000000000001e4'
  });
  const stateCases = [
    ['v2-pending', 'PENDING_CONFIRMATION', null, precise],
    ['v2-executing', 'EXECUTING', null, base],
    ['v2-waiting', 'WAITING_HEDGE', null, base],
    ['v2-hedged', 'HEDGED', null, base],
    [
      'v2-incomplete',
      'HEDGE_INCOMPLETE',
      'HEDGE_RESIDUAL_NOT_TRADABLE',
      base
    ],
    ['v2-failed', 'FAILED', 'ORDER_RECONCILIATION_FAILED', base]
  ] as const;
  for (const [id, state, failureCode, preview] of stateCases) {
    seedV2Strategy(database, id, state, failureCode, preview);
  }

  const uncertainRequest = requestFor('v2-executing', 'CONTRACT_MARKET');
  const definiteRequest = requestFor('v2-executing', 'SPOT_MARKET');
  const observedRequest = requestFor('v2-executing', 'SPOT_HEDGE_GTC', {
    baseQuantity: '0.4'
  });
  const observedSnapshot = snapshotFor(observedRequest, 'bitget', {
    exchangeOrderId: 'v2-observed-exchange-order',
    requestedBaseQuantity: '0.4',
    remainingBaseQuantity: '0.4'
  });
  const insertOrder = database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      submission_disposition, submission_failure_code,
      created_at, updated_at
    ) VALUES (?, 'v2-executing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertOrder.run(
    'v2-uncertain-order',
    'CONTRACT_MARKET',
    'okx',
    uncertainRequest.clientOrderId,
    null,
    JSON.stringify(uncertainRequest),
    null,
    'planned',
    'SUBMISSION_UNCERTAIN',
    null,
    base.createdAt,
    base.createdAt
  );
  insertOrder.run(
    'v2-definite-order',
    'SPOT_MARKET',
    'bitget',
    definiteRequest.clientOrderId,
    null,
    JSON.stringify(definiteRequest),
    null,
    'planned',
    'DEFINITELY_NOT_SUBMITTED',
    'ORDER_SUBMISSION_FAILED',
    base.createdAt,
    base.createdAt
  );
  insertOrder.run(
    'v2-observed-order',
    'SPOT_HEDGE_GTC',
    'bitget',
    observedRequest.clientOrderId,
    observedSnapshot.exchangeOrderId,
    JSON.stringify(observedRequest),
    JSON.stringify(observedSnapshot),
    'open',
    'REMOTE_OBSERVED',
    null,
    base.createdAt,
    observedSnapshot.updatedAt
  );
  database.prepare(`
    INSERT INTO order_events (strategy_order_id, snapshot_json, recorded_at)
    VALUES (?, ?, ?)
  `).run(
    'v2-observed-order',
    JSON.stringify(observedSnapshot),
    observedSnapshot.updatedAt
  );

  seedFundingMigrationCoverage(database);
}

function jsonWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (
    typeof nested === 'bigint' ? nested.toString() : nested
  ));
}

function strategyDatabaseFingerprint(database: Database.Database): string {
  const catalog = database.prepare(`
    SELECT type, name, tbl_name, rootpage, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<{ type: unknown; name: unknown }>;
  const tableNames = new Set(catalog.flatMap(({ type, name }) => (
    type === 'table' && typeof name === 'string' ? [name] : []
  )));
  const rows = (table: string, orderBy: string): unknown[] => (
    tableNames.has(table)
      ? database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()
      : []
  );
  const hasSequence = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'sqlite_sequence'
  `).get() !== undefined;
  return jsonWithBigInts({
    catalog,
    strategies: rows('strategies', 'id'),
    orders: rows('strategy_orders', 'id'),
    events: rows('order_events', 'id'),
    metadata: rows('strategy_schema_metadata', 'singleton'),
    fundingHistory: rows(
      'funding_rate_history',
      'exchange_id, exchange_market_id, funding_timestamp_ms'
    ),
    fundingRevisions: rows('funding_rate_revisions', 'id'),
    fundingState: rows(
      'funding_rate_sync_state',
      'exchange_id, exchange_market_id'
    ),
    sequence: hasSequence
      ? database.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
      : []
  });
}

function strategySchemaVersion(database: Database.Database): unknown {
  return database.prepare(`
    SELECT version FROM strategy_schema_metadata WHERE singleton = 1
  `).pluck().get();
}

function tableColumnNames(
  database: Database.Database,
  table: string
): readonly string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>).map(({ name }) => name);
}

function isV3MigrationSql(source: string): boolean {
  return source.includes('CREATE TABLE strategies_v3')
    && source.includes('DROP TABLE strategy_schema_metadata');
}

function isV1MigrationSql(source: string): boolean {
  return source.includes('CREATE TABLE strategies_v2')
    && source.includes('ALTER TABLE strategy_orders ADD COLUMN');
}

const ORDER_EVENTS_DDL_DRIFTS = [
  {
    name: 'missing AUTOINCREMENT',
    rewrite: (sql: string): string => sql.replace(
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      'id INTEGER PRIMARY KEY'
    )
  },
  {
    name: 'nullable snapshot',
    rewrite: (sql: string): string => sql.replace(
      'snapshot_json TEXT NOT NULL',
      'snapshot_json TEXT'
    )
  },
  {
    name: 'changed recorded type',
    rewrite: (sql: string): string => sql.replace(
      'recorded_at TEXT NOT NULL',
      'recorded_at BLOB NOT NULL'
    )
  },
  {
    name: 'changed FK action',
    rewrite: (sql: string): string => sql.replace(
      'REFERENCES strategy_orders(id)',
      'REFERENCES strategy_orders(id) ON DELETE CASCADE'
    )
  }
] as const;

function v2PreservedFingerprint(database: Database.Database): string {
  const protectedNames = [
    'strategy_orders',
    'order_events',
    'strategy_orders_strategy_idx',
    'order_events_order_idx',
    'order_events_no_update',
    'order_events_no_delete',
    'strategy_orders_submission_evidence_insert',
    'strategy_orders_submission_evidence_update',
    'funding_rate_history',
    'funding_rate_revisions',
    'funding_rate_sync_state',
    'funding_rate_revisions_no_update',
    'funding_rate_revisions_no_delete'
  ];
  const placeholders = protectedNames.map(() => '?').join(', ');
  return jsonWithBigInts({
    protectedCatalog: database.prepare(`
      SELECT type, name, tbl_name, rootpage, sql
      FROM sqlite_master
      WHERE name IN (${placeholders})
      ORDER BY type, name
    `).all(...protectedNames),
    strategies: database.prepare(`
      SELECT
        id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
        requested_base_quantity, effective_base_quantity, preflight_json,
        failure_code, created_at, updated_at
      FROM strategies
      ORDER BY id
    `).all(),
    orders: database.prepare(
      'SELECT * FROM strategy_orders ORDER BY id'
    ).all(),
    events: database.prepare(
      'SELECT * FROM order_events ORDER BY id'
    ).all(),
    fundingHistory: database.prepare(`
      SELECT * FROM funding_rate_history
      ORDER BY exchange_id, exchange_market_id, funding_timestamp_ms
    `).all(),
    fundingRevisions: database.prepare(
      'SELECT * FROM funding_rate_revisions ORDER BY id'
    ).all(),
    fundingState: database.prepare(`
      SELECT * FROM funding_rate_sync_state
      ORDER BY exchange_id, exchange_market_id
    `).all(),
    sequence: database.prepare(
      'SELECT * FROM sqlite_sequence ORDER BY name'
    ).all()
  });
}

function rawStrategy(
  database: Database.Database,
  strategyId: string
): unknown {
  return database.prepare(
    'SELECT * FROM strategies WHERE id = ?'
  ).get(strategyId);
}

function insertRawPlannedOrder(
  database: Database.Database,
  strategyId: string,
  role: OrderRole = 'SPOT_MARKET'
): string {
  const request = requestFor(strategyId, role);
  const orderId = `raw-${role.toLowerCase()}-${strategyId}`;
  const exchangeId = role.startsWith('SPOT_') ? 'bitget' : 'okx';
  database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      submission_disposition, submission_failure_code,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 'planned',
      'SUBMISSION_UNCERTAIN', NULL, ?, ?)
  `).run(
    orderId,
    strategyId,
    role,
    exchangeId,
    request.clientOrderId,
    JSON.stringify(request),
    '2026-10-03T00:00:00.000Z',
    '2026-10-03T00:00:00.000Z'
  );
  return orderId;
}

function updateStoredPreflight(
  database: Database.Database,
  strategyId: string,
  mutate: (preview: PreflightResult) => void
): PreflightResult {
  const json = database.prepare(
    'SELECT preflight_json FROM strategies WHERE id = ?'
  ).pluck().get(strategyId);
  assert.ok(typeof json === 'string');
  const preview = JSON.parse(json) as PreflightResult;
  mutate(preview);
  database.prepare(
    'UPDATE strategies SET preflight_json = ? WHERE id = ?'
  ).run(JSON.stringify(preview), strategyId);
  return preview;
}

function confirmationStateFingerprint(database: Database.Database): string {
  return jsonWithBigInts({
    strategies: database.prepare(
      'SELECT * FROM strategies ORDER BY id'
    ).all(),
    orders: database.prepare(
      'SELECT * FROM strategy_orders ORDER BY id'
    ).all(),
    events: database.prepare(
      'SELECT * FROM order_events ORDER BY id'
    ).all()
  });
}

function legacyFingerprint(database: Database.Database): string {
  return JSON.stringify({
    schema: database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all(),
    strategies: database.prepare('SELECT * FROM strategies ORDER BY id').all(),
    orders: database.prepare('SELECT * FROM strategy_orders ORDER BY id').all(),
    events: database.prepare('SELECT * FROM order_events ORDER BY id').all()
  });
}

function schemaObjectDefinition(
  database: Database.Database,
  type: 'table' | 'trigger',
  name: string
): string {
  const sql = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = ? AND name = ?
  `).pluck().get(type, name);
  if (typeof sql !== 'string') {
    assert.fail(`missing SQLite ${type} definition: ${name}`);
  }
  return sql;
}

function rewriteSchemaObjectDefinition(
  database: Database.Database,
  type: 'table' | 'trigger',
  name: string,
  rewrite: (sql: string) => string
): void {
  const original = schemaObjectDefinition(database, type, name);
  const rewritten = rewrite(original);
  assert.notEqual(rewritten, original);
  database.unsafeMode(true);
  try {
    database.pragma('writable_schema = ON');
    const result = database.prepare(`
      UPDATE sqlite_master
      SET sql = ?
      WHERE type = ? AND name = ?
    `).run(rewritten, type, name);
    assert.equal(result.changes, 1);
  } finally {
    try {
      database.pragma('writable_schema = OFF');
    } finally {
      database.unsafeMode(false);
    }
  }
}

function tableDefinition(
  database: Database.Database,
  table: string
): string {
  return schemaObjectDefinition(database, 'table', table);
}

function rewriteTableDefinition(
  database: Database.Database,
  table: string,
  rewrite: (sql: string) => string
): void {
  rewriteSchemaObjectDefinition(database, 'table', table, rewrite);
}

const SUBMISSION_EVIDENCE_CHECK_SQL = `CHECK (
  (
    submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
    AND submission_failure_code IS NOT NULL
  )
  OR
  (
    submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'
    AND submission_failure_code IS NULL
  )
)`;

const CANONICAL_SUBMISSION_EVIDENCE_CHECK_SQL =
  "check((submission_disposition='DEFINITELY_NOT_SUBMITTED' and "
  + 'submission_failure_code is not null)or('
  + "submission_disposition<>'DEFINITELY_NOT_SUBMITTED' and "
  + 'submission_failure_code is null))';

function makeMalformedLegacyStrategies(database: Database.Database): void {
  database.pragma('foreign_keys = OFF');
  database.exec(`
    CREATE TABLE strategies_bad (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      mode TEXT NOT NULL,
      spot_exchange_id TEXT NOT NULL,
      contract_exchange_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      requested_base_quantity TEXT NOT NULL,
      effective_base_quantity TEXT NOT NULL,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO strategies_bad
    SELECT
      id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
      requested_base_quantity, effective_base_quantity, failure_code,
      created_at, updated_at
    FROM strategies;
    DROP TABLE strategies;
    ALTER TABLE strategies_bad RENAME TO strategies;
    CREATE INDEX strategies_recoverable_idx
      ON strategies(state, created_at);
  `);
  database.pragma('foreign_keys = ON');
}

test('enables foreign keys for every repository connection', (t) => {
  const { database } = setup(t);

  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
});

test('creates a fresh file database in WAL before installing v3 schema', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-schema-'));
  const database = new Database(join(directory, 'strategies.sqlite'));
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  new SqliteStrategyRepository(database);

  assert.equal(
    database.pragma('journal_mode', { simple: true }),
    'wal'
  );
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 3 }]);
  assert.deepEqual(
    (database.prepare('PRAGMA table_info(strategies)').all() as Array<{
      name: string;
    }>).map(({ name }) => name),
    [
      'id',
      'state',
      'mode',
      'spot_exchange_id',
      'contract_exchange_id',
      'symbol',
      'requested_base_quantity',
      'effective_base_quantity',
      'preflight_json',
      'failure_code',
      'preflight_failure_json',
      'created_at',
      'updated_at'
    ]
  );
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('classifies an unknown strategy schema pragma failure as a storage operation', (t) => {
  const rawMarker = 'raw-strategy-schema-pragma-secret-marker';
  const database = new Database(':memory:');
  t.after(() => database.close());
  const originalPragma = database.pragma.bind(database);
  t.mock.method(database, 'pragma', (
    source: string,
    options?: Database.PragmaOptions
  ): unknown => {
    if (source === 'journal_mode = WAL') throw new Error(rawMarker);
    return originalPragma(source, options);
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.ok(error instanceof TradeOpsError);
  assert.equal(error.detail.code, 'STORAGE_OPERATION_FAILED');
  assert.equal(error.detail.phase, 'startup');
  assert.equal(error.detail.subject.type, 'database');
  if (error.detail.subject.type === 'database') {
    assert.equal(error.detail.subject.table, 'strategies');
    assert.equal(error.detail.subject.operation, 'enable-strategy-journal');
  }
  assert.equal(error.detail.actual, 'object-failure');
  assert.equal(JSON.stringify(error.detail).includes(rawMarker), false);
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all(), []);
});

test('repair: classifies a thrown foreign-key restoration failure as startup storage failure', (t) => {
  const restoreMarker = 'foreign-key-restore-secret-marker';
  const database = new Database(':memory:');
  const originalPragma = database.pragma.bind(database);
  t.after(() => {
    if (database.open) {
      originalPragma('foreign_keys = ON');
      database.close();
    }
  });
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2MigrationCoverage(database);
  let migrationStarted = false;
  t.mock.method(database, 'pragma', (
    source: string,
    options?: Database.PragmaOptions
  ): unknown => {
    if (source === 'foreign_keys = OFF') {
      const result = originalPragma(source, options);
      migrationStarted = true;
      return result;
    }
    if (migrationStarted && source === 'foreign_keys = ON') {
      throw new Error(restoreMarker);
    }
    return originalPragma(source, options);
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.equal(strategySchemaVersion(database), 3);
  assertStartupStorageError(
    error,
    /(?:restore|enable).*foreign|foreign.*(?:restore|enable)/i,
    [restoreMarker]
  );
});

test('repair: rejects an unverified foreign-key restoration as startup storage failure', (t) => {
  const database = new Database(':memory:');
  const originalPragma = database.pragma.bind(database);
  t.after(() => {
    if (database.open) database.close();
  });
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2MigrationCoverage(database);
  let migrationStarted = false;
  let returnUnverifiedRestore = false;
  t.mock.method(database, 'pragma', (
    source: string,
    options?: Database.PragmaOptions
  ): unknown => {
    if (source === 'foreign_keys = OFF') {
      const result = originalPragma(source, options);
      migrationStarted = true;
      return result;
    }
    if (migrationStarted && source === 'foreign_keys = ON') {
      const result = originalPragma(source, options);
      returnUnverifiedRestore = true;
      return result;
    }
    if (
      returnUnverifiedRestore
      && source === 'foreign_keys'
      && options?.simple === true
    ) {
      returnUnverifiedRestore = false;
      return 0;
    }
    return originalPragma(source, options);
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.equal(strategySchemaVersion(database), 3);
  assert.equal(originalPragma('foreign_keys', { simple: true }), 1);
  assertStartupStorageError(
    error,
    /(?:restore|enable).*foreign|foreign.*(?:restore|enable)/i
  );
});

test('repair: preserves the primary v3 migration failure when foreign-key restoration also fails', (t) => {
  const restoreMarker = 'secondary-restore-secret-marker';
  const database = new Database(':memory:');
  const originalPragma = database.pragma.bind(database);
  const originalExec = database.exec.bind(database);
  t.after(() => {
    if (database.open) {
      originalPragma('foreign_keys = ON');
      database.close();
    }
  });
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2MigrationCoverage(database);
  const before = strategyDatabaseFingerprint(database);
  let migrationStarted = false;
  t.mock.method(database, 'pragma', (
    source: string,
    options?: Database.PragmaOptions
  ): unknown => {
    if (source === 'foreign_keys = OFF') {
      const result = originalPragma(source, options);
      migrationStarted = true;
      return result;
    }
    if (migrationStarted && source === 'foreign_keys = ON') {
      throw new Error(restoreMarker);
    }
    return originalPragma(source, options);
  });
  t.mock.method(database, 'exec', (source: string): Database.Database => {
    if (!isV3MigrationSql(source)) return originalExec(source);
    assert.equal(strategySchemaVersion(database), 2);
    originalExec(source);
    assert.equal(strategySchemaVersion(database), 3);
    assert.equal(
      tableColumnNames(database, 'strategies').includes('preflight_failure_json'),
      true
    );
    assert.equal(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'strategies_v3'
    `).get(), undefined);
    throw undefined;
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.equal(strategyDatabaseFingerprint(database), before);
  originalPragma('foreign_keys = ON');
  assert.equal(originalPragma('foreign_keys', { simple: true }), 1);
  assertStartupStorageError(
    error,
    /^migrate-v2-to-v3$/,
    [restoreMarker],
    'undefined-thrown'
  );
});

test('repair: classifies a foreign-key disable failure as startup storage failure', (t) => {
  const disableMarker = 'foreign-key-disable-secret-marker';
  const database = new Database(':memory:');
  const originalPragma = database.pragma.bind(database);
  t.after(() => {
    if (database.open) database.close();
  });
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2MigrationCoverage(database);
  const before = strategyDatabaseFingerprint(database);
  t.mock.method(database, 'pragma', (
    source: string,
    options?: Database.PragmaOptions
  ): unknown => {
    if (source === 'foreign_keys = OFF') throw new Error(disableMarker);
    return originalPragma(source, options);
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.equal(strategyDatabaseFingerprint(database), before);
  assert.equal(originalPragma('foreign_keys', { simple: true }), 1);
  assertStartupStorageError(
    error,
    /disable.*foreign|foreign.*disable/i,
    [disableMarker]
  );
});

for (const fixture of [
  {
    name: 'fresh-table-check',
    sql: V2_FRESH_SCHEMA_SQL,
    safeIntegers: false
  },
  {
    name: 'migrated-trigger',
    sql: V2_MIGRATED_SCHEMA_SQL,
    safeIntegers: true
  }
] as const) {
  test(`migrates pinned ${fixture.name} v2 schema to v3 without rebuilding protected tables`, (t) => {
    const database = new Database(':memory:');
    t.after(() => database.close());
    if (fixture.safeIntegers) database.defaultSafeIntegers(true);
    database.exec(fixture.sql);
    seedV2MigrationCoverage(database);
    const before = v2PreservedFingerprint(database);

    const repository = new SqliteStrategyRepository(database);

    const expectedVersion = fixture.safeIntegers ? 3n : 3;
    assert.deepEqual(database.prepare(`
      SELECT singleton, version FROM strategy_schema_metadata
    `).get(), {
      singleton: fixture.safeIntegers ? 1n : 1,
      version: expectedVersion
    });
    assert.equal(v2PreservedFingerprint(database), before);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      database.pragma('foreign_keys', { simple: true }),
      fixture.safeIntegers ? 1n : 1
    );
    const states = [
      'PENDING_CONFIRMATION',
      'EXECUTING',
      'WAITING_HEDGE',
      'HEDGED',
      'HEDGE_INCOMPLETE',
      'FAILED'
    ];
    assert.deepEqual(
      [
        'v2-pending',
        'v2-executing',
        'v2-waiting',
        'v2-hedged',
        'v2-incomplete',
        'v2-failed'
      ].map((id) => task3Record(repository.getStrategy(id)).state),
      states
    );
    const precise = task3Record(repository.getStrategy('v2-pending'));
    assert.equal(
      precise.requestedBaseQuantity,
      '12345678901234567890123456789012345678901.9'
    );
    assert.equal(
      precise.preflight.contractMarket.contractSize,
      '0.00000003'
    );
    assert.equal(precise.preflightFailure, null);
    assert.deepEqual(
      repository.listOrders('v2-executing').map((order) => ({
        id: order.id,
        disposition: order.submissionDisposition,
        failure: order.submissionFailureCode,
        status: order.status
      })),
      [
        {
          id: 'v2-uncertain-order',
          disposition: 'SUBMISSION_UNCERTAIN',
          failure: null,
          status: 'planned'
        },
        {
          id: 'v2-definite-order',
          disposition: 'DEFINITELY_NOT_SUBMITTED',
          failure: 'ORDER_SUBMISSION_FAILED',
          status: 'planned'
        },
        {
          id: 'v2-observed-order',
          disposition: 'REMOTE_OBSERVED',
          failure: null,
          status: 'open'
        }
      ]
    );
    assert.equal(repository.listOrderEvents('v2-observed-order').length, 1);
  });
}

test('rejects a damaged pinned v2 state allowlist without upgrading data', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2Strategy(
    database,
    'damaged-v2-strategy',
    'PENDING_CONFIRMATION',
    null
  );
  rewriteTableDefinition(database, 'strategies', (sql) => sql.replace(
    "      'FAILED'\n    )),",
    "      'FAILED',\n      'CORRUPTED_STATE'\n    )),"
  ));
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 2 }]);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
});

for (const scope of ['main', 'TEMP'] as const) {
  test(`rejects an unexpected ${scope} trigger on a strategy table`, (t) => {
    const { database } = setup(t);
    const triggerName = `force_strategy_hedged_${scope.toLowerCase()}`;
    const temporary = scope === 'TEMP' ? 'TEMP ' : '';
    const target = scope === 'TEMP' ? 'main.strategy_orders' : 'strategy_orders';
    database.exec(`
      CREATE ${temporary}TRIGGER ${triggerName}
      AFTER INSERT ON ${target}
      BEGIN
        UPDATE strategies
        SET state = 'HEDGED'
        WHERE id = NEW.strategy_id;
      END;
    `);

    assertSchemaMismatch(() => new SqliteStrategyRepository(database));
  });
}

test('rejects v3 submission evidence checks with the wrong inequality operator', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-wrong-check-'));
  const databasePath = join(directory, 'strategies.sqlite');
  let database = new Database(databasePath);
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = new SqliteStrategyRepository(database);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const order = repository.planOrder(
    strategyId,
    'CONTRACT_MARKET',
    requestFor(strategyId, 'CONTRACT_MARKET')
  );
  const correctOperator =
    "submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'";
  const wrongOperator =
    "submission_disposition = 'DEFINITELY_NOT_SUBMITTED'";

  rewriteTableDefinition(database, 'strategy_orders', (sql) => {
    assert.equal(sql.split(correctOperator).length - 1, 1);
    return sql.replace(correctOperator, wrongOperator);
  });
  database.close();
  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const reloadedSql = tableDefinition(database, 'strategy_orders');
  assert.equal(reloadedSql.includes(correctOperator), false);
  assert.equal(reloadedSql.includes(wrongOperator), true);
  database.exec('SAVEPOINT invalid_evidence_probe');
  try {
    assert.equal(database.prepare(`
      UPDATE strategy_orders
      SET submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
      WHERE id = ?
    `).run(order.id).changes, 1);
  } finally {
    database.exec('ROLLBACK TO invalid_evidence_probe');
    database.exec('RELEASE invalid_evidence_probe');
  }
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.deepEqual(database.prepare(`
    SELECT submission_disposition, submission_failure_code
    FROM strategy_orders
    WHERE id = ?
  `).get(order.id), {
    submission_disposition: 'SUBMISSION_UNCERTAIN',
    submission_failure_code: null
  });
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
});

test('rejects v3 evidence CHECK with a case-changed quoted literal', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-check-case-'));
  const databasePath = join(directory, 'strategies.sqlite');
  let database = new Database(databasePath);
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = new SqliteStrategyRepository(database);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const order = repository.planOrder(
    strategyId,
    'CONTRACT_MARKET',
    requestFor(strategyId, 'CONTRACT_MARKET')
  );
  const correctLiteral =
    "submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'";
  const caseChangedLiteral =
    "submission_disposition <> 'definitely_not_submitted'";

  rewriteTableDefinition(database, 'strategy_orders', (sql) => {
    assert.equal(sql.split(correctLiteral).length - 1, 1);
    return sql.replace(correctLiteral, caseChangedLiteral);
  });
  database.close();
  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const reloadedSql = tableDefinition(database, 'strategy_orders');
  assert.equal(reloadedSql.includes(correctLiteral), false);
  assert.equal(reloadedSql.includes(caseChangedLiteral), true);
  database.exec('SAVEPOINT invalid_literal_case_probe');
  try {
    assert.equal(database.prepare(`
      UPDATE strategy_orders
      SET submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
      WHERE id = ?
    `).run(order.id).changes, 1);
  } finally {
    database.exec('ROLLBACK TO invalid_literal_case_probe');
    database.exec('RELEASE invalid_literal_case_probe');
  }
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.deepEqual(database.prepare(`
    SELECT submission_disposition, submission_failure_code
    FROM strategy_orders
    WHERE id = ?
  `).get(order.id), {
    submission_disposition: 'SUBMISSION_UNCERTAIN',
    submission_failure_code: null
  });
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
});

for (const inactiveCheck of [
  {
    name: 'inactive block-comment text',
    directoryPrefix: 'trade-ops-check-comment-',
    insertion: `\n/* ${SUBMISSION_EVIDENCE_CHECK_SQL} */\n`
  },
  {
    name: 'an inactive quoted constraint name',
    directoryPrefix: 'trade-ops-check-name-',
    insertion: `,\nCONSTRAINT "${CANONICAL_SUBMISSION_EVIDENCE_CHECK_SQL}"
      CHECK (1)\n`
  }
] as const) {
  test(`rejects broken v3 evidence CHECK disguised by ${inactiveCheck.name}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), inactiveCheck.directoryPrefix));
    const databasePath = join(directory, 'strategies.sqlite');
    let database = new Database(databasePath);
    t.after(() => {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const repository = new SqliteStrategyRepository(database);
    const strategyId = repository.createPending(preflight()).id;
    assert.equal(repository.claimForExecution(strategyId), true);
    const order = repository.planOrder(
      strategyId,
      'CONTRACT_MARKET',
      requestFor(strategyId, 'CONTRACT_MARKET')
    );
    const correctOperator =
      "submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'";
    const wrongOperator =
      "submission_disposition = 'DEFINITELY_NOT_SUBMITTED'";

    rewriteTableDefinition(database, 'strategy_orders', (sql) => {
      assert.equal(sql.split(correctOperator).length - 1, 1);
      const brokenSql = sql.replace(correctOperator, wrongOperator);
      const finalParenthesis = brokenSql.lastIndexOf(')');
      assert.notEqual(finalParenthesis, -1);
      return brokenSql.slice(0, finalParenthesis)
        + inactiveCheck.insertion
        + brokenSql.slice(finalParenthesis);
    });
    database.close();
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');

    const reloadedSql = tableDefinition(database, 'strategy_orders');
    assert.equal(reloadedSql.includes(wrongOperator), true);
    assert.equal(reloadedSql.includes(inactiveCheck.insertion.trim()), true);
    database.exec('SAVEPOINT inactive_check_probe');
    try {
      assert.equal(database.prepare(`
        UPDATE strategy_orders
        SET submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
        WHERE id = ?
      `).run(order.id).changes, 1);
    } finally {
      database.exec('ROLLBACK TO inactive_check_probe');
      database.exec('RELEASE inactive_check_probe');
    }
    const before = legacyFingerprint(database);

    assertSchemaMismatch(() => new SqliteStrategyRepository(database));

    assert.equal(legacyFingerprint(database), before);
    assert.deepEqual(database.prepare(`
      SELECT singleton, version FROM strategy_schema_metadata
    `).all(), [{ singleton: 1, version: 3 }]);
    assert.deepEqual(database.prepare(`
      SELECT submission_disposition, submission_failure_code
      FROM strategy_orders
      WHERE id = ?
    `).get(order.id), {
      submission_disposition: 'SUBMISSION_UNCERTAIN',
      submission_failure_code: null
    });
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

test('migrates v1 failure constraints and order submission evidence atomically', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'legacy-strategy');
  seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
  seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');

  const repository = new SqliteStrategyRepository(database);
  const [planned, observed] = repository.listOrders('legacy-strategy');

  assert.equal(planned?.submissionDisposition, 'SUBMISSION_UNCERTAIN');
  assert.equal(planned?.submissionFailureCode, null);
  assert.equal(observed?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(observed?.submissionFailureCode, null);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    repository.transition(
      'legacy-strategy',
      ['EXECUTING'],
      'HEDGE_INCOMPLETE',
      'HEDGE_RESIDUAL_NOT_TRADABLE'
    ),
    true
  );
});

test('rejects migrated v1 evidence trigger with a case-changed quoted literal', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-trigger-case-'));
  const databasePath = join(directory, 'strategies.sqlite');
  let database = new Database(databasePath);
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec(LEGACY_SCHEMA);
  seedLegacyExecutingStrategy(database, 'legacy-case-strategy');
  seedLegacyPlannedOrder(
    database,
    'legacy-case-strategy',
    'legacy-case-order'
  );
  new SqliteStrategyRepository(database);
  const triggerName = 'strategy_orders_submission_evidence_update';
  const correctLiteral =
    "NEW.submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'";
  const caseChangedLiteral =
    "NEW.submission_disposition <> 'definitely_not_submitted'";

  rewriteSchemaObjectDefinition(
    database,
    'trigger',
    triggerName,
    (sql) => {
      assert.equal(sql.split(correctLiteral).length - 1, 1);
      return sql.replace(correctLiteral, caseChangedLiteral);
    }
  );
  database.close();
  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const reloadedSql = schemaObjectDefinition(
    database,
    'trigger',
    triggerName
  );
  assert.equal(reloadedSql.includes(correctLiteral), false);
  assert.equal(reloadedSql.includes(caseChangedLiteral), true);
  database.exec('SAVEPOINT invalid_trigger_literal_case_probe');
  try {
    assert.equal(database.prepare(`
      UPDATE strategy_orders
      SET submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
      WHERE id = 'legacy-case-order'
    `).run().changes, 1);
  } finally {
    database.exec('ROLLBACK TO invalid_trigger_literal_case_probe');
    database.exec('RELEASE invalid_trigger_literal_case_probe');
  }
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 3 }]);
  assert.deepEqual(database.prepare(`
    SELECT submission_disposition, submission_failure_code
    FROM strategy_orders
    WHERE id = 'legacy-case-order'
  `).get(), {
    submission_disposition: 'SUBMISSION_UNCERTAIN',
    submission_failure_code: null
  });
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('rejects migrated v1 schema with an expanded submission failure-code allowlist', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-failure-allowlist-'));
  const databasePath = join(directory, 'strategies.sqlite');
  let database = new Database(databasePath);
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec(LEGACY_SCHEMA);
  seedLegacyExecutingStrategy(database, 'legacy-allowlist-strategy');
  seedLegacyPlannedOrder(
    database,
    'legacy-allowlist-strategy',
    'legacy-allowlist-order'
  );
  new SqliteStrategyRepository(database);
  const triggerNames = [
    'strategy_orders_submission_evidence_insert',
    'strategy_orders_submission_evidence_update'
  ] as const;
  const evidenceTriggersBefore = triggerNames.map((name) => ({
    name,
    sql: schemaObjectDefinition(database, 'trigger', name)
  }));
  const lastAllowedFailureCode = "'HEDGE_RESIDUAL_NOT_TRADABLE'";

  rewriteTableDefinition(database, 'strategy_orders', (sql) => {
    assert.equal(sql.split(lastAllowedFailureCode).length - 1, 1);
    return sql.replace(
      lastAllowedFailureCode,
      `${lastAllowedFailureCode},\n        'BOGUS_FAILURE'`
    );
  });
  database.close();
  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const reloadedSql = tableDefinition(database, 'strategy_orders');
  assert.equal(reloadedSql.split("'BOGUS_FAILURE'").length - 1, 1);
  for (const trigger of evidenceTriggersBefore) {
    assert.equal(
      schemaObjectDefinition(database, 'trigger', trigger.name),
      trigger.sql
    );
  }
  database.exec('SAVEPOINT bogus_failure_code_probe');
  try {
    assert.equal(database.prepare(`
      UPDATE strategy_orders
      SET
        submission_disposition = 'DEFINITELY_NOT_SUBMITTED',
        submission_failure_code = 'BOGUS_FAILURE'
      WHERE id = 'legacy-allowlist-order'
    `).run().changes, 1);
  } finally {
    database.exec('ROLLBACK TO bogus_failure_code_probe');
    database.exec('RELEASE bogus_failure_code_probe');
  }
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 3 }]);
  assert.deepEqual(database.prepare(`
    SELECT submission_disposition, submission_failure_code
    FROM strategy_orders
    WHERE id = 'legacy-allowlist-order'
  `).get(), {
    submission_disposition: 'SUBMISSION_UNCERTAIN',
    submission_failure_code: null
  });
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const missingForeignKey of [
  {
    name: 'strategy order parent',
    table: 'strategy_orders',
    from: 'strategy_id',
    parent: 'strategies',
    referenceClause: 'REFERENCES strategies(id)',
    insertOrphan(database: Database.Database) {
      const request = requestFor('missing-strategy', 'SPOT_MARKET');
      return database.prepare(`
        INSERT INTO strategy_orders (
          id, strategy_id, role, exchange_id, client_order_id,
          exchange_order_id, request_json, snapshot_json, status,
          created_at, updated_at
        ) VALUES (?, ?, 'SPOT_MARKET', 'bitget', ?, NULL, ?, NULL,
          'planned', ?, ?)
      `).run(
        'orphan-order',
        'missing-strategy',
        request.clientOrderId,
        JSON.stringify(request),
        '2026-07-26T00:00:00.000Z',
        '2026-07-26T00:00:00.000Z'
      ).changes;
    }
  },
  {
    name: 'order event parent',
    table: 'order_events',
    from: 'strategy_order_id',
    parent: 'strategy_orders',
    referenceClause: 'REFERENCES strategy_orders(id)',
    insertOrphan(database: Database.Database) {
      return database.prepare(`
        INSERT INTO order_events (
          strategy_order_id, snapshot_json, recorded_at
        ) VALUES (?, ?, ?)
      `).run(
        'missing-order',
        '{}',
        '2026-07-26T00:00:00.000Z'
      ).changes;
    }
  }
] as const) {
  test(`rejects v1 migration without required ${missingForeignKey.name} foreign key`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'trade-ops-missing-fk-'));
    const databasePath = join(directory, 'strategies.sqlite');
    let database = new Database(databasePath);
    t.after(() => {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    });
    database.exec(LEGACY_SCHEMA);
    seedLegacyExecutingStrategy(database, 'legacy-strategy');
    seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
    seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');

    rewriteTableDefinition(database, missingForeignKey.table, (sql) => {
      assert.equal(
        sql.split(missingForeignKey.referenceClause).length - 1,
        1
      );
      return sql.replace(missingForeignKey.referenceClause, '');
    });
    database.close();
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');

    const foreignKeys = database.prepare(
      `PRAGMA foreign_key_list(${missingForeignKey.table})`
    ).all() as Array<{ from: unknown; table: unknown; to: unknown }>;
    assert.equal(foreignKeys.some((foreignKey) => (
      foreignKey.from === missingForeignKey.from
      && foreignKey.table === missingForeignKey.parent
      && foreignKey.to === 'id'
    )), false);
    database.exec('SAVEPOINT orphan_probe');
    try {
      assert.equal(missingForeignKey.insertOrphan(database), 1);
    } finally {
      database.exec('ROLLBACK TO orphan_probe');
      database.exec('RELEASE orphan_probe');
    }
    const before = legacyFingerprint(database);

    assertSchemaMismatch(() => new SqliteStrategyRepository(database));

    assert.equal(legacyFingerprint(database), before);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'strategy_schema_metadata'
    `).get(), undefined);
  });
}

for (const generation of ['v2', 'v3', 'v1'] as const) {
  for (const drift of ORDER_EVENTS_DDL_DRIFTS) {
    test(`repair: rejects ${generation} ${drift.name} order_events DDL drift without modifying evidence`, (t) => {
      const directory = mkdtempSync(join(
        tmpdir(),
        `trade-ops-order-events-${generation}-`
      ));
      const databasePath = join(directory, 'strategies.sqlite');
      let database = new Database(databasePath);
      t.after(() => {
        if (database.open) database.close();
        rmSync(directory, { recursive: true, force: true });
      });

      if (generation === 'v2') {
        database.exec(V2_FRESH_SCHEMA_SQL);
        seedV2MigrationCoverage(database);
      } else if (generation === 'v3') {
        const repository = new SqliteStrategyRepository(database);
        const strategyId = repository.createPending(preflight()).id;
        assert.equal(repository.claimForExecution(strategyId), true);
        const request = requestFor(strategyId, 'SPOT_MARKET');
        const order = repository.planOrder(
          strategyId,
          'SPOT_MARKET',
          request
        );
        assert.equal(
          repository.attachOrderSnapshot(
            order.id,
            snapshotFor(request, 'bitget')
          ),
          'attached'
        );
        seedFundingMigrationCoverage(database);
      } else {
        database.exec(LEGACY_SCHEMA);
        seedLegacyExecutingStrategy(database, 'repair-v1-strategy');
        seedLegacyPlannedOrder(
          database,
          'repair-v1-strategy',
          'repair-v1-planned-order'
        );
        seedLegacyObservedOrder(
          database,
          'repair-v1-strategy',
          'repair-v1-observed-order'
        );
        seedFundingMigrationCoverage(database);
      }

      rewriteTableDefinition(database, 'order_events', drift.rewrite);
      const corruptedDefinition = tableDefinition(database, 'order_events');
      database.close();
      database = new Database(databasePath);
      database.pragma('foreign_keys = ON');
      assert.equal(
        tableDefinition(database, 'order_events'),
        corruptedDefinition
      );
      const before = strategyDatabaseFingerprint(database);

      assertSchemaMismatch(() => new SqliteStrategyRepository(database));

      assert.equal(strategyDatabaseFingerprint(database), before);
      assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(
        database.prepare('SELECT COUNT(*) FROM order_events').pluck().get(),
        1
      );
      if (generation === 'v1') {
        assert.equal(database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'strategy_schema_metadata'
        `).get(), undefined);
        assert.equal(
          tableColumnNames(database, 'strategy_orders').includes(
            'submission_disposition'
          ),
          false
        );
      } else {
        assert.equal(
          strategySchemaVersion(database),
          generation === 'v2' ? 2 : 3
        );
      }
    });
  }
}

test('persists definite no-submit evidence with a single compare-and-set', (t) => {
  const { repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const order = repository.planOrder(
    strategyId,
    'CONTRACT_MARKET',
    requestFor(strategyId, 'CONTRACT_MARKET')
  );

  assert.equal(
    repository.markDefinitelyNotSubmitted(order.id, 'ORDER_SUBMISSION_FAILED'),
    true
  );
  assert.equal(
    repository.markDefinitelyNotSubmitted(
      order.id,
      'HEDGE_RESIDUAL_NOT_TRADABLE'
    ),
    false
  );
  assert.deepEqual(
    repository.listOrders(strategyId).map((row) => ({
      disposition: row.submissionDisposition,
      failureCode: row.submissionFailureCode
    })),
    [{
      disposition: 'DEFINITELY_NOT_SUBMITTED',
      failureCode: 'ORDER_SUBMISSION_FAILED'
    }]
  );
});

test('returns false for an unknown order in definite no-submit CAS', (t) => {
  const { repository } = setup(t);

  assert.equal(repository.markDefinitelyNotSubmitted(
    'missing-order',
    'ORDER_SUBMISSION_FAILED'
  ), false);
});

test('rejects invalid definite no-submit CAS failure codes before SQL', (t) => {
  const { database, repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const order = repository.planOrder(
    strategyId,
    'CONTRACT_MARKET',
    requestFor(strategyId, 'CONTRACT_MARKET')
  );
  const before = database.prepare(`
    SELECT submission_disposition, submission_failure_code, updated_at
    FROM strategy_orders
    WHERE id = ?
  `).get(order.id);
  database.exec(`
    CREATE TEMP TRIGGER detect_unsafe_no_submit_sql
    BEFORE UPDATE OF submission_disposition, submission_failure_code
    ON strategy_orders
    BEGIN
      SELECT RAISE(ABORT, 'unsafe no-submit SQL reached');
    END;
  `);
  const unsafeRepository = repository as unknown as {
    markDefinitelyNotSubmitted(
      strategyOrderId: string,
      failureCode: unknown
    ): boolean;
  };

  assert.throws(
    () => unsafeRepository.markDefinitelyNotSubmitted(
      order.id,
      'UNSAFE_FAILURE_CODE'
    ),
    /order submission failure code/i
  );
  assert.deepEqual(database.prepare(`
    SELECT submission_disposition, submission_failure_code, updated_at
    FROM strategy_orders
    WHERE id = ?
  `).get(order.id), before);
});

test('attaches only semantic snapshot changes and promotes evidence atomically', (t) => {
  const { repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  const first = snapshotFor(request, 'bitget', {
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6',
    averagePrice: '60000'
  });
  const semanticallyEquivalent = {
    ...first,
    requestedBaseQuantity: '1.0',
    filledBaseQuantity: '0.40',
    remainingBaseQuantity: '0.600',
    averagePrice: '6e4',
    updatedAt: '2026-07-26T00:02:00.000Z'
  };

  assert.equal(repository.attachOrderSnapshot(order.id, first), 'attached');
  assert.equal(
    repository.attachOrderSnapshot(order.id, semanticallyEquivalent),
    'unchanged'
  );
  assert.equal(repository.listOrderEvents(order.id).length, 1);
  assert.equal(
    repository.listOrders(strategyId)[0]?.submissionDisposition,
    'REMOTE_OBSERVED'
  );
});

test('rejects invalid semantic snapshot with a typed validation error and no writes', (t) => {
  const { repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(strategyId, 'SPOT_MARKET', request);

  assert.throws(
    () => repository.attachOrderSnapshot(
      order.id,
      snapshotFor(request, 'bitget', {
        requestedBaseQuantity: '2',
        remainingBaseQuantity: '2'
      })
    ),
    OrderSnapshotValidationError
  );
  assert.deepEqual(repository.listOrderEvents(order.id), []);
  const persisted = repository.listOrders(strategyId)[0];
  assert.equal(persisted?.status, 'planned');
  assert.equal(persisted?.submissionDisposition, 'SUBMISSION_UNCERTAIN');
});

test('rolls back semantic snapshot event and evidence after a CAS conflict', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  const competing = snapshotFor(request, 'bitget', {
    status: 'unknown',
    updatedAt: '2026-07-26T00:01:30.000Z'
  });
  database.exec(`
    CREATE TEMP TABLE snapshot_write_conflict_fixture (
      exchange_order_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TEMP TRIGGER force_snapshot_write_conflict
    AFTER INSERT ON main.order_events
    BEGIN
      UPDATE strategy_orders
      SET
        exchange_order_id = (
          SELECT exchange_order_id FROM snapshot_write_conflict_fixture
        ),
        snapshot_json = (
          SELECT snapshot_json FROM snapshot_write_conflict_fixture
        ),
        status = (SELECT status FROM snapshot_write_conflict_fixture),
        submission_disposition = 'REMOTE_OBSERVED',
        submission_failure_code = NULL,
        updated_at = (SELECT updated_at FROM snapshot_write_conflict_fixture)
      WHERE id = NEW.strategy_order_id;
    END;
  `);
  database.prepare(`
    INSERT INTO snapshot_write_conflict_fixture (
      exchange_order_id, snapshot_json, status, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    competing.exchangeOrderId,
    JSON.stringify(competing),
    competing.status,
    competing.updatedAt
  );

  assert.throws(
    () => repository.attachOrderSnapshot(
      order.id,
      snapshotFor(request, 'bitget')
    ),
    OrderSnapshotWriteConflictError
  );
  assert.deepEqual(repository.listOrderEvents(order.id), []);
  const persisted = repository.listOrders(strategyId)[0];
  assert.equal(persisted?.status, 'planned');
  assert.equal(persisted?.snapshot, null);
  assert.equal(persisted?.submissionDisposition, 'SUBMISSION_UNCERTAIN');
});

test('never marks a remotely observed order as definitely not submitted', (t) => {
  const { repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  assert.equal(
    repository.attachOrderSnapshot(order.id, snapshotFor(request, 'bitget')),
    'attached'
  );

  assert.equal(repository.markDefinitelyNotSubmitted(
    order.id,
    'ORDER_SUBMISSION_FAILED'
  ), false);
  const persisted = repository.listOrders(strategyId)[0];
  assert.equal(persisted?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(persisted?.submissionFailureCode, null);
});

function evidenceConstraintFixture(
  t: TestContext,
  schema: 'fresh v3' | 'migrated v1 to v3'
) {
  if (schema === 'fresh v3') {
    const { database, repository } = setup(t);
    const strategyId = repository.createPending(preflight()).id;
    assert.equal(repository.claimForExecution(strategyId), true);
    return {
      database,
      repository,
      strategyId,
      order: repository.planOrder(
        strategyId,
        'CONTRACT_MARKET',
        requestFor(strategyId, 'CONTRACT_MARKET')
      )
    };
  }

  const database = legacyDatabase(t);
  const strategyId = 'migrated-constraint-strategy';
  seedLegacyExecutingStrategy(database, strategyId);
  seedLegacyPlannedOrder(database, strategyId, 'migrated-planned-order');
  const repository = new SqliteStrategyRepository(database);
  const [order] = repository.listOrders(strategyId);
  assert.ok(order);
  return { database, repository, strategyId, order };
}

for (const schema of ['fresh v3', 'migrated v1 to v3'] as const) {
  test(`enforces submission evidence constraints for ${schema}`, (t) => {
    const {
      database,
      repository,
      strategyId,
      order
    } = evidenceConstraintFixture(t, schema);

    for (const statement of [
      `UPDATE strategy_orders
       SET submission_failure_code = 'ORDER_SUBMISSION_FAILED'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET submission_disposition = 'REMOTE_OBSERVED'
       WHERE id = ?`
    ]) {
      assert.throws(
        () => database.prepare(statement).run(order.id),
        /constraint|submission evidence/i
      );
    }

    const insertRequest = requestFor(strategyId, 'SPOT_MARKET');
    const insertSnapshot = snapshotFor(insertRequest, 'bitget', {
      status: 'open',
      remainingBaseQuantity: insertRequest.baseQuantity
    });
    const invalidInserts = [
      {
        status: 'planned',
        exchangeOrderId: null,
        snapshotJson: null,
        disposition: 'DEFINITELY_NOT_SUBMITTED',
        failureCode: null
      },
      {
        status: 'planned',
        exchangeOrderId: null,
        snapshotJson: null,
        disposition: 'SUBMISSION_UNCERTAIN',
        failureCode: 'ORDER_SUBMISSION_FAILED'
      },
      {
        status: 'planned',
        exchangeOrderId: null,
        snapshotJson: null,
        disposition: 'REMOTE_OBSERVED',
        failureCode: null
      },
      {
        status: 'open',
        exchangeOrderId: insertSnapshot.exchangeOrderId,
        snapshotJson: JSON.stringify(insertSnapshot),
        disposition: 'SUBMISSION_UNCERTAIN',
        failureCode: null
      },
      {
        status: 'open',
        exchangeOrderId: insertSnapshot.exchangeOrderId,
        snapshotJson: JSON.stringify(insertSnapshot),
        disposition: 'DEFINITELY_NOT_SUBMITTED',
        failureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
      }
    ] as const;

    for (const [index, invalid] of invalidInserts.entries()) {
      assert.throws(
        () => database.prepare(`
          INSERT INTO strategy_orders (
            id, strategy_id, role, exchange_id, client_order_id,
            exchange_order_id, request_json, snapshot_json, status,
            submission_disposition, submission_failure_code,
            created_at, updated_at
          ) VALUES (?, ?, 'SPOT_MARKET', 'bitget', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `invalid-evidence-${index}`,
          strategyId,
          insertRequest.clientOrderId,
          invalid.exchangeOrderId,
          JSON.stringify(insertRequest),
          invalid.snapshotJson,
          invalid.status,
          invalid.disposition,
          invalid.failureCode,
          '2026-07-26T00:00:00.000Z',
          '2026-07-26T00:00:00.000Z'
        ),
        /constraint|submission evidence/i
      );
    }

    const request = requestFor(strategyId, 'CONTRACT_MARKET');
    assert.equal(
      repository.attachOrderSnapshot(
        order.id,
        snapshotFor(request, 'okx')
      ),
      'attached'
    );
    for (const statement of [
      `UPDATE strategy_orders
       SET submission_disposition = 'SUBMISSION_UNCERTAIN'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET status = 'planned'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET snapshot_json = NULL
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET exchange_order_id = NULL
       WHERE id = ?`
    ]) {
      assert.throws(
        () => database.prepare(statement).run(order.id),
        /constraint|submission evidence/i
      );
    }
    const persisted = repository.listOrders(strategyId)
      .find(({ id }) => id === order.id);
    assert.ok(persisted);
    assert.equal(persisted.status, 'open');
    assert.equal(persisted.submissionDisposition, 'REMOTE_OBSERVED');
    assert.notEqual(persisted.snapshot, null);
    assert.equal(repository.listOrderEvents(order.id).length, 1);
  });
}

test('rejects an unknown schema version without modifying the database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-unknown-schema-'));
  const database = new Database(join(directory, 'strategies.sqlite'));
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec(LEGACY_SCHEMA);
  seedLegacyExecutingStrategy(database, 'unknown-version-strategy');
  database.exec(`
    CREATE TABLE strategy_schema_metadata (
      singleton INTEGER PRIMARY KEY,
      version INTEGER NOT NULL
    );
    INSERT INTO strategy_schema_metadata (singleton, version) VALUES (1, 99);
  `);
  const before = legacyFingerprint(database);
  const journalModeBefore = database.pragma(
    'journal_mode',
    { simple: true }
  );
  assert.equal(journalModeBefore, 'delete');

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.equal(
    database.pragma('journal_mode', { simple: true }),
    journalModeBefore
  );
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
});

test('rejects migration inside an external transaction without taking ownership of it', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'external-transaction-strategy');
  const before = legacyFingerprint(database);
  database.exec('BEGIN');
  try {
    assertSchemaMismatch(() => new SqliteStrategyRepository(database));
    assert.equal(database.inTransaction, true);
    assert.equal(legacyFingerprint(database), before);
    assert.equal(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'strategy_schema_metadata'
      `).get(),
      undefined
    );
  } finally {
    database.exec('ROLLBACK');
  }
});

test('constructs a v3 repository twice without changing migrated data', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'legacy-strategy');
  seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
  seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');
  const first = new SqliteStrategyRepository(database);
  const firstOrders = first.listOrders('legacy-strategy');
  const firstEvents = first.listOrderEvents('observed-order');

  const second = new SqliteStrategyRepository(database);

  assert.deepEqual(second.listOrders('legacy-strategy'), firstOrders);
  assert.deepEqual(second.listOrderEvents('observed-order'), firstEvents);
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 3 }]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const preflightRejection of [
  {
    name: 'a v1 schema missing a required column before migration',
    kind: 'missing-column'
  },
  {
    name: 'a reserved object name before v1 migration',
    kind: 'reserved-object'
  }
] as const) {
  test(`rejects ${preflightRejection.name}`, (t) => {
    const database = legacyDatabase(t);
    seedLegacyExecutingStrategy(database, 'legacy-strategy');
    seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
    seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');
    if (preflightRejection.kind === 'missing-column') {
      makeMalformedLegacyStrategies(database);
    } else {
      database.exec(`
        DROP INDEX strategies_recoverable_idx;
        CREATE TABLE strategies_recoverable_idx (blocker TEXT NOT NULL);
      `);
    }
    const before = legacyFingerprint(database);

    assertSchemaMismatch(() => new SqliteStrategyRepository(database));

    assert.equal(legacyFingerprint(database), before);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'strategy_schema_metadata'
      `).get(),
      undefined
    );
    assert.equal(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'strategies_v2'
      `).get(),
      undefined
    );
    assert.equal(
      (database.prepare('PRAGMA table_info(strategy_orders)').all() as Array<{
        name: string;
      }>).some(({ name }) => (
        name === 'submission_disposition'
        || name === 'submission_failure_code'
      )),
      false
    );
    assert.deepEqual(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name LIKE 'strategy_orders_submission_evidence_%'
      ORDER BY name
    `).all(), []);
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM strategies').pluck().get(),
      1
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM strategy_orders').pluck().get(),
      2
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM order_events').pluck().get(),
      1
    );
  });
}

test('rejects a reserved v3 table before v1 migration and preserves data', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'legacy-chain-strategy');
  seedLegacyPlannedOrder(
    database,
    'legacy-chain-strategy',
    'legacy-chain-planned-order'
  );
  seedLegacyObservedOrder(
    database,
    'legacy-chain-strategy',
    'legacy-chain-observed-order'
  );
  database.exec('CREATE TABLE strategies_v3 (blocker TEXT NOT NULL)');
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'strategy_schema_metadata'
  `).get(), undefined);
  assert.equal(
    (database.prepare('PRAGMA table_info(strategy_orders)').all() as Array<{
      name: string;
    }>).some(({ name }) => (
      name === 'submission_disposition'
      || name === 'submission_failure_code'
    )),
    false
  );
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
      AND name LIKE 'strategy_orders_submission_evidence_%'
    ORDER BY name
  `).all(), []);
});

test('rejects a reserved v3 table before v2 migration and preserves data', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2MigrationCoverage(database);
  database.exec('CREATE TABLE strategies_v3 (blocker TEXT NOT NULL)');
  const before = legacyFingerprint(database);

  assertSchemaMismatch(() => new SqliteStrategyRepository(database));

  assert.equal(legacyFingerprint(database), before);
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 2 }]);
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM strategies_v3
  `).pluck().get(), 0);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('repair: rolls v2 migration back after completed v3 DDL', (t) => {
  const migrationMarker = 'v2-post-ddl-secret-marker';
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(V2_FRESH_SCHEMA_SQL);
  seedV2MigrationCoverage(database);
  const before = strategyDatabaseFingerprint(database);
  const originalExec = database.exec.bind(database);
  let v3ExecCompleted = 0;
  t.mock.method(database, 'exec', (source: string): Database.Database => {
    if (!isV3MigrationSql(source)) return originalExec(source);
    assert.equal(strategySchemaVersion(database), 2);
    assert.equal(
      tableColumnNames(database, 'strategies').includes('preflight_failure_json'),
      false
    );
    originalExec(source);
    assert.equal(strategySchemaVersion(database), 3);
    assert.equal(
      tableColumnNames(database, 'strategies').includes('preflight_failure_json'),
      true
    );
    assert.equal(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'strategies_v3'
    `).get(), undefined);
    v3ExecCompleted += 1;
    throw new Error(migrationMarker);
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.equal(v3ExecCompleted, 1);
  assert.equal(strategyDatabaseFingerprint(database), before);
  assert.equal(strategySchemaVersion(database), 2);
  assert.equal(
    tableColumnNames(database, 'strategies').includes('preflight_failure_json'),
    false
  );
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'strategies_v3'
  `).get(), undefined);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assertStartupStorageError(
    error,
    /^migrate-v2-to-v3$/,
    [migrationMarker]
  );
});

test('repair: rolls v1 migration chain back after completed v3 DDL', (t) => {
  const migrationMarker = 'v1-chain-post-ddl-secret-marker';
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'repair-v1-rollback-strategy');
  seedLegacyPlannedOrder(
    database,
    'repair-v1-rollback-strategy',
    'repair-v1-rollback-planned-order'
  );
  seedLegacyObservedOrder(
    database,
    'repair-v1-rollback-strategy',
    'repair-v1-rollback-observed-order'
  );
  seedFundingMigrationCoverage(database);
  const before = strategyDatabaseFingerprint(database);
  const originalExec = database.exec.bind(database);
  let v1ExecCompleted = 0;
  let v3ExecCompleted = 0;
  t.mock.method(database, 'exec', (source: string): Database.Database => {
    if (isV1MigrationSql(source)) {
      const result = originalExec(source);
      assert.equal(
        tableColumnNames(database, 'strategy_orders').includes(
          'submission_disposition'
        ),
        true
      );
      v1ExecCompleted += 1;
      return result;
    }
    if (!isV3MigrationSql(source)) return originalExec(source);
    assert.equal(strategySchemaVersion(database), 2);
    assert.equal(
      tableColumnNames(database, 'strategy_orders').includes(
        'submission_disposition'
      ),
      true
    );
    originalExec(source);
    assert.equal(strategySchemaVersion(database), 3);
    assert.equal(
      tableColumnNames(database, 'strategies').includes('preflight_failure_json'),
      true
    );
    assert.equal(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'strategies_v3'
    `).get(), undefined);
    v3ExecCompleted += 1;
    throw new Error(migrationMarker);
  });

  const error = captureError(() => new SqliteStrategyRepository(database));

  assert.equal(v1ExecCompleted, 1);
  assert.equal(v3ExecCompleted, 1);
  assert.equal(strategyDatabaseFingerprint(database), before);
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'strategy_schema_metadata'
  `).get(), undefined);
  assert.equal(
    tableColumnNames(database, 'strategy_orders').includes(
      'submission_disposition'
    ),
    false
  );
  assert.equal(
    tableColumnNames(database, 'strategies').includes('preflight_failure_json'),
    false
  );
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'strategies_v3'
  `).get(), undefined);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assertStartupStorageError(
    error,
    /^migrate-v1-to-v3$/,
    [migrationMarker]
  );
});

test('supports foreign keys and event persistence with SQLite safe integers', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.defaultSafeIntegers(true);

  const repository = new SqliteStrategyRepository(database);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1n);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(
    strategyId,
    'SPOT_MARKET',
    request
  );

  repository.attachOrderSnapshot(
    order.id,
    snapshotFor(request, 'bitget', {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    })
  );

  assert.equal(repository.listOrders(strategyId)[0]?.status, 'open');
  assert.equal(repository.listOrderEvents(order.id).length, 1);
});

test('only one competing confirmation can claim a pending strategy', (t) => {
  const { database, repository } = setup(t);
  const competitor = new SqliteStrategyRepository(database);
  const id = repository.createPending(preflight()).id;

  assert.equal(repository.claimForExecution(id), true);
  assert.equal(competitor.claimForExecution(id), false);
  assert.equal(repository.getStrategy(id).state, 'EXECUTING');
});

test('confirms an unchanged pending strategy atomically before returning', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-confirm-'));
  const databasePath = join(directory, 'strategies.sqlite');
  const database = new Database(databasePath);
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = new SqliteStrategyRepository(
    database,
    () => new Date('2026-10-03T00:01:00.000Z')
  );
  const expected = repository.createPending(preflight());
  const confirmation = task3Repository(repository);

  confirmation.confirmPreflight(expected);

  const observer = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(observer.prepare(`
      SELECT state, failure_code, preflight_failure_json
      FROM strategies WHERE id = ?
    `).get(expected.id), {
      state: 'EXECUTING',
      failure_code: null,
      preflight_failure_json: null
    });
    assert.equal(observer.prepare(`
      SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
    `).pluck().get(expected.id), 0);
  } finally {
    observer.close();
  }
  const loaded = task3Record(repository.getStrategy(expected.id));
  assert.equal(loaded.state, 'EXECUTING');
  assert.equal(loaded.failureCode, null);
  assert.equal(loaded.preflightFailure, null);
  assert.equal(loaded.updatedAt, '2026-10-03T00:01:00.000Z');
});

test('invalidates pending preflight atomically and reads the full failure after restart', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-invalidate-'));
  const databasePath = join(directory, 'strategies.sqlite');
  let database = new Database(databasePath);
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let repository = new SqliteStrategyRepository(database);
  const expected = repository.createPending(preflight());
  const failure = confirmationFailure();

  task3Repository(repository).invalidatePreflight(expected, failure);

  const raw = database.prepare(`
    SELECT state, failure_code, preflight_failure_json
    FROM strategies WHERE id = ?
  `).get(expected.id) as {
    state: unknown;
    failure_code: unknown;
    preflight_failure_json: unknown;
  };
  assert.equal(raw.state, 'PREFLIGHT_INVALIDATED');
  assert.equal(raw.failure_code, null);
  assert.equal(raw.preflight_failure_json, JSON.stringify(failure));
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
  `).pluck().get(expected.id), 0);

  database.close();
  database = new Database(databasePath);
  repository = new SqliteStrategyRepository(database);
  const loaded = task3Record(repository.getStrategy(expected.id));
  assert.equal(loaded.state, 'PREFLIGHT_INVALIDATED');
  assert.deepEqual(loaded.preflightFailure, failure);
  assert.equal(Object.isFrozen(loaded.preflightFailure), true);
  assert.deepEqual(repository.listOrders(expected.id), []);
  assert.deepEqual(repository.listRecoverable(), []);
});

test('persists the maximum valid confirmation failure without truncation', (t) => {
  const { database, repository } = setup(t);
  const expected = repository.createPending(preflight());
  const failure = createTradeOpsError({
    code: 'BALANCE_INSUFFICIENT',
    phase: 'confirmation',
    subject: {
      type: 'account',
      exchangeId: 'bitget',
      symbol: SYMBOL,
      field: 'freeUsdt'
    },
    expected: 'e'.repeat(2_000),
    actual: Array.from({ length: 16 }, () => 'a'.repeat(2_000)),
    occurredAt: CONFIRMATION_OCCURRED_AT
  }).detail;

  task3Repository(repository).invalidatePreflight(expected, failure);

  assert.equal(database.prepare(`
    SELECT preflight_failure_json FROM strategies WHERE id = ?
  `).pluck().get(expected.id), JSON.stringify(failure));
  const loaded = task3Record(repository.getStrategy(expected.id));
  assert.deepEqual(loaded.preflightFailure, failure);
  assert.equal(Object.isFrozen(loaded.preflightFailure), true);
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
  `).pluck().get(expected.id), 0);
});

test('rejects unsafe confirmation failure contracts before writing SQL', async (t) => {
  const base = confirmationFailure();
  let getterCalls = 0;
  const accessorFailure = { ...base } as Record<string, unknown>;
  Object.defineProperty(accessorFailure, 'actual', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe-getter-marker';
    }
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly failure: unknown;
    readonly markers: readonly string[];
  }> = [
    {
      name: 'diagnostic string above 2000 characters',
      failure: { ...base, actual: `${'x'.repeat(2_000)}string-limit-marker` },
      markers: ['string-limit-marker']
    },
    {
      name: 'diagnostic list above 16 entries',
      failure: {
        ...base,
        actual: [...Array.from({ length: 16 }, () => 'safe'), 'list-limit-marker']
      },
      markers: ['list-limit-marker']
    },
    {
      name: 'extra field',
      failure: { ...base, extra: 'extra-field-marker' },
      markers: ['extra-field-marker']
    },
    {
      name: 'forged message',
      failure: { ...base, message: 'forged-message-marker' },
      markers: ['forged-message-marker']
    },
    {
      name: 'accessor property',
      failure: accessorFailure,
      markers: ['unsafe-getter-marker']
    },
    {
      name: 'proxy object',
      failure: new Proxy({ ...base }, {}),
      markers: []
    }
  ];

  for (const unsafeCase of cases) {
    await t.test(unsafeCase.name, (child) => {
      const { database, repository } = setup(child);
      const expected = repository.createPending(preflight());
      const confirmation = task3Repository(repository);
      const before = confirmationStateFingerprint(database);

      const error = captureError(() => confirmation.invalidatePreflight(
        expected,
        unsafeCase.failure as ErrorDetail
      ));

      assert.equal(confirmationStateFingerprint(database), before);
      assert.equal(database.inTransaction, false);
      const rendered = String(error);
      for (const marker of unsafeCase.markers) {
        assert.equal(rendered.includes(marker), false);
      }
    });
  }
  assert.equal(getterCalls, 0);
});

test('rejects every persisted confirmation precondition drift without writes', async (t) => {
  const mutations: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (database: Database.Database, strategyId: string) => void;
  }> = [
    {
      name: 'id',
      mutate(database, strategyId) {
        database.prepare(
          'UPDATE strategies SET id = ? WHERE id = ?'
        ).run(`${strategyId}-moved`, strategyId);
      }
    },
    {
      name: 'state',
      mutate(database, strategyId) {
        database.prepare(
          "UPDATE strategies SET state = 'EXECUTING' WHERE id = ?"
        ).run(strategyId);
      }
    },
    {
      name: 'mode',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.mode = 'SPOT_FIRST';
        });
        database.prepare(
          "UPDATE strategies SET mode = 'SPOT_FIRST' WHERE id = ?"
        ).run(strategyId);
      }
    },
    {
      name: 'spot exchange identity',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.spotExchangeId = 'coinbase';
          preview.spotMarket.exchangeId = 'coinbase';
        });
        database.prepare(`
          UPDATE strategies SET spot_exchange_id = 'coinbase' WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'contract exchange identity',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.contractExchangeId = 'bybit';
          preview.contractMarket.exchangeId = 'bybit';
        });
        database.prepare(`
          UPDATE strategies SET contract_exchange_id = 'bybit' WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'symbol identity',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.symbol = 'ETH/USDT';
          preview.spotMarket.symbol = 'ETH/USDT';
          preview.spotMarket.base = 'ETH';
          preview.contractMarket.symbol = 'ETH/USDT';
          preview.contractMarket.base = 'ETH';
        });
        database.prepare(`
          UPDATE strategies SET symbol = 'ETH/USDT' WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'requested quantity',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.requestedBaseQuantity = '2';
        });
        database.prepare(`
          UPDATE strategies SET requested_base_quantity = '2' WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'effective quantity',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.effectiveBaseQuantity = '0.5';
        });
        database.prepare(`
          UPDATE strategies SET effective_base_quantity = '0.5' WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'preflight snapshot',
      mutate(database, strategyId) {
        updateStoredPreflight(database, strategyId, (preview) => {
          preview.spotReferencePrice = '60001';
        });
      }
    },
    {
      name: 'execution failure',
      mutate(database, strategyId) {
        database.pragma('ignore_check_constraints = ON');
        try {
          database.prepare(`
            UPDATE strategies
            SET failure_code = 'ORDER_SUBMISSION_FAILED'
            WHERE id = ?
          `).run(strategyId);
        } finally {
          database.pragma('ignore_check_constraints = OFF');
        }
      }
    },
    {
      name: 'preflight failure',
      mutate(database, strategyId) {
        database.pragma('ignore_check_constraints = ON');
        try {
          database.prepare(`
            UPDATE strategies SET preflight_failure_json = ? WHERE id = ?
          `).run(JSON.stringify(confirmationFailure()), strategyId);
        } finally {
          database.pragma('ignore_check_constraints = OFF');
        }
      }
    },
    {
      name: 'creation timestamp',
      mutate(database, strategyId) {
        database.prepare(`
          UPDATE strategies
          SET created_at = '2026-07-25T23:59:59.000Z'
          WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'update timestamp',
      mutate(database, strategyId) {
        database.prepare(`
          UPDATE strategies
          SET updated_at = '2026-07-26T00:00:01.000Z'
          WHERE id = ?
        `).run(strategyId);
      }
    },
    {
      name: 'existing order',
      mutate(database, strategyId) {
        insertRawPlannedOrder(database, strategyId);
      }
    }
  ];
  for (const mutation of mutations) {
    for (const operation of ['confirm', 'invalidate'] as const) {
      await t.test(`${operation}: ${mutation.name}`, (child) => {
        const { database, repository } = setup(child);
        const expected = repository.createPending(preflight());
        const confirmation = task3Repository(repository);
        mutation.mutate(database, expected.id);
        const beforeAttempt = confirmationStateFingerprint(database);

        const error = captureError(() => {
          if (operation === 'confirm') {
            confirmation.confirmPreflight(expected);
          } else {
            confirmation.invalidatePreflight(expected, confirmationFailure());
          }
        });

        assertTrustedStorageError(
          error,
          'STORAGE_TRANSITION_REJECTED',
          'strategy',
          expected.id
        );
        assert.equal(confirmationStateFingerprint(database), beforeAttempt);
        assert.equal(
          database.pragma('ignore_check_constraints', { simple: true }),
          0
        );
      });
    }
  }
});

for (const operation of ['confirm', 'invalidate'] as const) {
  test(`treats a zero-row ${operation} confirmation CAS as an integrity error`, (t) => {
    const { database, repository } = setup(t);
    const expected = repository.createPending(preflight());
    const confirmation = task3Repository(repository);
    database.exec(`
      CREATE TEMP TRIGGER ignore_confirmation_update
      BEFORE UPDATE ON main.strategies
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    const before = rawStrategy(database, expected.id);

    const error = captureError(() => {
      if (operation === 'confirm') {
        confirmation.confirmPreflight(expected);
      } else {
        confirmation.invalidatePreflight(expected, confirmationFailure());
      }
    });

    assertTrustedStorageError(
      error,
      'STORAGE_TRANSITION_REJECTED',
      'strategy',
      expected.id
    );
    assert.deepEqual(rawStrategy(database, expected.id), before);
    assert.equal(database.prepare(`
      SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
    `).pluck().get(expected.id), 0);
  });

  test(`rolls back an aborted ${operation} confirmation with no partial failure`, (t) => {
    const rawMarker = `raw-sql-secret-fixture-${operation}`;
    const { database, repository } = setup(t);
    const expected = repository.createPending(preflight());
    const confirmation = task3Repository(repository);
    database.exec(`
      CREATE TEMP TRIGGER abort_confirmation_update
      BEFORE UPDATE ON main.strategies
      BEGIN
        SELECT RAISE(ABORT, '${rawMarker}');
      END;
    `);
    const before = rawStrategy(database, expected.id);

    const error = captureError(() => {
      if (operation === 'confirm') {
        confirmation.confirmPreflight(expected);
      } else {
        confirmation.invalidatePreflight(expected, confirmationFailure());
      }
    });

    assertTrustedStorageError(
      error,
      'STORAGE_OPERATION_FAILED',
      'database',
      expected.id,
      [rawMarker]
    );
    assert.deepEqual(rawStrategy(database, expected.id), before);
    assert.equal(database.inTransaction, false);
    assert.equal(database.prepare(`
      SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
    `).pluck().get(expected.id), 0);
  });

  test(`rejects ${operation} confirmation inside an external transaction`, (t) => {
    const { database, repository } = setup(t);
    const expected = repository.createPending(preflight());
    const confirmation = task3Repository(repository);
    const before = rawStrategy(database, expected.id);
    database.exec('BEGIN');
    try {
      const error = captureError(() => {
        if (operation === 'confirm') {
          confirmation.confirmPreflight(expected);
        } else {
          confirmation.invalidatePreflight(expected, confirmationFailure());
        }
      });

      assertTrustedStorageError(
        error,
        'STORAGE_OPERATION_FAILED',
        'database',
        expected.id
      );
      assert.equal(database.inTransaction, true);
      assert.deepEqual(rawStrategy(database, expected.id), before);
      assert.equal(database.prepare(`
        SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
      `).pluck().get(expected.id), 0);
    } finally {
      database.exec('ROLLBACK');
    }
  });
}

test('classifies hostile confirmation transaction failures without trusting prototypes', async (t) => {
  for (const scenario of [
    {
      name: 'revoked proxy',
      failure(): unknown {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        return revocable.proxy;
      }
    },
    {
      name: 'forged TradeOpsError prototype',
      failure(): unknown {
        return Object.create(TradeOpsError.prototype) as unknown;
      }
    }
  ] as const) {
    await t.test(scenario.name, (child) => {
      const { database, repository } = setup(child);
      const pending = repository.createPending(preflight());
      const confirmation = task3Repository(repository);
      const internals = repository as unknown as Task3RepositoryInternals;
      assert.equal(
        typeof internals.confirmPreflightTransaction,
        'function',
        'Task 3 requires a replaceable private confirmation transaction seam'
      );
      internals.confirmPreflightTransaction = () => {
        throw scenario.failure();
      };
      const before = rawStrategy(database, pending.id);

      const error = captureError(() => confirmation.confirmPreflight(pending));

      assertTrustedStorageError(
        error,
        'STORAGE_OPERATION_FAILED',
        'database',
        pending.id
      );
      assert.equal(
        error.detail.actual,
        'transaction-failed:object-failure;rollback-verified'
      );
      assert.deepEqual(rawStrategy(database, pending.id), before);
      assert.equal(database.inTransaction, false);
      assert.equal(repository.listOrders(pending.id).length, 0);
      assert.equal(repository.getStrategy(pending.id).state, 'PENDING_CONFIRMATION');
    });
  }
});

test('rejects order planning before confirmation and after preflight invalidation', async (t) => {
  await t.test('pending confirmation', (child) => {
    const { database, repository } = setup(child);
    const pending = repository.createPending(preflight());

    assert.throws(
      () => repository.planOrder(
        pending.id,
        'SPOT_MARKET',
        requestFor(pending.id, 'SPOT_MARKET')
      ),
      /strategy|state|confirmation/i
    );
    assert.throws(
      () => repository.planOrdersAtomically(pending.id, [{
        role: 'CONTRACT_MARKET',
        request: requestFor(pending.id, 'CONTRACT_MARKET')
      }]),
      /strategy|state|confirmation/i
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
    `).pluck().get(pending.id), 0);
  });

  await t.test('invalidated preflight', (child) => {
    const { database, repository } = setup(child);
    const pending = repository.createPending(preflight());
    task3Repository(repository).invalidatePreflight(
      pending,
      confirmationFailure()
    );

    assert.throws(
      () => repository.planOrder(
        pending.id,
        'SPOT_MARKET',
        requestFor(pending.id, 'SPOT_MARKET')
      ),
      /strategy|state|invalidated/i
    );
    assert.throws(
      () => repository.planOrdersAtomically(pending.id, [{
        role: 'CONTRACT_MARKET',
        request: requestFor(pending.id, 'CONTRACT_MARKET')
      }]),
      /strategy|state|invalidated/i
    );
    assert.equal(repository.claimForExecution(pending.id), false);
    assert.equal(database.prepare(`
      SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
    `).pluck().get(pending.id), 0);
  });
});

test('does not let generic transitions create or revive preflight invalidation', (t) => {
  const { repository } = setup(t);
  const pending = repository.createPending(preflight());
  const invalidated = repository.createPending(preflight({
    mode: 'SPOT_FIRST'
  }));
  task3Repository(repository).invalidatePreflight(
    invalidated,
    confirmationFailure()
  );

  assert.throws(
    () => repository.transition(
      pending.id,
      ['PENDING_CONFIRMATION'],
      'PREFLIGHT_INVALIDATED' as StrategyState
    ),
    /state|transition|unsupported/i
  );
  assert.throws(
    () => repository.transition(
      invalidated.id,
      ['PREFLIGHT_INVALIDATED' as StrategyState],
      'EXECUTING'
    ),
    /state|transition|unsupported|illegal/i
  );
  const loaded = task3Record(repository.getStrategy(invalidated.id));
  assert.equal(loaded.state, 'PREFLIGHT_INVALIDATED');
  assert.deepEqual(loaded.preflightFailure, confirmationFailure());
});

test('fails closed when an invalidated strategy has an order', (t) => {
  const { database, repository } = setup(t);
  const pending = repository.createPending(preflight());
  task3Repository(repository).invalidatePreflight(
    pending,
    confirmationFailure()
  );
  insertRawPlannedOrder(database, pending.id);

  const error = captureError(() => repository.getStrategy(pending.id));

  assertTrustedStorageError(
    error,
    'STORAGE_RECORD_INVALID',
    'database',
    pending.id
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
  `).pluck().get(pending.id), 1);
});

for (const corruption of [
  {
    name: 'malformed failure JSON',
    rawFailure: '{"raw":"row-json-secret-marker"'
  },
  {
    name: 'non-object failure JSON',
    rawFailure: JSON.stringify(['row-json-secret-marker'])
  },
  {
    name: 'unknown failure code',
    rawFailure: JSON.stringify({
      ...confirmationFailure(),
      code: 'UNKNOWN_CONFIRMATION_FAILURE',
      actual: 'row-json-secret-marker'
    })
  },
  {
    name: 'failure JSON with an extra field',
    rawFailure: JSON.stringify({
      ...confirmationFailure(),
      extra: 'row-json-secret-marker'
    })
  },
  {
    name: 'forged failure message',
    rawFailure: JSON.stringify({
      ...confirmationFailure(),
      message: 'row-json-secret-marker'
    })
  }
] as const) {
  test(`rejects ${corruption.name} without exposing the raw row`, (t) => {
    const { database, repository } = setup(t);
    const pending = repository.createPending(preflight());
    task3Repository(repository).invalidatePreflight(
      pending,
      confirmationFailure()
    );
    database.prepare(`
      UPDATE strategies SET preflight_failure_json = ? WHERE id = ?
    `).run(corruption.rawFailure, pending.id);

    const error = captureError(() => repository.getStrategy(pending.id));

    assertTrustedStorageError(
      error,
      'STORAGE_RECORD_INVALID',
      'database',
      pending.id,
      ['row-json-secret-marker', corruption.rawFailure]
    );
  });
}

test('fails closed on invalid preflight failure and state combinations', async (t) => {
  for (const corruption of [
    {
      name: 'invalidated without preflight failure',
      update: `
        UPDATE strategies
        SET state = 'PREFLIGHT_INVALIDATED', preflight_failure_json = NULL
        WHERE id = ?
      `
    },
    {
      name: 'pending with preflight failure',
      update: `
        UPDATE strategies SET preflight_failure_json = '${JSON.stringify(
          confirmationFailure()
        ).replaceAll("'", "''")}' WHERE id = ?
      `
    },
    {
      name: 'invalidated with execution failure',
      update: `
        UPDATE strategies
        SET state = 'PREFLIGHT_INVALIDATED',
            failure_code = 'ORDER_SUBMISSION_FAILED',
            preflight_failure_json = '${JSON.stringify(
              confirmationFailure()
            ).replaceAll("'", "''")}'
        WHERE id = ?
      `
    }
  ] as const) {
    await t.test(corruption.name, (child) => {
      const { database, repository } = setup(child);
      const pending = repository.createPending(preflight());
      task3Repository(repository);
      database.pragma('ignore_check_constraints = ON');
      try {
        database.prepare(corruption.update).run(pending.id);
      } finally {
        database.pragma('ignore_check_constraints = OFF');
      }

      const error = captureError(() => repository.getStrategy(pending.id));

      assertTrustedStorageError(
        error,
        'STORAGE_RECORD_INVALID',
        'database',
        pending.id
      );
      assert.equal(
        database.pragma('ignore_check_constraints', { simple: true }),
        0
      );
    });
  }
});

test('fails closed after an unconfirmed confirmation transaction result', (t) => {
  const rawMarker = 'raw-open-transaction-secret-marker';
  const { database, repository } = setup(t);
  const existingStrategyId = createExecutingStrategy(repository, preflight({
    mode: 'SPOT_FIRST'
  }));
  const existingRequest = requestFor(existingStrategyId, 'SPOT_MARKET');
  const existingOrder = repository.planOrder(
    existingStrategyId,
    'SPOT_MARKET',
    existingRequest
  );
  const pending = repository.createPending(preflight());
  const confirmation = task3Repository(repository);
  const internals = repository as unknown as Task3RepositoryInternals;
  assert.equal(
    typeof internals.confirmPreflightTransaction,
    'function',
    'Task 3 requires a replaceable private confirmation transaction seam'
  );
  internals.confirmPreflightTransaction = () => {
    database.exec('BEGIN');
    database.prepare(`
      UPDATE strategies SET state = 'EXECUTING' WHERE id = ?
    `).run(pending.id);
    throw new Error(rawMarker);
  };

  const error = captureError(() => confirmation.confirmPreflight(pending));

  assertTrustedStorageError(
    error,
    'STORAGE_OPERATION_FAILED',
    'database',
    pending.id,
    [rawMarker]
  );
  assert.equal(database.inTransaction, true);
  assert.equal(database.prepare(`
    SELECT state FROM strategies WHERE id = ?
  `).pluck().get(pending.id), 'EXECUTING');
  const beforeBlockedCalls = confirmationStateFingerprint(database);
  const blockedCalls: ReadonlyArray<readonly [string, () => unknown]> = [
    ['createPending', () => repository.createPending(preflight())],
    ['getStrategy', () => repository.getStrategy(existingStrategyId)],
    ['confirmPreflight', () => confirmation.confirmPreflight(pending)],
    [
      'invalidatePreflight',
      () => confirmation.invalidatePreflight(pending, confirmationFailure())
    ],
    ['claimForExecution', () => repository.claimForExecution(pending.id)],
    [
      'planOrder',
      () => repository.planOrder(
        existingStrategyId,
        'CONTRACT_MARKET',
        requestFor(existingStrategyId, 'CONTRACT_MARKET')
      )
    ],
    [
      'planOrdersAtomically',
      () => repository.planOrdersAtomically(existingStrategyId, [{
        role: 'CONTRACT_MARKET',
        request: requestFor(existingStrategyId, 'CONTRACT_MARKET')
      }])
    ],
    [
      'attachOrderSnapshot',
      () => repository.attachOrderSnapshot(
        existingOrder.id,
        snapshotFor(existingRequest, 'bitget')
      )
    ],
    [
      'markDefinitelyNotSubmitted',
      () => repository.markDefinitelyNotSubmitted(
        existingOrder.id,
        'ORDER_SUBMISSION_FAILED'
      )
    ],
    ['listOrders', () => repository.listOrders(existingStrategyId)],
    ['listOrderEvents', () => repository.listOrderEvents(existingOrder.id)],
    [
      'transition',
      () => repository.transition(
        existingStrategyId,
        ['EXECUTING'],
        'WAITING_HEDGE'
      )
    ],
    ['listRecoverable', () => repository.listRecoverable()]
  ];
  for (const [name, action] of blockedCalls) {
    const blockedError = captureError(action);
    assert.ok(blockedError instanceof TradeOpsError, name);
    assert.equal(blockedError.detail.code, 'STORAGE_OPERATION_FAILED', name);
    assert.equal(blockedError.detail.phase, 'storage', name);
    assert.equal(
      JSON.stringify(blockedError.detail).includes(rawMarker),
      false,
      name
    );
  }
  assert.equal(confirmationStateFingerprint(database), beforeBlockedCalls);
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
  `).pluck().get(pending.id), 0);

  database.exec('ROLLBACK');
  assert.equal(database.inTransaction, false);
  assert.throws(
    () => repository.getStrategy(pending.id),
    TradeOpsError
  );
  const restarted = new SqliteStrategyRepository(database);
  assert.equal(restarted.getStrategy(pending.id).state, 'PENDING_CONFIRMATION');
  assert.equal(restarted.listOrders(pending.id).length, 0);
});

test('poisons the repository when rollback verification cannot reread the strategy', (t) => {
  const rawMarker = 'raw-reread-secret-marker';
  const { database, repository } = setup(t);
  const pending = repository.createPending(preflight());
  const confirmation = task3Repository(repository);
  const internals = repository as unknown as Task3RepositoryInternals;
  assert.ok(internals.selectStrategy);
  const statement = internals.selectStrategy;
  const originalGet = statement.get.bind(statement);
  let reads = 0;
  t.mock.method(statement, 'get', (...parameters: unknown[]) => {
    reads += 1;
    if (reads === 2) throw new Error(rawMarker);
    return originalGet(...parameters);
  });
  database.exec(`
    CREATE TEMP TRIGGER abort_confirmation_before_reread
    BEFORE UPDATE ON main.strategies
    BEGIN
      SELECT RAISE(ABORT, 'controlled confirmation abort');
    END;
  `);

  const error = captureError(() => confirmation.confirmPreflight(pending));

  assertTrustedStorageError(
    error,
    'STORAGE_OPERATION_FAILED',
    'database',
    pending.id,
    [rawMarker, 'controlled confirmation abort']
  );
  assert.equal(database.inTransaction, false);
  assert.equal(reads, 2);
  assert.throws(() => repository.listRecoverable(), TradeOpsError);
  assert.throws(() => repository.getStrategy(pending.id), TradeOpsError);
  assert.equal(database.prepare(`
    SELECT COUNT(*) FROM strategy_orders WHERE strategy_id = ?
  `).pluck().get(pending.id), 0);
});

test('lists only executing and waiting strategies for restart recovery', (t) => {
  const { repository } = setup(t);
  const executing = repository.createPending(preflight()).id;
  const waiting = repository.createPending(preflight({
    mode: 'SPOT_FIRST'
  })).id;
  const terminal = repository.createPending(preflight({
    mode: 'CONCURRENT'
  })).id;
  repository.claimForExecution(executing);
  repository.claimForExecution(waiting);
  repository.claimForExecution(terminal);
  repository.transition(waiting, ['EXECUTING'], 'WAITING_HEDGE');
  repository.transition(terminal, ['EXECUTING'], 'HEDGED');

  assert.deepEqual(
    repository.listRecoverable().map((row) => row.state).sort(),
    ['EXECUTING', 'WAITING_HEDGE']
  );
});

test('permits only explicit domain state transitions with SQL source guards', (t) => {
  const { repository } = setup(t);
  const id = repository.createPending(preflight()).id;

  assert.throws(
    () => repository.transition(id, [], 'EXECUTING'),
    /source state/i
  );
  assert.throws(
    () => repository.transition(
      id,
      ['PENDING_CONFIRMATION'],
      'HEDGED'
    ),
    /illegal strategy state transition/i
  );
  assert.throws(
    () => repository.transition(
      id,
      ['PENDING_CONFIRMATION'],
      'NOT_A_STATE' as StrategyState
    ),
    /unsupported value/i
  );
  assert.equal(
    repository.transition(id, ['EXECUTING'], 'WAITING_HEDGE'),
    false
  );
  assert.equal(
    repository.transition(id, ['PENDING_CONFIRMATION'], 'EXECUTING'),
    true
  );
  assert.equal(
    repository.transition(
      id,
      ['EXECUTING'],
      'HEDGE_INCOMPLETE',
      'HEDGE_ORDER_REJECTED'
    ),
    true
  );
  assert.equal(
    repository.getStrategy(id).failureCode,
    'HEDGE_ORDER_REJECTED'
  );
  assert.throws(
    () => repository.transition(
      id,
      ['HEDGE_INCOMPLETE'],
      'EXECUTING'
    ),
    /illegal strategy state transition/i
  );
});

test('transition persists only allowlisted failure codes and never arbitrary secrets', (t) => {
  const sensitiveValues = [
    'apiKey=review-fixture-api-key',
    'secret=review-fixture-secret',
    'password=review-fixture-password',
    'signature=review-fixture-signature'
  ];

  for (const sensitiveValue of sensitiveValues) {
    const { database, repository } = setup(t);
    const id = repository.createPending(preflight()).id;
    repository.claimForExecution(id);
    const reviewedRepository = repository as unknown as {
      transition(
        strategyId: string,
        from: StrategyState[],
        to: StrategyState,
        failureCode?: unknown
      ): boolean;
    };

    assert.throws(
      () => reviewedRepository.transition(
        id,
        ['EXECUTING'],
        'FAILED',
        sensitiveValue
      ),
      /failure code/i
    );

    const rawCells = JSON.stringify(database.prepare(
      'SELECT * FROM strategies'
    ).all());
    assert.equal(rawCells.includes(sensitiveValue), false);
    const loaded = repository.getStrategy(id) as unknown as
      Record<string, unknown>;
    assert.equal(loaded.state, 'EXECUTING');
    assert.equal(loaded.failureCode, null);
    assert.equal(Object.hasOwn(loaded, 'lastError'), false);
    assert.equal(JSON.stringify(repository.listRecoverable()).includes(
      sensitiveValue
    ), false);
  }
});

test('never claims or launders a persisted unknown failure code', (t) => {
  const { database, repository } = setup(t);
  const id = repository.createPending(preflight()).id;
  database.pragma('ignore_check_constraints = ON');
  database.prepare(
    'UPDATE strategies SET failure_code = ? WHERE id = ?'
  ).run('UNSAFE_FAILURE_CODE', id);
  database.pragma('ignore_check_constraints = OFF');

  assert.throws(
    () => repository.getStrategy(id),
    /invalid persisted strategy/i
  );
  const before = database.prepare(
    'SELECT state, failure_code FROM strategies WHERE id = ?'
  ).get(id);

  assert.equal(repository.claimForExecution(id), false);
  assert.equal(
    repository.transition(id, ['PENDING_CONFIRMATION'], 'EXECUTING'),
    false
  );
  assert.deepEqual(
    database.prepare(
      'SELECT state, failure_code FROM strategies WHERE id = ?'
    ).get(id),
    before
  );
  assert.throws(
    () => repository.getStrategy(id),
    /invalid persisted strategy/i
  );
});

test('keeps failure codes consistent with strategy state', (t) => {
  const { database, repository } = setup(t);
  const id = repository.createPending(preflight()).id;

  assert.throws(
    () => database.prepare(
      'UPDATE strategies SET failure_code = ? WHERE id = ?'
    ).run('ORDER_SUBMISSION_FAILED', id),
    /CHECK constraint/i
  );
  assert.throws(
    () => repository.transition(
      id,
      ['PENDING_CONFIRMATION'],
      'EXECUTING',
      'ORDER_SUBMISSION_FAILED'
    ),
    /failure code/i
  );
  assert.equal(repository.claimForExecution(id), true);
  assert.throws(
    () => repository.transition(id, ['EXECUTING'], 'FAILED'),
    /failure code/i
  );
  assert.equal(repository.getStrategy(id).state, 'EXECUTING');
});

test('fails closed on a persisted state and failure-code mismatch', (t) => {
  const { database, repository } = setup(t);
  const id = repository.createPending(preflight()).id;
  database.pragma('ignore_check_constraints = ON');
  database.prepare(
    'UPDATE strategies SET failure_code = ? WHERE id = ?'
  ).run('ORDER_SUBMISSION_FAILED', id);
  database.pragma('ignore_check_constraints = OFF');

  assert.throws(
    () => repository.getStrategy(id),
    /invalid persisted strategy/i
  );
  assert.equal(repository.claimForExecution(id), false);
  assert.deepEqual(
    database.prepare(
      'SELECT state, failure_code FROM strategies WHERE id = ?'
    ).get(id),
    {
      state: 'PENDING_CONFIRMATION',
      failure_code: 'ORDER_SUBMISSION_FAILED'
    }
  );
});

test('createPending stores a defensive immutable public preflight snapshot', (t) => {
  const { database, repository } = setup(t);
  const source = preflight();

  const created = repository.createPending(source);
  source.accountSettings.marginMode = 'cross';
  source.spotMarket.symbol = 'ETH/USDT';
  const loaded = repository.getStrategy(created.id);

  assert.equal(loaded.preflight.accountSettings.marginMode, 'isolated');
  assert.equal(loaded.preflight.spotMarket.symbol, SYMBOL);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.preflight), true);
  assert.equal(Object.isFrozen(loaded.preflight.accountSettings), true);
  assert.throws(() => {
    loaded.preflight.accountSettings.marginMode = 'cross';
  }, TypeError);

  const stored = database.prepare(
    'SELECT preflight_json FROM strategies WHERE id = ?'
  ).pluck().get(created.id);
  assert.equal(typeof stored, 'string');
  assert.doesNotMatch(stored as string, /credential|gateway|client|secret/i);
});

test('createPending fails closed before writing unsafe preflight values', (t) => {
  const { database, repository } = setup(t);
  const cyclic = preflight() as PreflightResult & { gateway?: unknown };
  cyclic.gateway = cyclic;
  const cases: unknown[] = [
    { ...preflight(), credentials: { apiKey: 'secret-value' } },
    { ...preflight(), client: { createOrder() {} } },
    { ...preflight(), spotFreeUsdt: Number.POSITIVE_INFINITY },
    cyclic
  ];

  for (const value of cases) {
    assert.throws(
      () => repository.createPending(value as PreflightResult),
      /invalid preflight snapshot/i
    );
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) FROM strategies').pluck().get(),
    0
  );
  assert.doesNotMatch(
    JSON.stringify(database.prepare(
      'SELECT preflight_json FROM strategies'
    ).all()),
    /secret-value/
  );
});

test('fails safely when persisted strategy state or JSON is tampered', (t) => {
  const { database, repository } = setup(t);
  const id = repository.createPending(preflight()).id;
  database.pragma('ignore_check_constraints = ON');
  database.prepare(
    'UPDATE strategies SET state = ? WHERE id = ?'
  ).run('BROKEN_STATE', id);
  database.pragma('ignore_check_constraints = OFF');

  assert.throws(() => repository.getStrategy(id), /persisted strategy/i);

  database.pragma('ignore_check_constraints = ON');
  database.prepare(
    'UPDATE strategies SET state = ?, preflight_json = ? WHERE id = ?'
  ).run('PENDING_CONFIRMATION', '{"mode":"CONTRACT_FIRST"}', id);
  database.pragma('ignore_check_constraints = OFF');
  assert.throws(() => repository.getStrategy(id), /persisted strategy/i);
});

test('plans one order for each valid strategy role', (t) => {
  const { repository } = setup(t);
  const id = createExecutingStrategy(repository);

  for (const role of [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'SPOT_HEDGE_GTC',
    'CONTRACT_HEDGE_GTC'
  ] satisfies OrderRole[]) {
    const planned = repository.planOrder(id, role, requestFor(id, role));
    assert.equal(planned.role, role);
    assert.equal(planned.exchangeId, role.startsWith('SPOT_') ? 'bitget' : 'okx');
    assert.equal(planned.status, 'planned');
    assert.equal(planned.snapshot, null);
    assert.equal(planned.exchangeOrderId, null);
  }
  assert.equal(repository.listOrders(id).length, 4);
});

test('rolls back every order when atomic planning fails on a later intent', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository, preflight({
    mode: 'CONCURRENT'
  }));
  database.exec(`
    CREATE TRIGGER fail_contract_plan
    BEFORE INSERT ON strategy_orders
    WHEN NEW.role = 'CONTRACT_MARKET'
    BEGIN
      SELECT RAISE(ABORT, 'second plan failed');
    END;
  `);
  let planningError: unknown;
  try {
    repository.planOrdersAtomically(strategyId, [
      {
        role: 'SPOT_MARKET',
        request: requestFor(strategyId, 'SPOT_MARKET')
      },
      {
        role: 'CONTRACT_MARKET',
        request: requestFor(strategyId, 'CONTRACT_MARKET')
      }
    ]);
  } catch (error) {
    planningError = error;
  }

  assert.ok(planningError instanceof Error);
  assert.match(planningError.message, /second plan failed/);
  assert.deepEqual(repository.listOrders(strategyId), []);
});

test('rejects duplicate roles and client IDs that do not belong to the saved role', (t) => {
  const { repository } = setup(t);
  const id = createExecutingStrategy(repository);
  repository.planOrder(id, 'SPOT_MARKET', requestFor(id, 'SPOT_MARKET'));

  assert.throws(
    () => repository.planOrder(
      id,
      'SPOT_MARKET',
      requestFor(id, 'SPOT_MARKET')
    ),
    /UNIQUE/i
  );
  assert.throws(
    () => repository.planOrder(id, 'CONTRACT_MARKET', requestFor(
      id,
      'CONTRACT_MARKET',
      { clientOrderId: makeClientOrderId(id, 'SPOT_MARKET') }
    )),
    /client order id.*role/i
  );
  assert.equal(repository.listOrders(id).length, 1);
});

test('enforces the global client-order-id unique constraint independently', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const first = repository.planOrder(
    strategyId,
    'SPOT_MARKET',
    requestFor(strategyId, 'SPOT_MARKET')
  );
  const secondRequest = requestFor(strategyId, 'SPOT_HEDGE_GTC');

  assert.throws(
    () => database.prepare(`
      INSERT INTO strategy_orders (
        id, strategy_id, role, exchange_id, client_order_id,
        request_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'second-order',
      strategyId,
      'SPOT_HEDGE_GTC',
      'bitget',
      first.clientOrderId,
      JSON.stringify(secondRequest),
      'planned',
      '2026-07-26T00:01:00.000Z',
      '2026-07-26T00:01:00.000Z'
    ),
    /UNIQUE.*client_order_id/i
  );
  assert.equal(repository.listOrders(strategyId).length, 1);
});

test('rejects cross-exchange, wrong-kind, wrong-side, and margin-mode order plans', (t) => {
  const invalidCases: Array<{
    name: string;
    preflight?: PreflightResult;
    role: OrderRole;
    overrides: Partial<OrderRequest>;
    error: RegExp;
  }> = [
    {
      name: 'spot role with swap kind',
      role: 'SPOT_MARKET',
      overrides: { kind: 'swap' },
      error: /spot.*kind/i
    },
    {
      name: 'contract role with spot kind',
      role: 'CONTRACT_MARKET',
      overrides: { kind: 'spot' },
      error: /contract.*kind/i
    },
    {
      name: 'spot sell',
      role: 'SPOT_MARKET',
      overrides: { side: 'sell' },
      error: /side/i
    },
    {
      name: 'contract buy',
      role: 'CONTRACT_MARKET',
      overrides: { side: 'buy' },
      error: /side/i
    },
    {
      name: 'swap without confirmed margin mode',
      role: 'CONTRACT_MARKET',
      overrides: { marginMode: undefined } as unknown as Partial<OrderRequest>,
      error: /margin mode/i
    },
    {
      name: 'swap with different margin mode',
      role: 'CONTRACT_MARKET',
      overrides: { marginMode: 'cross' },
      error: /margin mode/i
    },
    {
      name: 'wrong symbol',
      role: 'SPOT_MARKET',
      overrides: { symbol: 'ETH/USDT' },
      error: /symbol/i
    },
    {
      name: 'market role with limit shape',
      role: 'SPOT_MARKET',
      overrides: { type: 'limit', price: '60000', timeInForce: 'GTC' },
      error: /market role/i
    },
    {
      name: 'hedge role without GTC limit shape',
      role: 'SPOT_HEDGE_GTC',
      overrides: { type: 'market' },
      error: /hedge role/i
    }
  ];

  for (const invalidCase of invalidCases) {
    const { repository } = setup(t);
    const id = createExecutingStrategy(
      repository,
      invalidCase.preflight ?? preflight()
    );
    assert.throws(
      () => repository.planOrder(
        id,
        invalidCase.role,
        requestFor(id, invalidCase.role, invalidCase.overrides)
      ),
      invalidCase.error,
      invalidCase.name
    );
    assert.deepEqual(repository.listOrders(id), []);
  }
});

test('foreign keys and unknown identifiers fail closed', (t) => {
  const { database, repository } = setup(t);
  assert.throws(
    () => repository.getStrategy('missing-strategy'),
    /unknown strategy/i
  );
  assert.throws(
    () => repository.planOrder(
      'missing-strategy',
      'SPOT_MARKET',
      requestFor('missing-strategy', 'SPOT_MARKET')
    ),
    /unknown strategy/i
  );
  assert.throws(
    () => repository.listOrders('missing-strategy'),
    /unknown strategy/i
  );
  assert.throws(
    () => repository.attachOrderSnapshot(
      'missing-order',
      snapshotFor(
        requestFor('missing-strategy', 'SPOT_MARKET'),
        'bitget'
      )
    ),
    /unknown strategy order/i
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO strategy_orders (
        id, strategy_id, role, exchange_id, client_order_id,
        request_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'orphan-order',
      'missing-strategy',
      'SPOT_MARKET',
      'bitget',
      '0123456789abcdef0123456789abcdef',
      JSON.stringify(requestFor('missing-strategy', 'SPOT_MARKET')),
      'planned',
      '2026-07-26T00:00:00.000Z',
      '2026-07-26T00:00:00.000Z'
    ),
    /FOREIGN KEY/i
  );
});

test('keeps ordered immutable events and an atomic latest snapshot', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const orderRow = repository.planOrder(
    strategyId,
    'SPOT_MARKET',
    request
  );
  const partial = snapshotFor(request, 'bitget', {
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6',
    averagePrice: '60000'
  });
  const closed = snapshotFor(request, 'bitget', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60001',
    status: 'closed',
    updatedAt: '2026-07-26T00:02:00.000Z'
  });

  repository.attachOrderSnapshot(orderRow.id, partial);
  repository.attachOrderSnapshot(orderRow.id, closed);

  const events = repository.listOrderEvents(orderRow.id);
  assert.deepEqual(events, [partial, closed]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.equal(repository.listOrders(strategyId)[0]?.status, 'closed');
  assert.deepEqual(repository.listOrders(strategyId)[0]?.snapshot, closed);
  assert.equal(
    database.prepare(
      'SELECT COUNT(*) FROM order_events WHERE strategy_order_id = ?'
    ).pluck().get(orderRow.id),
    2
  );
  assert.throws(
    () => database.prepare(
      'UPDATE order_events SET snapshot_json = ? WHERE strategy_order_id = ?'
    ).run('{}', orderRow.id),
    /immutable/i
  );
  assert.throws(
    () => database.prepare(
      'DELETE FROM order_events WHERE strategy_order_id = ?'
    ).run(orderRow.id),
    /immutable/i
  );
});

test('rejects snapshot identity and cross-strategy pollution', (t) => {
  const identityCases: Array<{
    name: string;
    overrides: Partial<OrderSnapshot>;
    error: RegExp;
  }> = [
    {
      name: 'exchange',
      overrides: { exchangeId: 'okx' },
      error: /exchange/i
    },
    {
      name: 'client order',
      overrides: { clientOrderId: 'other-client' },
      error: /client order/i
    },
    {
      name: 'symbol',
      overrides: { symbol: 'ETH/USDT' },
      error: /symbol/i
    },
    {
      name: 'kind',
      overrides: { kind: 'swap' },
      error: /kind/i
    },
    {
      name: 'type',
      overrides: { type: 'limit' },
      error: /type/i
    },
    {
      name: 'side',
      overrides: { side: 'sell' },
      error: /side/i
    },
    {
      name: 'requested quantity',
      overrides: { requestedBaseQuantity: '2', remainingBaseQuantity: '2' },
      error: /requested.*quantity/i
    }
  ];

  for (const identityCase of identityCases) {
    const { repository } = setup(t);
    const strategyId = createExecutingStrategy(repository);
    const request = requestFor(strategyId, 'SPOT_MARKET');
    const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
    assert.throws(
      () => repository.attachOrderSnapshot(
        row.id,
        snapshotFor(request, 'bitget', identityCase.overrides)
      ),
      identityCase.error,
      identityCase.name
    );
    assert.deepEqual(repository.listOrderEvents(row.id), []);
  }

  const { repository } = setup(t);
  const firstId = createExecutingStrategy(repository);
  const secondId = createExecutingStrategy(repository);
  const firstRequest = requestFor(firstId, 'SPOT_MARKET');
  const secondRequest = requestFor(secondId, 'SPOT_MARKET');
  const firstOrder = repository.planOrder(
    firstId,
    'SPOT_MARKET',
    firstRequest
  );
  repository.planOrder(secondId, 'SPOT_MARKET', secondRequest);
  assert.throws(
    () => repository.attachOrderSnapshot(
      firstOrder.id,
      snapshotFor(secondRequest, 'bitget')
    ),
    /client order/i
  );
});

test('rejects inconsistent, non-finite, and regressing snapshot quantities', (t) => {
  const invalidInitialCases = [
    {
      filledBaseQuantity: '-0.1',
      remainingBaseQuantity: '1.1'
    },
    {
      filledBaseQuantity: 'NaN',
      remainingBaseQuantity: '1'
    },
    {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.7'
    },
    {
      filledBaseQuantity: '1.1',
      remainingBaseQuantity: '0'
    }
  ] satisfies Array<Partial<OrderSnapshot>>;

  for (const overrides of invalidInitialCases) {
    const { repository } = setup(t);
    const strategyId = createExecutingStrategy(repository);
    const request = requestFor(strategyId, 'SPOT_MARKET');
    const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
    assert.throws(
      () => repository.attachOrderSnapshot(
        row.id,
        snapshotFor(request, 'bitget', overrides)
      ),
      /snapshot quantity/i
    );
    assert.deepEqual(repository.listOrderEvents(row.id), []);
  }

  const { repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  repository.attachOrderSnapshot(row.id, snapshotFor(request, 'bitget', {
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6'
  }));
  for (const overrides of [
    {
      filledBaseQuantity: '0.3',
      remainingBaseQuantity: '0.7',
      updatedAt: '2026-07-26T00:02:00.000Z'
    },
    {
      filledBaseQuantity: '0.5',
      remainingBaseQuantity: '0.5',
      updatedAt: '2026-07-25T23:59:00.000Z'
    }
  ] satisfies Array<Partial<OrderSnapshot>>) {
    assert.throws(
      () => repository.attachOrderSnapshot(
        row.id,
        snapshotFor(request, 'bitget', overrides)
      ),
      /regress/i
    );
  }
  assert.equal(repository.listOrderEvents(row.id).length, 1);
});

test('uses exact snapshot arithmetic independently of global Decimal precision', async (t) => {
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

  for (const precision of [20, 40]) {
    await t.test(`global precision ${precision}`, (child) => {
      Decimal.set({ precision, rounding: Decimal.ROUND_DOWN });
      const { database, repository } = setup(child);
      const strategyId = createExecutingStrategy(repository);
      const request = requestFor(strategyId, 'SPOT_MARKET');
      const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);

      assert.throws(
        () => repository.attachOrderSnapshot(
          row.id,
          snapshotFor(request, 'bitget', {
            filledBaseQuantity:
              '0.99999999999999999999999999999999999999999',
            remainingBaseQuantity:
              '0.00000000000000000000000000000000000000002'
          })
        ),
        /snapshot quantity/i
      );
      assert.equal(
        database.prepare(
          'SELECT COUNT(*) FROM order_events WHERE strategy_order_id = ?'
        ).pluck().get(row.id),
        0
      );
      assert.equal(repository.listOrders(strategyId)[0]?.status, 'planned');
      assert.equal(repository.listOrders(strategyId)[0]?.snapshot, null);

      repository.attachOrderSnapshot(
        row.id,
        snapshotFor(request, 'bitget', {
          filledBaseQuantity:
            '0.99999999999999999999999999999999999999999',
          remainingBaseQuantity:
            '0.00000000000000000000000000000000000000001'
        })
      );
      assert.equal(repository.listOrderEvents(row.id).length, 1);
    });
  }
});

test('accepts an extreme supported quantity when either sum operand is zero', async (t) => {
  const quantity = '2e-9000000000000000';
  for (const testCase of [
    {
      name: 'zero remaining after a full fill',
      filledBaseQuantity: quantity,
      remainingBaseQuantity: '0',
      averagePrice: '60000',
      status: 'closed'
    },
    {
      name: 'zero fill with the full quantity remaining',
      filledBaseQuantity: '0',
      remainingBaseQuantity: quantity,
      averagePrice: null,
      status: 'open'
    }
  ] as const) {
    await t.test(testCase.name, (child) => {
      const { repository } = setup(child);
      const strategyId = createExecutingStrategy(repository, preflight({
        requestedBaseQuantity: quantity,
        effectiveBaseQuantity: quantity
      }));
      const request = requestFor(strategyId, 'SPOT_MARKET', {
        baseQuantity: quantity
      });
      const row = repository.planOrder(
        strategyId,
        'SPOT_MARKET',
        request
      );

      assert.equal(repository.attachOrderSnapshot(
        row.id,
        snapshotFor(request, 'bitget', {
          filledBaseQuantity: testCase.filledBaseQuantity,
          remainingBaseQuantity: testCase.remainingBaseQuantity,
          averagePrice: testCase.averagePrice,
          status: testCase.status
        })
      ), 'attached');
      assert.deepEqual(
        repository.listOrders(strategyId)[0]?.snapshot,
        snapshotFor(request, 'bitget', {
          filledBaseQuantity: testCase.filledBaseQuantity,
          remainingBaseQuantity: testCase.remainingBaseQuantity,
          averagePrice: testCase.averagePrice,
          status: testCase.status
        })
      );
      assert.equal(repository.listOrderEvents(row.id).length, 1);
    });
  }
});

test('does not let ambient Decimal exponent settings underflow snapshot quantities', (t) => {
  const originalMinE = Decimal.minE;
  t.after(() => Decimal.set({ minE: originalMinE }));
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  Decimal.set({ minE: -2 });

  assert.equal(repository.getStrategy(strategyId).id, strategyId);
  assert.throws(
    () => repository.attachOrderSnapshot(
      row.id,
      snapshotFor(request, 'bitget', {
        filledBaseQuantity: '1',
        remainingBaseQuantity: '.001'
      })
    ),
    /snapshot quantity/i
  );
  assert.equal(
    database.prepare(
      'SELECT COUNT(*) FROM order_events WHERE strategy_order_id = ?'
    ).pluck().get(row.id),
    0
  );
  assert.equal(repository.listOrders(strategyId)[0]?.status, 'planned');
  assert.equal(repository.listOrders(strategyId)[0]?.snapshot, null);

  repository.attachOrderSnapshot(
    row.id,
    snapshotFor(request, 'bitget', {
      filledBaseQuantity:
        '0.99999999999999999999999999999999999999999',
      remainingBaseQuantity:
        '0.00000000000000000000000000000000000000001'
    })
  );
  assert.equal(repository.listOrderEvents(row.id).length, 1);
});

test('rejects nonzero decimals beyond the private exponent range', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);

  assert.throws(
    () => repository.attachOrderSnapshot(
      row.id,
      snapshotFor(request, 'bitget', {
        filledBaseQuantity: '1',
        remainingBaseQuantity: '1e-9000000000000001'
      })
    ),
    /snapshot quantity/i
  );
  assert.equal(
    database.prepare(
      'SELECT COUNT(*) FROM order_events WHERE strategy_order_id = ?'
    ).pluck().get(row.id),
    0
  );
  assert.equal(repository.listOrders(strategyId)[0]?.status, 'planned');
  assert.equal(repository.listOrders(strategyId)[0]?.snapshot, null);
});

test('rejects exchange-order identity changes and terminal status regression', (t) => {
  const { repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  repository.attachOrderSnapshot(row.id, snapshotFor(request, 'bitget', {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    averagePrice: '60000',
    status: 'closed'
  }));

  assert.throws(
    () => repository.attachOrderSnapshot(
      row.id,
      snapshotFor(request, 'bitget', {
        exchangeOrderId: 'different-exchange-order',
        filledBaseQuantity: '1',
        remainingBaseQuantity: '0',
        averagePrice: '60000',
        status: 'closed',
        updatedAt: '2026-07-26T00:02:00.000Z'
      })
    ),
    /exchange order id changed/i
  );
  assert.throws(
    () => repository.attachOrderSnapshot(
      row.id,
      snapshotFor(request, 'bitget', {
        filledBaseQuantity: '1',
        remainingBaseQuantity: '0',
        averagePrice: '60000',
        status: 'open',
        updatedAt: '2026-07-26T00:02:00.000Z'
      })
    ),
    /status.*regress/i
  );
  assert.equal(repository.listOrderEvents(row.id).length, 1);
});

test('does not report fills without a snapshot and rejects corrupted order rows', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  assert.equal(repository.listOrders(strategyId)[0]?.status, 'planned');
  assert.equal(repository.listOrders(strategyId)[0]?.snapshot, null);

  database.pragma('ignore_check_constraints = ON');
  database.prepare(`
    UPDATE strategy_orders
    SET status = 'closed', snapshot_json = NULL
    WHERE id = ?
  `).run(row.id);
  database.pragma('ignore_check_constraints = OFF');
  assert.throws(
    () => repository.listOrders(strategyId),
    /persisted strategy order/i
  );
});

test('rolls back the event when the latest-snapshot update fails', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  database.exec(`
    CREATE TRIGGER force_snapshot_update_failure
    BEFORE UPDATE ON strategy_orders
    BEGIN
      SELECT RAISE(ABORT, 'forced snapshot update failure');
    END;
  `);

  assert.throws(
    () => repository.attachOrderSnapshot(
      row.id,
      snapshotFor(request, 'bitget')
    ),
    /forced snapshot update failure/
  );
  assert.equal(
    database.prepare(
      'SELECT COUNT(*) FROM order_events WHERE strategy_order_id = ?'
    ).pluck().get(row.id),
    0
  );
  assert.equal(repository.listOrders(strategyId)[0]?.status, 'planned');
  assert.equal(repository.listOrders(strategyId)[0]?.snapshot, null);
});

test('fails safely on corrupted request, snapshot, or event JSON', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);

  database.prepare(
    'UPDATE strategy_orders SET request_json = ? WHERE id = ?'
  ).run('{"kind":"spot"}', row.id);
  assert.throws(
    () => repository.listOrders(strategyId),
    /persisted strategy order/i
  );

  database.prepare(
    'UPDATE strategy_orders SET request_json = ? WHERE id = ?'
  ).run(JSON.stringify(request), row.id);
  database.prepare(`
    INSERT INTO order_events (strategy_order_id, snapshot_json, recorded_at)
    VALUES (?, ?, ?)
  `).run(row.id, '{"status":"closed"}', '2026-07-26T00:03:00.000Z');
  assert.throws(
    () => repository.listOrderEvents(row.id),
    /persisted order event/i
  );
});

test('validates every persisted enum allowlist instead of trusting TypeScript', (t) => {
  const { database, repository } = setup(t);
  const strategyId = createExecutingStrategy(repository);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const row = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  database.pragma('ignore_check_constraints = ON');
  database.prepare(
    'UPDATE strategy_orders SET role = ?, status = ? WHERE id = ?'
  ).run('UNKNOWN_ROLE', 'FILLED', row.id);
  database.pragma('ignore_check_constraints = OFF');

  assert.throws(
    () => repository.listOrders(strategyId),
    /persisted strategy order/i
  );
});

test('rejects invalid runtime enum values before they reach SQL', (t) => {
  const { repository } = setup(t);
  assert.throws(
    () => repository.createPending(preflight({
      mode: 'UNSAFE_MODE' as ExecutionMode
    })),
    /execution mode/i
  );
  const id = createExecutingStrategy(repository);
  assert.throws(
    () => repository.planOrder(
      id,
      'UNKNOWN_ROLE' as OrderRole,
      requestFor(id, 'SPOT_MARKET')
    ),
    /order role/i
  );
  assert.throws(
    () => repository.planOrder(
      id,
      'SPOT_MARKET',
      requestFor(id, 'SPOT_MARKET', {
        kind: 'future' as MarketKind
      })
    ),
    /market kind/i
  );
});
