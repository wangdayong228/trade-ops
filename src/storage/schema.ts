export const SQLITE_STRATEGY_ORDERS_TABLE = `
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

export const SQLITE_MIGRATED_STRATEGY_ORDERS_TABLE = `
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

export const SQLITE_STRATEGY_SCHEMA = `
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

  ${SQLITE_STRATEGY_ORDERS_TABLE}

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

  CREATE TABLE IF NOT EXISTS strategy_schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 2)
  );
  INSERT OR IGNORE INTO strategy_schema_metadata (singleton, version)
  VALUES (1, 2);
`;
