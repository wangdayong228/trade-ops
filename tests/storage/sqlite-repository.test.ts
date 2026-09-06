/// <reference types="node" />

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { PreflightResult } from '../../src/strategy/preflight-service.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import {
  OrderSnapshotValidationError,
  OrderSnapshotWriteConflictError
} from '../../src/storage/strategy-repository.js';

const SYMBOL = 'BTC/USDT';

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

test('creates a fresh file database in WAL before installing v2 schema', (t) => {
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
  `).all(), [{ singleton: 1, version: 2 }]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

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
    repository.markDefinitelyNotSubmitted(order.id, 'ORDER_SUBMISSION_FAILED'),
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
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  schema: 'fresh v2' | 'migrated v1'
) {
  if (schema === 'fresh v2') {
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

for (const schema of ['fresh v2', 'migrated v1'] as const) {
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

  assert.throws(
    () => new SqliteStrategyRepository(database),
    /^Error: SQLite strategy schema migration failed$/
  );

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
    assert.throws(
      () => new SqliteStrategyRepository(database),
      /^Error: SQLite strategy schema migration failed$/
    );
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

test('constructs a v2 repository twice without changing migrated data', (t) => {
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
  `).all(), [{ singleton: 1, version: 2 }]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const failurePoint of ['early malformed copy', 'late index install'] as const) {
  test(`rolls back the whole v1 migration after ${failurePoint}`, (t) => {
    const database = legacyDatabase(t);
    seedLegacyExecutingStrategy(database, 'legacy-strategy');
    seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
    seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');
    if (failurePoint === 'early malformed copy') {
      makeMalformedLegacyStrategies(database);
    } else {
      database.exec(`
        DROP INDEX strategies_recoverable_idx;
        CREATE TABLE strategies_recoverable_idx (blocker TEXT NOT NULL);
      `);
    }
    const before = legacyFingerprint(database);

    assert.throws(
      () => new SqliteStrategyRepository(database),
      /SQLite strategy schema migration failed/
    );

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
  const id = repository.createPending(preflight()).id;

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
  const strategyId = repository.createPending(preflight({
    mode: 'CONCURRENT'
  })).id;
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
  const id = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
    const id = repository.createPending(invalidCase.preflight ?? preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
    const strategyId = repository.createPending(preflight()).id;
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
  const firstId = repository.createPending(preflight()).id;
  const secondId = repository.createPending(preflight()).id;
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
    const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
      const strategyId = repository.createPending(preflight()).id;
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

test('does not let ambient Decimal exponent settings underflow snapshot quantities', (t) => {
  const originalMinE = Decimal.minE;
  t.after(() => Decimal.set({ minE: originalMinE }));
  const { database, repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  const strategyId = repository.createPending(preflight()).id;
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
  const id = repository.createPending(preflight()).id;
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
