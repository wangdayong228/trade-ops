import { Decimal } from 'decimal.js';
import { decimal } from '../domain/decimal.js';
import type {
  AccountSettings,
  MarketKind,
  MarketRules,
  OrderRequest,
  OrderSnapshot
} from '../domain/types.js';

export interface MarketLoadOptions {
  readonly reload?: boolean;
}

export type MarketIdentity = Pick<MarketRules,
  | 'exchangeId'
  | 'symbol'
  | 'marketId'
  | 'kind'
  | 'base'
  | 'quote'
  | 'active'>;

export type MarketQuantityRules = Pick<MarketRules,
  | 'amountStep'
  | 'contractSize'
  | 'minBaseAmount'
  | 'maxBaseAmount'
  | 'priceStep'>;

export type MarketNotionalRules = Pick<MarketRules,
  'minQuoteNotional' | 'maxQuoteNotional'>;

export interface LoadedMarketSnapshot {
  readonly identity: Readonly<MarketIdentity>;
  quantityRules(): Readonly<MarketQuantityRules>;
  notionalRules(): Readonly<MarketNotionalRules>;
  fetchAccountSettings(): Promise<AccountSettings>;
  fetchLastPrice(): Promise<string>;
}

export interface ExchangeGateway {
  readonly exchangeId: string;
  loadMarket(
    symbol: string,
    kind: MarketKind,
    options?: MarketLoadOptions
  ): Promise<MarketRules>;
  loadMarketSnapshot(
    symbol: string,
    kind: MarketKind,
    options?: MarketLoadOptions
  ): Promise<LoadedMarketSnapshot>;
  quantizePrice(symbol: string, kind: MarketKind, price: string): Promise<string>;
  fetchFreeBalance(asset: 'USDT', kind: MarketKind): Promise<string>;
  fetchAccountSettings(symbol: string): Promise<AccountSettings>;
  fetchLastPrice(symbol: string, kind: MarketKind): Promise<string>;
  createOrder(request: OrderRequest): Promise<OrderSnapshot>;
  fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot>;
  findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null>;
}

export type NoOrderSubmittedReason =
  | 'UNCLASSIFIED'
  | 'UNTRADABLE_REQUEST';

export class NoOrderSubmittedError extends Error {
  readonly code = 'NO_ORDER_SUBMITTED';

  constructor(readonly reason: NoOrderSubmittedReason = 'UNCLASSIFIED', options?: ErrorOptions) {
    super('order was not submitted', options);
    this.name = 'NoOrderSubmittedError';
  }
}

function parsedDecimal(value: string, field: string): Decimal {
  try {
    return decimal(value);
  } catch (error) {
    throw new Error(`invalid ${field}: expected decimal; actual ${value}`, { cause: error });
  }
}

function positiveDecimal(value: string, field: string): Decimal {
  const parsed = parsedDecimal(value, field);
  if (!parsed.isFinite() || parsed.lte('0')) {
    throw new Error(`invalid ${field}: must be finite and greater than zero; actual ${value}`);
  }
  return parsed;
}

function nonNegativeDecimal(value: string, field: string): Decimal {
  const parsed = parsedDecimal(value, field);
  if (!parsed.isFinite() || parsed.lt('0')) {
    throw new Error(`invalid ${field}: must be finite and non-negative; actual ${value}`);
  }
  return parsed;
}

function exactDecimalConstructor(
  requiredPrecision: number,
  field: string,
  operands: string
): Decimal.Constructor {
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision > 1_000_000_000
  ) {
    throw new Error(`invalid ${field}: required precision ${requiredPrecision} exceeds supported maximum 1000000000; ${operands}`);
  }
  return Decimal.clone({
    precision: Math.max(Decimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN
  });
}

export function baseToExchangeAmount(
  baseQuantity: string,
  contractSize: string
): string {
  const base = positiveDecimal(baseQuantity, 'baseQuantity');
  const size = positiveDecimal(contractSize, 'contractSize');
  const integerDigits = Math.max(1, base.e - size.e + 1);
  const ExactDecimal = exactDecimalConstructor(
    Math.max(base.sd() + size.sd() + 2, integerDigits + 2),
    'contract count',
    `baseQuantity=${baseQuantity}, contractSize=${contractSize}`
  );
  const exactBase = new ExactDecimal(baseQuantity);
  const exactSize = new ExactDecimal(contractSize);
  if (!exactBase.mod(exactSize).isZero()) {
    throw new Error(`base quantity does not produce a whole contract count: baseQuantity=${baseQuantity}, contractSize=${contractSize}, actual contracts=${exactBase.div(exactSize).toString()}`);
  }
  const contracts = exactBase.div(exactSize);
  if (!contracts.isFinite() || contracts.lte('0')) {
    throw new Error(`invalid contract count: expected finite and greater than zero; actual ${contracts.toString()}; baseQuantity=${baseQuantity}, contractSize=${contractSize}`);
  }
  return contracts.toFixed();
}

export function exchangeAmountToBase(
  amount: string,
  contractSize: string
): string {
  const exchangeAmount = nonNegativeDecimal(amount, 'amount');
  const size = positiveDecimal(contractSize, 'contractSize');
  const ExactDecimal = exactDecimalConstructor(
    exchangeAmount.sd() + size.sd() + 2,
    'base quantity',
    `amount=${amount}, contractSize=${contractSize}`
  );
  const baseQuantity = new ExactDecimal(amount).mul(contractSize);
  if (
    !baseQuantity.isFinite()
    || baseQuantity.lt('0')
    || (exchangeAmount.gt('0') && baseQuantity.isZero())
  ) {
    throw new Error(`invalid base quantity: derived value must be finite and must not underflow; actual ${baseQuantity.toString()}; amount=${amount}, contractSize=${contractSize}`);
  }
  return baseQuantity.toFixed();
}
