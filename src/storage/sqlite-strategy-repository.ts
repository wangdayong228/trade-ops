import { diagnosticValue } from '../errors/error-evidence.js';
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
import {
  createTradeOpsError,
  parseErrorDetail,
  safeFailureCategory,
  TradeOpsError,
  withErrorPhase,
  type ErrorDetail,
  type SafeDiagnosticValue
} from '../errors/trade-ops-error.js';
import {
  SQLITE_MIGRATED_STRATEGY_ORDERS_TABLE,
  SQLITE_ORDER_EVENTS_TABLE,
  SQLITE_STRATEGY_ORDERS_TABLE,
  SQLITE_STRATEGY_SCHEMA,
  SQLITE_V2_STRATEGIES_TABLE,
  SQLITE_V3_SCHEMA_METADATA,
  SQLITE_V3_STRATEGIES_TABLE
} from './schema.js';
import type {
  OrderSubmissionDisposition,
  OrderSubmissionFailureCode,
  SnapshotAttachmentResult,
  StrategyFailureCode,
  StrategyOrderPlan,
  StrategyOrderRecord,
  StrategyOrderStatus,
  StrategyRecord,
  StrategyRepository
} from './strategy-repository.js';
import {
  OrderSnapshotValidationError,
  OrderSnapshotWriteConflictError,
  StrategyNotFoundError
} from './strategy-repository.js';

const REQUIRED_BUSINESS_TABLES = [
  'strategies',
  'strategy_orders',
  'order_events'
] as const;
const RESERVED_STRATEGY_TABLE_NAMES = new Set([
  'strategies_v2',
  'strategies_v3',
  'strategies_recoverable_idx',
  'strategy_orders_strategy_idx',
  'order_events_order_idx'
]);

const EXECUTION_MODES = new Set<ExecutionMode>([
  'CONCURRENT',
  'CONTRACT_FIRST',
  'SPOT_FIRST'
]);
const STRATEGY_STATES = new Set<StrategyState>([
  'PENDING_CONFIRMATION',
  'PREFLIGHT_INVALIDATED',
  'EXECUTING',
  'WAITING_HEDGE',
  'HEDGED',
  'HEDGE_INCOMPLETE',
  'FAILED'
]);
const STRATEGY_FAILURE_CODES = new Set<StrategyFailureCode>([
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
]);
const FAILURE_STATES = new Set<StrategyState>([
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
const ORDER_SUBMISSION_DISPOSITIONS = new Set<OrderSubmissionDisposition>([
  'SUBMISSION_UNCERTAIN',
  'DEFINITELY_NOT_SUBMITTED',
  'REMOTE_OBSERVED'
]);
const ORDER_SUBMISSION_FAILURE_CODES = new Set<OrderSubmissionFailureCode>([
  'ORDER_SUBMISSION_FAILED',
  'HEDGE_RESIDUAL_NOT_TRADABLE'
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
  PREFLIGHT_INVALIDATED: new Set(),
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
const MAX_EXACT_DECIMAL_PRECISION = 1_000_000;
const STORAGE_DECIMAL_MIN_EXPONENT = -9_000_000_000_000_000;
const STORAGE_DECIMAL_MAX_EXPONENT = 9_000_000_000_000_000;
const DECIMAL_STRING_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const StorageDecimal = Decimal.clone({
  precision: MAX_EXACT_DECIMAL_PRECISION,
  rounding: Decimal.ROUND_DOWN,
  minE: STORAGE_DECIMAL_MIN_EXPONENT,
  maxE: STORAGE_DECIMAL_MAX_EXPONENT,
  toExpNeg: -7,
  toExpPos: 21
});

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
  failure_code: unknown;
  preflight_failure_json: unknown;
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
  submission_disposition: unknown;
  submission_failure_code: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface SqliteMasterRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

interface SchemaMetadataRow {
  singleton: unknown;
  version: unknown;
}

interface TableInfoRow {
  name: unknown;
}

interface ForeignKeyRow {
  id: unknown;
  seq: unknown;
  table: unknown;
  from: unknown;
  to: unknown;
  on_update: unknown;
  on_delete: unknown;
  match: unknown;
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

class StorageValidationError extends Error {}

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

function isPositiveSqliteInteger(value: unknown): boolean {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
  ) || (
    typeof value === 'bigint'
    && value > 0n
  );
}

function isNonNegativeSqliteInteger(value: unknown): boolean {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  ) || (
    typeof value === 'bigint'
    && value >= 0n
  );
}

function invalid(context: string, detail: string, options?: ErrorOptions): never {
  throw new StorageValidationError(`invalid ${context}: ${detail}`, options);
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
    return invalid(context, `must be a plain data object; actual ${diagnosticValue(value)}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    return invalid(context, 'expected string keys; actual symbol key');
  }
  for (const key of ownKeys as string[]) {
    if (!requiredKeys.has(key) && !optionalKeys.has(key)) {
      return invalid(context, `unsupported field ${key}; expected ${[...requiredKeys, ...optionalKeys].join(',')}`);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return invalid(context, `field ${key}: expected data property; actual accessor`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      return invalid(context, `field ${key}: expected required field; actual missing`);
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
    return invalid(context, `must be a non-empty trimmed string at most ${maximumLength} characters; actual ${diagnosticValue(value)}`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  context: string
): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    return invalid(context, `contains an unsupported value; expected ${[...values].join("|")}; actual ${diagnosticValue(value)}`);
  }
  return value as T;
}

function isoTimestamp(value: unknown, context: string): string {
  const timestamp = nonEmptyString(value, context, 64);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      return invalid(context, `must be a canonical ISO timestamp; actual ${diagnosticValue(value)}`);
    }
  } catch {
    return invalid(context, `must be a canonical ISO timestamp; actual ${diagnosticValue(value)}`);
  }
  return timestamp;
}

function decimalValue(
  value: unknown,
  context: string,
  allowZero: boolean
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 10_000
    || !DECIMAL_STRING_PATTERN.test(value)
  ) {
    return invalid(context, `must be a bounded decimal string; actual ${diagnosticValue(value)}`);
  }
  let parsed: Decimal;
  try {
    parsed = new StorageDecimal(value);
  } catch {
    return invalid(context, `must be a decimal string; actual ${diagnosticValue(value)}`);
  }
  const coefficient = value.split(/[eE]/, 1)[0] ?? '';
  const lexicalValueIsZero = !/[1-9]/.test(coefficient);
  if (parsed.isZero() && !lexicalValueIsZero) {
    return invalid(context, `must be within the supported exponent range; actual ${diagnosticValue(value)}`);
  }
  if (
    !parsed.isFinite()
    || parsed.isNegative()
    || (!allowZero && parsed.isZero())
  ) {
    return invalid(context, allowZero
      ? 'must be finite and non-negative'
      : 'must be finite and greater than zero', { cause: new Error(`actual ${diagnosticValue(value)}`) });
  }
  return value;
}

function decimalEqual(left: string, right: string): boolean {
  return new StorageDecimal(left).eq(right);
}

function exactSumEquals(
  requestedValue: string,
  filledValue: string,
  remainingValue: string,
  context: string
): boolean {
  const operands = [
    new StorageDecimal(requestedValue),
    new StorageDecimal(filledValue),
    new StorageDecimal(remainingValue)
  ].filter((value) => !value.isZero());
  const highestExponent = Math.max(...operands.map((value) => value.e));
  const lowestSignificantExponent = Math.min(...operands.map(
    (value) => value.e - value.sd() + 1
  ));
  const requiredPrecision =
    highestExponent - lowestSignificantExponent + 2;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision <= 0
    || requiredPrecision > MAX_EXACT_DECIMAL_PRECISION
  ) {
    return invalid(
      context,
      `exact snapshot quantity comparison exceeds supported precision; expected at most ${MAX_EXACT_DECIMAL_PRECISION}; actual ${requiredPrecision}`
    );
  }
  const ExactDecimal = StorageDecimal.clone({ precision: requiredPrecision });
  const requested = new ExactDecimal(requestedValue);
  const filled = new ExactDecimal(filledValue);
  const remaining = new ExactDecimal(remainingValue);
  return filled.plus(remaining).eq(requested);
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
    return invalid(context, `JSON storage is not text; actual ${typeof json}`);
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return invalid(context, `JSON is malformed; actual text length ${json.length}; parser body omitted`);
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
    return invalid(context, `quote must be USDT; actual ${diagnosticValue(object.quote)}`);
  }
  if (object.active !== true) {
    return invalid(context, `market must be active; expected true; actual ${diagnosticValue(object.active)}`);
  }
  if (
    exchangeId !== expected.exchangeId
    || symbol !== expected.symbol
    || kind !== expected.kind
    || base !== expected.base
  ) {
    for (const [field, actual] of [['exchangeId', exchangeId], ['symbol', symbol], ['kind', kind], ['base', base]] as const) {
      if (actual !== expected[field]) return invalid(context, `${field} identity does not match preflight; expected ${expected[field]}; actual ${actual}`);
    }
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
    && new StorageDecimal(result.minBaseAmount).gt(result.maxBaseAmount)
  ) {
    return invalid(context, `minimum base amount exceeds maximum; minimum=${result.minBaseAmount}, maximum=${result.maxBaseAmount}`);
  }
  if (
    result.minQuoteNotional !== undefined
    && result.maxQuoteNotional !== undefined
    && new StorageDecimal(result.minQuoteNotional).gt(result.maxQuoteNotional)
  ) {
    return invalid(context, `minimum quote notional exceeds maximum; minimum=${result.minQuoteNotional}, maximum=${result.maxQuoteNotional}`);
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
    return invalid(context, `spot and contract exchanges must differ; actual spot=${spotExchangeId}, contract=${contractExchangeId}`);
  }
  const symbol = nonEmptyString(object.symbol, `${context} symbol`, 256);
  const symbolParts = symbol.split('/');
  if (
    symbolParts.length !== 2
    || symbolParts[0] === undefined
    || symbolParts[0].length === 0
    || symbolParts[1] !== 'USDT'
  ) {
    return invalid(context, `symbol must be a BASE/USDT pair; actual ${symbol}`);
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
  if (new StorageDecimal(effectiveBaseQuantity).gt(requestedBaseQuantity)) {
    return invalid(context, `effective quantity exceeds requested quantity; requested=${requestedBaseQuantity}, effective=${effectiveBaseQuantity}`);
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
    return invalid(context, `risk acknowledgement must be required; expected true; actual ${diagnosticValue(object.riskAcknowledgementRequired)}`);
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
      return invalid(context, `contains unsupported time in force; expected GTC; actual ${diagnosticValue(object.timeInForce)}`);
    }
    request.timeInForce = 'GTC';
  }
  if (Object.prototype.hasOwnProperty.call(object, 'positionSide')) {
    if (object.positionSide !== 'SHORT') {
      return invalid(context, `contains unsupported position side; expected SHORT; actual ${diagnosticValue(object.positionSide)}`);
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
    return invalid(prefix, `request symbol does not match strategy; expected ${strategy.symbol}; actual ${request.symbol}`);
  }
  if (request.kind !== expected.kind) {
    return invalid(
      prefix,
      role.startsWith('SPOT_')
        ? `spot role requires spot market kind; actual ${request.kind}`
        : `contract role requires swap market kind; actual ${request.kind}`
    );
  }
  if (request.side !== expected.side) {
    return invalid(prefix, `request side does not match order role ${role}; expected ${expected.side}; actual ${request.side}`);
  }
  if (request.type !== expected.type) {
    return invalid(
      prefix,
      role.endsWith('_MARKET')
        ? `market role requires a market request; actual ${request.type}`
        : `hedge role requires a limit request; actual ${request.type}`
    );
  }
  const isHedge = role.endsWith('_HEDGE_GTC');
  if (
    isHedge
    && (request.timeInForce !== 'GTC' || request.price === undefined)
  ) {
    return invalid(prefix, `hedge role requires a priced GTC limit request; actual timeInForce=${diagnosticValue(request.timeInForce)}, price=${diagnosticValue(request.price)}`);
  }
  if (
    !isHedge
    && (
      request.timeInForce !== undefined
      || request.price !== undefined
    )
  ) {
    return invalid(prefix, `market role cannot contain limit fields; actual timeInForce=${diagnosticValue(request.timeInForce)}, price=${diagnosticValue(request.price)}`);
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
      `contract request requires SHORT and the confirmed margin mode ${strategy.preflight.accountSettings.marginMode}; actual positionSide=${diagnosticValue(request.positionSide)}, marginMode=${diagnosticValue(request.marginMode)}`
    );
  }
  if (
    !isContract
    && (
      request.positionSide !== undefined
      || request.marginMode !== undefined
    )
  ) {
    return invalid(prefix, `spot request cannot contain contract fields; actual positionSide=${diagnosticValue(request.positionSide)}, marginMode=${diagnosticValue(request.marginMode)}`);
  }
  if (
    new StorageDecimal(request.baseQuantity).gt(
      strategy.effectiveBaseQuantity
    )
  ) {
    return invalid(prefix, `request quantity exceeds strategy quantity; expected at most ${strategy.effectiveBaseQuantity}; actual ${request.baseQuantity}`);
  }
  if (request.clientOrderId !== makeClientOrderId(strategy.id, role)) {
    return invalid(prefix, `client order id does not match saved role ${role}; expected ${makeClientOrderId(strategy.id, role)}; actual ${request.clientOrderId}`);
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
    return invalid(context, `exchange does not match planned order; expected ${order.exchangeId}; actual ${snapshot.exchangeId}`);
  }
  if (snapshot.clientOrderId !== order.clientOrderId) {
    return invalid(context, `client order id does not match planned order; expected ${order.clientOrderId}; actual ${snapshot.clientOrderId}`);
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
    return invalid(context, `${differingField} does not match planned request; expected ${order.request[differingField]}; actual ${snapshot[differingField]}`);
  }
  if (
    !decimalEqual(
      snapshot.requestedBaseQuantity,
      order.request.baseQuantity
    )
  ) {
    return invalid(context, `requested quantity does not match planned request; expected ${order.request.baseQuantity}; actual ${snapshot.requestedBaseQuantity}`);
  }
  const requested = new StorageDecimal(snapshot.requestedBaseQuantity);
  const filled = new StorageDecimal(snapshot.filledBaseQuantity);
  const remaining = new StorageDecimal(snapshot.remainingBaseQuantity);
  if (filled.gt(requested)) return invalid(context, `filled quantity: expected at most ${requested.toString()}; actual ${filled.toString()}`);
  if (remaining.gt(requested)) return invalid(context, `remaining quantity: expected at most ${requested.toString()}; actual ${remaining.toString()}`);
  if (!exactSumEquals(snapshot.requestedBaseQuantity, snapshot.filledBaseQuantity, snapshot.remainingBaseQuantity, context)) {
    return invalid(context, `snapshot quantity totals are inconsistent: expected filled + remaining = ${snapshot.requestedBaseQuantity}; actual filled=${snapshot.filledBaseQuantity}, remaining=${snapshot.remainingBaseQuantity}`);
  }
  if (!STATUS_TRANSITIONS[order.status].has(snapshot.status)) {
    return invalid(context, `order status would regress; expected one of ${[...STATUS_TRANSITIONS[order.status]].join("|")} from ${order.status}; actual ${snapshot.status}`);
  }
  if (previous !== null) {
    if (snapshot.exchangeOrderId !== previous.exchangeOrderId) {
      return invalid(context, `exchange order id changed; expected ${previous.exchangeOrderId}; actual ${snapshot.exchangeOrderId}`);
    }
    if (
      filled.lt(previous.filledBaseQuantity)
      || remaining.gt(previous.remainingBaseQuantity)
      || new Date(snapshot.updatedAt).getTime()
        < new Date(previous.updatedAt).getTime()
    ) {
      if (filled.lt(previous.filledBaseQuantity)) return invalid(context, `filled quantity regresses: expected at least ${previous.filledBaseQuantity}; actual ${snapshot.filledBaseQuantity}`);
      if (remaining.gt(previous.remainingBaseQuantity)) return invalid(context, `remaining quantity regresses: expected at most ${previous.remainingBaseQuantity}; actual ${snapshot.remainingBaseQuantity}`);
      return invalid(context, `snapshot time regresses: expected at least ${previous.updatedAt}; actual ${snapshot.updatedAt}`);
    }
  }
  return snapshot;
}

function sameSnapshotSemantics(
  left: Readonly<OrderSnapshot>,
  right: Readonly<OrderSnapshot>
): boolean {
  return left.exchangeId === right.exchangeId
    && left.exchangeOrderId === right.exchangeOrderId
    && left.clientOrderId === right.clientOrderId
    && left.symbol === right.symbol
    && left.kind === right.kind
    && left.type === right.type
    && left.side === right.side
    && decimalEqual(left.requestedBaseQuantity, right.requestedBaseQuantity)
    && decimalEqual(left.filledBaseQuantity, right.filledBaseQuantity)
    && decimalEqual(left.remainingBaseQuantity, right.remainingBaseQuantity)
    && (
      left.averagePrice === null
        ? right.averagePrice === null
        : right.averagePrice !== null
          && decimalEqual(left.averagePrice, right.averagePrice)
    )
    && left.status === right.status;
}

function safely<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`invalid ${context}:`)) {
      throw error;
    }
    throw new Error(`invalid ${context}: stored values failed validation`, { cause: error });
  }
}

const SUBMISSION_EVIDENCE_CONDITION = `
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

const SUBMISSION_EVIDENCE_INSERT_TRIGGER = `
  CREATE TRIGGER strategy_orders_submission_evidence_insert
  BEFORE INSERT ON strategy_orders
  WHEN NOT ${SUBMISSION_EVIDENCE_CONDITION}
  BEGIN
    SELECT RAISE(ABORT, 'invalid submission evidence');
  END;
`;

const SUBMISSION_EVIDENCE_UPDATE_TRIGGER = `
  CREATE TRIGGER strategy_orders_submission_evidence_update
  BEFORE UPDATE OF
    status,
    snapshot_json,
    exchange_order_id,
    submission_disposition,
    submission_failure_code
  ON strategy_orders
  WHEN NOT ${SUBMISSION_EVIDENCE_CONDITION}
  BEGIN
    SELECT RAISE(ABORT, 'invalid submission evidence');
  END;
`;

const SQLITE_V1_MIGRATION = `
  CREATE TABLE strategies_v2 (
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
        'HEDGE_RESIDUAL_NOT_TRADABLE',
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

  INSERT INTO strategies_v2 (
    id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
    requested_base_quantity, effective_base_quantity, preflight_json,
    failure_code, created_at, updated_at
  )
  SELECT
    id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
    requested_base_quantity, effective_base_quantity, preflight_json,
    failure_code, created_at, updated_at
  FROM strategies;

  DROP TABLE strategies;
  ALTER TABLE strategies_v2 RENAME TO strategies;

  ALTER TABLE strategy_orders ADD COLUMN
    submission_disposition TEXT NOT NULL DEFAULT 'SUBMISSION_UNCERTAIN' CHECK (
      submission_disposition IN (
        'SUBMISSION_UNCERTAIN',
        'DEFINITELY_NOT_SUBMITTED',
        'REMOTE_OBSERVED'
      )
    );
  ALTER TABLE strategy_orders ADD COLUMN
    submission_failure_code TEXT CHECK (
      submission_failure_code IS NULL
      OR submission_failure_code IN (
        'ORDER_SUBMISSION_FAILED',
        'HEDGE_RESIDUAL_NOT_TRADABLE'
      )
    );

  UPDATE strategy_orders
  SET
    submission_disposition = CASE
      WHEN snapshot_json IS NULL THEN 'SUBMISSION_UNCERTAIN'
      ELSE 'REMOTE_OBSERVED'
    END,
    submission_failure_code = NULL;

  ${SUBMISSION_EVIDENCE_INSERT_TRIGGER}
  ${SUBMISSION_EVIDENCE_UPDATE_TRIGGER}

  CREATE INDEX strategies_recoverable_idx
    ON strategies(state, created_at);
  CREATE INDEX IF NOT EXISTS strategy_orders_strategy_idx
    ON strategy_orders(strategy_id, created_at);
  CREATE INDEX IF NOT EXISTS order_events_order_idx
    ON order_events(strategy_order_id, id);
`;

const SQLITE_V2_SCHEMA_METADATA = `
  CREATE TABLE IF NOT EXISTS strategy_schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 2)
  );
  INSERT OR IGNORE INTO strategy_schema_metadata (singleton, version)
  VALUES (1, 2);
`;

const SQLITE_V3_MIGRATION_STRATEGIES_TABLE = SQLITE_V3_STRATEGIES_TABLE.replace(
  'CREATE TABLE strategies (',
  'CREATE TABLE strategies_v3 ('
);

const SQLITE_V2_TO_V3_MIGRATION = `
  ${SQLITE_V3_MIGRATION_STRATEGIES_TABLE}

  INSERT INTO strategies_v3 (
    id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
    requested_base_quantity, effective_base_quantity, preflight_json,
    failure_code, preflight_failure_json, created_at, updated_at
  )
  SELECT
    id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
    requested_base_quantity, effective_base_quantity, preflight_json,
    failure_code, NULL, created_at, updated_at
  FROM strategies;

  DROP INDEX strategies_recoverable_idx;
  DROP TABLE strategies;
  ALTER TABLE strategies_v3 RENAME TO strategies;
  CREATE INDEX strategies_recoverable_idx
    ON strategies(state, created_at);

  DROP TABLE strategy_schema_metadata;
  ${SQLITE_V3_SCHEMA_METADATA}
`;

function schemaError(actual: string): TradeOpsError {
  return createTradeOpsError({
    code: 'DATABASE_SCHEMA_VERSION_MISMATCH',
    phase: 'startup',
    subject: {
      type: 'database',
      table: 'strategies',
      operation: 'prepare strategy schema'
    },
    expected: 'exact known strategy schema version 1, 2, or 3',
    actual: actual.length <= 2000 ? actual : `schema diagnostic length ${actual.length}; full detail in evidence`
  }, undefined, actual.length <= 2000 ? undefined : { cause: new Error(actual) });
}

function trustedTradeOpsFailure(
  error: unknown,
  phase: 'startup' | 'storage'
): TradeOpsError | undefined {
  try {
    return withErrorPhase(error as TradeOpsError, phase);
  } catch {
    return undefined;
  }
}

function schemaOperationError(
  operation: string,
  actual: string,
  options?: ErrorOptions
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_OPERATION_FAILED',
    phase: 'startup',
    subject: {
      type: 'database',
      table: 'strategies',
      operation
    },
    expected: 'successful strategy schema storage operation',
    actual: actual.length <= 2000 ? actual : `diagnostic length ${actual.length}; full detail in evidence`
  }, undefined, options);
}

function safePragmaActual(value: unknown): SafeDiagnosticValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 'non-finite-number';
  }
  if (
    typeof value === 'bigint'
    && value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return `${typeof value}-value`;
}

function foreignKeyStateError(
  operation: string,
  expected: 0 | 1,
  actual: unknown
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_OPERATION_FAILED',
    phase: 'startup',
    subject: {
      type: 'database',
      table: 'strategies',
      operation
    },
    expected,
    actual: safePragmaActual(actual)
  });
}

function throwSchemaFailure(operation: string, error: unknown): never {
  const trusted = trustedTradeOpsFailure(error, 'startup');
  if (
    trusted?.detail.code === 'DATABASE_SCHEMA_VERSION_MISMATCH'
    || trusted?.detail.code === 'STORAGE_OPERATION_FAILED'
  ) {
    throw trusted;
  }
  throw schemaOperationError(operation, safeFailureCategory(error), { cause: error });
}

function schemaMetadata(database: Database.Database): SchemaMetadataRow[] {
  return database.prepare(`
    SELECT singleton, version
    FROM strategy_schema_metadata
  `).all() as SchemaMetadataRow[];
}

function validMetadata(
  rows: readonly SchemaMetadataRow[],
  version: 2 | 3
): boolean {
  return rows.length === 1
    && sqliteIntegerEquals(rows[0]?.singleton, 1)
    && sqliteIntegerEquals(rows[0]?.version, version);
}

function classifyStrategySchema(
  database: Database.Database
): 'empty' | 'v1' | 'v2' | 'v3' {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as SqliteMasterRow[];
  const tableNames = new Set(rows.map(({ name }) => {
    if (typeof name !== 'string') {
      throw schemaError(`table name: expected string; actual ${diagnosticValue(name)}`);
    }
    return name;
  }));
  if (tableNames.size === 0) {
    return 'empty';
  }
  if ([...RESERVED_STRATEGY_TABLE_NAMES].some((name) => tableNames.has(name))) {
    throw schemaError(`reserved-strategy-object-name-used-as-table; expected no reserved table names; actual ${[...RESERVED_STRATEGY_TABLE_NAMES].filter((name) => tableNames.has(name)).join(',')}`);
  }
  const hasBusinessTables = REQUIRED_BUSINESS_TABLES.every(
    (name) => tableNames.has(name)
  );
  if (!tableNames.has('strategy_schema_metadata')) {
    if (hasBusinessTables) {
      assertV1MigrationSourceColumns(database);
      return 'v1';
    }
    throw schemaError(`business tables: expected ${REQUIRED_BUSINESS_TABLES.join(',')}; actual ${[...tableNames].join(',')}`);
  }
  if (!hasBusinessTables) {
    throw schemaError(`business tables: expected ${REQUIRED_BUSINESS_TABLES.join(',')}; actual ${[...tableNames].join(',')}`);
  }
  const metadata = schemaMetadata(database);
  if (validMetadata(metadata, 2)) return 'v2';
  if (validMetadata(metadata, 3)) return 'v3';
  throw schemaError(`schema-metadata-version-or-singleton-invalid; expected one singleton=1 version=2|3; actual ${metadata.map((row) => `singleton=${diagnosticValue(row.singleton)},version=${diagnosticValue(row.version)}`).join(';')}; count=${metadata.length}`);
}

function assertV1MigrationSourceColumns(database: Database.Database): void {
  assertColumns(database, 'strategies', [
    'id', 'state', 'mode', 'spot_exchange_id', 'contract_exchange_id',
    'symbol', 'requested_base_quantity', 'effective_base_quantity',
    'preflight_json', 'failure_code', 'created_at', 'updated_at'
  ]);
  assertColumns(database, 'strategy_orders', [
    'id', 'strategy_id', 'role', 'exchange_id', 'client_order_id',
    'exchange_order_id', 'request_json', 'snapshot_json', 'status',
    'created_at', 'updated_at'
  ]);
  assertColumns(database, 'order_events', [
    'id', 'strategy_order_id', 'snapshot_json', 'recorded_at'
  ]);
}

function canonicalSql(value: unknown): string {
  if (typeof value !== 'string') {
    throw schemaError(`schema definition: expected SQL text; actual ${typeof value}`);
  }
  let result = '';
  let pendingSpace = false;
  let previousWasCompact = false;
  let quotedTerminator: "'" | '"' | '`' | ']' | null = null;

  const appendText = (text: string): void => {
    if (pendingSpace && result.length !== 0 && !previousWasCompact) {
      result += ' ';
    }
    result += text;
    pendingSpace = false;
    previousWasCompact = false;
  };
  const appendCompact = (text: string): void => {
    result = result.trimEnd();
    result += text;
    pendingSpace = false;
    previousWasCompact = true;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (quotedTerminator !== null) {
      result += character;
      if (character === quotedTerminator) {
        if (
          quotedTerminator !== ']'
          && value[index + 1] === quotedTerminator
        ) {
          result += quotedTerminator;
          index += 1;
        } else {
          quotedTerminator = null;
        }
      }
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      appendText(character);
      quotedTerminator = character;
      continue;
    }
    if (character === '[') {
      appendText(character);
      quotedTerminator = ']';
      continue;
    }
    if (character === '<' && value[index + 1] === '>') {
      appendCompact('<>');
      index += 1;
      continue;
    }
    if (character === '=' || /[(),;]/.test(character)) {
      appendCompact(character);
      continue;
    }
    appendText(character.toLowerCase());
  }
  if (quotedTerminator !== null) {
    throw schemaError(`schema definition: expected closed quoted term; actual unterminated ${quotedTerminator}`);
  }
  return result.replace(/;+$/g, '');
}

function assertColumns(
  database: Database.Database,
  table: string,
  expected: readonly string[]
): void {
  const rows = database.prepare(
    `PRAGMA table_info(${table})`
  ).all() as TableInfoRow[];
  const actual = rows.map(({ name }) => name);
  const actualNames = new Set(actual);
  if (
    actual.some((name) => typeof name !== 'string')
    || actual.length !== expected.length
    || expected.some((name) => !actualNames.has(name))
  ) {
    throw schemaError(`${table} columns: expected ${expected.join(',')}; actual ${actual.map(diagnosticValue).join(',')}`);
  }
}

function assertParentForeignKey(
  database: Database.Database,
  childTable: string,
  childColumn: string,
  parentTable: string,
  parentColumn: string
): void {
  const rows = database.prepare(
    `PRAGMA foreign_key_list(${childTable})`
  ).all() as ForeignKeyRow[];
  const row = rows[0];
  if (
    rows.length !== 1
    || row === undefined
    || !sqliteIntegerEquals(row.id, 0)
    || !sqliteIntegerEquals(row.seq, 0)
    || row.table !== parentTable
    || row.from !== childColumn
    || row.to !== parentColumn
    || row.on_update !== 'NO ACTION'
    || row.on_delete !== 'NO ACTION'
    || row.match !== 'NONE'
  ) {
    throw schemaError(`${childTable}.${childColumn} foreign key: expected id=0,seq=0,${parentTable}.${parentColumn}, NO ACTION/NONE; actual count=${rows.length}, ${row === undefined ? 'missing' : ['id','seq','table','from','to','on_update','on_delete','match'].map((field) => `${field}=${diagnosticValue(row[field as keyof ForeignKeyRow])}`).join(',')}`);
  }
}

function assertKnownBusinessSchema(
  database: Database.Database,
  expectedStrategiesTable: string,
  expectedStrategyColumns: readonly string[]
): void {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as SqliteMasterRow[];
  const object = (type: string, name: string, table: string): SqliteMasterRow => {
    const row = rows.find((candidate) => (
      candidate.type === type
      && candidate.name === name
      && candidate.tbl_name === table
    ));
    if (row === undefined) {
      throw schemaError(`schema object ${type}:${name}:${table}: expected present; actual missing`);
    }
    return row;
  };

  const strategiesSql = canonicalSql(object(
    'table',
    'strategies',
    'strategies'
  ).sql);
  const ordersSql = canonicalSql(object(
    'table',
    'strategy_orders',
    'strategy_orders'
  ).sql);
  const orderEventsSql = canonicalSql(object(
    'table',
    'order_events',
    'order_events'
  ).sql);
  const recoverableIndexSql = canonicalSql(object(
    'index',
    'strategies_recoverable_idx',
    'strategies'
  ).sql);
  const strategyOrdersIndexSql = canonicalSql(object(
    'index',
    'strategy_orders_strategy_idx',
    'strategy_orders'
  ).sql);
  const orderEventsIndexSql = canonicalSql(object(
    'index',
    'order_events_order_idx',
    'order_events'
  ).sql);
  const noUpdateSql = canonicalSql(object(
    'trigger',
    'order_events_no_update',
    'order_events'
  ).sql);
  const noDeleteSql = canonicalSql(object(
    'trigger',
    'order_events_no_delete',
    'order_events'
  ).sql);

  assertColumns(database, 'strategies', expectedStrategyColumns);
  assertColumns(database, 'strategy_orders', [
    'id', 'strategy_id', 'role', 'exchange_id', 'client_order_id',
    'exchange_order_id', 'request_json', 'snapshot_json', 'status',
    'created_at', 'updated_at', 'submission_disposition',
    'submission_failure_code'
  ]);
  assertColumns(database, 'order_events', [
    'id', 'strategy_order_id', 'snapshot_json', 'recorded_at'
  ]);
  assertParentForeignKey(
    database,
    'strategy_orders',
    'strategy_id',
    'strategies',
    'id'
  );
  assertParentForeignKey(
    database,
    'order_events',
    'strategy_order_id',
    'strategy_orders',
    'id'
  );

  const renamedStrategiesTable = expectedStrategiesTable.replace(
    'CREATE TABLE strategies (',
    'CREATE TABLE "strategies" ('
  );
  if (
    strategiesSql !== canonicalSql(expectedStrategiesTable)
    && strategiesSql !== canonicalSql(renamedStrategiesTable)
  ) {
    throw schemaError('strategies-table-definition-mismatch');
  }
  if (orderEventsSql !== canonicalSql(SQLITE_ORDER_EVENTS_TABLE)) {
    throw schemaError('order_events definition: expected locked definition; actual definition mismatch');
  }
  if (recoverableIndexSql !== canonicalSql(`
      CREATE INDEX strategies_recoverable_idx
      ON strategies(state, created_at)
    `)) {
    throw schemaError('strategies_recoverable_idx definition: expected locked definition; actual definition mismatch');
  }
  if (strategyOrdersIndexSql !== canonicalSql(`
      CREATE INDEX strategy_orders_strategy_idx
      ON strategy_orders(strategy_id, created_at)
    `)) {
    throw schemaError('strategy_orders_strategy_idx definition: expected locked definition; actual definition mismatch');
  }
  if (orderEventsIndexSql !== canonicalSql(`
      CREATE INDEX order_events_order_idx
      ON order_events(strategy_order_id, id)
    `)) {
    throw schemaError('order_events_order_idx definition: expected locked definition; actual definition mismatch');
  }
  if (noUpdateSql !== canonicalSql(`
      CREATE TRIGGER order_events_no_update
      BEFORE UPDATE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are immutable');
      END
    `)) {
    throw schemaError('order_events_no_update definition: expected locked definition; actual definition mismatch');
  }
  if (noDeleteSql !== canonicalSql(`
      CREATE TRIGGER order_events_no_delete
      BEFORE DELETE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are immutable');
      END
    `)) {
    throw schemaError('order_events_no_delete definition: expected locked definition; actual definition mismatch');
  }

  const hasFreshOrderTable = ordersSql
    === canonicalSql(SQLITE_STRATEGY_ORDERS_TABLE);
  const hasMigratedOrderTable = ordersSql
    === canonicalSql(SQLITE_MIGRATED_STRATEGY_ORDERS_TABLE);
  const evidenceInsert = rows.find(({ type, name, tbl_name: table }) => (
    type === 'trigger'
    && name === 'strategy_orders_submission_evidence_insert'
    && table === 'strategy_orders'
  ));
  const evidenceUpdate = rows.find(({ type, name, tbl_name: table }) => (
    type === 'trigger'
    && name === 'strategy_orders_submission_evidence_update'
    && table === 'strategy_orders'
  ));
  const hasMigrationEvidenceTriggers = evidenceInsert !== undefined
    && evidenceUpdate !== undefined
    && canonicalSql(evidenceInsert.sql)
      === canonicalSql(SUBMISSION_EVIDENCE_INSERT_TRIGGER)
    && canonicalSql(evidenceUpdate.sql)
      === canonicalSql(SUBMISSION_EVIDENCE_UPDATE_TRIGGER);
  if (
    !hasFreshOrderTable
    && !(hasMigratedOrderTable && hasMigrationEvidenceTriggers)
  ) {
    throw schemaError(`strategy_orders definition: expected fresh table or migrated table with valid evidence triggers; actual fresh=${hasFreshOrderTable}, migrated=${hasMigratedOrderTable}, evidenceTriggers=${hasMigrationEvidenceTriggers}`);
  }

  const expectedBusinessObjects = new Set([
    'table:strategies:strategies',
    'table:strategy_orders:strategy_orders',
    'table:order_events:order_events',
    'index:strategies_recoverable_idx:strategies',
    'index:strategy_orders_strategy_idx:strategy_orders',
    'index:order_events_order_idx:order_events',
    'trigger:order_events_no_update:order_events',
    'trigger:order_events_no_delete:order_events'
  ]);
  if (hasMigratedOrderTable) {
    expectedBusinessObjects.add(
      'trigger:strategy_orders_submission_evidence_insert:strategy_orders'
    );
    expectedBusinessObjects.add(
      'trigger:strategy_orders_submission_evidence_update:strategy_orders'
    );
  }
  const businessTables = new Set<string>(REQUIRED_BUSINESS_TABLES);
  for (const row of rows) {
    const table = row.tbl_name;
    if (typeof table !== 'string' || !businessTables.has(table)) continue;
    if (
      typeof row.type !== 'string'
      || typeof row.name !== 'string'
      || !expectedBusinessObjects.has(`${row.type}:${row.name}:${table}`)
    ) {
      throw schemaError(`business schema object: expected known object; actual ${diagnosticValue(row.type)}:${diagnosticValue(row.name)}:${table}`);
    }
  }

  const placeholders = REQUIRED_BUSINESS_TABLES.map(() => '?').join(', ');
  const temporaryBusinessObject = database.prepare(`
    SELECT 1
    FROM sqlite_temp_master
    WHERE tbl_name IN (${placeholders})
    LIMIT 1
  `).get(...REQUIRED_BUSINESS_TABLES);
  if (temporaryBusinessObject !== undefined) {
    throw schemaError('temporary business object: expected absent; actual present');
  }
}

function assertV2BusinessSchema(database: Database.Database): void {
  assertKnownBusinessSchema(database, SQLITE_V2_STRATEGIES_TABLE, [
    'id', 'state', 'mode', 'spot_exchange_id', 'contract_exchange_id',
    'symbol', 'requested_base_quantity', 'effective_base_quantity',
    'preflight_json', 'failure_code', 'created_at', 'updated_at'
  ]);
}

function assertV3BusinessSchema(database: Database.Database): void {
  assertKnownBusinessSchema(database, SQLITE_V3_STRATEGIES_TABLE, [
    'id', 'state', 'mode', 'spot_exchange_id', 'contract_exchange_id',
    'symbol', 'requested_base_quantity', 'effective_base_quantity',
    'preflight_json', 'failure_code', 'preflight_failure_json',
    'created_at', 'updated_at'
  ]);
}

function assertForeignKeysClean(database: Database.Database): void {
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length !== 0) {
    throw schemaError(`foreign-key-check-failed; expected 0 violations; actual ${violations.length}`);
  }
}

function assertMetadataSchema(
  database: Database.Database,
  version: 2 | 3
): void {
  const metadataSql = canonicalSql(database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'strategy_schema_metadata'
  `).pluck().get());
  assertColumns(database, 'strategy_schema_metadata', [
    'singleton',
    'version'
  ]);
  const metadataTable = canonicalSql(`
    CREATE TABLE strategy_schema_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = ${version})
    )
  `);
  const metadataTableIfMissing = canonicalSql(`
    CREATE TABLE IF NOT EXISTS strategy_schema_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = ${version})
    )
  `);
  if (
    metadataSql !== metadataTable
    && !(version === 2 && metadataSql === metadataTableIfMissing)
  ) {
    throw schemaError(`strategy_schema_metadata definition: expected locked version ${version} definition; actual definition mismatch`);
  }
  const metadata = schemaMetadata(database);
  if (!validMetadata(metadata, version)) {
    throw schemaError(`strategy_schema_metadata row: expected one singleton=1 version=${version}; actual count=${metadata.length}, ${metadata.map((row) => `singleton=${diagnosticValue(row.singleton)},version=${diagnosticValue(row.version)}`).join(';')}`);
  }
}

function assertCompleteV2Schema(database: Database.Database): void {
  assertV2BusinessSchema(database);
  assertMetadataSchema(database, 2);
}

function assertCompleteV3Schema(database: Database.Database): void {
  assertV3BusinessSchema(database);
  assertMetadataSchema(database, 3);
}

function createFreshV3Schema(database: Database.Database): void {
  try {
    database.transaction(() => {
      database.exec(SQLITE_STRATEGY_SCHEMA);
      assertForeignKeysClean(database);
      assertCompleteV3Schema(database);
    })();
    assertForeignKeysClean(database);
    assertCompleteV3Schema(database);
  } catch (error) {
    throwSchemaFailure('create-fresh-v3-schema', error);
  }
}

function migrateToV3Schema(
  database: Database.Database,
  source: 'v1' | 'v2'
): void {
  const disableOperation = 'disable-strategy-schema-foreign-keys';
  const restoreOperation = 'restore-strategy-schema-foreign-keys';
  let migrationFailed = false;
  let migrationFailure: unknown;
  try {
    try {
      database.pragma('foreign_keys = OFF');
      const disabledState = database.pragma(
        'foreign_keys',
        { simple: true }
      );
      if (!sqliteIntegerEquals(disabledState, 0)) {
        throw foreignKeyStateError(disableOperation, 0, disabledState);
      }
    } catch (error) {
      const trusted = trustedTradeOpsFailure(error, 'startup');
      if (trusted?.detail.code === 'STORAGE_OPERATION_FAILED') throw trusted;
      throw schemaOperationError(
        disableOperation,
        safeFailureCategory(error),
        { cause: error }
      );
    }
    database.transaction(() => {
      if (source === 'v1') {
        database.exec(SQLITE_V1_MIGRATION);
        assertForeignKeysClean(database);
        assertV2BusinessSchema(database);
        database.exec(SQLITE_V2_SCHEMA_METADATA);
      }
      assertCompleteV2Schema(database);
      database.exec(SQLITE_V2_TO_V3_MIGRATION);
      assertForeignKeysClean(database);
      assertCompleteV3Schema(database);
    })();
  } catch (error) {
    migrationFailed = true;
    migrationFailure = error;
  } finally {
    let restoreFailure: TradeOpsError | undefined;
    try {
      database.pragma('foreign_keys = ON');
      const restoredState = database.pragma(
        'foreign_keys',
        { simple: true }
      );
      if (!sqliteIntegerEquals(restoredState, 1)) {
        restoreFailure = foreignKeyStateError(
          restoreOperation,
          1,
          restoredState
        );
      }
    } catch (error) {
      const trusted = trustedTradeOpsFailure(error, 'startup');
      restoreFailure = trusted?.detail.code === 'STORAGE_OPERATION_FAILED'
        ? trusted
        : schemaOperationError(
          restoreOperation,
          safeFailureCategory(error),
          { cause: error }
        );
    }
    if (restoreFailure !== undefined) {
      if (migrationFailed) {
        const primary = trustedTradeOpsFailure(migrationFailure, 'startup');
        const combined = new AggregateError(
          [migrationFailure, restoreFailure],
          'schema migration and foreign-key restoration failed'
        );
        migrationFailure = primary === undefined
          ? combined
          : createTradeOpsError({
            code: primary.detail.code,
            phase: primary.detail.phase,
            subject: primary.detail.subject,
            expected: primary.detail.expected,
            actual: primary.detail.actual,
            occurredAt: primary.detail.occurredAt
          }, undefined, { cause: combined });
      } else {
        migrationFailure = restoreFailure;
      }
      migrationFailed = true;
    }
  }
  if (migrationFailed) {
    throwSchemaFailure(
      `migrate-${source}-to-v3`,
      migrationFailure
    );
  }
  try {
    assertForeignKeysClean(database);
    assertCompleteV3Schema(database);
  } catch (error) {
    throwSchemaFailure(`verify-${source}-to-v3`, error);
  }
}

function prepareStrategySchema(database: Database.Database): void {
  if (database.inTransaction) {
    throw schemaError('external-transaction-active; expected inTransaction=false; actual true');
  }
  let schemaGeneration: 'empty' | 'v1' | 'v2' | 'v3';
  try {
    database.pragma('foreign_keys = ON');
    const foreignKeys = database.pragma('foreign_keys', { simple: true });
    if (!sqliteIntegerEquals(foreignKeys, 1)) {
      throw schemaError(`foreign_keys: expected 1; actual ${diagnosticValue(foreignKeys)}`);
    }
    schemaGeneration = classifyStrategySchema(database);
  } catch (error) {
    throwSchemaFailure('classify-strategy-schema', error);
  }

  try {
    const journalMode = database.pragma(
      'journal_mode = WAL',
      { simple: true }
    );
    const expectedJournalMode = database.name === ':memory:'
      ? 'memory'
      : 'wal';
    if (
      typeof journalMode !== 'string'
      || journalMode.toLowerCase() !== expectedJournalMode
    ) {
      throw schemaError(`journal_mode: expected ${expectedJournalMode}; actual ${diagnosticValue(journalMode)}`);
    }
  } catch (error) {
    throwSchemaFailure('enable-strategy-journal', error);
  }

  if (schemaGeneration === 'empty') {
    createFreshV3Schema(database);
  } else if (schemaGeneration === 'v1') {
    migrateToV3Schema(database, 'v1');
  } else if (schemaGeneration === 'v2') {
    migrateToV3Schema(database, 'v2');
  } else {
    try {
      assertForeignKeysClean(database);
      assertCompleteV3Schema(database);
    } catch (error) {
      throwSchemaFailure('verify-v3-schema', error);
    }
  }
}

interface ConfirmationExpectedRow {
  readonly id: string;
  readonly state: 'PENDING_CONFIRMATION';
  readonly mode: ExecutionMode;
  readonly spotExchangeId: string;
  readonly contractExchangeId: string;
  readonly symbol: string;
  readonly requestedBaseQuantity: string;
  readonly effectiveBaseQuantity: string;
  readonly preflightJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function storageTransitionError(
  strategyId: string,
  actual: string
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_TRANSITION_REJECTED',
    phase: 'storage',
    subject: { type: 'strategy', strategyId },
    expected: 'unchanged pending confirmation snapshot without failures or orders',
    actual
  });
}

function confirmationClockRollbackError(
  strategyId: string,
  expectedUpdatedAt: string,
  actualUpdatedAt: string
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_TRANSITION_REJECTED',
    phase: 'storage',
    subject: { type: 'strategy', strategyId, field: 'updatedAt' },
    expected: `timestamp at or after ${expectedUpdatedAt}`,
    actual: `observed ${actualUpdatedAt}`
  });
}

function storageOperationError(
  strategyId: string,
  actual: string,
  options?: ErrorOptions
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_OPERATION_FAILED',
    phase: 'storage',
    subject: {
      type: 'database',
      table: 'strategies',
      recordId: strategyId,
      operation: 'confirmation transaction'
    },
    expected: 'transaction committed or rolled back with the original snapshot intact',
    actual: actual.length <= 2000 ? actual : `diagnostic length ${actual.length}; full detail in evidence`
  }, undefined, options);
}

function storageRecordError(
  recordId: string,
  actual: string,
  options?: ErrorOptions
): TradeOpsError {
  return createTradeOpsError({
    code: 'STORAGE_RECORD_INVALID',
    phase: 'storage',
    subject: {
      type: 'database',
      table: 'strategies',
      recordId,
      operation: 'read strategy record'
    },
    expected: 'valid strategy state, failures, snapshot, and order relationship',
    actual: actual.length <= 2000 ? actual : `diagnostic length ${actual.length}; full detail in evidence`
  }, undefined, options);
}

function confirmationExpectedRow(
  expected: Readonly<StrategyRecord>
): ConfirmationExpectedRow {
  const id = nonEmptyString(expected.id, 'confirmation strategy id', 128);
  if (expected.state !== 'PENDING_CONFIRMATION') {
    throw storageTransitionError(id, 'expected-record-state-is-not-pending');
  }
  if (expected.failureCode !== null || expected.preflightFailure !== null) {
    throw storageTransitionError(id, 'expected-record-already-has-failure');
  }
  const preflight = publicPreflightSnapshot(expected.preflight);
  const mode = enumValue(expected.mode, EXECUTION_MODES, 'confirmation mode');
  const spotExchangeId = nonEmptyString(
    expected.spotExchangeId,
    'confirmation spot exchange id',
    128
  );
  const contractExchangeId = nonEmptyString(
    expected.contractExchangeId,
    'confirmation contract exchange id',
    128
  );
  const symbol = nonEmptyString(expected.symbol, 'confirmation symbol', 256);
  const requestedBaseQuantity = decimalValue(
    expected.requestedBaseQuantity,
    'confirmation requested quantity',
    false
  );
  const effectiveBaseQuantity = decimalValue(
    expected.effectiveBaseQuantity,
    'confirmation effective quantity',
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
    throw storageTransitionError(id, 'expected-record-columns-differ-from-snapshot');
  }
  return {
    id,
    state: 'PENDING_CONFIRMATION',
    mode,
    spotExchangeId,
    contractExchangeId,
    symbol,
    requestedBaseQuantity,
    effectiveBaseQuantity,
    preflightJson: JSON.stringify(preflight),
    createdAt: isoTimestamp(expected.createdAt, 'confirmation creation time'),
    updatedAt: isoTimestamp(expected.updatedAt, 'confirmation update time')
  };
}

function confirmationMismatch(
  row: StrategyDbRow | undefined,
  expected: ConfirmationExpectedRow,
  orderCount: unknown
): string | null {
  if (row === undefined) return 'strategy-record-missing';
  for (const [field, actual, wanted] of [
    ['id', row.id, expected.id],
    ['state', row.state, expected.state],
    ['mode', row.mode, expected.mode],
    ['spot-exchange-id', row.spot_exchange_id, expected.spotExchangeId],
    ['contract-exchange-id', row.contract_exchange_id, expected.contractExchangeId],
    ['symbol', row.symbol, expected.symbol],
    ['requested-base-quantity', row.requested_base_quantity,
      expected.requestedBaseQuantity],
    ['effective-base-quantity', row.effective_base_quantity,
      expected.effectiveBaseQuantity],
    ['preflight-snapshot', row.preflight_json, expected.preflightJson],
    ['creation-time', row.created_at, expected.createdAt],
    ['update-time', row.updated_at, expected.updatedAt]
  ] as const) {
    if (actual !== wanted) return field === 'preflight-snapshot'
      ? `${field}-changed; expected identical saved JSON; actual different JSON`
      : `${field}-changed; expected ${diagnosticValue(wanted)}; actual ${diagnosticValue(actual)}`;
  }
  if (row.failure_code !== null) return 'execution-failure-present';
  if (row.preflight_failure_json !== null) return 'preflight-failure-present';
  if (!sqliteIntegerEquals(orderCount, 0)) return `strategy-orders-present; expected 0; actual ${diagnosticValue(orderCount)}`;
  return null;
}

export class SqliteStrategyRepository implements StrategyRepository {
  private readonly insertStrategy;
  private readonly selectStrategy;
  private readonly countStrategyOrders;
  private readonly updateConfirmation;
  private readonly claimStrategy;
  private readonly selectRecoverable;
  private readonly insertOrder;
  private readonly selectOrder;
  private readonly selectOrders;
  private readonly selectLatestEvent;
  private readonly insertEvent;
  private readonly updateOrderSnapshot;
  private readonly markOrderDefinitelyNotSubmitted;
  private readonly selectEvents;
  private readonly planOrderTransaction;
  private readonly planOrdersAtomicallyTransaction;
  private readonly attachSnapshotTransaction;
  private confirmPreflightTransaction: (
    expected: Readonly<StrategyRecord>
  ) => void;
  private readonly invalidatePreflightTransaction: (
    expected: Readonly<StrategyRecord>,
    failure: ErrorDetail
  ) => void;
  private poisonedError: TradeOpsError | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly clock: () => Date = () => new Date()
  ) {
    prepareStrategySchema(this.database);
    this.insertStrategy = this.database.prepare(`
      INSERT INTO strategies (
        id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
        requested_base_quantity, effective_base_quantity, preflight_json,
        failure_code, preflight_failure_json, created_at, updated_at
      ) VALUES (
        @id, @state, @mode, @spotExchangeId, @contractExchangeId, @symbol,
        @requestedBaseQuantity, @effectiveBaseQuantity, @preflightJson,
        NULL, NULL, @createdAt, @updatedAt
      )
    `);
    this.selectStrategy = this.database.prepare(
      'SELECT * FROM strategies WHERE id = ?'
    );
    this.countStrategyOrders = this.database.prepare(`
      SELECT COUNT(*)
      FROM strategy_orders
      WHERE strategy_id = ?
    `).pluck();
    this.updateConfirmation = this.database.prepare(`
      UPDATE strategies
      SET
        state = @targetState,
        failure_code = NULL,
        preflight_failure_json = @preflightFailureJson,
        updated_at = @nextUpdatedAt
      WHERE
        id = @id
        AND state = @state
        AND mode = @mode
        AND spot_exchange_id = @spotExchangeId
        AND contract_exchange_id = @contractExchangeId
        AND symbol = @symbol
        AND requested_base_quantity = @requestedBaseQuantity
        AND effective_base_quantity = @effectiveBaseQuantity
        AND preflight_json = @preflightJson
        AND failure_code IS NULL
        AND preflight_failure_json IS NULL
        AND created_at = @createdAt
        AND updated_at = @updatedAt
        AND NOT EXISTS (
          SELECT 1 FROM strategy_orders WHERE strategy_id = @id
        )
    `);
    this.claimStrategy = this.database.prepare(`
      UPDATE strategies
      SET
        state = 'EXECUTING',
        failure_code = NULL,
        preflight_failure_json = NULL,
        updated_at = @updatedAt
      WHERE
        id = @id
        AND state = 'PENDING_CONFIRMATION'
        AND failure_code IS NULL
        AND preflight_failure_json IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM strategy_orders WHERE strategy_id = @id
        )
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
        submission_disposition, submission_failure_code,
        created_at, updated_at
      ) VALUES (
        @id, @strategyId, @role, @exchangeId, @clientOrderId,
        NULL, @requestJson, NULL, 'planned',
        'SUBMISSION_UNCERTAIN', NULL, @createdAt, @updatedAt
      )
    `);
    this.selectOrder = this.database.prepare(
      'SELECT * FROM strategy_orders WHERE id = ?'
    );
    this.selectOrders = this.database.prepare(`
      SELECT *
      FROM strategy_orders
      WHERE strategy_id = ?
      ORDER BY rowid
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
        submission_disposition = 'REMOTE_OBSERVED',
        submission_failure_code = NULL,
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
        AND (
          exchange_order_id = @previousExchangeOrderId
          OR (
            exchange_order_id IS NULL
            AND @previousExchangeOrderId IS NULL
          )
        )
        AND submission_disposition = @previousSubmissionDisposition
        AND (
          submission_failure_code = @previousSubmissionFailureCode
          OR (
            submission_failure_code IS NULL
            AND @previousSubmissionFailureCode IS NULL
          )
        )
    `);
    this.markOrderDefinitelyNotSubmitted = this.database.prepare(`
      UPDATE strategy_orders
      SET
        submission_disposition = 'DEFINITELY_NOT_SUBMITTED',
        submission_failure_code = @failureCode,
        updated_at = @updatedAt
      WHERE
        id = @id
        AND status = 'planned'
        AND snapshot_json IS NULL
        AND exchange_order_id IS NULL
        AND submission_disposition = 'SUBMISSION_UNCERTAIN'
        AND submission_failure_code IS NULL
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
    this.planOrdersAtomicallyTransaction = this.database.transaction((
      strategyId: string,
      plans: readonly Readonly<StrategyOrderPlan>[]
    ) => plans.map((plan) => this.planOrderInsideTransaction(
      strategyId,
      plan.role,
      plan.request
    )));
    this.attachSnapshotTransaction = this.database.transaction((
      strategyOrderId: string,
      snapshot: OrderSnapshot
    ) => this.attachSnapshotInsideTransaction(strategyOrderId, snapshot));
    this.confirmPreflightTransaction = this.database.transaction((
      expected: Readonly<StrategyRecord>
    ) => this.writeConfirmation(
      confirmationExpectedRow(expected),
      'EXECUTING',
      null
    ));
    this.invalidatePreflightTransaction = this.database.transaction((
      expected: Readonly<StrategyRecord>,
      failure: ErrorDetail
    ) => this.writeConfirmation(
      confirmationExpectedRow(expected),
      'PREFLIGHT_INVALIDATED',
      JSON.stringify(failure)
    ));
  }

  createPending(preflight: PreflightResult): StrategyRecord {
    this.assertUsable();
    const snapshot = publicPreflightSnapshot(preflight);
    const id = randomUUID();
    const now = this.clock().toISOString();
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
    this.assertUsable();
    const strategyId = nonEmptyString(id, 'strategy id', 128);
    const row = this.selectStrategy.get(strategyId) as StrategyDbRow | undefined;
    if (row === undefined) {
      throw new StrategyNotFoundError();
    }
    return this.strategyFromRow(row);
  }

  confirmPreflight(expected: Readonly<StrategyRecord>): void {
    this.assertUsable();
    const snapshot = confirmationExpectedRow(expected);
    if (this.database.inTransaction) {
      throw storageOperationError(snapshot.id, 'external-transaction-active');
    }
    this.runConfirmationOperation(
      snapshot,
      () => this.confirmPreflightTransaction(expected)
    );
  }

  invalidatePreflight(
    expected: Readonly<StrategyRecord>,
    failure: ErrorDetail
  ): void {
    this.assertUsable();
    const snapshot = confirmationExpectedRow(expected);
    let validatedFailure: ErrorDetail;
    try {
      validatedFailure = parseErrorDetail(failure);
      if (validatedFailure.phase !== 'confirmation') {
        throw new TypeError(`confirmation failure phase: expected confirmation; actual ${diagnosticValue(validatedFailure.phase)}`);
      }
    } catch (error) {
      throw storageRecordError(
        snapshot.id,
        'confirmation-failure-contract-invalid',
        { cause: error }
      );
    }
    if (this.database.inTransaction) {
      throw storageOperationError(snapshot.id, 'external-transaction-active');
    }
    this.runConfirmationOperation(
      snapshot,
      () => this.invalidatePreflightTransaction(expected, validatedFailure)
    );
  }

  claimForExecution(id: string): boolean {
    this.assertUsable();
    const strategyId = nonEmptyString(id, 'strategy id', 128);
    const result = this.claimStrategy.run({
      id: strategyId,
      updatedAt: this.clock().toISOString()
    });
    return sqliteIntegerEquals(result.changes, 1);
  }

  planOrder(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord {
    this.assertUsable();
    return this.planOrderTransaction(strategyId, role, request);
  }

  planOrdersAtomically(
    strategyId: string,
    plans: readonly Readonly<StrategyOrderPlan>[]
  ): StrategyOrderRecord[] {
    this.assertUsable();
    return this.planOrdersAtomicallyTransaction(strategyId, plans);
  }

  attachOrderSnapshot(
    strategyOrderId: string,
    snapshot: OrderSnapshot
  ): SnapshotAttachmentResult {
    this.assertUsable();
    return this.attachSnapshotTransaction(strategyOrderId, snapshot);
  }

  markDefinitelyNotSubmitted(
    strategyOrderId: string,
    failureCode: OrderSubmissionFailureCode
  ): boolean {
    this.assertUsable();
    const orderId = nonEmptyString(
      strategyOrderId,
      'strategy order id',
      128
    );
    const safeFailureCode = enumValue(
      failureCode,
      ORDER_SUBMISSION_FAILURE_CODES,
      'order submission failure code'
    );
    const result = this.markOrderDefinitelyNotSubmitted.run({
      id: orderId,
      failureCode: safeFailureCode,
      updatedAt: this.clock().toISOString()
    });
    return sqliteIntegerEquals(result.changes, 1);
  }

  listOrders(strategyId: string): StrategyOrderRecord[] {
    this.assertUsable();
    const strategy = this.getStrategy(strategyId);
    const rows = this.selectOrders.all(strategy.id) as StrategyOrderDbRow[];
    return rows.map((row) => this.orderFromRow(row, strategy, true));
  }

  listOrderEvents(strategyOrderId: string): OrderSnapshot[] {
    this.assertUsable();
    const order = this.getOrder(strategyOrderId, false);
    const rows = this.selectEvents.all(order.id) as OrderEventDbRow[];
    const events: OrderSnapshot[] = [];
    let previous: OrderSnapshot | null = null;
    for (const row of rows) {
      const snapshot = safely('persisted order event', () => {
        if (!isPositiveSqliteInteger(row.id)) {
          return invalid('persisted order event', `id: expected positive SQLite integer; actual ${diagnosticValue(row.id)}`);
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
        `latest event does not match latest order snapshot; expected ${order.snapshot === null ? '0 events' : 'at least one event with identical latest snapshot'}; actual count=${events.length}, latestMatches=${JSON.stringify(events.at(-1)) === JSON.stringify(order.snapshot)}`
      );
    }
    return events;
  }

  transition(
    strategyId: string,
    from: StrategyState[],
    to: StrategyState,
    failureCode?: StrategyFailureCode
  ): boolean {
    this.assertUsable();
    const id = nonEmptyString(strategyId, 'strategy id', 128);
    const target = enumValue(to, STRATEGY_STATES, 'strategy state');
    if (!Array.isArray(from) || from.length === 0) {
      throw new Error(`invalid source state list: at least one state is required; actual ${diagnosticValue(from)}`);
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
    const safeFailureCode = failureCode === undefined
      ? null
      : enumValue(
        failureCode,
        STRATEGY_FAILURE_CODES,
        'strategy failure code'
      );
    if (
      FAILURE_STATES.has(target) !== (safeFailureCode !== null)
    ) {
      throw new Error(
        `invalid strategy failure code: must match the target state; expected failure present=${FAILURE_STATES.has(target)}; actual target=${target}, failureCode=${safeFailureCode}`
      );
    }
    const placeholders = sources.map(() => '?').join(', ');
    const statement = this.database.prepare(`
      UPDATE strategies
      SET state = ?, failure_code = ?, updated_at = ?
      WHERE
        id = ?
        AND state IN (${placeholders})
        AND failure_code IS NULL
        AND preflight_failure_json IS NULL
    `);
    const result = statement.run(
      target,
      safeFailureCode,
      this.clock().toISOString(),
      id,
      ...sources
    );
    return sqliteIntegerEquals(result.changes, 1);
  }

  listRecoverable(): StrategyRecord[] {
    this.assertUsable();
    return (this.selectRecoverable.all() as StrategyDbRow[])
      .map((row) => this.strategyFromRow(row));
  }

  private assertUsable(): void {
    if (this.poisonedError !== null) throw this.poisonedError;
  }

  private poison(expected: ConfirmationExpectedRow, actual: string, cause: unknown): void {
    this.poisonedError ??= storageOperationError(expected.id, actual, { cause });
  }

  private confirmationMismatch(
    expected: ConfirmationExpectedRow
  ): string | null {
    const row = this.selectStrategy.get(expected.id) as StrategyDbRow | undefined;
    const orderCount = this.countStrategyOrders.get(expected.id);
    return confirmationMismatch(row, expected, orderCount);
  }

  private runConfirmationOperation(
    expected: ConfirmationExpectedRow,
    operation: () => void
  ): void {
    try {
      operation();
    } catch (error) {
      if (this.database.inTransaction) {
        this.poison(expected, 'confirmation-transaction-still-active; expected inTransaction=false; actual true', error);
        throw this.poisonedError;
      }
      const trusted = trustedTradeOpsFailure(error, 'storage');
      if (
        trusted?.detail.code === 'STORAGE_TRANSITION_REJECTED'
      ) {
        throw trusted;
      }
      let mismatch: string | null;
      try {
        mismatch = this.confirmationMismatch(expected);
      } catch (verificationError) {
        this.poison(
          expected,
          `rollback-verification:${safeFailureCategory(verificationError)}`,
          new AggregateError([error, verificationError], 'confirmation transaction and rollback verification failed')
        );
        throw this.poisonedError;
      }
      if (mismatch !== null) {
        this.poison(expected, `rollback-verification:${mismatch}`, error);
        throw this.poisonedError;
      }
      throw storageOperationError(
        expected.id,
        `transaction-failed:${safeFailureCategory(error)};rollback-verified`,
        { cause: error }
      );
    }
  }

  private writeConfirmation(
    expected: ConfirmationExpectedRow,
    targetState: 'EXECUTING' | 'PREFLIGHT_INVALIDATED',
    preflightFailureJson: string | null
  ): void {
    const mismatch = this.confirmationMismatch(expected);
    if (mismatch !== null) {
      throw storageTransitionError(expected.id, mismatch);
    }
    const nextUpdatedDate = this.clock();
    const nextUpdatedAt = nextUpdatedDate.toISOString();
    if (
      nextUpdatedDate.getTime()
      < new Date(expected.updatedAt).getTime()
    ) {
      throw confirmationClockRollbackError(
        expected.id,
        expected.updatedAt,
        nextUpdatedAt
      );
    }
    const result = this.updateConfirmation.run({
      ...expected,
      targetState,
      preflightFailureJson,
      nextUpdatedAt
    });
    if (!sqliteIntegerEquals(result.changes, 1)) {
      throw storageTransitionError(
        expected.id,
        'conditional-confirmation-cas-updated-zero-rows'
      );
    }
  }

  private planOrderInsideTransaction(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord {
    const strategy = this.getStrategy(strategyId);
    if (strategy.state === 'PENDING_CONFIRMATION') {
      return invalid(
        'order plan',
        'strategy state requires confirmation before order planning'
      );
    }
    if (strategy.state === 'PREFLIGHT_INVALIDATED') {
      return invalid(
        'order plan',
        'strategy state is invalidated and cannot plan orders'
      );
    }
    if (strategy.state !== 'EXECUTING' && strategy.state !== 'WAITING_HEDGE') {
      return invalid('order plan', `strategy state does not allow order planning; expected EXECUTING or WAITING_HEDGE; actual ${strategy.state}`);
    }
    const validated = validatedRequestForRole(strategy, role, request, false);
    const id = randomUUID();
    const now = this.clock().toISOString();
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
  ): SnapshotAttachmentResult {
    const order = this.getOrder(strategyOrderId);
    let snapshot: OrderSnapshot;
    try {
      snapshot = validatedSnapshot(
        value,
        order,
        order.snapshot,
        'order snapshot'
      );
    } catch (error) {
      const detail = error instanceof StorageValidationError
        && error.message.startsWith('invalid order snapshot')
        ? error.message
        : 'invalid order snapshot: validation failed';
      throw new OrderSnapshotValidationError(detail, { cause: error });
    }
    if (
      order.snapshot !== null
      && sameSnapshotSemantics(order.snapshot, snapshot)
    ) {
      return 'unchanged';
    }
    const snapshotJson = JSON.stringify(snapshot);
    const recordedAt = this.clock().toISOString();
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
        : JSON.stringify(order.snapshot),
      previousExchangeOrderId: order.exchangeOrderId,
      previousSubmissionDisposition: order.submissionDisposition,
      previousSubmissionFailureCode: order.submissionFailureCode
    });
    if (!sqliteIntegerEquals(result.changes, 1)) {
      throw new OrderSnapshotWriteConflictError();
    }
    return 'attached';
  }

  private strategyFromRow(row: StrategyDbRow): StrategyRecord {
    const recordId = typeof row.id === 'string'
      && row.id.length > 0
      && row.id.length <= 128
      ? row.id
      : 'unknown-strategy-record';
    try {
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
            `columns do not match preflight snapshot; expected ${JSON.stringify({ mode: preflight.mode, spotExchangeId: preflight.spotExchangeId, contractExchangeId: preflight.contractExchangeId, symbol: preflight.symbol, requestedBaseQuantity: preflight.requestedBaseQuantity, effectiveBaseQuantity: preflight.effectiveBaseQuantity })}; actual ${JSON.stringify({ mode, spotExchangeId, contractExchangeId, symbol, requestedBaseQuantity, effectiveBaseQuantity })}`
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
          return invalid('persisted strategy', `update time precedes creation; expected at least ${createdAt}; actual ${updatedAt}`);
        }
        const failureCode = row.failure_code === null
          ? null
          : enumValue(
            row.failure_code,
            STRATEGY_FAILURE_CODES,
            'persisted strategy failure code'
          );
        if (FAILURE_STATES.has(state) !== (failureCode !== null)) {
          return invalid(
            'persisted strategy',
            `execution failure code does not match state; expected failure code present=${FAILURE_STATES.has(state)}; actual state=${state}, failureCode=${failureCode}`
          );
        }
        const preflightFailure = row.preflight_failure_json === null
          ? null
          : parseErrorDetail(parseJson(
            row.preflight_failure_json,
            'persisted strategy preflight failure'
          ));
        if (
          preflightFailure !== null
          && preflightFailure.phase !== 'confirmation'
        ) {
          return invalid(
            'persisted strategy',
            `preflight failure phase is not confirmation; actual ${preflightFailure.phase}`
          );
        }
        if (
          (state === 'PREFLIGHT_INVALIDATED')
          !== (preflightFailure !== null)
        ) {
          return invalid(
            'persisted strategy',
            `preflight failure does not match state; expected present=${state === 'PREFLIGHT_INVALIDATED'}; actual present=${preflightFailure !== null}, state=${state}`
          );
        }
        if (
          (state === 'PENDING_CONFIRMATION'
            || state === 'PREFLIGHT_INVALIDATED')
          && !sqliteIntegerEquals(this.countStrategyOrders.get(id), 0)
        ) {
          return invalid(
            'persisted strategy',
            'pending or invalidated strategy has orders'
          );
        }
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
          failureCode,
          preflightFailure,
          createdAt,
          updatedAt
        });
      });
    } catch (error) {
      const actual = error instanceof Error
        && error.message.startsWith('invalid persisted strategy:')
        ? error.message
        : `strategy-validation:${safeFailureCategory(error)}`;
      throw storageRecordError(recordId, actual, { cause: error });
    }
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
          `strategy id does not match parent; expected ${strategy.id}; actual ${strategyId}`
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
          `identity columns do not match request; expected exchangeId=${validated.exchangeId}, clientOrderId=${validated.request.clientOrderId}; actual exchangeId=${exchangeId}, clientOrderId=${clientOrderId}`
        );
      }
      const status = enumValue(
        row.status,
        ORDER_STATUSES,
        'persisted strategy order status'
      );
      const submissionDisposition = enumValue(
        row.submission_disposition,
        ORDER_SUBMISSION_DISPOSITIONS,
        'persisted strategy order submission disposition'
      );
      const submissionFailureCode = row.submission_failure_code === null
        ? null
        : enumValue(
          row.submission_failure_code,
          ORDER_SUBMISSION_FAILURE_CODES,
          'persisted strategy order submission failure code'
        );
      if (
        (submissionDisposition === 'DEFINITELY_NOT_SUBMITTED')
        !== (submissionFailureCode !== null)
      ) {
        return invalid(
          'persisted strategy order',
          `submission disposition does not match failure evidence; expected failure present=${submissionDisposition === 'DEFINITELY_NOT_SUBMITTED'}; actual disposition=${submissionDisposition}, failureCode=${submissionFailureCode}`
        );
      }
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
          `update time precedes creation; expected at least ${createdAt}; actual ${updatedAt}`
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
        submissionDisposition,
        submissionFailureCode,
        createdAt,
        updatedAt
      };
      let snapshot: OrderSnapshot | null = null;
      let exchangeOrderId: string | null = null;
      if (status === 'planned') {
        if (
          row.snapshot_json !== null
          || row.exchange_order_id !== null
          || submissionDisposition === 'REMOTE_OBSERVED'
        ) {
          return invalid(
            'persisted strategy order',
            `planned order cannot report a snapshot or fill; expected snapshot/exchangeOrderId null and disposition not REMOTE_OBSERVED; actual snapshotPresent=${row.snapshot_json !== null}, exchangeOrderId=${diagnosticValue(row.exchange_order_id)}, disposition=${submissionDisposition}`
          );
        }
      } else {
        if (
          row.snapshot_json === null
          || row.exchange_order_id === null
          || submissionDisposition !== 'REMOTE_OBSERVED'
        ) {
          return invalid(
            'persisted strategy order',
            `snapshot status requires a snapshot and exchange order id and REMOTE_OBSERVED; actual status=${status}, snapshotPresent=${row.snapshot_json !== null}, exchangeOrderId=${diagnosticValue(row.exchange_order_id)}, disposition=${submissionDisposition}`
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
            `snapshot does not match latest status columns; expected status=${status}, exchangeOrderId=${exchangeOrderId}; actual status=${snapshot.status}, exchangeOrderId=${snapshot.exchangeOrderId}`
          );
        }
      }
      if (verifyEvents) {
        const eventRow = this.selectLatestEvent.get(
          id,
          id
        ) as LatestEventDbRow;
        if (!isNonNegativeSqliteInteger(eventRow.event_count)) {
          return invalid(
            'persisted strategy order',
            `event count is invalid; expected non-negative SQLite integer; actual ${diagnosticValue(eventRow.event_count)}`
          );
        }
        if (
          (snapshot === null && !sqliteIntegerEquals(
            eventRow.event_count,
            0
          ))
          || (
            snapshot !== null
            && (
              sqliteIntegerEquals(eventRow.event_count, 0)
              || eventRow.latest_snapshot_json !== row.snapshot_json
            )
          )
        ) {
          return invalid(
            'persisted strategy order',
            `latest snapshot does not match immutable events; expected count ${snapshot === null ? '0' : '>0 and identical snapshot'}; actual count=${diagnosticValue(eventRow.event_count)}, latestMatches=${eventRow.latest_snapshot_json === row.snapshot_json}`
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
