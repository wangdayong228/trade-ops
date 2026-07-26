import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../domain/client-order-id.js';
import type {
  AccountSettings,
  ExecutionMode,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderRole,
  OrderSide,
  OrderSnapshot,
  OrderType,
  StrategyState
} from '../domain/types.js';
import type { PreflightResult } from '../strategy/preflight-service.js';
import { SQLITE_STRATEGY_SCHEMA } from './schema.js';
import type {
  StrategyOrderRecord,
  StrategyOrderStatus,
  StrategyRecord,
  StrategyRepository
} from './strategy-repository.js';

const EXECUTION_MODES = new Set<ExecutionMode>([
  'CONCURRENT',
  'CONTRACT_FIRST',
  'SPOT_FIRST'
]);
const STRATEGY_STATES = new Set<StrategyState>([
  'PENDING_CONFIRMATION',
  'EXECUTING',
  'WAITING_HEDGE',
  'HEDGED',
  'HEDGE_INCOMPLETE',
  'FAILED'
]);
const ORDER_ROLES = new Set<OrderRole>([
  'SPOT_MARKET',
  'CONTRACT_MARKET',
  'SPOT_HEDGE_GTC',
  'CONTRACT_HEDGE_GTC'
]);
const MARKET_KINDS = new Set<MarketKind>(['spot', 'swap']);
const ORDER_TYPES = new Set<OrderType>(['market', 'limit']);
const ORDER_SIDES = new Set<OrderSide>(['buy', 'sell']);
const SNAPSHOT_STATUSES = new Set<OrderSnapshot['status']>([
  'open',
  'closed',
  'canceled',
  'rejected',
  'unknown'
]);
const ORDER_STATUSES = new Set<StrategyOrderStatus>([
  'planned',
  ...SNAPSHOT_STATUSES
]);
type ConfirmedMarginMode = Exclude<AccountSettings['marginMode'], 'unknown'>;
const MARGIN_MODES = new Set<ConfirmedMarginMode>([
  'isolated',
  'cross'
]);
const POSITION_MODES = new Set<AccountSettings['positionMode']>([
  'one-way',
  'hedged'
]);

const ALLOWED_TRANSITIONS: Readonly<Record<
  StrategyState,
  ReadonlySet<StrategyState>
>> = {
  PENDING_CONFIRMATION: new Set(['EXECUTING']),
  EXECUTING: new Set([
    'WAITING_HEDGE',
    'HEDGED',
    'HEDGE_INCOMPLETE',
    'FAILED'
  ]),
  WAITING_HEDGE: new Set(['HEDGED', 'HEDGE_INCOMPLETE']),
  HEDGED: new Set(),
  HEDGE_INCOMPLETE: new Set(),
  FAILED: new Set()
};

const STATUS_TRANSITIONS: Readonly<Record<
  StrategyOrderStatus,
  ReadonlySet<OrderSnapshot['status']>
>> = {
  planned: SNAPSHOT_STATUSES,
  unknown: new Set(['unknown', 'open', 'closed', 'canceled', 'rejected']),
  open: new Set(['open', 'closed', 'canceled', 'rejected']),
  closed: new Set(['closed']),
  canceled: new Set(['canceled']),
  rejected: new Set(['rejected'])
};

const PREFLIGHT_KEYS = new Set([
  'spotExchangeId',
  'contractExchangeId',
  'symbol',
  'requestedBaseQuantity',
  'mode',
  'effectiveBaseQuantity',
  'spotMarket',
  'contractMarket',
  'accountSettings',
  'spotFreeUsdt',
  'contractFreeUsdt',
  'spotReferencePrice',
  'contractReferencePrice',
  'riskAcknowledgementRequired',
  'createdAt'
]);
const MARKET_REQUIRED_KEYS = new Set([
  'exchangeId',
  'symbol',
  'marketId',
  'kind',
  'base',
  'quote',
  'active',
  'amountStep',
  'contractSize',
  'minBaseAmount',
  'priceStep'
]);
const MARKET_OPTIONAL_KEYS = new Set([
  'maxBaseAmount',
  'minQuoteNotional',
  'maxQuoteNotional'
]);
const ACCOUNT_KEYS = new Set([
  'marginMode',
  'positionMode',
  'leverage'
]);
const REQUEST_REQUIRED_KEYS = new Set([
  'symbol',
  'kind',
  'type',
  'side',
  'baseQuantity',
  'clientOrderId'
]);
const REQUEST_OPTIONAL_KEYS = new Set([
  'price',
  'timeInForce',
  'positionSide',
  'marginMode'
]);
const SNAPSHOT_KEYS = new Set([
  'exchangeId',
  'exchangeOrderId',
  'clientOrderId',
  'symbol',
  'kind',
  'type',
  'side',
  'requestedBaseQuantity',
  'filledBaseQuantity',
  'remainingBaseQuantity',
  'averagePrice',
  'status',
  'updatedAt'
]);

interface StrategyDbRow {
  id: unknown;
  state: unknown;
  mode: unknown;
  spot_exchange_id: unknown;
  contract_exchange_id: unknown;
  symbol: unknown;
  requested_base_quantity: unknown;
  effective_base_quantity: unknown;
  preflight_json: unknown;
  last_error: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface StrategyOrderDbRow {
  id: unknown;
  strategy_id: unknown;
  role: unknown;
  exchange_id: unknown;
  client_order_id: unknown;
  exchange_order_id: unknown;
  request_json: unknown;
  snapshot_json: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface OrderEventDbRow {
  id: unknown;
  snapshot_json: unknown;
  recorded_at: unknown;
}

interface LatestEventDbRow {
  event_count: unknown;
  latest_snapshot_json: unknown;
}

type DataObject = Record<string, unknown>;

function invalid(context: string, detail: string): never {
  throw new Error(`invalid ${context}: ${detail}`);
}

function dataObject(
  value: unknown,
  context: string,
  requiredKeys: ReadonlySet<string>,
  optionalKeys: ReadonlySet<string> = new Set()
): DataObject {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(context, 'must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    return invalid(context, 'contains unsupported keys');
  }
  for (const key of ownKeys as string[]) {
    if (!requiredKeys.has(key) && !optionalKeys.has(key)) {
      return invalid(context, 'contains unsupported fields');
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return invalid(context, 'contains accessors');
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      return invalid(context, 'is missing required fields');
    }
  }
  const result: DataObject = {};
  for (const key of ownKeys as string[]) {
    result[key] = descriptors[key]?.value;
  }
  return result;
}

function nonEmptyString(
  value: unknown,
  context: string,
  maximumLength = 1_024
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || value.length > maximumLength
  ) {
    return invalid(context, 'must be a non-empty bounded string');
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  context: string
): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    return invalid(context, 'contains an unsupported value');
  }
  return value as T;
}

function isoTimestamp(value: unknown, context: string): string {
  const timestamp = nonEmptyString(value, context, 64);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      return invalid(context, 'must be a canonical ISO timestamp');
    }
  } catch {
    return invalid(context, 'must be a canonical ISO timestamp');
  }
  return timestamp;
}

function decimalValue(
  value: unknown,
  context: string,
  allowZero: boolean
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 10_000) {
    return invalid(context, 'must be a bounded decimal string');
  }
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    return invalid(context, 'must be a decimal string');
  }
  if (
    !parsed.isFinite()
    || parsed.isNegative()
    || (!allowZero && parsed.isZero())
  ) {
    return invalid(context, allowZero
      ? 'must be finite and non-negative'
      : 'must be finite and greater than zero');
  }
  return value;
}

function decimalEqual(left: string, right: string): boolean {
  return new Decimal(left).eq(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function parseJson(json: unknown, context: string): unknown {
  if (typeof json !== 'string') {
    return invalid(context, 'JSON storage is not text');
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return invalid(context, 'JSON is malformed');
  }
}

function publicMarketSnapshot(
  value: unknown,
  expected: {
    exchangeId: string;
    symbol: string;
    kind: MarketKind;
    base: string;
  },
  context: string
): MarketRules {
  const object = dataObject(
    value,
    context,
    MARKET_REQUIRED_KEYS,
    MARKET_OPTIONAL_KEYS
  );
  const exchangeId = nonEmptyString(
    object.exchangeId,
    `${context} exchange id`,
    128
  );
  const symbol = nonEmptyString(object.symbol, `${context} symbol`, 256);
  const marketId = nonEmptyString(object.marketId, `${context} market id`, 256);
  const kind = enumValue(object.kind, MARKET_KINDS, `${context} market kind`);
  const base = nonEmptyString(object.base, `${context} base asset`, 64);
  if (object.quote !== 'USDT') {
    return invalid(context, 'quote must be USDT');
  }
  if (object.active !== true) {
    return invalid(context, 'market must be active');
  }
  if (
    exchangeId !== expected.exchangeId
    || symbol !== expected.symbol
    || kind !== expected.kind
    || base !== expected.base
  ) {
    return invalid(context, 'identity does not match preflight');
  }
  const amountStep = decimalValue(
    object.amountStep,
    `${context} amount step`,
    false
  );
  const contractSize = decimalValue(
    object.contractSize,
    `${context} contract size`,
    false
  );
  const minBaseAmount = decimalValue(
    object.minBaseAmount,
    `${context} minimum base amount`,
    true
  );
  const priceStep = decimalValue(
    object.priceStep,
    `${context} price step`,
    false
  );
  const result: MarketRules = {
    exchangeId,
    symbol,
    marketId,
    kind,
    base,
    quote: 'USDT',
    active: true,
    amountStep,
    contractSize,
    minBaseAmount,
    priceStep
  };
  for (const [key, allowZero] of [
    ['maxBaseAmount', false],
    ['minQuoteNotional', true],
    ['maxQuoteNotional', false]
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      result[key] = decimalValue(
        object[key],
        `${context} ${key}`,
        allowZero
      );
    }
  }
  if (
    result.maxBaseAmount !== undefined
    && new Decimal(result.minBaseAmount).gt(result.maxBaseAmount)
  ) {
    return invalid(context, 'minimum base amount exceeds maximum');
  }
  if (
    result.minQuoteNotional !== undefined
    && result.maxQuoteNotional !== undefined
    && new Decimal(result.minQuoteNotional).gt(result.maxQuoteNotional)
  ) {
    return invalid(context, 'minimum quote notional exceeds maximum');
  }
  return result;
}

function publicAccountSettings(
  value: unknown,
  context: string
): AccountSettings {
  const object = dataObject(value, context, ACCOUNT_KEYS);
  return {
    marginMode: enumValue(
      object.marginMode,
      MARGIN_MODES,
      `${context} margin mode`
    ),
    positionMode: enumValue(
      object.positionMode,
      POSITION_MODES,
      `${context} position mode`
    ),
    leverage: decimalValue(
      object.leverage,
      `${context} leverage`,
      false
    )
  };
}

function publicPreflightSnapshot(value: unknown): PreflightResult {
  const context = 'preflight snapshot';
  const object = dataObject(value, context, PREFLIGHT_KEYS);
  const spotExchangeId = nonEmptyString(
    object.spotExchangeId,
    `${context} spot exchange id`,
    128
  );
  const contractExchangeId = nonEmptyString(
    object.contractExchangeId,
    `${context} contract exchange id`,
    128
  );
  if (spotExchangeId === contractExchangeId) {
    return invalid(context, 'spot and contract exchanges must differ');
  }
  const symbol = nonEmptyString(object.symbol, `${context} symbol`, 256);
  const symbolParts = symbol.split('/');
  if (
    symbolParts.length !== 2
    || symbolParts[0] === undefined
    || symbolParts[0].length === 0
    || symbolParts[1] !== 'USDT'
  ) {
    return invalid(context, 'symbol must be a BASE/USDT pair');
  }
  const mode = enumValue(
    object.mode,
    EXECUTION_MODES,
    `${context} execution mode`
  );
  const requestedBaseQuantity = decimalValue(
    object.requestedBaseQuantity,
    `${context} requested base quantity`,
    false
  );
  const effectiveBaseQuantity = decimalValue(
    object.effectiveBaseQuantity,
    `${context} effective base quantity`,
    false
  );
  if (new Decimal(effectiveBaseQuantity).gt(requestedBaseQuantity)) {
    return invalid(context, 'effective quantity exceeds requested quantity');
  }
  const spotMarket = publicMarketSnapshot(object.spotMarket, {
    exchangeId: spotExchangeId,
    symbol,
    kind: 'spot',
    base: symbolParts[0]
  }, `${context} spot market`);
  const contractMarket = publicMarketSnapshot(object.contractMarket, {
    exchangeId: contractExchangeId,
    symbol,
    kind: 'swap',
    base: symbolParts[0]
  }, `${context} contract market`);
  const accountSettings = publicAccountSettings(
    object.accountSettings,
    `${context} account settings`
  );
  if (object.riskAcknowledgementRequired !== true) {
    return invalid(context, 'risk acknowledgement must be required');
  }
  return {
    spotExchangeId,
    contractExchangeId,
    symbol,
    requestedBaseQuantity,
    mode,
    effectiveBaseQuantity,
    spotMarket,
    contractMarket,
    accountSettings,
    spotFreeUsdt: decimalValue(
      object.spotFreeUsdt,
      `${context} spot balance`,
      false
    ),
    contractFreeUsdt: decimalValue(
      object.contractFreeUsdt,
      `${context} contract balance`,
      false
    ),
    spotReferencePrice: decimalValue(
      object.spotReferencePrice,
      `${context} spot reference price`,
      false
    ),
    contractReferencePrice: decimalValue(
      object.contractReferencePrice,
      `${context} contract reference price`,
      false
    ),
    riskAcknowledgementRequired: true,
    createdAt: isoTimestamp(object.createdAt, `${context} creation time`)
  };
}

function publicOrderRequest(value: unknown, context: string): OrderRequest {
  const object = dataObject(
    value,
    context,
    REQUEST_REQUIRED_KEYS,
    REQUEST_OPTIONAL_KEYS
  );
  const request: OrderRequest = {
    symbol: nonEmptyString(object.symbol, `${context} symbol`, 256),
    kind: enumValue(object.kind, MARKET_KINDS, `${context} market kind`),
    type: enumValue(object.type, ORDER_TYPES, `${context} order type`),
    side: enumValue(object.side, ORDER_SIDES, `${context} order side`),
    baseQuantity: decimalValue(
      object.baseQuantity,
      `${context} base quantity`,
      false
    ),
    clientOrderId: nonEmptyString(
      object.clientOrderId,
      `${context} client order id`,
      128
    )
  };
  if (Object.prototype.hasOwnProperty.call(object, 'price')) {
    request.price = decimalValue(object.price, `${context} price`, false);
  }
  if (Object.prototype.hasOwnProperty.call(object, 'timeInForce')) {
    if (object.timeInForce !== 'GTC') {
      return invalid(context, 'contains unsupported time in force');
    }
    request.timeInForce = 'GTC';
  }
  if (Object.prototype.hasOwnProperty.call(object, 'positionSide')) {
    if (object.positionSide !== 'SHORT') {
      return invalid(context, 'contains unsupported position side');
    }
    request.positionSide = 'SHORT';
  }
  if (Object.prototype.hasOwnProperty.call(object, 'marginMode')) {
    request.marginMode = enumValue(
      object.marginMode,
      MARGIN_MODES,
      `${context} margin mode`
    );
  }
  return request;
}

function expectedLeg(
  strategy: StrategyRecord,
  role: OrderRole
): {
  exchangeId: string;
  kind: MarketKind;
  side: OrderSide;
  type: OrderType;
} {
  switch (role) {
    case 'SPOT_MARKET':
      return {
        exchangeId: strategy.spotExchangeId,
        kind: 'spot',
        side: 'buy',
        type: 'market'
      };
    case 'CONTRACT_MARKET':
      return {
        exchangeId: strategy.contractExchangeId,
        kind: 'swap',
        side: 'sell',
        type: 'market'
      };
    case 'SPOT_HEDGE_GTC':
      return {
        exchangeId: strategy.spotExchangeId,
        kind: 'spot',
        side: 'buy',
        type: 'limit'
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        exchangeId: strategy.contractExchangeId,
        kind: 'swap',
        side: 'sell',
        type: 'limit'
      };
  }
}

function validatedRequestForRole(
  strategy: StrategyRecord,
  roleValue: unknown,
  value: unknown,
  persisted: boolean
): {
  role: OrderRole;
  exchangeId: string;
  request: OrderRequest;
} {
  const prefix = persisted ? 'persisted strategy order' : 'order plan';
  const role = enumValue(roleValue, ORDER_ROLES, `${prefix} order role`);
  const request = publicOrderRequest(value, `${prefix} request`);
  const expected = expectedLeg(strategy, role);
  if (request.symbol !== strategy.symbol) {
    return invalid(prefix, 'request symbol does not match strategy');
  }
  if (request.kind !== expected.kind) {
    return invalid(
      prefix,
      role.startsWith('SPOT_')
        ? 'spot role requires spot market kind'
        : 'contract role requires swap market kind'
    );
  }
  if (request.side !== expected.side) {
    return invalid(prefix, 'request side does not match order role');
  }
  if (request.type !== expected.type) {
    return invalid(
      prefix,
      role.endsWith('_MARKET')
        ? 'market role requires a market request'
        : 'hedge role requires a limit request'
    );
  }
  const isHedge = role.endsWith('_HEDGE_GTC');
  if (
    isHedge
    && (request.timeInForce !== 'GTC' || request.price === undefined)
  ) {
    return invalid(prefix, 'hedge role requires a priced GTC limit request');
  }
  if (
    !isHedge
    && (
      request.timeInForce !== undefined
      || request.price !== undefined
    )
  ) {
    return invalid(prefix, 'market role cannot contain limit fields');
  }
  const isContract = role.startsWith('CONTRACT_');
  if (
    isContract
    && (
      request.positionSide !== 'SHORT'
      || request.marginMode !== strategy.preflight.accountSettings.marginMode
    )
  ) {
    return invalid(
      prefix,
      'contract request requires SHORT and the confirmed margin mode'
    );
  }
  if (
    !isContract
    && (
      request.positionSide !== undefined
      || request.marginMode !== undefined
    )
  ) {
    return invalid(prefix, 'spot request cannot contain contract fields');
  }
  if (new Decimal(request.baseQuantity).gt(strategy.effectiveBaseQuantity)) {
    return invalid(prefix, 'request quantity exceeds strategy quantity');
  }
  if (request.clientOrderId !== makeClientOrderId(strategy.id, role)) {
    return invalid(prefix, 'client order id does not match saved role');
  }
  return { role, exchangeId: expected.exchangeId, request };
}

function publicOrderSnapshot(
  value: unknown,
  context: string
): OrderSnapshot {
  const object = dataObject(value, context, SNAPSHOT_KEYS);
  const averagePrice = object.averagePrice === null
    ? null
    : decimalValue(object.averagePrice, `${context} average price`, false);
  return {
    exchangeId: nonEmptyString(
      object.exchangeId,
      `${context} exchange id`,
      128
    ),
    exchangeOrderId: nonEmptyString(
      object.exchangeOrderId,
      `${context} exchange order id`,
      256
    ),
    clientOrderId: nonEmptyString(
      object.clientOrderId,
      `${context} client order id`,
      128
    ),
    symbol: nonEmptyString(object.symbol, `${context} symbol`, 256),
    kind: enumValue(object.kind, MARKET_KINDS, `${context} market kind`),
    type: enumValue(object.type, ORDER_TYPES, `${context} order type`),
    side: enumValue(object.side, ORDER_SIDES, `${context} order side`),
    requestedBaseQuantity: decimalValue(
      object.requestedBaseQuantity,
      `${context} requested quantity`,
      false
    ),
    filledBaseQuantity: decimalValue(
      object.filledBaseQuantity,
      `${context} snapshot quantity`,
      true
    ),
    remainingBaseQuantity: decimalValue(
      object.remainingBaseQuantity,
      `${context} snapshot quantity`,
      true
    ),
    averagePrice,
    status: enumValue(
      object.status,
      SNAPSHOT_STATUSES,
      `${context} order status`
    ),
    updatedAt: isoTimestamp(object.updatedAt, `${context} update time`)
  };
}

function validatedSnapshot(
  value: unknown,
  order: StrategyOrderRecord,
  previous: OrderSnapshot | null,
  context: string
): OrderSnapshot {
  const snapshot = publicOrderSnapshot(value, context);
  if (snapshot.exchangeId !== order.exchangeId) {
    return invalid(context, 'exchange does not match planned order');
  }
  if (snapshot.clientOrderId !== order.clientOrderId) {
    return invalid(context, 'client order id does not match planned order');
  }
  if (
    snapshot.symbol !== order.request.symbol
    || snapshot.kind !== order.request.kind
    || snapshot.type !== order.request.type
    || snapshot.side !== order.request.side
  ) {
    const differingField = (
      snapshot.symbol !== order.request.symbol
        ? 'symbol'
        : snapshot.kind !== order.request.kind
          ? 'kind'
          : snapshot.type !== order.request.type
            ? 'type'
            : 'side'
    );
    return invalid(context, `${differingField} does not match planned request`);
  }
  if (
    !decimalEqual(
      snapshot.requestedBaseQuantity,
      order.request.baseQuantity
    )
  ) {
    return invalid(context, 'requested quantity does not match planned request');
  }
  const requested = new Decimal(snapshot.requestedBaseQuantity);
  const filled = new Decimal(snapshot.filledBaseQuantity);
  const remaining = new Decimal(snapshot.remainingBaseQuantity);
  if (
    filled.gt(requested)
    || remaining.gt(requested)
    || !filled.plus(remaining).eq(requested)
  ) {
    return invalid(context, 'snapshot quantity totals are inconsistent');
  }
  if (!STATUS_TRANSITIONS[order.status].has(snapshot.status)) {
    return invalid(context, 'order status would regress');
  }
  if (previous !== null) {
    if (snapshot.exchangeOrderId !== previous.exchangeOrderId) {
      return invalid(context, 'exchange order id changed');
    }
    if (
      filled.lt(previous.filledBaseQuantity)
      || remaining.gt(previous.remainingBaseQuantity)
      || new Date(snapshot.updatedAt).getTime()
        < new Date(previous.updatedAt).getTime()
    ) {
      return invalid(context, 'snapshot quantities or time regress');
    }
  }
  return snapshot;
}

function safely<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`invalid ${context}:`)) {
      throw error;
    }
    throw new Error(`invalid ${context}: stored values failed validation`);
  }
}

export class SqliteStrategyRepository implements StrategyRepository {
  private readonly insertStrategy;
  private readonly selectStrategy;
  private readonly claimStrategy;
  private readonly selectRecoverable;
  private readonly insertOrder;
  private readonly selectOrder;
  private readonly selectOrders;
  private readonly selectLatestEvent;
  private readonly insertEvent;
  private readonly updateOrderSnapshot;
  private readonly selectEvents;
  private readonly planOrderTransaction;
  private readonly attachSnapshotTransaction;

  constructor(private readonly database: Database.Database) {
    this.database.exec(SQLITE_STRATEGY_SCHEMA);
    this.insertStrategy = this.database.prepare(`
      INSERT INTO strategies (
        id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
        requested_base_quantity, effective_base_quantity, preflight_json,
        last_error, created_at, updated_at
      ) VALUES (
        @id, @state, @mode, @spotExchangeId, @contractExchangeId, @symbol,
        @requestedBaseQuantity, @effectiveBaseQuantity, @preflightJson,
        NULL, @createdAt, @updatedAt
      )
    `);
    this.selectStrategy = this.database.prepare(
      'SELECT * FROM strategies WHERE id = ?'
    );
    this.claimStrategy = this.database.prepare(`
      UPDATE strategies
      SET state = 'EXECUTING', last_error = NULL, updated_at = @updatedAt
      WHERE id = @id AND state = 'PENDING_CONFIRMATION'
    `);
    this.selectRecoverable = this.database.prepare(`
      SELECT *
      FROM strategies
      WHERE state IN ('EXECUTING', 'WAITING_HEDGE')
      ORDER BY created_at, id
    `);
    this.insertOrder = this.database.prepare(`
      INSERT INTO strategy_orders (
        id, strategy_id, role, exchange_id, client_order_id,
        exchange_order_id, request_json, snapshot_json, status,
        created_at, updated_at
      ) VALUES (
        @id, @strategyId, @role, @exchangeId, @clientOrderId,
        NULL, @requestJson, NULL, 'planned', @createdAt, @updatedAt
      )
    `);
    this.selectOrder = this.database.prepare(
      'SELECT * FROM strategy_orders WHERE id = ?'
    );
    this.selectOrders = this.database.prepare(`
      SELECT *
      FROM strategy_orders
      WHERE strategy_id = ?
      ORDER BY created_at, rowid
    `);
    this.selectLatestEvent = this.database.prepare(`
      SELECT
        COUNT(*) AS event_count,
        (
          SELECT snapshot_json
          FROM order_events
          WHERE strategy_order_id = ?
          ORDER BY id DESC
          LIMIT 1
        ) AS latest_snapshot_json
      FROM order_events
      WHERE strategy_order_id = ?
    `);
    this.insertEvent = this.database.prepare(`
      INSERT INTO order_events (
        strategy_order_id, snapshot_json, recorded_at
      ) VALUES (@strategyOrderId, @snapshotJson, @recordedAt)
    `);
    this.updateOrderSnapshot = this.database.prepare(`
      UPDATE strategy_orders
      SET
        exchange_order_id = @exchangeOrderId,
        snapshot_json = @snapshotJson,
        status = @status,
        updated_at = @updatedAt
      WHERE
        id = @id
        AND status = @previousStatus
        AND (
          snapshot_json = @previousSnapshotJson
          OR (
            snapshot_json IS NULL
            AND @previousSnapshotJson IS NULL
          )
        )
    `);
    this.selectEvents = this.database.prepare(`
      SELECT id, snapshot_json, recorded_at
      FROM order_events
      WHERE strategy_order_id = ?
      ORDER BY id
    `);
    this.planOrderTransaction = this.database.transaction((
      strategyId: string,
      role: OrderRole,
      request: OrderRequest
    ) => this.planOrderInsideTransaction(strategyId, role, request));
    this.attachSnapshotTransaction = this.database.transaction((
      strategyOrderId: string,
      snapshot: OrderSnapshot
    ) => this.attachSnapshotInsideTransaction(strategyOrderId, snapshot));
  }

  createPending(preflight: PreflightResult): StrategyRecord {
    const snapshot = publicPreflightSnapshot(preflight);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.insertStrategy.run({
      id,
      state: 'PENDING_CONFIRMATION',
      mode: snapshot.mode,
      spotExchangeId: snapshot.spotExchangeId,
      contractExchangeId: snapshot.contractExchangeId,
      symbol: snapshot.symbol,
      requestedBaseQuantity: snapshot.requestedBaseQuantity,
      effectiveBaseQuantity: snapshot.effectiveBaseQuantity,
      preflightJson: JSON.stringify(snapshot),
      createdAt: now,
      updatedAt: now
    });
    return this.getStrategy(id);
  }

  getStrategy(id: string): StrategyRecord {
    const strategyId = nonEmptyString(id, 'strategy id', 128);
    const row = this.selectStrategy.get(strategyId) as StrategyDbRow | undefined;
    if (row === undefined) {
      throw new Error(`unknown strategy: ${strategyId}`);
    }
    return this.strategyFromRow(row);
  }

  claimForExecution(id: string): boolean {
    const strategyId = nonEmptyString(id, 'strategy id', 128);
    const result = this.claimStrategy.run({
      id: strategyId,
      updatedAt: new Date().toISOString()
    });
    return result.changes === 1;
  }

  planOrder(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord {
    return this.planOrderTransaction(strategyId, role, request);
  }

  attachOrderSnapshot(
    strategyOrderId: string,
    snapshot: OrderSnapshot
  ): void {
    this.attachSnapshotTransaction(strategyOrderId, snapshot);
  }

  listOrders(strategyId: string): StrategyOrderRecord[] {
    const strategy = this.getStrategy(strategyId);
    const rows = this.selectOrders.all(strategy.id) as StrategyOrderDbRow[];
    return rows.map((row) => this.orderFromRow(row, strategy, true));
  }

  listOrderEvents(strategyOrderId: string): OrderSnapshot[] {
    const order = this.getOrder(strategyOrderId, false);
    const rows = this.selectEvents.all(order.id) as OrderEventDbRow[];
    const events: OrderSnapshot[] = [];
    let previous: OrderSnapshot | null = null;
    for (const row of rows) {
      const snapshot = safely('persisted order event', () => {
        if (
          typeof row.id !== 'number'
          || !Number.isSafeInteger(row.id)
          || row.id <= 0
        ) {
          return invalid('persisted order event', 'id is invalid');
        }
        isoTimestamp(row.recorded_at, 'persisted order event recording time');
        return validatedSnapshot(
          parseJson(row.snapshot_json, 'persisted order event'),
          {
            ...order,
            status: previous?.status ?? 'planned',
            snapshot: previous
          },
          previous,
          'persisted order event'
        );
      });
      events.push(deepFreeze(snapshot));
      previous = snapshot;
    }
    if (
      (order.snapshot === null && events.length !== 0)
      || (
        order.snapshot !== null
        && (
          events.length === 0
          || JSON.stringify(events.at(-1)) !== JSON.stringify(order.snapshot)
        )
      )
    ) {
      return invalid(
        'persisted order event',
        'latest event does not match latest order snapshot'
      );
    }
    return events;
  }

  transition(
    strategyId: string,
    from: StrategyState[],
    to: StrategyState,
    error?: string
  ): boolean {
    const id = nonEmptyString(strategyId, 'strategy id', 128);
    const target = enumValue(to, STRATEGY_STATES, 'strategy state');
    if (!Array.isArray(from) || from.length === 0) {
      throw new Error('invalid source state list: at least one state is required');
    }
    const sources = [...new Set(from.map((state) => enumValue(
      state,
      STRATEGY_STATES,
      'source strategy state'
    )))];
    for (const source of sources) {
      if (!ALLOWED_TRANSITIONS[source].has(target)) {
        throw new Error(
          `illegal strategy state transition: ${source} -> ${target}`
        );
      }
    }
    const lastError = error === undefined
      ? null
      : nonEmptyString(error, 'strategy transition error', 10_000);
    const placeholders = sources.map(() => '?').join(', ');
    const statement = this.database.prepare(`
      UPDATE strategies
      SET state = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND state IN (${placeholders})
    `);
    const result = statement.run(
      target,
      lastError,
      new Date().toISOString(),
      id,
      ...sources
    );
    return result.changes === 1;
  }

  listRecoverable(): StrategyRecord[] {
    return (this.selectRecoverable.all() as StrategyDbRow[])
      .map((row) => this.strategyFromRow(row));
  }

  private planOrderInsideTransaction(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord {
    const strategy = this.getStrategy(strategyId);
    const validated = validatedRequestForRole(strategy, role, request, false);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.insertOrder.run({
      id,
      strategyId: strategy.id,
      role: validated.role,
      exchangeId: validated.exchangeId,
      clientOrderId: validated.request.clientOrderId,
      requestJson: JSON.stringify(validated.request),
      createdAt: now,
      updatedAt: now
    });
    return this.getOrder(id);
  }

  private attachSnapshotInsideTransaction(
    strategyOrderId: string,
    value: OrderSnapshot
  ): void {
    const order = this.getOrder(strategyOrderId);
    const snapshot = validatedSnapshot(
      value,
      order,
      order.snapshot,
      'order snapshot'
    );
    const snapshotJson = JSON.stringify(snapshot);
    const recordedAt = new Date().toISOString();
    this.insertEvent.run({
      strategyOrderId: order.id,
      snapshotJson,
      recordedAt
    });
    const result = this.updateOrderSnapshot.run({
      id: order.id,
      exchangeOrderId: snapshot.exchangeOrderId,
      snapshotJson,
      status: snapshot.status,
      updatedAt: recordedAt,
      previousStatus: order.status,
      previousSnapshotJson: order.snapshot === null
        ? null
        : JSON.stringify(order.snapshot)
    });
    if (result.changes !== 1) {
      throw new Error('strategy order changed during snapshot attachment');
    }
  }

  private strategyFromRow(row: StrategyDbRow): StrategyRecord {
    return safely('persisted strategy', () => {
      const id = nonEmptyString(row.id, 'persisted strategy id', 128);
      const state = enumValue(
        row.state,
        STRATEGY_STATES,
        'persisted strategy state'
      );
      const mode = enumValue(
        row.mode,
        EXECUTION_MODES,
        'persisted strategy execution mode'
      );
      const preflight = publicPreflightSnapshot(
        parseJson(row.preflight_json, 'persisted strategy')
      );
      const spotExchangeId = nonEmptyString(
        row.spot_exchange_id,
        'persisted strategy spot exchange id',
        128
      );
      const contractExchangeId = nonEmptyString(
        row.contract_exchange_id,
        'persisted strategy contract exchange id',
        128
      );
      const symbol = nonEmptyString(
        row.symbol,
        'persisted strategy symbol',
        256
      );
      const requestedBaseQuantity = decimalValue(
        row.requested_base_quantity,
        'persisted strategy requested quantity',
        false
      );
      const effectiveBaseQuantity = decimalValue(
        row.effective_base_quantity,
        'persisted strategy effective quantity',
        false
      );
      if (
        mode !== preflight.mode
        || spotExchangeId !== preflight.spotExchangeId
        || contractExchangeId !== preflight.contractExchangeId
        || symbol !== preflight.symbol
        || requestedBaseQuantity !== preflight.requestedBaseQuantity
        || effectiveBaseQuantity !== preflight.effectiveBaseQuantity
      ) {
        return invalid(
          'persisted strategy',
          'columns do not match preflight snapshot'
        );
      }
      const createdAt = isoTimestamp(
        row.created_at,
        'persisted strategy creation time'
      );
      const updatedAt = isoTimestamp(
        row.updated_at,
        'persisted strategy update time'
      );
      if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
        return invalid('persisted strategy', 'update time precedes creation');
      }
      const lastError = row.last_error === null
        ? null
        : nonEmptyString(
          row.last_error,
          'persisted strategy last error',
          10_000
        );
      return deepFreeze({
        id,
        state,
        mode,
        spotExchangeId,
        contractExchangeId,
        symbol,
        requestedBaseQuantity,
        effectiveBaseQuantity,
        preflight: deepFreeze(preflight),
        lastError,
        createdAt,
        updatedAt
      });
    });
  }

  private getOrder(
    id: string,
    verifyEvents = true
  ): StrategyOrderRecord {
    const orderId = nonEmptyString(id, 'strategy order id', 128);
    const row = this.selectOrder.get(orderId) as StrategyOrderDbRow | undefined;
    if (row === undefined) {
      throw new Error(`unknown strategy order: ${orderId}`);
    }
    const strategyId = nonEmptyString(
      row.strategy_id,
      'persisted strategy order strategy id',
      128
    );
    return this.orderFromRow(
      row,
      this.getStrategy(strategyId),
      verifyEvents
    );
  }

  private orderFromRow(
    row: StrategyOrderDbRow,
    strategy: StrategyRecord,
    verifyEvents: boolean
  ): StrategyOrderRecord {
    return safely('persisted strategy order', () => {
      const id = nonEmptyString(
        row.id,
        'persisted strategy order id',
        128
      );
      const strategyId = nonEmptyString(
        row.strategy_id,
        'persisted strategy order strategy id',
        128
      );
      if (strategyId !== strategy.id) {
        return invalid(
          'persisted strategy order',
          'strategy id does not match parent'
        );
      }
      const validated = validatedRequestForRole(
        strategy,
        row.role,
        parseJson(row.request_json, 'persisted strategy order'),
        true
      );
      const exchangeId = nonEmptyString(
        row.exchange_id,
        'persisted strategy order exchange id',
        128
      );
      const clientOrderId = nonEmptyString(
        row.client_order_id,
        'persisted strategy order client order id',
        128
      );
      if (
        exchangeId !== validated.exchangeId
        || clientOrderId !== validated.request.clientOrderId
      ) {
        return invalid(
          'persisted strategy order',
          'identity columns do not match request'
        );
      }
      const status = enumValue(
        row.status,
        ORDER_STATUSES,
        'persisted strategy order status'
      );
      const createdAt = isoTimestamp(
        row.created_at,
        'persisted strategy order creation time'
      );
      const updatedAt = isoTimestamp(
        row.updated_at,
        'persisted strategy order update time'
      );
      if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
        return invalid(
          'persisted strategy order',
          'update time precedes creation'
        );
      }
      const baseRecord: StrategyOrderRecord = {
        id,
        strategyId,
        role: validated.role,
        exchangeId,
        clientOrderId,
        exchangeOrderId: null,
        request: deepFreeze(validated.request),
        snapshot: null,
        status,
        createdAt,
        updatedAt
      };
      let snapshot: OrderSnapshot | null = null;
      let exchangeOrderId: string | null = null;
      if (status === 'planned') {
        if (
          row.snapshot_json !== null
          || row.exchange_order_id !== null
        ) {
          return invalid(
            'persisted strategy order',
            'planned order cannot report a snapshot or fill'
          );
        }
      } else {
        if (
          row.snapshot_json === null
          || row.exchange_order_id === null
        ) {
          return invalid(
            'persisted strategy order',
            'snapshot status requires a snapshot and exchange order id'
          );
        }
        exchangeOrderId = nonEmptyString(
          row.exchange_order_id,
          'persisted strategy order exchange order id',
          256
        );
        snapshot = validatedSnapshot(
          parseJson(row.snapshot_json, 'persisted strategy order'),
          { ...baseRecord, exchangeOrderId },
          null,
          'persisted strategy order'
        );
        if (
          snapshot.status !== status
          || snapshot.exchangeOrderId !== exchangeOrderId
        ) {
          return invalid(
            'persisted strategy order',
            'snapshot does not match latest status columns'
          );
        }
      }
      if (verifyEvents) {
        const eventRow = this.selectLatestEvent.get(
          id,
          id
        ) as LatestEventDbRow;
        if (
          typeof eventRow.event_count !== 'number'
          || !Number.isSafeInteger(eventRow.event_count)
          || eventRow.event_count < 0
        ) {
          return invalid(
            'persisted strategy order',
            'event count is invalid'
          );
        }
        if (
          (snapshot === null && eventRow.event_count !== 0)
          || (
            snapshot !== null
            && (
              eventRow.event_count === 0
              || eventRow.latest_snapshot_json !== row.snapshot_json
            )
          )
        ) {
          return invalid(
            'persisted strategy order',
            'latest snapshot does not match immutable events'
          );
        }
      }
      return deepFreeze({
        ...baseRecord,
        exchangeOrderId,
        snapshot: snapshot === null ? null : deepFreeze(snapshot)
      });
    });
  }
}
