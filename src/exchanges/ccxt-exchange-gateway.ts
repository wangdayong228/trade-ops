import { Decimal } from 'decimal.js';
import {
  OrderNotFound,
  bitget,
  functions,
  okx
} from 'ccxt';
import {
  loadExchangeCredentials
} from '../config/exchange-credentials.js';
import { decimal } from '../domain/decimal.js';
import type {
  AccountSettings,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderSide,
  OrderSnapshot,
  OrderType
} from '../domain/types.js';
import {
  createTradeOpsError,
  type ErrorCode,
  type SafeDiagnosticValue
} from '../errors/trade-ops-error.js';
import {
  exchangeAmountToBase,
  type LoadedMarketSnapshot,
  type MarketIdentity,
  type MarketLoadOptions,
  type MarketNotionalRules,
  type MarketQuantityRules,
  NoOrderSubmittedError,
  type ExchangeGateway
} from './exchange-gateway.js';
import type { ExchangeProfile } from './exchange-profile.js';
import { BitgetProfile } from './profiles/bitget-profile.js';
import { OkxProfile } from './profiles/okx-profile.js';

type SupportedExchangeId = 'bitget' | 'okx';
type Numeric = number | string;

export interface CcxtMarket {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  settle: string | undefined;
  type: string;
  spot: boolean;
  margin: boolean;
  swap: boolean;
  future: boolean;
  option: boolean;
  contract: boolean;
  linear: boolean | undefined;
  inverse: boolean | undefined;
  active: boolean | undefined;
  contractSize: Numeric | undefined;
  precision: {
    amount: Numeric | undefined;
    price: Numeric | undefined;
  };
  limits: {
    amount: {
      min: Numeric | undefined;
      max: Numeric | undefined;
    };
    price: {
      min: Numeric | undefined;
      max: Numeric | undefined;
    };
    cost: {
      min: Numeric | undefined;
      max: Numeric | undefined;
    };
  };
  info: unknown;
}

export interface CcxtOrder {
  id: string | undefined;
  clientOrderId: string | undefined;
  timestamp: number | undefined;
  datetime: string | undefined;
  lastTradeTimestamp: number | undefined;
  lastUpdateTimestamp: number | undefined;
  status: string | undefined;
  symbol: string | undefined;
  type: string | undefined;
  timeInForce: string | undefined;
  side: string | undefined;
  price: Numeric | undefined;
  average: Numeric | undefined;
  amount: Numeric | undefined;
  filled: Numeric | undefined;
  remaining: Numeric | undefined;
  cost: Numeric | undefined;
  trades: unknown[];
  fees: unknown[];
  fee: unknown;
  info: unknown;
}

export interface CcxtExchangeLike {
  readonly id: string;
  precisionMode: number;
  readonly has: Record<string, boolean | string | undefined>;
  readonly enableRateLimit?: boolean;
  loadMarkets(reload?: boolean): Promise<Record<string, CcxtMarket>>;
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  fetchBalance(
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  fetchTicker(
    symbol: string
  ): Promise<{ ask?: Numeric; bid?: Numeric; last?: Numeric }>;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price: number | undefined,
    params: Record<string, unknown>
  ): Promise<CcxtOrder>;
  fetchOrder(
    id: string,
    symbol?: string,
    params?: Record<string, unknown>
  ): Promise<CcxtOrder>;
  fetchOpenOrders(symbol?: string): Promise<CcxtOrder[]>;
  fetchClosedOrders(symbol?: string): Promise<CcxtOrder[]>;
  fetchPositions(
    symbols?: string[]
  ): Promise<Array<Record<string, unknown>>>;
  fetchLeverage(symbol: string): Promise<Record<string, unknown>>;
  fetchPositionMode(symbol?: string): Promise<Record<string, unknown>>;
}

interface ResolvedMarket {
  market: CcxtMarket;
  rules: MarketRules;
}

interface CapturedMarket {
  readonly market: CcxtMarket;
  readonly exchangeSymbol: string;
  readonly requestedSymbol: string;
  readonly requestedKind: MarketKind;
  readonly identity: Readonly<MarketIdentity>;
  readonly precisionMode: number;
  readonly amountPrecision: Numeric | undefined;
  readonly pricePrecision: Numeric | undefined;
  readonly minimumAmount: Numeric | undefined;
  readonly maximumAmount: Numeric | undefined;
  readonly minimumQuoteNotional: Numeric | undefined;
  readonly maximumQuoteNotional: Numeric | undefined;
  readonly notionalRulesContainerActual: SafeDiagnosticValue | undefined;
  readonly contractSize: Numeric | undefined;
  readonly hasStructuredInfo: boolean;
  readonly rawMinimumAmount: unknown;
  readonly spot: boolean;
  readonly swap: boolean;
  readonly future: boolean;
  readonly contract: boolean;
  readonly linear: boolean | undefined;
  readonly inverse: boolean | undefined;
  readonly settle: string | undefined;
}

interface NormalizationContext {
  request?: OrderRequest;
  exchangeOrderId?: string;
  clientOrderId?: string;
}

interface PreparedCcxtOrder {
  readonly market: CcxtMarket;
  readonly rules: MarketRules;
  readonly formattedAmount: string;
  readonly submissionPrice: string | undefined;
  readonly params: Record<string, unknown>;
}

class UntradableOrderRequestError extends Error {
  readonly name = 'UntradableOrderRequestError';

  constructor() {
    super('order request is definitely untradable');
  }
}

function supportedExchangeId(exchangeId: string): SupportedExchangeId {
  if (exchangeId === 'bitget' || exchangeId === 'okx') {
    return exchangeId;
  }
  throw new Error(`unsupported exchange: ${exchangeId}`);
}

function profileFor(exchangeId: SupportedExchangeId): ExchangeProfile {
  return exchangeId === 'bitget'
    ? new BitgetProfile()
    : new OkxProfile();
}

function productionExchange(
  exchangeId: SupportedExchangeId,
  env: NodeJS.ProcessEnv
): CcxtExchangeLike {
  const credentials = loadExchangeCredentials(exchangeId, env);
  const options = {
    ...credentials,
    enableRateLimit: true
  };
  const exchange = exchangeId === 'bitget'
    ? new bitget(options)
    : new okx(options);
  return exchange as unknown as CcxtExchangeLike;
}

function decimalString(
  value: unknown,
  field: string,
  minimum: 'positive' | 'non-negative' = 'positive'
): string {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || String(value).trim() === ''
  ) {
    throw new Error(`invalid ${field}: missing decimal value`);
  }
  let parsed: Decimal;
  try {
    parsed = decimal(String(value));
  } catch {
    throw new Error(`invalid ${field}: malformed decimal value`);
  }
  const wrongSign = minimum === 'positive'
    ? parsed.lte(0)
    : parsed.lt(0);
  if (!parsed.isFinite() || wrongSign) {
    throw new Error(
      `invalid ${field}: must be finite and ${minimum}`
    );
  }
  return parsed.toFixed();
}

function exactFiniteDecimalZero(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return false;
  }
  const text = String(value).trim();
  if (text === '') {
    return false;
  }
  try {
    const parsed = decimal(text);
    return parsed.isFinite() && parsed.eq(0);
  } catch {
    return false;
  }
}

function classicBitgetSpotMinimumAmount(
  exchangeId: SupportedExchangeId,
  kind: MarketKind,
  quote: string,
  unifiedMinimumAmount: unknown,
  hasStructuredInfo: boolean,
  rawMinimumAmount: unknown,
  amountStep: string,
  minQuoteNotional: string | undefined
): string | undefined {
  if (
    exchangeId !== 'bitget'
    || kind !== 'spot'
    || quote !== 'USDT'
    || minQuoteNotional === undefined
    || !exactFiniteDecimalZero(unifiedMinimumAmount)
    || !hasStructuredInfo
  ) {
    return undefined;
  }
  return exactFiniteDecimalZero(rawMinimumAmount)
    ? amountStep
    : undefined;
}

function safeRuleActual(value: unknown): SafeDiagnosticValue {
  if (value === undefined) {
    return 'missing';
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return 'non-finite number';
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') {
      return 'empty string';
    }
    try {
      const parsed = decimal(text);
      return parsed.isFinite() ? parsed.toFixed() : 'non-finite decimal';
    } catch {
      return 'malformed decimal string';
    }
  }
  return `${typeof value} value`;
}

function marketRuleError(
  exchangeId: string,
  captured: Readonly<CapturedMarket>,
  field: string,
  expected: SafeDiagnosticValue,
  actual: SafeDiagnosticValue
): Error {
  return marketError(
    'MARKET_RULE_INVALID',
    exchangeId,
    captured.requestedSymbol,
    captured.requestedKind,
    field,
    expected,
    actual
  );
}

function marketError(
  code: ErrorCode,
  exchangeId: string,
  symbol: string,
  kind: MarketKind,
  field: string | undefined,
  expected: SafeDiagnosticValue,
  actual: SafeDiagnosticValue
): Error {
  return createTradeOpsError({
    code,
    phase: 'preflight',
    subject: {
      type: 'market',
      exchangeId,
      symbol,
      kind,
      ...(field === undefined ? {} : { field })
    },
    expected,
    actual
  });
}

function safeIdentityActual(value: unknown): SafeDiagnosticValue {
  if (value === undefined) {
    return 'missing';
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return /^[A-Z0-9:/_-]{1,64}$/u.test(value)
      ? value
      : 'unrecognized string';
  }
  return `${typeof value} value`;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function missingContainerActual(value: unknown): SafeDiagnosticValue | undefined {
  if (nestedRecord(value) !== undefined) {
    return undefined;
  }
  return value === undefined ? 'missing' : `${typeof value} value`;
}

function optionalDecimalString(
  value: unknown,
  field: string
): string | undefined {
  return value === undefined
    ? undefined
    : decimalString(value, field, 'non-negative');
}

function parseUnifiedSymbol(symbol: string): {
  base: string;
  quote: 'USDT';
} {
  const parts = symbol.split('/');
  const base = parts[0];
  const quote = parts[1];
  if (
    parts.length !== 2
    || base === undefined
    || base === ''
    || quote !== 'USDT'
  ) {
    throw new Error(
      `unsupported symbol: expected BASE/USDT, received ${symbol}`
    );
  }
  return { base, quote };
}

function isSupportedSwap(
  candidate: CcxtMarket,
  base: string
): boolean {
  return hasSupportedSwapIdentity(candidate, base)
    && candidate.active === true;
}

function hasSupportedSwapIdentity(
  candidate: CcxtMarket,
  base: string
): boolean {
  return candidate.base === base
    && candidate.quote === 'USDT'
    && candidate.settle === 'USDT'
    && candidate.swap === true
    && candidate.future === false
    && candidate.contract === true
    && candidate.linear === true
    && candidate.inverse === false;
}

function timestampToIso(order: CcxtOrder): string {
  const timestamp = order.lastUpdateTimestamp ?? order.timestamp;
  if (
    timestamp !== undefined
    && Number.isSafeInteger(timestamp)
    && timestamp >= 0
  ) {
    const result = new Date(timestamp).toISOString();
    if (result !== 'Invalid Date') {
      return result;
    }
  }
  if (order.datetime !== undefined) {
    const parsed = new Date(order.datetime);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

function normalizedStatus(
  status: string | undefined
): OrderSnapshot['status'] {
  switch (status) {
    case 'open':
    case 'closed':
    case 'canceled':
    case 'rejected':
      return status;
    default:
      return 'unknown';
  }
}

function normalizedType(
  type: string | undefined,
  fallback: OrderType | undefined
): OrderType {
  const value = type ?? fallback;
  if (value === 'market' || value === 'limit') {
    return value;
  }
  throw new Error('malformed order response: invalid order type');
}

function normalizedSide(
  side: string | undefined,
  fallback: OrderSide | undefined
): OrderSide {
  const value = side ?? fallback;
  if (value === 'buy' || value === 'sell') {
    return value;
  }
  throw new Error('malformed order response: invalid order side');
}

function exactSum(left: string, right: string): string {
  const leftValue = decimal(left);
  const rightValue = decimal(right);
  const requiredPrecision = leftValue.sd() + rightValue.sd() + 4;
  if (!Number.isSafeInteger(requiredPrecision) || requiredPrecision > 1_000_000) {
    throw new Error('order quantity precision exceeds supported bounds');
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  return new ExactDecimal(left).add(right).toFixed();
}

function exactDifference(left: string, right: string): string {
  const leftValue = decimal(left);
  const rightValue = decimal(right);
  const requiredPrecision = leftValue.sd() + rightValue.sd() + 4;
  if (!Number.isSafeInteger(requiredPrecision) || requiredPrecision > 1_000_000) {
    throw new Error('order quantity precision exceeds supported bounds');
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  return new ExactDecimal(left).sub(right).toFixed();
}

function exactProduct(
  left: string,
  right: string,
  field: string
): string {
  const leftValue = decimalString(left, `${field} left operand`);
  const rightValue = decimalString(right, `${field} right operand`);
  const leftDecimal = decimal(leftValue);
  const rightDecimal = decimal(rightValue);
  const requiredPrecision = leftDecimal.sd() + rightDecimal.sd() + 4;
  if (!Number.isSafeInteger(requiredPrecision) || requiredPrecision > 1_000_000) {
    throw new Error(`${field} precision exceeds supported bounds`);
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  const product = new ExactDecimal(leftValue).mul(rightValue);
  if (!product.isFinite() || product.lte(0)) {
    throw new Error(`${field} must be finite and positive`);
  }
  return product.toFixed();
}

function exactAggregate(
  values: readonly string[],
  field: string
): string | null {
  if (values.length === 0) {
    return null;
  }
  const parsed = values.map((value) => decimal(value));
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
    || requiredPrecision > 1_000_000
  ) {
    throw new Error(`${field} precision exceeds supported bounds`);
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  let total = new ExactDecimal(0);
  for (const value of values) {
    total = total.plus(value);
  }
  return total.isFinite() && total.gt(0) ? total.toFixed() : null;
}

function exactPositiveQuotient(
  numerator: string,
  denominator: string,
  field: string
): string | null {
  const numeratorValue = decimal(numerator);
  const denominatorValue = decimal(denominator);
  const requiredPrecision = Math.max(
    80,
    numeratorValue.sd() + denominatorValue.sd() + 40
  );
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000
  ) {
    throw new Error(`${field} precision exceeds supported bounds`);
  }
  const ExactDecimal = Decimal.clone({
    precision: requiredPrecision,
    rounding: Decimal.ROUND_DOWN
  });
  const quotient = new ExactDecimal(numerator).div(denominator);
  return quotient.isFinite() && quotient.gt(0) ? quotient.toFixed() : null;
}

function tradeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function averageFromTrades(
  order: Readonly<CcxtOrder>,
  market: Readonly<CcxtMarket>,
  rules: Readonly<MarketRules>,
  side: OrderSide,
  filledExchangeAmount: string,
  filledBaseQuantity: string
): string | null {
  if (!Array.isArray(order.trades) || order.trades.length === 0) {
    return null;
  }
  const amounts: string[] = [];
  const costs: string[] = [];
  try {
    for (const value of order.trades) {
      const trade = tradeRecord(value);
      if (
        trade === null
        || trade.order !== order.id
        || trade.symbol !== market.symbol
        || trade.side !== side
      ) {
        return null;
      }
      amounts.push(decimalString(trade.amount, 'trade amount'));
      costs.push(decimalString(trade.cost, 'trade cost'));
    }
    const totalAmount = exactAggregate(amounts, 'trade amount total');
    const totalCost = exactAggregate(costs, 'trade cost total');
    if (
      totalAmount === null
      || totalCost === null
      || !decimal(totalAmount).eq(filledExchangeAmount)
      || (
        rules.kind === 'swap'
        && !decimal(
          exchangeAmountToBase(totalAmount, rules.contractSize)
        ).eq(filledBaseQuantity)
      )
    ) {
      return null;
    }
    return exactPositiveQuotient(
      totalCost,
      filledBaseQuantity,
      'trade average price'
    );
  } catch {
    return null;
  }
}

function fallbackActualAverage(
  order: Readonly<CcxtOrder>,
  market: Readonly<CcxtMarket>,
  rules: Readonly<MarketRules>,
  side: OrderSide,
  filledExchangeAmount: string,
  filledBaseQuantity: string
): string | null {
  if (!decimal(filledBaseQuantity).gt(0)) {
    return null;
  }
  try {
    const cost = decimalString(order.cost, 'order cost');
    const fromCost = exactPositiveQuotient(
      cost,
      filledBaseQuantity,
      'order average price'
    );
    if (fromCost !== null) {
      return fromCost;
    }
  } catch {
    // A missing or invalid aggregate cost can still be recovered from trades.
  }
  return averageFromTrades(
    order,
    market,
    rules,
    side,
    filledExchangeAmount,
    filledBaseQuantity
  );
}

function validateBaseAmount(
  baseQuantity: string,
  rules: MarketRules
): void {
  const base = decimal(baseQuantity);
  if (base.lt(rules.minBaseAmount)) {
    throw new UntradableOrderRequestError();
  }
  if (
    rules.maxBaseAmount !== undefined
    && base.gt(rules.maxBaseAmount)
  ) {
    throw new UntradableOrderRequestError();
  }
}

function validateQuoteNotional(
  baseQuantity: string,
  referencePrice: string,
  rules: MarketRules
): void {
  const quoteNotional = exactProduct(
    baseQuantity,
    referencePrice,
    'quote notional'
  );
  if (
    rules.minQuoteNotional !== undefined
    && decimal(quoteNotional).lt(rules.minQuoteNotional)
  ) {
    throw new UntradableOrderRequestError();
  }
  if (
    rules.maxQuoteNotional !== undefined
    && decimal(quoteNotional).gt(rules.maxQuoteNotional)
  ) {
    throw new UntradableOrderRequestError();
  }
}

function positiveTickerValue(value: unknown): string | undefined {
  try {
    return value === undefined
      ? undefined
      : decimalString(value, 'ticker reference price');
  } catch {
    return undefined;
  }
}

function baseToCcxtAmount(
  baseQuantity: string,
  contractSize: string
): string {
  const base = decimalString(baseQuantity, 'base quantity');
  const size = decimalString(contractSize, 'contract size');
  const baseValue = decimal(base);
  const sizeValue = decimal(size);
  const integerDigits = Math.max(1, baseValue.e - sizeValue.e + 1);
  const requiredPrecision = Math.max(
    baseValue.sd() + sizeValue.sd() + 4,
    integerDigits + baseValue.decimalPlaces() + sizeValue.sd() + 4
  );
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000
  ) {
    throw new Error('exchange amount precision exceeds supported bounds');
  }
  const ExactDecimal = Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
  const exchangeAmount = new ExactDecimal(base).div(size).toFixed();
  if (!decimal(exchangeAmountToBase(exchangeAmount, size)).eq(base)) {
    throw new UntradableOrderRequestError();
  }
  return exchangeAmount;
}

export class CcxtExchangeGateway implements ExchangeGateway {
  readonly exchangeId: SupportedExchangeId;
  private readonly exchange: CcxtExchangeLike;
  private readonly profile: ExchangeProfile;

  constructor(
    exchangeId: string,
    exchange?: CcxtExchangeLike,
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.exchangeId = supportedExchangeId(exchangeId);
    this.exchange = exchange
      ?? productionExchange(this.exchangeId, env);
    if (this.exchange.id !== this.exchangeId) {
      throw new Error(
        `CCXT adapter identity mismatch: expected ${this.exchangeId}`
      );
    }
    this.profile = profileFor(this.exchangeId);
  }

  private async captureMarket(
    symbol: string,
    kind: MarketKind,
    options: MarketLoadOptions = {},
    selection: 'staged' | 'strict' = 'staged'
  ): Promise<CapturedMarket> {
    if (kind !== 'spot' && kind !== 'swap') {
      throw new Error(`unsupported market kind: ${String(kind)}`);
    }
    const { base } = parseUnifiedSymbol(symbol);
    const markets = await this.exchange.loadMarkets(options.reload === true);

    let selected: CcxtMarket | undefined;
    if (kind === 'spot') {
      selected = markets[symbol];
      if (selected === undefined) {
        if (selection === 'staged') {
          throw marketError(
            'MARKET_UNAVAILABLE',
            this.exchangeId,
            symbol,
            kind,
            undefined,
            'market present in refreshed market set',
            'missing'
          );
        }
        throw new Error(`missing supported active spot market for ${symbol}`);
      }
    } else {
      const candidates = Object.values(markets)
        .filter((candidate) => isSupportedSwap(candidate, base));
      const exactSymbol = `${symbol}:USDT`;
      selected = selection === 'strict'
        ? candidates.find((candidate) => candidate.symbol === exactSymbol)
        : Object.values(markets).find(
          (candidate) => candidate.symbol === exactSymbol
        );
      if (selected === undefined && candidates.length === 1) {
        selected = candidates[0];
      }
      if (selected === undefined) {
        if (selection === 'staged') {
          throw marketError(
            'MARKET_UNAVAILABLE',
            this.exchangeId,
            symbol,
            kind,
            undefined,
            'one unambiguous supported active linear USDT-settled swap',
            candidates.length === 0
              ? 'missing'
              : `${candidates.length} supported candidates`
          );
        }
        throw new Error(
          `missing supported active linear USDT-settled swap for ${symbol}`
        );
      }
    }

    if (selection === 'staged') {
      const identityChecks: ReadonlyArray<readonly [
        string,
        SafeDiagnosticValue,
        unknown
      ]> = kind === 'spot'
        ? [
            ['symbol', symbol, selected.symbol],
            ['base', base, selected.base],
            ['quote', 'USDT', selected.quote],
            ['kind', 'spot', selected.spot === true && selected.contract === false
              ? 'spot'
              : selected.type]
          ]
        : [
            ['base', base, selected.base],
            ['quote', 'USDT', selected.quote],
            ['settle', 'USDT', selected.settle],
            ['kind', 'swap', selected.swap === true
              && selected.future === false
              && selected.contract === true
              ? 'swap'
              : selected.type],
            ['linear', true, selected.linear],
            ['inverse', false, selected.inverse]
          ];
      for (const [field, expected, actual] of identityChecks) {
        if (actual !== expected) {
          throw marketError(
            'MARKET_IDENTITY_MISMATCH',
            this.exchangeId,
            symbol,
            kind,
            field,
            expected,
            safeIdentityActual(actual)
          );
        }
      }
      if (selected.active !== true) {
        throw marketError(
          'MARKET_INACTIVE',
          this.exchangeId,
          symbol,
          kind,
          'active',
          true,
          safeIdentityActual(selected.active)
        );
      }
    }

    const structuredInfo = typeof selected.info === 'object'
      && selected.info !== null
      && !Array.isArray(selected.info);
    const rawMinimumAmount = structuredInfo
      ? (selected.info as Record<string, unknown>).minTradeAmount
      : undefined;
    const precision = nestedRecord(selected.precision);
    const limits = nestedRecord(selected.limits);
    const amountLimits = nestedRecord(limits?.amount);
    const costLimits = nestedRecord(limits?.cost);
    return Object.freeze({
      market: selected,
      exchangeSymbol: selected.symbol,
      requestedSymbol: symbol,
      requestedKind: kind,
      identity: Object.freeze({
        exchangeId: this.exchangeId,
        symbol,
        marketId: selected.id,
        kind,
        base: selected.base,
        quote: selected.quote as 'USDT',
        active: selected.active === true
      }),
      precisionMode: this.exchange.precisionMode,
      amountPrecision: precision?.amount as Numeric | undefined,
      pricePrecision: precision?.price as Numeric | undefined,
      minimumAmount: amountLimits?.min as Numeric | undefined,
      maximumAmount: amountLimits?.max as Numeric | undefined,
      minimumQuoteNotional: costLimits?.min as Numeric | undefined,
      maximumQuoteNotional: costLimits?.max as Numeric | undefined,
      notionalRulesContainerActual: missingContainerActual(limits?.cost),
      contractSize: selected.contractSize,
      hasStructuredInfo: structuredInfo,
      rawMinimumAmount,
      spot: selected.spot,
      swap: selected.swap,
      future: selected.future,
      contract: selected.contract,
      linear: selected.linear,
      inverse: selected.inverse,
      settle: selected.settle
    });
  }

  private assertStrictMarket(captured: Readonly<CapturedMarket>): void {
    const { identity } = captured;
    if (captured.requestedKind === 'spot') {
      if (
        identity.symbol !== captured.requestedSymbol
        || identity.base !== parseUnifiedSymbol(captured.requestedSymbol).base
        || identity.quote !== 'USDT'
        || captured.spot !== true
        || captured.contract !== false
        || identity.active !== true
      ) {
        throw new Error(
          `missing supported active spot market for ${captured.requestedSymbol}`
        );
      }
      return;
    }
    if (
      !hasSupportedSwapIdentity(
        captured.market,
        parseUnifiedSymbol(captured.requestedSymbol).base
      )
      || identity.active !== true
    ) {
      throw new Error(
        `missing supported active linear USDT-settled swap for ${captured.requestedSymbol}`
      );
    }
  }

  private capturedDecimal(
    captured: Readonly<CapturedMarket>,
    value: unknown,
    parseField: string,
    publicField: string,
    preciseErrors: boolean,
    minimum: 'positive' | 'non-negative' = 'positive'
  ): string {
    try {
      return decimalString(value, parseField, minimum);
    } catch (error) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          publicField,
          minimum === 'positive'
            ? 'finite decimal greater than zero'
            : 'finite non-negative decimal',
          safeRuleActual(value)
        );
      }
      throw error;
    }
  }

  private quantityRules(
    captured: Readonly<CapturedMarket>,
    preciseErrors: boolean
  ): Readonly<MarketQuantityRules> {
    if (captured.precisionMode !== functions.TICK_SIZE) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          'precisionMode',
          'TICK_SIZE',
          Number.isFinite(captured.precisionMode)
            ? captured.precisionMode
            : 'non-finite number'
        );
      }
      throw new Error(`unsupported precision mode for ${this.exchangeId}`);
    }
    const amountStep = this.capturedDecimal(
      captured,
      captured.amountPrecision,
      'amount precision',
      'amountStep',
      preciseErrors
    );
    const priceStep = this.capturedDecimal(
      captured,
      captured.pricePrecision,
      'price precision',
      'priceStep',
      preciseErrors
    );
    let compatibleMinimumAmount: string | undefined;
    if (
      this.exchangeId === 'bitget'
      && captured.requestedKind === 'spot'
      && exactFiniteDecimalZero(captured.minimumAmount)
    ) {
      const minimumQuoteNotional = captured.minimumQuoteNotional === undefined
        ? undefined
        : this.capturedDecimal(
          captured,
          captured.minimumQuoteNotional,
          'minimum quote notional',
          'minQuoteNotional',
          preciseErrors
        );
      compatibleMinimumAmount = classicBitgetSpotMinimumAmount(
        this.exchangeId,
        captured.requestedKind,
        captured.identity.quote,
        captured.minimumAmount,
        captured.hasStructuredInfo,
        captured.rawMinimumAmount,
        amountStep,
        minimumQuoteNotional
      );
    }
    const minimumAmount = compatibleMinimumAmount ?? this.capturedDecimal(
      captured,
      captured.minimumAmount,
      'minimum amount limit',
      'minBaseAmount',
      preciseErrors
    );
    const contractSize = captured.requestedKind === 'swap'
      ? this.capturedDecimal(
        captured,
        captured.contractSize,
        'contract size',
        'contractSize',
        preciseErrors
      )
      : '1';
    let minBaseAmount: string;
    try {
      minBaseAmount = exchangeAmountToBase(minimumAmount, contractSize);
    } catch (error) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          'minBaseAmount',
          'finite non-negative base amount',
          'unrepresentable derived value'
        );
      }
      throw error;
    }
    const maximumAmount = captured.maximumAmount === undefined
      ? undefined
      : this.capturedDecimal(
        captured,
        captured.maximumAmount,
        'maximum amount limit',
        'maxBaseAmount',
        preciseErrors
      );
    let maxBaseAmount: string | undefined;
    try {
      maxBaseAmount = maximumAmount === undefined
        ? undefined
        : exchangeAmountToBase(maximumAmount, contractSize);
    } catch (error) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          'maxBaseAmount',
          'finite positive base amount',
          'unrepresentable derived value'
        );
      }
      throw error;
    }
    if (
      maxBaseAmount !== undefined
      && decimal(minBaseAmount).gt(maxBaseAmount)
    ) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          'baseAmountRange',
          'minimum less than or equal to maximum',
          'minimum exceeds maximum'
        );
      }
      throw new Error('invalid base amount range');
    }
    return Object.freeze({
      amountStep,
      contractSize,
      minBaseAmount,
      ...(maxBaseAmount === undefined ? {} : { maxBaseAmount }),
      priceStep
    });
  }

  private notionalRules(
    captured: Readonly<CapturedMarket>,
    preciseErrors: boolean
  ): Readonly<MarketNotionalRules> {
    if (captured.notionalRulesContainerActual !== undefined) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          'notionalRules',
          'limits.cost object',
          captured.notionalRulesContainerActual
        );
      }
      throw new Error('invalid quote notional rules: expected limits.cost object');
    }
    const minQuoteNotional = captured.minimumQuoteNotional === undefined
      ? undefined
      : this.capturedDecimal(
        captured,
        captured.minimumQuoteNotional,
        'minimum quote notional',
        'minQuoteNotional',
        preciseErrors
      );
    const maxQuoteNotional = captured.maximumQuoteNotional === undefined
      ? undefined
      : this.capturedDecimal(
        captured,
        captured.maximumQuoteNotional,
        'maximum quote notional',
        'maxQuoteNotional',
        preciseErrors
      );
    if (
      minQuoteNotional !== undefined
      && maxQuoteNotional !== undefined
      && decimal(minQuoteNotional).gt(maxQuoteNotional)
    ) {
      if (preciseErrors) {
        throw marketRuleError(
          this.exchangeId,
          captured,
          'quoteNotionalRange',
          'minimum less than or equal to maximum',
          'minimum exceeds maximum'
        );
      }
      throw new Error('invalid quote notional range');
    }
    return Object.freeze({
      ...(minQuoteNotional === undefined ? {} : { minQuoteNotional }),
      ...(maxQuoteNotional === undefined ? {} : { maxQuoteNotional })
    });
  }

  private async resolveMarket(
    symbol: string,
    kind: MarketKind,
    options: MarketLoadOptions = {}
  ): Promise<ResolvedMarket> {
    const captured = await this.captureMarket(symbol, kind, options, 'strict');
    this.assertStrictMarket(captured);
    return {
      market: captured.market,
      rules: {
        ...captured.identity,
        ...this.quantityRules(captured, false),
        ...this.notionalRules(captured, false)
      }
    };
  }

  async loadMarket(
    symbol: string,
    kind: MarketKind,
    options: MarketLoadOptions = {}
  ): Promise<MarketRules> {
    return (await this.resolveMarket(symbol, kind, options)).rules;
  }

  async loadMarketSnapshot(
    symbol: string,
    kind: MarketKind,
    options: MarketLoadOptions = {}
  ): Promise<LoadedMarketSnapshot> {
    const captured = await this.captureMarket(symbol, kind, options);
    return Object.freeze({
      identity: captured.identity,
      quantityRules: () => this.quantityRules(captured, true),
      notionalRules: () => this.notionalRules(captured, true),
      fetchAccountSettings: () => this.profile.fetchAccountSettings(
        this.exchange,
        captured.exchangeSymbol
      ),
      fetchLastPrice: async () => {
        const ticker = await this.exchange.fetchTicker(captured.exchangeSymbol);
        const value = ticker.last;
        if (value === undefined || value === null || String(value).trim() === '') {
          throw marketError(
            'PRICE_UNAVAILABLE',
            this.exchangeId,
            captured.requestedSymbol,
            captured.requestedKind,
            'price',
            'finite decimal greater than zero',
            safeRuleActual(value)
          );
        }
        try {
          return decimalString(value, 'ticker reference price');
        } catch {
          throw marketError(
            'PRICE_INVALID',
            this.exchangeId,
            captured.requestedSymbol,
            captured.requestedKind,
            'price',
            'finite decimal greater than zero',
            safeRuleActual(value)
          );
        }
      }
    });
  }

  async quantizePrice(
    symbol: string,
    kind: MarketKind,
    price: string
  ): Promise<string> {
    const { market } = await this.resolveMarket(symbol, kind);
    const validPrice = decimalString(price, 'price');
    const formatted = this.exchange.priceToPrecision(
      market.symbol,
      validPrice as unknown as number
    );
    return decimalString(formatted, 'quantized price');
  }

  async fetchFreeBalance(
    asset: 'USDT',
    kind: MarketKind
  ): Promise<string> {
    const balance = await this.exchange.fetchBalance(
      this.profile.balanceParams(kind)
    );
    const free = balance.free;
    const freeByCurrency = typeof free === 'object' && free !== null
      ? free as Record<string, unknown>
      : undefined;
    const currency = balance[asset];
    const currencyBalance = typeof currency === 'object' && currency !== null
      ? currency as Record<string, unknown>
      : undefined;
    const value = freeByCurrency?.[asset] ?? currencyBalance?.free;
    try {
      return decimalString(value, `free ${asset} balance`, 'non-negative');
    } catch {
      throw createTradeOpsError({
        code: 'BALANCE_UNAVAILABLE',
        phase: 'preflight',
        subject: {
          type: 'exchange',
          exchangeId: this.exchangeId,
          operation: `fetch ${kind} ${asset} balance`
        },
        expected: 'finite non-negative USDT balance',
        actual: safeRuleActual(value)
      });
    }
  }

  async fetchAccountSettings(
    symbol: string
  ): Promise<AccountSettings> {
    const { market } = await this.resolveMarket(symbol, 'swap');
    return this.profile.fetchAccountSettings(
      this.exchange,
      market.symbol
    );
  }

  async fetchLastPrice(
    symbol: string,
    kind: MarketKind
  ): Promise<string> {
    const { market } = await this.resolveMarket(symbol, kind);
    const ticker = await this.exchange.fetchTicker(market.symbol);
    return decimalString(ticker.last, 'last price');
  }

  async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    let prepared: PreparedCcxtOrder;
    try {
      prepared = await this.prepareCreateOrder(request);
    } catch (error) {
      throw new NoOrderSubmittedError(
        error instanceof UntradableOrderRequestError
          ? 'UNTRADABLE_REQUEST'
          : 'UNCLASSIFIED'
      );
    }
    const order = await this.exchange.createOrder(
      prepared.market.symbol,
      request.type,
      request.side,
      prepared.formattedAmount as unknown as number,
      prepared.submissionPrice as unknown as number | undefined,
      prepared.params
    );
    return this.normalizeOrder(
      order,
      prepared.market,
      prepared.rules,
      { request }
    );
  }

  private async prepareCreateOrder(
    request: OrderRequest
  ): Promise<PreparedCcxtOrder> {
    if (
      request.kind === 'swap'
      && request.marginMode !== 'isolated'
      && request.marginMode !== 'cross'
    ) {
      throw new Error(
        'swap order requires a confirmed isolated or cross margin mode'
      );
    }
    if (request.kind === 'spot' && request.marginMode !== undefined) {
      throw new Error('spot order must not include a margin mode');
    }
    const { market, rules } = await this.resolveMarket(
      request.symbol,
      request.kind
    );
    const baseQuantity = decimalString(
      request.baseQuantity,
      'base quantity'
    );
    validateBaseAmount(baseQuantity, rules);
    const exchangeAmount = request.kind === 'swap'
      ? baseToCcxtAmount(baseQuantity, rules.contractSize)
      : baseQuantity;
    const formattedAmount = this.exchange.amountToPrecision(
      market.symbol,
      exchangeAmount as unknown as number
    );
    const validFormattedAmount = decimalString(
      formattedAmount,
      'formatted amount'
    );
    if (!decimal(validFormattedAmount).eq(exchangeAmount)) {
      throw new UntradableOrderRequestError();
    }

    let formattedPrice: string | undefined;
    if (request.type === 'limit') {
      if (request.price === undefined) {
        throw new Error('limit order requires a price');
      }
      const price = decimalString(request.price, 'price');
      formattedPrice = decimalString(
        this.exchange.priceToPrecision(
          market.symbol,
          price as unknown as number
        ),
        'formatted price'
      );
    }
    const submissionPrice = await this.profile.prepareSubmissionPrice(
      request,
      this.exchange,
      market.symbol,
      formattedPrice
    );
    const hasQuoteNotionalLimit = rules.minQuoteNotional !== undefined
      || rules.maxQuoteNotional !== undefined;
    if (hasQuoteNotionalLimit) {
      let referencePrice = submissionPrice;
      if (referencePrice === undefined) {
        const ticker = await this.exchange.fetchTicker(market.symbol);
        const preferredValue = request.side === 'buy'
          ? ticker.ask
          : ticker.bid;
        referencePrice = positiveTickerValue(preferredValue)
          ?? positiveTickerValue(ticker.last);
        if (referencePrice === undefined) {
          const preferredField = request.side === 'buy' ? 'ask' : 'bid';
          throw new Error(
            `market ${request.side} requires a finite positive ticker `
            + `${preferredField} or last for quote notional validation`
          );
        }
      }
      validateQuoteNotional(baseQuantity, referencePrice, rules);
    }
    return {
      market,
      rules,
      formattedAmount: validFormattedAmount,
      submissionPrice,
      params: this.profile.buildCreateOrderParams(request)
    };
  }

  async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    const { market, rules } = await this.resolveMarket(symbol, kind);
    const order = await this.exchange.fetchOrder(
      exchangeOrderId,
      market.symbol
    );
    return this.normalizeOrder(order, market, rules, {
      exchangeOrderId
    });
  }

  async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    const { market, rules } = await this.resolveMarket(symbol, kind);
    try {
      const order = await this.exchange.fetchOrder(
        clientOrderId,
        market.symbol,
        this.profile.clientOrderLookupParams(clientOrderId)
      );
      return this.normalizeOrder(order, market, rules, {
        clientOrderId
      });
    } catch (error) {
      if (error instanceof OrderNotFound) {
        return null;
      }
      throw error;
    }
  }

  async fetchOpenOrders(
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot[]> {
    const { market, rules } = await this.resolveMarket(symbol, kind);
    if (this.exchange.has.fetchOpenOrders !== true) {
      throw new Error(
        `${this.exchangeId} does not support fetchOpenOrders`
      );
    }
    const orders = await this.exchange.fetchOpenOrders(market.symbol);
    return orders.map((order) => this.normalizeOrder(
      order,
      market,
      rules,
      {}
    ));
  }

  async fetchClosedOrders(
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot[]> {
    const { market, rules } = await this.resolveMarket(symbol, kind);
    if (this.exchange.has.fetchClosedOrders !== true) {
      throw new Error(
        `${this.exchangeId} does not support fetchClosedOrders`
      );
    }
    const orders = await this.exchange.fetchClosedOrders(market.symbol);
    return orders.map((order) => this.normalizeOrder(
      order,
      market,
      rules,
      {}
    ));
  }

  private normalizeOrder(
    order: CcxtOrder,
    market: CcxtMarket,
    rules: MarketRules,
    context: NormalizationContext
  ): OrderSnapshot {
    const request = context.request;
    if (order.id === undefined || order.id.trim() === '') {
      throw new Error('malformed order response: missing exchange order id');
    }
    if (
      context.exchangeOrderId !== undefined
      && order.id !== context.exchangeOrderId
    ) {
      throw new Error('malformed order response: exchange order id mismatch');
    }
    if (
      order.symbol !== undefined
      && order.symbol !== market.symbol
    ) {
      throw new Error('malformed order response: market symbol mismatch');
    }

    const clientOrderId = order.clientOrderId
      ?? request?.clientOrderId;
    if (clientOrderId === undefined || clientOrderId.trim() === '') {
      throw new Error('malformed order response: missing client order id');
    }
    const expectedClientOrderId = context.clientOrderId
      ?? request?.clientOrderId;
    if (
      expectedClientOrderId !== undefined
      && clientOrderId !== expectedClientOrderId
    ) {
      throw new Error('malformed order response: client order id mismatch');
    }

    const type = normalizedType(order.type, request?.type);
    const side = normalizedSide(order.side, request?.side);
    if (request !== undefined) {
      if (type !== request.type || side !== request.side) {
        throw new Error('malformed order response: order identity mismatch');
      }
    }

    const fallbackExchangeAmount = request === undefined
      ? undefined
      : rules.kind === 'swap'
        ? baseToCcxtAmount(request.baseQuantity, rules.contractSize)
        : decimalString(request.baseQuantity, 'requested base quantity');
    const exchangeAmount = optionalDecimalString(
      order.amount,
      'order amount'
    ) ?? fallbackExchangeAmount;
    if (exchangeAmount === undefined) {
      throw new Error('malformed order response: missing order amount');
    }
    const filledExchangeAmount = optionalDecimalString(
      order.filled,
      'filled amount'
    ) ?? (request === undefined ? undefined : '0');
    if (filledExchangeAmount === undefined) {
      throw new Error('malformed order response: missing filled amount');
    }
    const remainingExchangeAmount = optionalDecimalString(
      order.remaining,
      'remaining amount'
    ) ?? exactDifference(exchangeAmount, filledExchangeAmount);
    if (
      decimal(filledExchangeAmount).gt(exchangeAmount)
      || decimal(remainingExchangeAmount).gt(exchangeAmount)
      || exactSum(
        filledExchangeAmount,
        remainingExchangeAmount
      ) !== decimal(exchangeAmount).toFixed()
    ) {
      throw new Error(
        'malformed order response: inconsistent order quantities'
      );
    }

    const requestedBaseQuantity = rules.kind === 'swap'
      ? exchangeAmountToBase(exchangeAmount, rules.contractSize)
      : exchangeAmount;
    if (
      request !== undefined
      && !decimal(requestedBaseQuantity).eq(request.baseQuantity)
    ) {
      throw new Error(
        'malformed order response: requested quantity mismatch'
      );
    }
    const filledBaseQuantity = rules.kind === 'swap'
      ? exchangeAmountToBase(
        filledExchangeAmount,
        rules.contractSize
      )
      : filledExchangeAmount;
    const remainingBaseQuantity = rules.kind === 'swap'
      ? exchangeAmountToBase(
        remainingExchangeAmount,
        rules.contractSize
      )
      : remainingExchangeAmount;

    let averagePrice: string | null = null;
    if (order.average !== undefined && order.average !== null) {
      const average = decimalString(
        order.average,
        'average price',
        'non-negative'
      );
      if (decimal(average).gt(0)) {
        averagePrice = average;
      } else {
        averagePrice = fallbackActualAverage(
          order,
          market,
          rules,
          side,
          filledExchangeAmount,
          filledBaseQuantity
        );
      }
    } else {
      averagePrice = fallbackActualAverage(
        order,
        market,
        rules,
        side,
        filledExchangeAmount,
        filledBaseQuantity
      );
    }

    return {
      exchangeId: this.exchangeId,
      exchangeOrderId: order.id,
      clientOrderId,
      symbol: rules.symbol,
      kind: rules.kind,
      type,
      side,
      requestedBaseQuantity,
      filledBaseQuantity,
      remainingBaseQuantity,
      averagePrice,
      status: normalizedStatus(order.status),
      updatedAt: timestampToIso(order)
    };
  }
}
