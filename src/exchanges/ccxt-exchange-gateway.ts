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
  exchangeAmountToBase,
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
  loadMarkets(): Promise<Record<string, CcxtMarket>>;
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
  return candidate.base === base
    && candidate.quote === 'USDT'
    && candidate.settle === 'USDT'
    && candidate.swap === true
    && candidate.future === false
    && candidate.contract === true
    && candidate.linear === true
    && candidate.inverse === false
    && candidate.active === true;
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
    throw new Error(
      `order is below minimum base amount ${rules.minBaseAmount}`
    );
  }
  if (
    rules.maxBaseAmount !== undefined
    && base.gt(rules.maxBaseAmount)
  ) {
    throw new Error(
      `order exceeds maximum base amount ${rules.maxBaseAmount}`
    );
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
    throw new Error(
      `order is below minimum quote notional ${rules.minQuoteNotional}`
    );
  }
  if (
    rules.maxQuoteNotional !== undefined
    && decimal(quoteNotional).gt(rules.maxQuoteNotional)
  ) {
    throw new Error(
      `order exceeds maximum quote notional ${rules.maxQuoteNotional}`
    );
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
    throw new Error(
      'base quantity cannot be represented exactly in exchange amount units'
    );
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

  private async resolveMarket(
    symbol: string,
    kind: MarketKind
  ): Promise<ResolvedMarket> {
    if (kind !== 'spot' && kind !== 'swap') {
      throw new Error(`unsupported market kind: ${String(kind)}`);
    }
    const { base } = parseUnifiedSymbol(symbol);
    const markets = await this.exchange.loadMarkets();
    if (this.exchange.precisionMode !== functions.TICK_SIZE) {
      throw new Error(
        `unsupported precision mode for ${this.exchangeId}`
      );
    }

    let selected: CcxtMarket | undefined;
    if (kind === 'spot') {
      const direct = markets[symbol];
      if (
        direct !== undefined
        && direct.symbol === symbol
        && direct.base === base
        && direct.quote === 'USDT'
        && direct.spot === true
        && direct.contract === false
        && direct.active === true
      ) {
        selected = direct;
      }
      if (selected === undefined) {
        throw new Error(
          `missing supported active spot market for ${symbol}`
        );
      }
    } else {
      const candidates = Object.values(markets)
        .filter((candidate) => isSupportedSwap(candidate, base));
      const exactSymbol = `${symbol}:USDT`;
      selected = candidates.find(
        (candidate) => candidate.symbol === exactSymbol
      );
      if (selected === undefined && candidates.length === 1) {
        selected = candidates[0];
      }
      if (selected === undefined) {
        throw new Error(
          `missing supported active linear USDT-settled swap for ${symbol}`
        );
      }
    }

    const amountStep = decimalString(
      selected.precision.amount,
      'amount precision'
    );
    const priceStep = decimalString(
      selected.precision.price,
      'price precision'
    );
    const minimumAmount = decimalString(
      selected.limits.amount.min,
      'minimum amount limit'
    );
    const contractSize = kind === 'swap'
      ? decimalString(selected.contractSize, 'contract size')
      : '1';
    const minBaseAmount = exchangeAmountToBase(
      minimumAmount,
      contractSize
    );
    const maximumAmount = selected.limits.amount.max === undefined
      ? undefined
      : decimalString(
        selected.limits.amount.max,
        'maximum amount limit'
      );
    const maxBaseAmount = maximumAmount === undefined
      ? undefined
      : exchangeAmountToBase(maximumAmount, contractSize);
    if (
      maxBaseAmount !== undefined
      && decimal(minBaseAmount).gt(maxBaseAmount)
    ) {
      throw new Error('invalid base amount range');
    }
    const minQuoteNotional = selected.limits.cost.min === undefined
      ? undefined
      : decimalString(
        selected.limits.cost.min,
        'minimum quote notional'
      );
    const maxQuoteNotional = selected.limits.cost.max === undefined
      ? undefined
      : decimalString(
        selected.limits.cost.max,
        'maximum quote notional'
      );
    if (
      minQuoteNotional !== undefined
      && maxQuoteNotional !== undefined
      && decimal(minQuoteNotional).gt(maxQuoteNotional)
    ) {
      throw new Error('invalid quote notional range');
    }

    return {
      market: selected,
      rules: {
        exchangeId: this.exchangeId,
        symbol,
        marketId: selected.id,
        kind,
        base: selected.base,
        quote: 'USDT',
        active: true,
        amountStep,
        contractSize,
        minBaseAmount,
        priceStep,
        ...(maxBaseAmount === undefined ? {} : { maxBaseAmount }),
        ...(minQuoteNotional === undefined
          ? {}
          : { minQuoteNotional }),
        ...(maxQuoteNotional === undefined
          ? {}
          : { maxQuoteNotional })
      }
    };
  }

  async loadMarket(
    symbol: string,
    kind: MarketKind
  ): Promise<MarketRules> {
    return (await this.resolveMarket(symbol, kind)).rules;
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
    return decimalString(value, `free ${asset} balance`, 'non-negative');
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
    } catch {
      throw new NoOrderSubmittedError();
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
      throw new Error(
        'amount precision changed the pre-normalized base quantity'
      );
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
