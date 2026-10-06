import { resolve } from 'node:path';
import type { RuntimeStatus } from '../operations/runtime-status.js';
import { registerStatusRoutes } from './status-routes.js';
import { isNativeError, isProxy } from 'node:util/types';
import staticPlugin from '@fastify/static';
import { Decimal } from 'decimal.js';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions
} from 'fastify';
import type {
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../domain/types.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import type {
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../storage/strategy-repository.js';
import { StrategyNotFoundError } from '../storage/strategy-repository.js';
import type { HedgeCoordinator } from '../strategy/hedge-coordinator.js';
import type { ConfirmationService } from '../strategy/confirmation-service.js';
import type {
  PreflightInput,
  PreflightResult,
  PreflightService
} from '../strategy/preflight-service.js';
import {
  LOGGER_REDACT_PATHS,
  nonEmptySecrets,
  nonThrowingLogCall,
  nonThrowingOperationalLog,
  redactText,
  utf8Prefix,
  type OperationalLog
} from '../logging/logger.js';
import {
  createTradeOpsError,
  projectTradeOpsError,
  safeFailureCategory,
  withErrorPhase,
  type ErrorCode,
  type ErrorDetail,
  type SafeDiagnosticValue,
  type TradeOpsError
} from '../errors/trade-ops-error.js';
import {
  createRequestBodyCapture,
  createRequestBodyCaptureTransform,
  RAW_REQUEST_BODY_CAPTURE_LIMIT,
  type RequestBodyCapture
} from './request-body-capture.js';
import {
  publicErrorDetail,
  type PublicErrorDetail
} from './public-error.js';

export { LOGGER_REDACT_PATHS } from '../logging/logger.js';

export interface BuildServerDependencies {
  readonly runtimeStatus?: RuntimeStatus;
  readonly registry: Pick<ExchangeRegistry, 'ids'>;
  readonly preflightService: Pick<PreflightService, 'run'>;
  readonly confirmationService: Pick<ConfirmationService, 'confirm'>;
  readonly repository: StrategyRepository;
  readonly coordinator: Pick<HedgeCoordinator, 'confirmAndExecute'>;
  readonly logger?: FastifyServerOptions['logger'];
  readonly loggerInstance?: FastifyBaseLogger;
  readonly operationalLog?: OperationalLog;
  readonly secretProvider?: () => readonly string[];
  readonly publicDirectory?: string;
}



const HTTP_REQUEST_BODY_LOG_LIMIT = 8192;
const UNAVAILABLE = '[Unavailable]';
const REDACTED = '[Redacted]';
const CREDENTIAL_KEYS = new Set([
  'apikey',
  'secret',
  'password',
  'passphrase',
  'signature',
  'authorization',
  'cookie',
  'credentials',
  'auth'
]);

interface HttpErrorForLog {
  readonly code: string;
  readonly message: string;
  readonly error?: PublicErrorDetail;
}

interface RequestLogState {
  readonly method: string;
  readonly url: string;
  readonly capture: RequestBodyCapture;
  bodyObservationAllowed: boolean;
  httpError?: HttpErrorForLog;
}

function fallbackHttpError(statusCode: number): HttpErrorForLog {
  return {
    code: 'HTTP_ERROR',
    message: `HTTP request failed with status ${statusCode}`
  };
}

function trustedFailure(error: unknown): TradeOpsError | undefined {
  try {
    const trusted = error as TradeOpsError;
    withErrorPhase(trusted, 'request');
    return trusted;
  } catch {
    return undefined;
  }
}

function isLegacyStrategyNotFound(error: unknown): boolean {
  try {
    return typeof error === 'object'
      && error !== null
      && !isProxy(error)
      && isNativeError(error)
      && Object.getPrototypeOf(error) === StrategyNotFoundError.prototype;
  } catch {
    return false;
  }
}

type FastifyParserFailure =
  | 'FST_ERR_CTP_INVALID_JSON_BODY'
  | 'FST_ERR_CTP_BODY_TOO_LARGE'
  | 'FST_ERR_CTP_EMPTY_JSON_BODY'
  | 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
  | 'FST_ERR_CTP_INVALID_CONTENT_LENGTH';

function fastifyParserFailure(error: unknown): FastifyParserFailure | undefined {
  try {
    if (typeof error !== 'object' || error === null || isProxy(error)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(error);
    if (
      prototype
      === Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY.prototype
    ) {
      return 'FST_ERR_CTP_INVALID_JSON_BODY';
    }
    if (
      prototype
      === Fastify.errorCodes.FST_ERR_CTP_BODY_TOO_LARGE.prototype
    ) {
      return 'FST_ERR_CTP_BODY_TOO_LARGE';
    }
    if (
      prototype
      === Fastify.errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY.prototype
    ) {
      return 'FST_ERR_CTP_EMPTY_JSON_BODY';
    }
    if (
      prototype
      === Fastify.errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE.prototype
    ) {
      return 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    }
    if (
      prototype
      === Fastify.errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH.prototype
    ) {
      return 'FST_ERR_CTP_INVALID_CONTENT_LENGTH';
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isFastifyBadUrl(error: unknown): boolean {
  try {
    return typeof error === 'object'
      && error !== null
      && !isProxy(error)
      && Object.getPrototypeOf(error)
        === Fastify.errorCodes.FST_ERR_BAD_URL.prototype;
  } catch {
    return false;
  }
}

function parserFailureActual(failure: FastifyParserFailure): string {
  switch (failure) {
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return 'malformed JSON';
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return 'body too large';
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return 'empty JSON body';
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return 'unsupported media type';
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return 'invalid content length';
  }
}

function requestFailure(
  code: Extract<ErrorCode,
    | 'REQUEST_FORBIDDEN'
    | 'REQUEST_BODY_INVALID'
    | 'REQUEST_FIELD_INVALID'
    | 'REQUEST_OPERATION_FAILED'
    | 'REQUEST_ROUTE_NOT_FOUND'>,
  field: string,
  expected: SafeDiagnosticValue,
  actual: SafeDiagnosticValue,
  options?: ErrorOptions
): TradeOpsError {
  return createTradeOpsError({
    code,
    phase: 'request',
    subject: { type: 'request', field },
    expected,
    actual
  }, undefined, options);
}

function operationFailure(operation: string, error: unknown): TradeOpsError {
  return requestFailure(
    'REQUEST_OPERATION_FAILED',
    operation,
    `successful ${operation}`,
    safeFailureCategory(error),
    { cause: error }
  );
}

function projectionFallback(): TradeOpsError {
  return requestFailure(
    'REQUEST_OPERATION_FAILED',
    'errorProjection',
    'safe public error detail',
    'projection unavailable'
  );
}

function errorSummary(detail: Readonly<ErrorDetail>): string {
  const subjectStart = detail.message.indexOf('（');
  return subjectStart < 0
    ? '请求处理失败'
    : detail.message.slice(0, subjectStart);
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[_-]/gu, ''));
}

function safeJsonValue(
  value: unknown,
  secrets: readonly string[],
  seen = new Set<object>(),
  redactCredentialKeys = false
): unknown | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value as number) || typeof value !== 'number' ? value : null;
  }
  if (typeof value === 'string') return redactText(value, secrets);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        const safe = safeJsonValue(
          item,
          secrets,
          seen,
          redactCredentialKeys
        );
        result.push(safe === undefined ? null : safe);
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const safeKey = redactText(key, secrets);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      if (redactCredentialKeys && isCredentialKey(key)) {
        result[safeKey] = REDACTED;
        continue;
      }
      const safe = safeJsonValue(
        descriptor.value,
        secrets,
        seen,
        redactCredentialKeys
      );
      if (safe !== undefined) result[safeKey] = safe;
    }
    return result;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function bodyForLog(
  request: FastifyRequest,
  state: RequestLogState,
  secrets: readonly string[]
): { readonly body: unknown; readonly truncated: boolean; readonly originalByteLength: number } {
  if (!state.bodyObservationAllowed) {
    return { body: null, truncated: false, originalByteLength: 0 };
  }
  let body: unknown;
  const parsedBodyAvailable = request.body !== undefined;
  if (parsedBodyAvailable) {
    body = safeJsonValue(request.body, secrets, new Set(), true);
    if (body === undefined) body = null;
  }
  if (!parsedBodyAvailable) {
    const captured = state.capture.result();
    if (captured.status === 'complete' && captured.byteLength > 0) {
      body = UNAVAILABLE;
    } else if (captured.status !== 'complete') {
      body = UNAVAILABLE;
    }
  }
  if (body === undefined) body = null;
  let serialized: string;
  try {
    serialized = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    body = UNAVAILABLE;
    serialized = UNAVAILABLE;
  }
  const originalByteLength = Buffer.byteLength(serialized, 'utf8');
  const truncated = originalByteLength > HTTP_REQUEST_BODY_LOG_LIMIT;
  return {
    body: truncated ? utf8Prefix(serialized, HTTP_REQUEST_BODY_LOG_LIMIT) : body,
    truncated,
    originalByteLength
  };
}

function urlForLog(url: string, secrets: readonly string[]): string {
  if (url === UNAVAILABLE) return UNAVAILABLE;
  try {
    const queryStart = url.indexOf('?');
    const path = redactText(
      queryStart < 0 ? url : url.slice(0, queryStart),
      secrets
    );
    if (queryStart < 0) return path;
    const projected = new URLSearchParams();
    const query = new URLSearchParams(url.slice(queryStart + 1));
    for (const [key, value] of query) {
      projected.append(
        redactText(key, secrets),
        isCredentialKey(key) ? REDACTED : redactText(value, secrets)
      );
    }
    return `${path}?${projected.toString()}`;
  } catch {
    return UNAVAILABLE;
  }
}

function applySecurityHeaders(reply: FastifyReply, noStore: boolean): void {
  reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  if (noStore) {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
  } else {
    reply.header('Cache-Control', 'no-cache');
  }
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'spotExchangeId',
    'contractExchangeId',
    'symbol',
    'requestedBaseQuantity',
    'mode'
  ],
  properties: {
    spotExchangeId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    },
    contractExchangeId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    },
    symbol: {
      type: 'string',
      minLength: 6,
      maxLength: 64,
      pattern: '^[A-Z0-9][A-Z0-9._-]{0,30}/USDT$'
    },
    requestedBaseQuantity: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$'
    },
    mode: {
      type: 'string',
      enum: ['CONCURRENT', 'CONTRACT_FIRST', 'SPOT_FIRST']
    }
  }
} as const;

const CONFIRM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['riskAcknowledged'],
  properties: {
    riskAcknowledged: { const: true }
  }
} as const;

const STRATEGY_ID_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    }
  }
} as const;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'"
].join('; ');

const MAX_STATUS_PRECISION = 1_000_000;
const MAX_FIXED_EXPONENT = 10_000;
const StatusDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: -9_000_000_000_000_000,
  maxE: 9_000_000_000_000_000
});

function publicMarket(market: Readonly<MarketRules>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    exchangeId: market.exchangeId,
    symbol: market.symbol,
    marketId: market.marketId,
    kind: market.kind,
    base: market.base,
    quote: market.quote,
    active: market.active,
    amountStep: market.amountStep,
    contractSize: market.contractSize,
    minBaseAmount: market.minBaseAmount,
    priceStep: market.priceStep
  };
  if (market.maxBaseAmount !== undefined) {
    result.maxBaseAmount = market.maxBaseAmount;
  }
  if (market.minQuoteNotional !== undefined) {
    result.minQuoteNotional = market.minQuoteNotional;
  }
  if (market.maxQuoteNotional !== undefined) {
    result.maxQuoteNotional = market.maxQuoteNotional;
  }
  return result;
}

function publicPreflight(
  value: Readonly<PreflightResult>
): Record<string, unknown> {
  return {
    spotExchangeId: value.spotExchangeId,
    contractExchangeId: value.contractExchangeId,
    symbol: value.symbol,
    requestedBaseQuantity: value.requestedBaseQuantity,
    mode: value.mode,
    effectiveBaseQuantity: value.effectiveBaseQuantity,
    spotMarket: publicMarket(value.spotMarket),
    contractMarket: publicMarket(value.contractMarket),
    accountSettings: {
      marginMode: value.accountSettings.marginMode,
      positionMode: value.accountSettings.positionMode,
      leverage: value.accountSettings.leverage
    },
    spotFreeUsdt: value.spotFreeUsdt,
    contractFreeUsdt: value.contractFreeUsdt,
    spotReferencePrice: value.spotReferencePrice,
    contractReferencePrice: value.contractReferencePrice,
    riskAcknowledgementRequired: value.riskAcknowledgementRequired,
    createdAt: value.createdAt
  };
}

function publicStrategy(
  strategy: Readonly<StrategyRecord>,
  preflightFailure: PublicErrorDetail | null
): Record<string, unknown> {
  return {
    id: strategy.id,
    state: strategy.state,
    mode: strategy.mode,
    spotExchangeId: strategy.spotExchangeId,
    contractExchangeId: strategy.contractExchangeId,
    symbol: strategy.symbol,
    requestedBaseQuantity: strategy.requestedBaseQuantity,
    effectiveBaseQuantity: strategy.effectiveBaseQuantity,
    failureCode: strategy.failureCode,
    preflightFailure,
    createdAt: strategy.createdAt,
    updatedAt: strategy.updatedAt
  };
}

function publicOrderRequest(
  request: Readonly<OrderRequest>
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    symbol: request.symbol,
    kind: request.kind,
    type: request.type,
    side: request.side,
    baseQuantity: request.baseQuantity,
    clientOrderId: request.clientOrderId
  };
  if (request.price !== undefined) {
    result.price = request.price;
  }
  if (request.timeInForce !== undefined) {
    result.timeInForce = request.timeInForce;
  }
  if (request.positionSide !== undefined) {
    result.positionSide = request.positionSide;
  }
  if (request.marginMode !== undefined) {
    result.marginMode = request.marginMode;
  }
  return result;
}

function publicOrderSnapshot(
  snapshot: Readonly<OrderSnapshot>
): Record<string, unknown> {
  return {
    exchangeId: snapshot.exchangeId,
    exchangeOrderId: snapshot.exchangeOrderId,
    clientOrderId: snapshot.clientOrderId,
    symbol: snapshot.symbol,
    kind: snapshot.kind,
    type: snapshot.type,
    side: snapshot.side,
    requestedBaseQuantity: snapshot.requestedBaseQuantity,
    filledBaseQuantity: snapshot.filledBaseQuantity,
    remainingBaseQuantity: snapshot.remainingBaseQuantity,
    averagePrice: snapshot.averagePrice,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt
  };
}

function publicOrder(
  order: Readonly<StrategyOrderRecord>
): Record<string, unknown> {
  return {
    id: order.id,
    strategyId: order.strategyId,
    role: order.role,
    exchangeId: order.exchangeId,
    clientOrderId: order.clientOrderId,
    exchangeOrderId: order.exchangeOrderId,
    request: publicOrderRequest(order.request),
    snapshot: order.snapshot === null
      ? null
      : publicOrderSnapshot(order.snapshot),
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function statusDecimal(value: string, field: string): Decimal {
  if (value.length === 0 || value.length > 10_000) {
    throw new Error(`${field}: expected string length 1..10000; actual length ${value.length}`);
  }
  let parsed: Decimal;
  try {
    parsed = new StatusDecimal(value);
  } catch (error) {
    throw new Error(`${field}: expected decimal; actual malformed string length ${value.length}`, { cause: error });
  }
  if (!parsed.isFinite()) {
    throw new Error(`${field}: expected finite decimal; actual ${parsed.toString()}`);
  }
  if (parsed.isNegative()) {
    throw new Error(`${field}: expected non-negative decimal; actual ${parsed.toString()}`);
  }
  return parsed;
}

function exactStatusConstructor(
  values: readonly string[],
  field: string
): Decimal.Constructor {
  const parsed = values.map((value, index) => statusDecimal(value, `${field}.source[${index}].filledBaseQuantity`));
  const highestExponent = Math.max(...parsed.map((value) => value.e));
  const lowestSignificantExponent = Math.min(...parsed.map(
    (value) => value.e - value.sd() + 1
  ));
  const carryDigits = Math.ceil(Math.log10(values.length + 1));
  const requiredPrecision =
    highestExponent - lowestSignificantExponent + carryDigits + 4;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision <= 0
    || requiredPrecision > MAX_STATUS_PRECISION
  ) {
    throw new Error(`${field}.requiredPrecision: expected safe integer in [1, ${MAX_STATUS_PRECISION}]; actual ${requiredPrecision}`);
  }
  return StatusDecimal.clone({
    precision: Math.max(StatusDecimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN,
    minE: -9_000_000_000_000_000,
    maxE: 9_000_000_000_000_000
  });
}

function formatStatusDecimal(value: Decimal): string {
  if (
    value.e >= -MAX_FIXED_EXPONENT
    && value.e <= MAX_FIXED_EXPONENT
  ) {
    return value.toFixed();
  }
  return value.toString();
}

function exactSum(values: readonly string[], field: string): string {
  if (values.length === 0) {
    return '0';
  }
  const ExactDecimal = exactStatusConstructor(values, field);
  let total = new ExactDecimal(0);
  for (const value of values) {
    total = total.plus(value);
  }
  return formatStatusDecimal(total);
}

function exactAbsoluteDifference(left: string, right: string): string {
  const ExactDecimal = exactStatusConstructor([left, right], 'actualFills.unmatchedBaseQuantity');
  return formatStatusDecimal(
    new ExactDecimal(left).minus(right).abs()
  );
}

function actualFills(
  orders: readonly StrategyOrderRecord[]
): {
  spotBuyBaseQuantity: string;
  contractShortBaseQuantity: string;
  unmatchedBaseQuantity: string;
} {
  const spotFills: string[] = [];
  const contractFills: string[] = [];
  for (const order of orders) {
    const snapshot = order.snapshot;
    if (snapshot === null) {
      continue;
    }
    if (snapshot.kind === 'spot' && snapshot.side === 'buy') {
      spotFills.push(snapshot.filledBaseQuantity);
    }
    if (
      snapshot.kind === 'swap'
      && snapshot.side === 'sell'
      && order.request.positionSide === 'SHORT'
    ) {
      contractFills.push(snapshot.filledBaseQuantity);
    }
  }
  const spotBuyBaseQuantity = exactSum(spotFills, 'actualFills.spotBuyBaseQuantity');
  const contractShortBaseQuantity = exactSum(contractFills, 'actualFills.contractShortBaseQuantity');
  return {
    spotBuyBaseQuantity,
    contractShortBaseQuantity,
    unmatchedBaseQuantity: exactAbsoluteDifference(
      spotBuyBaseQuantity,
      contractShortBaseQuantity
    )
  };
}

function valueCategory(value: unknown): string {
  if (value === null) return 'null';
  const category = typeof value;
  if (category !== 'object') return category;
  try {
    if (isProxy(value)) return 'object';
    return Array.isArray(value) ? 'array' : 'object';
  } catch {
    return 'object';
  }
}

const REQUEST_FIELDS = new Set([
  'spotExchangeId',
  'contractExchangeId',
  'symbol',
  'requestedBaseQuantity',
  'mode',
  'riskAcknowledged',
  'id'
]);

type DataProperty =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

interface ValidationEntry {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: unknown;
}

interface ValidationEvidence {
  readonly field: string;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
}

function ownDataProperty(value: unknown, key: string): DataProperty {
  if (typeof value !== 'object' || value === null) {
    return { kind: 'unavailable' };
  }
  try {
    if (isProxy(value)) return { kind: 'unavailable' };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { kind: 'missing' };
    return 'value' in descriptor
      ? { kind: 'value', value: descriptor.value }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

function firstValidationEntry(validation: unknown): ValidationEntry | undefined {
  if (typeof validation !== 'object' || validation === null) {
    return undefined;
  }
  try {
    if (isProxy(validation) || !Array.isArray(validation)) return undefined;
    const firstDescriptor = Object.getOwnPropertyDescriptor(validation, '0');
    if (firstDescriptor === undefined || !('value' in firstDescriptor)) {
      return undefined;
    }
    const keyword = ownDataProperty(firstDescriptor.value, 'keyword');
    const instancePath = ownDataProperty(firstDescriptor.value, 'instancePath');
    const params = ownDataProperty(firstDescriptor.value, 'params');
    if (
      keyword.kind !== 'value'
      || typeof keyword.value !== 'string'
      || instancePath.kind !== 'value'
      || typeof instancePath.value !== 'string'
      || params.kind !== 'value'
    ) return undefined;
    return {
      keyword: keyword.value,
      instancePath: instancePath.value,
      params: params.value
    };
  } catch {
    return undefined;
  }
}

function validationField(entry: Readonly<ValidationEntry>): string {
  if (entry.keyword === 'additionalProperties') return 'field';
  if (entry.keyword === 'required') {
    const missing = ownDataProperty(entry.params, 'missingProperty');
    return missing.kind === 'value'
      && typeof missing.value === 'string'
      && REQUEST_FIELDS.has(missing.value)
      ? missing.value
      : 'field';
  }
  const match = /^\/([^/]+)$/u.exec(entry.instancePath);
  const candidate = match?.[1];
  return candidate !== undefined && REQUEST_FIELDS.has(candidate)
    ? candidate
    : 'field';
}

function schemaStringList(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    if (isProxy(value) || !Array.isArray(value) || value.length > 16) {
      return undefined;
    }
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined
        || !('value' in descriptor)
        || typeof descriptor.value !== 'string'
        || descriptor.value.length > 2_000
      ) return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function validationExpected(
  entry: Readonly<ValidationEntry>
): SafeDiagnosticValue {
  switch (entry.keyword) {
    case 'required': return 'required field';
    case 'additionalProperties': return 'no additional fields';
    case 'type': {
      const type = ownDataProperty(entry.params, 'type');
      return type.kind === 'value'
        && typeof type.value === 'string'
        && ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']
          .includes(type.value)
        ? type.value
        : 'schema type';
    }
    case 'enum': {
      const values = ownDataProperty(entry.params, 'allowedValues');
      return values.kind === 'value'
        ? schemaStringList(values.value) ?? 'allowed values'
        : 'allowed values';
    }
    case 'pattern': {
      const pattern = ownDataProperty(entry.params, 'pattern');
      return pattern.kind === 'value'
        && typeof pattern.value === 'string'
        && pattern.value.length <= 1_980
        ? `pattern ${pattern.value}`
        : 'matching pattern';
    }
    case 'minLength':
    case 'maxLength': {
      const limit = ownDataProperty(entry.params, 'limit');
      return limit.kind === 'value'
        && typeof limit.value === 'number'
        && Number.isSafeInteger(limit.value)
        && limit.value >= 0
        ? `${entry.keyword} ${limit.value}`
        : `${entry.keyword} limit`;
    }
    case 'const': {
      const allowed = ownDataProperty(entry.params, 'allowedValue');
      return allowed.kind === 'value' && typeof allowed.value === 'boolean'
        ? allowed.value
        : 'required constant';
    }
    default: return 'valid request field';
  }
}

function validationActual(
  entry: Readonly<ValidationEntry>,
  field: string,
  context: string,
  request: FastifyRequest
): SafeDiagnosticValue {
  if (entry.keyword === 'required') return 'missing';
  if (entry.keyword === 'additionalProperties') return 'extra field present';
  if (field === 'field') return 'invalid field value';
  const source = context === 'body'
    ? request.body
    : context === 'params'
      ? request.params
      : undefined;
  const actual = ownDataProperty(source, field);
  if (actual.kind === 'missing') return 'missing';
  if (actual.kind === 'unavailable') return 'unavailable';
  if (entry.keyword === 'const' && typeof actual.value === 'boolean') {
    return actual.value;
  }
  return valueCategory(actual.value);
}

function validationEvidence(
  validation: unknown,
  context: string,
  request: FastifyRequest
): ValidationEvidence {
  const entry = firstValidationEntry(validation);
  if (entry === undefined) {
    return {
      field: 'field',
      expected: 'valid request field',
      actual: 'unavailable'
    };
  }
  const field = validationField(entry);
  return {
    field,
    expected: validationExpected(entry),
    actual: validationActual(entry, field, context, request)
  };
}

interface LoopbackAuthority {
  readonly hostname: 'localhost' | '127.0.0.1' | '[::1]';
  readonly port: number;
}

const LOCAL_HTTP_PROTOCOL = 'http';

function loopbackAuthority(
  value: unknown,
  protocol: string
): LoopbackAuthority | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i
    .exec(value);
  if (match === null) {
    return null;
  }
  const rawHostname = match[1];
  if (rawHostname === undefined) {
    return null;
  }
  const hostname = rawHostname.toLowerCase() as LoopbackAuthority['hostname'];
  const rawPort = match[2];
  const port = rawPort === undefined
    ? protocol === 'https' ? 443 : 80
    : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { hostname, port };
}

function matchingLoopbackOrigin(
  value: unknown,
  requestAuthority: Readonly<LoopbackAuthority>,
  requestProtocol: 'http' | 'https'
): boolean {
  if (typeof value !== 'string' || value === 'null') {
    return false;
  }
  const match = /^(https?):\/\/(.+)$/i.exec(value);
  if (match === null) {
    return false;
  }
  const protocol = match[1]?.toLowerCase();
  const authority = match[2];
  if (
    authority === undefined
    || (protocol !== 'http' && protocol !== 'https')
    || protocol !== requestProtocol
  ) {
    return false;
  }
  const originAuthority = loopbackAuthority(authority, protocol);
  return (
    originAuthority !== null
    && originAuthority.hostname === requestAuthority.hostname
    && originAuthority.port === requestAuthority.port
  );
}

export function buildServer(
  dependencies: BuildServerDependencies
): FastifyInstance {
  const frameworkValidationFailures = new WeakMap<object, {
    readonly validation: readonly unknown[];
    readonly context: string;
  }>();
  const requestsEnteringHandlers = new WeakSet<FastifyRequest>();
  const loggerOptions = dependencies.loggerInstance === undefined
    ? {
        logger: dependencies.logger ?? {
          redact: [...LOGGER_REDACT_PATHS]
        }
      }
    : { loggerInstance: dependencies.loggerInstance };
  const app = Fastify({
    ...loggerOptions,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: RAW_REQUEST_BODY_CAPTURE_LIMIT,
    frameworkErrors(error, request, reply) {
      handleFrameworkError(error, request, reply);
    },
    schemaErrorFormatter(validation, context) {
      const error = new Error('request schema validation failed');
      frameworkValidationFailures.set(error, { validation, context });
      return error;
    },
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false
      }
    }
  });
  const operationalLog = nonThrowingOperationalLog(
    dependencies.operationalLog
  );
  const queuedStrategyIds = new Set<string>();
  const backgroundTasks = new Set<Promise<void>>();
  const requestLogStates = new WeakMap<FastifyRequest, RequestLogState>();
  const completedRequestLogs = new WeakSet<FastifyRequest>();

  function rememberHttpError(
    request: FastifyRequest,
    error: HttpErrorForLog
  ): void {
    const state = requestLogStates.get(request);
    if (state === undefined) return;
    state.httpError = error;
  }

  function projectFailure(error: unknown, includeStack = false): {
    readonly detail: PublicErrorDetail;
    readonly specific: boolean;
  } {
    try {
      const secrets = nonEmptySecrets(dependencies.secretProvider?.() ?? []);
      const detail = includeStack
        ? projectTradeOpsError(error as TradeOpsError, secrets, true)
        : publicErrorDetail(error, secrets);
      if (detail !== undefined) {
        return { detail, specific: true };
      }
      const fallback = publicErrorDetail(projectionFallback(), secrets);
      if (fallback !== undefined) {
        return { detail: fallback, specific: false };
      }
    } catch {
      // Public diagnostics are allowed to degrade without changing behavior.
    }
    return { detail: projectionFallback().detail, specific: false };
  }

  function projectPersistedFailure(
    detail: Readonly<ErrorDetail> | null
  ): PublicErrorDetail | null {
    if (detail === null) return null;
    try {
      const error = createTradeOpsError({
        code: detail.code,
        phase: detail.phase,
        subject: detail.subject,
        expected: detail.expected,
        actual: detail.actual,
        occurredAt: detail.occurredAt,
        ...(detail.evidence === undefined ? {} : { evidence: detail.evidence })
      });
      return projectFailure(error).detail;
    } catch {
      return projectFailure(projectionFallback()).detail;
    }
  }

  function sendHttpError(
    request: FastifyRequest,
    reply: FastifyReply,
    statusCode: number,
    failure: TradeOpsError,
    options: {
      readonly logDetail?: boolean;
      readonly fullLogMessage?: boolean;
    } = {}
  ): FastifyReply {
    const projected = projectFailure(failure);
    const logDetail = options.logDetail === true && projected.specific;
    const logged = logDetail
      ? projectFailure(failure, true)
      : projected;
    rememberHttpError(request, {
      code: logged.detail.code,
      message: options.fullLogMessage === true && logged.specific
        ? logged.detail.message
        : errorSummary(logged.detail),
      ...(logDetail && logged.specific ? { error: logged.detail } : {})
    });
    return reply.status(statusCode).send({
      requestId: request.id,
      error: projected.detail
    });
  }

  function logRequestCompletion(
    request: FastifyRequest,
    reply: FastifyReply,
    providedState?: RequestLogState
  ): void {
    if (completedRequestLogs.has(request)) return;
    completedRequestLogs.add(request);
    const state = providedState ?? requestLogStates.get(request);
    requestLogStates.delete(request);
    try {
      const fields: Record<string, unknown> = {
        res: reply,
        responseTime: reply.elapsedTime
      };
      const statusCode = reply.statusCode;
      if (statusCode >= 400) {
        const stableError = state?.httpError ?? fallbackHttpError(statusCode);
        try {
          const secrets = nonEmptySecrets(dependencies.secretProvider?.() ?? []);
          const requestBody = state === undefined
            ? {
                body: UNAVAILABLE,
                truncated: false,
                originalByteLength: Buffer.byteLength(UNAVAILABLE, 'utf8')
              }
            : bodyForLog(request, state, secrets);
          fields.httpError = safeJsonValue(stableError, secrets) ?? {
            code: stableError.code,
            message: stableError.message
          };
          fields.httpRequest = {
            method: state === undefined
              ? UNAVAILABLE
              : redactText(state.method, secrets),
            url: state === undefined
              ? UNAVAILABLE
              : urlForLog(state.url, secrets),
            ...requestBody
          };
        } catch {
          fields.httpError = {
            code: stableError.code,
            message: stableError.message
          };
          fields.httpRequest = {
            method: UNAVAILABLE,
            url: UNAVAILABLE,
            body: UNAVAILABLE,
            truncated: false,
            originalByteLength: Buffer.byteLength(UNAVAILABLE, 'utf8')
          };
        }
      }
      const method = statusCode >= 500
        ? request.log.error.bind(request.log)
        : statusCode >= 400
          ? request.log.warn.bind(request.log)
          : request.log.info.bind(request.log);
      nonThrowingLogCall(() => method(fields, 'request completed'));
    } catch {
      // Completion logging is a side channel and cannot change the response.
    } finally {
      state?.capture.release();
    }
  }

  function handleFrameworkError(
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply
  ): void {
    const state: RequestLogState = {
      method: request.method,
      url: UNAVAILABLE,
      capture: createRequestBodyCapture(),
      bodyObservationAllowed: false
    };
    requestLogStates.set(request, state);
    applySecurityHeaders(reply, true);
    reply.raw.once('finish', () => {
      logRequestCompletion(request, reply, state);
    });
    if (isFastifyBadUrl(error)) {
      void sendHttpError(request, reply, 400, requestFailure(
        'REQUEST_FIELD_INVALID',
        'url',
        'valid URL encoding',
        'malformed URL encoding'
      ));
      return;
    }
    void sendHttpError(
      request,
      reply,
      500,
      operationFailure('framework request', error),
      { logDetail: true, fullLogMessage: true }
    );
  }

  function queueConfirmation(strategyId: string): void {
    if (queuedStrategyIds.has(strategyId)) {
      return;
    }
    queuedStrategyIds.add(strategyId);
    let task: Promise<void>;
    task = new Promise<void>((resolveTask) => {
      setImmediate(resolveTask);
    })
      .then(async () => dependencies.coordinator.confirmAndExecute(strategyId))
      .catch((error: unknown) => {
        operationalLog?.error(
          'background_confirmation_failed',
          error,
          { strategyId }
        );
      })
      .finally(() => {
        queuedStrategyIds.delete(strategyId);
        backgroundTasks.delete(task);
      });
    backgroundTasks.add(task);
  }

  app.addHook('onRequest', async (request, reply) => {
    requestLogStates.set(request, {
      method: request.method,
      url: request.url,
      capture: createRequestBodyCapture(),
      bodyObservationAllowed: false
    });
    // This server is the cleartext local-HTTP boundary. Task 9 must bind it
    // only to loopback; proxy headers never upgrade or replace this tuple.
    const requestAuthority = loopbackAuthority(
      request.headers.host,
      LOCAL_HTTP_PROTOCOL
    );
    if (requestAuthority === null) {
      return sendHttpError(request, reply, 403, requestFailure(
        'REQUEST_FORBIDDEN',
        'host',
        'valid loopback authority',
        'invalid or missing'
      ));
    }
    if (request.method === 'POST' && !matchingLoopbackOrigin(
      request.headers.origin,
      requestAuthority,
      LOCAL_HTTP_PROTOCOL
    )) {
      return sendHttpError(request, reply, 403, requestFailure(
        'REQUEST_FORBIDDEN',
        'origin',
        'matching loopback origin',
        'invalid or missing'
      ));
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (
      request.method === 'POST'
      && typeof fetchSite === 'string'
      && fetchSite.toLowerCase() === 'cross-site'
    ) {
      return sendHttpError(request, reply, 403, requestFailure(
        'REQUEST_FORBIDDEN',
        'fetchSite',
        'same-origin request',
        'cross-site'
      ));
    }
    const state = requestLogStates.get(request);
    if (state !== undefined) state.bodyObservationAllowed = true;
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    const state = requestLogStates.get(request);
    if (state === undefined || !state.bodyObservationAllowed) return payload;
    return payload.pipe(createRequestBodyCaptureTransform(state.capture));
  });

  app.addHook('preValidation', async (request) => {
    const state = requestLogStates.get(request);
    if (state !== undefined && request.body !== undefined) {
      state.capture.release();
    }
  });

  app.addHook('preHandler', async (request) => {
    requestsEnteringHandlers.add(request);
  });

  app.addHook('onResponse', async (request, reply) => {
    logRequestCompletion(request, reply);
  });

  app.addHook('onSend', async (request, reply) => {
    applySecurityHeaders(
      reply,
      reply.statusCode >= 400 || request.url.startsWith('/api/') || request.url.startsWith('/health/')
    );
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([...backgroundTasks]);
  });

  app.setErrorHandler((error, request, reply) => {
    if (isLegacyStrategyNotFound(error)) {
      void sendHttpError(request, reply, 404, createTradeOpsError({
        code: 'STRATEGY_NOT_FOUND',
        phase: 'request',
        subject: { type: 'strategy', strategyId: 'unknown' },
        expected: 'existing strategy',
        actual: 'missing'
      }), { logDetail: true });
      return;
    }
    const frameworkValidation = typeof error === 'object' && error !== null
      ? frameworkValidationFailures.get(error)
      : undefined;
    const frameworkCode = requestsEnteringHandlers.has(request)
      ? undefined
      : fastifyParserFailure(error);
    if (frameworkValidation !== undefined || frameworkCode !== undefined) {
      const bodyInvalid = frameworkCode !== undefined
        || (
          frameworkValidation?.context === 'body'
          && (
            request.body === undefined
            || request.body === null
            || typeof request.body !== 'object'
            || Array.isArray(request.body)
          )
        );
      const evidence = frameworkValidation === undefined
        ? undefined
        : validationEvidence(
            frameworkValidation.validation,
            frameworkValidation.context,
            request
          );
      const failure = bodyInvalid
        ? requestFailure(
            'REQUEST_BODY_INVALID',
            'body',
            'JSON object body',
            frameworkCode === undefined
              ? valueCategory(request.body)
              : parserFailureActual(frameworkCode)
          )
        : requestFailure(
            'REQUEST_FIELD_INVALID',
            evidence?.field ?? 'field',
            evidence?.expected ?? 'valid request field',
            evidence?.actual ?? 'unavailable'
          );
      void sendHttpError(request, reply, 400, failure);
      return;
    }
    const trusted = trustedFailure(error);
    if (trusted !== undefined) {
      const statusCode = trusted.detail.code === 'STRATEGY_NOT_FOUND'
        ? 404
        : trusted.detail.code === 'REQUEST_FORBIDDEN'
          ? 403
          : trusted.detail.code === 'REQUEST_BODY_INVALID'
            || trusted.detail.code === 'REQUEST_FIELD_INVALID'
            ? 400
            : 500;
      void sendHttpError(request, reply, statusCode, trusted, {
        logDetail: true
      });
      return;
    }
    void sendHttpError(
      request,
      reply,
      500,
      operationFailure('request', error),
      { logDetail: true, fullLogMessage: true }
    );
  });

  registerStatusRoutes(app, dependencies.runtimeStatus);

  app.get('/api/exchanges', async () => ({
    exchanges: dependencies.registry.ids()
  }));

  app.post<{ Body: PreflightInput }>(
    '/api/hedges/preflight',
    { schema: { body: PREFLIGHT_SCHEMA } },
    async (request, reply) => {
      let preview: PreflightResult;
      try {
        preview = await dependencies.preflightService.run(request.body);
      } catch (error) {
        const trusted = trustedFailure(error);
        if (trusted === undefined) {
          return sendHttpError(
            request,
            reply,
            500,
            operationFailure('preflight', error),
            { logDetail: true, fullLogMessage: true }
          );
        }
        const statusCode = trusted.detail.code === 'REQUEST_BODY_INVALID'
          || trusted.detail.code === 'REQUEST_FIELD_INVALID'
          ? 400
          : trusted.detail.code === 'REQUEST_OPERATION_FAILED'
            || trusted.detail.code.startsWith('STORAGE_')
            ? 500
            : 422;
        return sendHttpError(request, reply, statusCode, trusted, {
          logDetail: true
        });
      }
      const strategy = dependencies.repository.createPending(preview);
      return reply.status(201).send({
        id: strategy.id,
        state: strategy.state,
        preflight: publicPreflight(strategy.preflight)
      });
    }
  );

  app.post<{
    Params: { id: string };
    Body: { riskAcknowledged: true };
  }>(
    '/api/hedges/:id/confirm',
    {
      schema: {
        params: STRATEGY_ID_PARAMS_SCHEMA,
        body: CONFIRM_SCHEMA
      }
    },
    async (request, reply) => {
      try {
        await dependencies.confirmationService.confirm(request.params.id);
      } catch (error) {
        const trusted = trustedFailure(error);
        if (trusted === undefined) {
          return sendHttpError(
            request,
            reply,
            500,
            operationFailure('confirmation', error),
            { logDetail: true, fullLogMessage: true }
          );
        }
        const statusCode = trusted.detail.code === 'STRATEGY_NOT_FOUND'
          ? 404
          : trusted.detail.code.startsWith('STORAGE_')
            ? 500
            : 409;
        return sendHttpError(request, reply, statusCode, trusted, {
          logDetail: true
        });
      }
      queueConfirmation(request.params.id);
      return reply.status(202).send({ accepted: true });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/hedges/:id',
    { schema: { params: STRATEGY_ID_PARAMS_SCHEMA } },
    async (request, reply) => {
      try {
        const strategy = dependencies.repository.getStrategy(request.params.id);
        const orders = dependencies.repository.listOrders(strategy.id);
        return {
          strategy: publicStrategy(
            strategy,
            projectPersistedFailure(strategy.preflightFailure)
          ),
          preflight: publicPreflight(strategy.preflight),
          orders: orders.map(publicOrder),
          actualFills: actualFills(orders)
        };
      } catch (error) {
        if (isLegacyStrategyNotFound(error)) {
          return sendHttpError(request, reply, 404, createTradeOpsError({
            code: 'STRATEGY_NOT_FOUND',
            phase: 'request',
            subject: {
              type: 'strategy',
              strategyId: request.params.id
            },
            expected: 'existing strategy',
            actual: 'missing'
          }), { logDetail: true });
        }
        const trusted = trustedFailure(error);
        if (trusted !== undefined) {
          return sendHttpError(request, reply, 500, trusted, {
            logDetail: true
          });
        }
        return sendHttpError(
          request,
          reply,
          500,
          operationFailure('status', error),
          { logDetail: true, fullLogMessage: true }
        );
      }
    }
  );

  void app.register(staticPlugin, {
    root: dependencies.publicDirectory ?? resolve(process.cwd(), 'public'),
    index: 'index.html'
  });

  app.setNotFoundHandler((request, reply) => sendHttpError(
    request,
    reply,
    404,
    requestFailure(
      'REQUEST_ROUTE_NOT_FOUND',
      'route',
      'matched route or static resource',
      'not found'
    )
  ));

  return app;
}
