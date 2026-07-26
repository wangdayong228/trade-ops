export const SQLITE_STRATEGY_SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS strategies (
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
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strategy_orders (
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

  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_order_id TEXT NOT NULL REFERENCES strategy_orders(id),
    snapshot_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS strategies_recoverable_idx
    ON strategies(state, created_at);
  CREATE INDEX IF NOT EXISTS strategy_orders_strategy_idx
    ON strategy_orders(strategy_id, created_at);
  CREATE INDEX IF NOT EXISTS order_events_order_idx
    ON order_events(strategy_order_id, id);

  CREATE TRIGGER IF NOT EXISTS order_events_no_update
  BEFORE UPDATE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS order_events_no_delete
  BEFORE DELETE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;
`;
