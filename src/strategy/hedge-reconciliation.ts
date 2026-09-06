import { Decimal } from 'decimal.js';
import type {
  MarketKind,
  MarketRules,
  OrderSnapshot,
  StrategyState
} from '../domain/types.js';
import type { ExchangeGateway } from '../exchanges/exchange-gateway.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import {
  nonThrowingOperationalLog,
  type OperationalFields,
  type OperationalLog
} from '../logging/logger.js';
import {
  NOOP_TRADE_EVENT_SINK,
  type TradeEventSink
} from '../logging/trade-events.js';
import {
  type StrategyFailureCode,
  type StrategyOrderRecord,
  type StrategyRecord,
  type StrategyRepository
} from '../storage/strategy-repository.js';
import {
  HedgeOrderEvidenceCollector,
  inspectLocalTopology
} from './hedge-reconciliation-evidence.js';

export type ReconciliationPendingReason =
  | 'INVALID_LOCAL_TOPOLOGY'
  | 'ORDER_LOOKUP_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'SUBMISSION_UNCERTAIN'
  | 'ORDER_SNAPSHOT_INVALID'
  | 'ORDER_EVIDENCE_MISMATCH'
  | 'SNAPSHOT_WRITE_CONFLICT'
  | 'MARKET_ORDER_ACTIVE'
  | 'GTC_STATUS_UNKNOWN'
  | 'MARKET_RULES_UNAVAILABLE'
  | 'PRICE_QUANTIZATION_FAILED'
  | 'EXACT_ARITHMETIC_UNAVAILABLE'
  | 'STATE_WRITE_CONFLICT';

export interface ReconciliationDiagnostic {
  readonly strategyState: 'EXECUTING' | 'WAITING_HEDGE';
  readonly exposureKnown: boolean;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeId?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export type ReconciliationResult =
  | {
      readonly kind: 'written';
      readonly state: 'HEDGED' | 'WAITING_HEDGE';
    }
  | {
      readonly kind: 'written';
      readonly state: 'FAILED' | 'HEDGE_INCOMPLETE';
      readonly failureCode: StrategyFailureCode;
    }
  | {
      readonly kind: 'observed_state';
      readonly state: StrategyState;
    }
  | ({
      readonly kind: 'pending';
      readonly reason: ReconciliationPendingReason;
    } & ReconciliationDiagnostic)
  | { readonly kind: 'waiting_gtc' }
  | { readonly kind: 'awaiting_market_submission' }
  | {
      readonly kind: 'need_gtc';
      readonly role: 'SPOT_HEDGE_GTC' | 'CONTRACT_HEDGE_GTC';
      readonly baseQuantity: string;
      readonly referencePrice: string;
    };

export interface ReconciliationRunner {
  run(strategyId: string): Promise<ReconciliationResult>;
}

interface PendingInput {
  readonly kind: 'pending';
  readonly reason: ReconciliationPendingReason;
  readonly exposureKnown: boolean;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeId?: string;
  readonly expected?: string;
  readonly actual?: string;
}

interface AmountFields {
  readonly marketSpot: string;
  readonly marketContract: string;
  readonly preGtcResidual: string;
  readonly currentResidual: string;
  readonly exposureKnown: boolean;
}

interface ReconciledAmounts {
  readonly marketSpot: Decimal;
  readonly marketContract: Decimal;
  readonly marketDelta: Decimal;
  readonly preGtcResidual: Decimal;
  readonly totalSpot: Decimal;
  readonly totalContract: Decimal;
  readonly totalDelta: Decimal;
  readonly currentResidual: Decimal;
  readonly gtcFilled: Decimal;
  readonly gtcRemaining: Decimal;
  readonly fields: AmountFields;
}

interface ParsedMarketRules {
  readonly amountStep: Decimal;
  readonly contractSize: Decimal;
  readonly minBaseAmount: Decimal;
  readonly maxBaseAmount?: Decimal;
  readonly minQuoteNotional?: Decimal;
  readonly maxQuoteNotional?: Decimal;
  readonly priceStep: Decimal;
}

interface GtcTarget {
  readonly role: 'SPOT_HEDGE_GTC' | 'CONTRACT_HEDGE_GTC';
  readonly exchangeId: string;
  readonly kind: MarketKind;
  readonly expectedMarket: Readonly<MarketRules>;
}

const MAX_RECONCILIATION_PRECISION = 1_000_000;
const RECONCILIATION_MIN_EXPONENT = -9_000_000_000_000_000;
const RECONCILIATION_MAX_EXPONENT = 9_000_000_000_000_000;
const MAX_CANONICAL_DECIMAL_CHARACTERS = 1_000_000n;
const DECIMAL_STRING_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const ReconciliationDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: RECONCILIATION_MIN_EXPONENT,
  maxE: RECONCILIATION_MAX_EXPONENT,
  toExpNeg: -7,
  toExpPos: 21
});

class ExactArithmeticUnavailable extends Error {
  readonly name = 'ExactArithmeticUnavailable';
}

function terminalStrategyState(state: StrategyState): boolean {
  return state === 'HEDGED'
    || state === 'HEDGE_INCOMPLETE'
    || state === 'FAILED';
}

function parsedDecimal(value: unknown): Decimal | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 10_000
    || !DECIMAL_STRING_PATTERN.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new ReconciliationDecimal(value);
    const coefficient = value.split(/[eE]/, 1)[0] ?? '';
    const lexicalValueIsZero = !/[1-9]/.test(coefficient);
    return parsed.isFinite() && (!parsed.isZero() || lexicalValueIsZero)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function requiredDecimal(value: unknown): Decimal {
  const parsed = parsedDecimal(value);
  if (parsed === null || parsed.isNegative()) {
    throw new ExactArithmeticUnavailable();
  }
  return parsed;
}

function positiveDecimal(value: unknown): Decimal | null {
  const parsed = parsedDecimal(value);
  return parsed !== null && parsed.gt(0) ? parsed : null;
}

function checkedMetric(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new ExactArithmeticUnavailable();
  }
  return value;
}

function checkedPrecision(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_RECONCILIATION_PRECISION
  ) {
    throw new ExactArithmeticUnavailable();
  }
  return value;
}

function nonzero(values: readonly Decimal[]): readonly Decimal[] {
  return values.filter((value) => !value.isZero());
}

function additivePrecision(values: readonly Decimal[]): number {
  const significant = nonzero(values);
  if (significant.length === 0) return 8;
  const exponents = significant.map((value) => checkedMetric(value.e));
  const lowestExponents = significant.map((value) => (
    checkedMetric(value.e) - checkedMetric(value.sd()) + 1
  ));
  const highest = Math.max(...exponents);
  const lowest = Math.min(...lowestExponents);
  return checkedPrecision(
    highest - lowest
      + Math.ceil(Math.log10(significant.length + 1))
      + 4
  );
}

function productPrecision(left: Decimal, right: Decimal): number {
  return checkedPrecision(
    checkedMetric(left.sd()) + checkedMetric(right.sd()) + 4
  );
}

function moduloPrecision(left: Decimal, right: Decimal): number {
  const quotientIntegerDigits = Math.max(
    1,
    checkedMetric(left.e) - checkedMetric(right.e) + 1
  );
  return checkedPrecision(
    quotientIntegerDigits
      + checkedMetric(left.sd())
      + checkedMetric(right.sd())
      + 4
  );
}

function exactConstructor(precision: number): Decimal.Constructor {
  return Decimal.clone({
    precision: checkedPrecision(precision),
    rounding: Decimal.ROUND_DOWN,
    minE: RECONCILIATION_MIN_EXPONENT,
    maxE: RECONCILIATION_MAX_EXPONENT,
    toExpNeg: -7,
    toExpPos: 21
  });
}

function exactValue(
  Constructor: Decimal.Constructor,
  value: Decimal
): Decimal {
  return new Constructor(value.toString());
}

function exactSum(values: readonly Decimal[]): Decimal {
  const ExactDecimal = exactConstructor(additivePrecision(values));
  let result = new ExactDecimal(0);
  for (const value of values) {
    result = result.plus(exactValue(ExactDecimal, value));
  }
  if (!result.isFinite()) throw new ExactArithmeticUnavailable();
  return result;
}

function exactDifference(left: Decimal, right: Decimal): Decimal {
  const ExactDecimal = exactConstructor(additivePrecision([left, right]));
  const result = exactValue(ExactDecimal, left)
    .minus(exactValue(ExactDecimal, right));
  if (!result.isFinite()) throw new ExactArithmeticUnavailable();
  return result;
}

function exactProduct(left: Decimal, right: Decimal): Decimal {
  const ExactDecimal = exactConstructor(productPrecision(left, right));
  const result = exactValue(ExactDecimal, left)
    .mul(exactValue(ExactDecimal, right));
  if (!result.isFinite()) throw new ExactArithmeticUnavailable();
  return result;
}

function exactModuloIsZero(left: Decimal, right: Decimal): boolean {
  if (!left.isFinite() || !right.isFinite() || right.isZero()) {
    throw new ExactArithmeticUnavailable();
  }
  const ExactDecimal = exactConstructor(moduloPrecision(left, right));
  const result = exactValue(ExactDecimal, left)
    .mod(exactValue(ExactDecimal, right));
  if (!result.isFinite()) throw new ExactArithmeticUnavailable();
  return result.isZero();
}

function canonicalDecimalWidth(value: Decimal): bigint {
  const decimalExponent = checkedMetric(value.e);
  const decimalSignificantDigits = checkedMetric(value.sd());
  if (value.isZero()) return 1n;
  const signWidth = value.isNegative() ? 1n : 0n;
  const exponent = BigInt(decimalExponent);
  const significantDigits = BigInt(decimalSignificantDigits);
  if (exponent >= 0n) {
    const integerDigits = exponent + 1n;
    const fractionalDigits = significantDigits > integerDigits
      ? significantDigits - integerDigits
      : 0n;
    return signWidth + integerDigits
      + (fractionalDigits === 0n ? 0n : 1n + fractionalDigits);
  }
  return signWidth + 2n + (-exponent - 1n) + significantDigits;
}

function canonicalDecimal(value: Decimal): string {
  if (
    !value.isFinite()
    || canonicalDecimalWidth(value) > MAX_CANONICAL_DECIMAL_CHARACTERS
  ) {
    throw new ExactArithmeticUnavailable();
  }
  return value.toFixed();
}

function snapshotEquals(
  left: Readonly<OrderSnapshot> | null,
  right: Readonly<OrderSnapshot> | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.exchangeId === right.exchangeId
    && left.exchangeOrderId === right.exchangeOrderId
    && left.clientOrderId === right.clientOrderId
    && left.symbol === right.symbol
    && left.kind === right.kind
    && left.type === right.type
    && left.side === right.side
    && left.requestedBaseQuantity === right.requestedBaseQuantity
    && left.filledBaseQuantity === right.filledBaseQuantity
    && left.remainingBaseQuantity === right.remainingBaseQuantity
    && left.averagePrice === right.averagePrice
    && left.status === right.status
    && left.updatedAt === right.updatedAt;
}

function sameOrderRevisions(
  expected: readonly Readonly<StrategyOrderRecord>[],
  actual: readonly Readonly<StrategyOrderRecord>[]
): boolean {
  return expected.length === actual.length
    && expected.every((left, index) => {
      const right = actual[index];
      return right !== undefined
        && left.id === right.id
        && left.status === right.status
        && left.updatedAt === right.updatedAt
        && left.submissionDisposition === right.submissionDisposition
        && left.submissionFailureCode === right.submissionFailureCode
        && snapshotEquals(left.snapshot, right.snapshot);
    });
}

function orderRevision(
  orders: readonly Readonly<StrategyOrderRecord>[]
): string {
  return orders.map(({ id, updatedAt }) => `${id}:${updatedAt}`).join(',');
}

function positiveFillKnown(order: Readonly<StrategyOrderRecord>): boolean {
  const filled = parsedDecimal(order.snapshot?.filledBaseQuantity);
  return filled !== null && filled.gt(0);
}

function hasPositiveFill(
  orders: readonly Readonly<StrategyOrderRecord>[]
): boolean {
  return orders.some(positiveFillKnown);
}

function isMarketOrder(order: Readonly<StrategyOrderRecord>): boolean {
  return order.role === 'SPOT_MARKET' || order.role === 'CONTRACT_MARKET';
}

function isGtcOrder(order: Readonly<StrategyOrderRecord>): boolean {
  return order.role === 'SPOT_HEDGE_GTC'
    || order.role === 'CONTRACT_HEDGE_GTC';
}

function filledQuantity(order: Readonly<StrategyOrderRecord>): Decimal {
  return requiredDecimal(order.snapshot?.filledBaseQuantity ?? '0');
}

function remainingQuantity(order: Readonly<StrategyOrderRecord>): Decimal {
  return requiredDecimal(order.snapshot?.remainingBaseQuantity ?? '0');
}

function exactUnavailable(exposureKnown: boolean): PendingInput {
  return {
    kind: 'pending',
    reason: 'EXACT_ARITHMETIC_UNAVAILABLE',
    exposureKnown,
    expected: 'canonical decimal at most 1000000 characters',
    actual: 'canonical decimal exceeds resource limit'
  };
}

function activeState(strategy: Readonly<StrategyRecord>):
  'EXECUTING' | 'WAITING_HEDGE' {
  if (strategy.state !== 'EXECUTING' && strategy.state !== 'WAITING_HEDGE') {
    throw new Error(
      'hedge reconciliation requires an executing or waiting strategy'
    );
  }
  return strategy.state;
}

function targetFor(
  strategy: Readonly<StrategyRecord>,
  role: GtcTarget['role']
): GtcTarget {
  return role === 'SPOT_HEDGE_GTC'
    ? {
        role,
        exchangeId: strategy.spotExchangeId,
        kind: 'spot',
        expectedMarket: strategy.preflight.spotMarket
      }
    : {
        role,
        exchangeId: strategy.contractExchangeId,
        kind: 'swap',
        expectedMarket: strategy.preflight.contractMarket
      };
}

function marketIdentityMatches(
  market: Readonly<MarketRules>,
  expected: Readonly<MarketRules>,
  target: Readonly<GtcTarget>,
  symbol: string
): boolean {
  return market.exchangeId === target.exchangeId
    && market.exchangeId === expected.exchangeId
    && market.symbol === symbol
    && market.symbol === expected.symbol
    && market.marketId === expected.marketId
    && market.kind === target.kind
    && market.kind === expected.kind
    && market.base === expected.base
    && market.quote === expected.quote
    && market.quote === 'USDT'
    && market.active === true;
}

function parsedMarketRules(
  market: Readonly<MarketRules>
): ParsedMarketRules | null {
  const amountStep = positiveDecimal(market.amountStep);
  const contractSize = positiveDecimal(market.contractSize);
  const minBaseAmount = requiredDecimalOrNull(market.minBaseAmount);
  const maxBaseAmount = market.maxBaseAmount === undefined
    ? undefined
    : positiveDecimal(market.maxBaseAmount) ?? undefined;
  const minQuoteNotional = market.minQuoteNotional === undefined
    ? undefined
    : requiredDecimalOrNull(market.minQuoteNotional);
  const maxQuoteNotional = market.maxQuoteNotional === undefined
    ? undefined
    : positiveDecimal(market.maxQuoteNotional) ?? undefined;
  const priceStep = positiveDecimal(market.priceStep);
  if (
    amountStep === null
    || contractSize === null
    || minBaseAmount === undefined
    || priceStep === null
    || (market.maxBaseAmount !== undefined && maxBaseAmount === undefined)
    || (
      market.minQuoteNotional !== undefined
      && minQuoteNotional === undefined
    )
    || (
      market.maxQuoteNotional !== undefined
      && maxQuoteNotional === undefined
    )
    || (maxBaseAmount !== undefined && maxBaseAmount.lt(minBaseAmount))
    || (
      minQuoteNotional !== undefined
      && maxQuoteNotional !== undefined
      && maxQuoteNotional.lt(minQuoteNotional)
    )
  ) {
    return null;
  }
  return {
    amountStep,
    contractSize,
    minBaseAmount,
    ...(maxBaseAmount === undefined ? {} : { maxBaseAmount }),
    ...(minQuoteNotional === undefined ? {} : { minQuoteNotional }),
    ...(maxQuoteNotional === undefined ? {} : { maxQuoteNotional }),
    priceStep
  };
}

function requiredDecimalOrNull(value: unknown): Decimal | undefined {
  const parsed = parsedDecimal(value);
  return parsed !== null && parsed.gte(0) ? parsed : undefined;
}

export class HedgeReconciliation implements ReconciliationRunner {
  private readonly evidence: HedgeOrderEvidenceCollector;
  private readonly operationalLog: OperationalLog | undefined;
  private readonly pendingWarningKeys = new Set<string>();

  constructor(
    private readonly registry: ExchangeRegistry,
    private readonly repository: StrategyRepository,
    tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK,
    operationalLog?: OperationalLog
  ) {
    this.evidence = new HedgeOrderEvidenceCollector(
      registry,
      repository,
      tradeEvents
    );
    this.operationalLog = nonThrowingOperationalLog(operationalLog);
  }

  async run(strategyId: string): Promise<ReconciliationResult> {
    const entered = this.repository.getStrategy(strategyId);
    if (terminalStrategyState(entered.state)) {
      const observed = { kind: 'observed_state', state: entered.state } as const;
      this.logConclusion(entered, observed);
      return observed;
    }
    activeState(entered);

    const initialOrders = this.repository.listOrders(strategyId);
    const topology = inspectLocalTopology(entered, initialOrders);
    if (topology.kind === 'empty') {
      return entered.state === 'EXECUTING'
        ? { kind: 'awaiting_market_submission' }
        : this.pending(entered, initialOrders, {
            kind: 'pending',
            reason: 'INVALID_LOCAL_TOPOLOGY',
            exposureKnown: false
          });
    }
    if (topology.kind === 'pending') {
      return this.pending(entered, initialOrders, topology);
    }

    const evidence = await this.evidence.collect(entered, topology.orders);
    if (evidence.kind === 'pending') {
      return this.pending(
        entered,
        this.repository.listOrders(strategyId),
        evidence
      );
    }

    const current = this.repository.getStrategy(strategyId);
    if (current.state !== entered.state) {
      const observed = { kind: 'observed_state', state: current.state } as const;
      if (terminalStrategyState(current.state)) {
        this.logConclusion(entered, observed);
      }
      return observed;
    }
    const orders = this.repository.listOrders(strategyId);
    if (!sameOrderRevisions(evidence.orders, orders)) {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'ORDER_EVIDENCE_MISMATCH',
        exposureKnown: hasPositiveFill(orders),
        expected: orderRevision(evidence.orders),
        actual: orderRevision(orders)
      });
    }
    return this.decideAndApply(entered, orders);
  }

  private async decideAndApply(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[]
  ): Promise<ReconciliationResult> {
    const marketOrders = orders.filter(isMarketOrder);
    const activeMarket = marketOrders.find((order) => (
      order.snapshot?.status === 'open'
      || order.snapshot?.status === 'unknown'
    ));
    if (activeMarket !== undefined) {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'MARKET_ORDER_ACTIVE',
        exposureKnown: hasPositiveFill(orders),
        strategyOrderId: activeMarket.id,
        clientOrderId: activeMarket.clientOrderId,
        exchangeId: activeMarket.exchangeId
      });
    }

    let amounts: ReconciledAmounts;
    try {
      amounts = this.reconciledAmounts(orders);
    } catch (error) {
      if (!(error instanceof ExactArithmeticUnavailable)) throw error;
      return this.pending(
        entered,
        orders,
        exactUnavailable(hasPositiveFill(orders))
      );
    }

    const marketFailure = marketOrders.find((order) => (
      order.snapshot?.status === 'rejected'
      || order.submissionDisposition === 'DEFINITELY_NOT_SUBMITTED'
    ));
    if (marketFailure !== undefined) {
      if (amounts.fields.exposureKnown) {
        return this.transitionFailure(
          entered,
          orders,
          'HEDGE_INCOMPLETE',
          'INCONSISTENT_ORDER_STATE',
          amounts.fields
        );
      }
      const failureCode = marketOrders.find((order) => (
        order.submissionDisposition === 'DEFINITELY_NOT_SUBMITTED'
        && order.submissionFailureCode !== null
      ))?.submissionFailureCode ?? 'ORDER_SUBMISSION_FAILED';
      return this.transitionFailure(
        entered,
        orders,
        'FAILED',
        failureCode,
        amounts.fields
      );
    }

    const gtc = orders.find(isGtcOrder);
    if (gtc !== undefined) {
      return this.decideExistingGtc(entered, orders, gtc, amounts);
    }
    return this.decideWithoutGtc(entered, orders, amounts);
  }

  private reconciledAmounts(
    orders: readonly Readonly<StrategyOrderRecord>[]
  ): ReconciledAmounts {
    const spotMarket = orders.filter(({ role }) => role === 'SPOT_MARKET');
    const contractMarket = orders.filter(
      ({ role }) => role === 'CONTRACT_MARKET'
    );
    const spotGtc = orders.find(({ role }) => role === 'SPOT_HEDGE_GTC');
    const contractGtc = orders.find(
      ({ role }) => role === 'CONTRACT_HEDGE_GTC'
    );
    const marketSpot = exactSum(spotMarket.map(filledQuantity));
    const marketContract = exactSum(contractMarket.map(filledQuantity));
    const marketDelta = exactDifference(marketSpot, marketContract);
    const preGtcResidual = marketDelta.abs();
    const spotGtcFilled = spotGtc === undefined
      ? requiredDecimal('0')
      : filledQuantity(spotGtc);
    const contractGtcFilled = contractGtc === undefined
      ? requiredDecimal('0')
      : filledQuantity(contractGtc);
    const gtc = spotGtc ?? contractGtc;
    const gtcFilled = gtc === undefined
      ? requiredDecimal('0')
      : filledQuantity(gtc);
    const gtcRemaining = gtc === undefined
      ? requiredDecimal('0')
      : remainingQuantity(gtc);
    const totalSpot = exactSum([marketSpot, spotGtcFilled]);
    const totalContract = exactSum([marketContract, contractGtcFilled]);
    const totalDelta = exactDifference(totalSpot, totalContract);
    const currentResidual = totalDelta.abs();
    const fields = {
      marketSpot: canonicalDecimal(marketSpot),
      marketContract: canonicalDecimal(marketContract),
      preGtcResidual: canonicalDecimal(preGtcResidual),
      currentResidual: canonicalDecimal(currentResidual),
      exposureKnown: marketSpot.gt(0)
        || marketContract.gt(0)
        || gtcFilled.gt(0)
    };
    return {
      marketSpot,
      marketContract,
      marketDelta,
      preGtcResidual,
      totalSpot,
      totalContract,
      totalDelta,
      currentResidual,
      gtcFilled,
      gtcRemaining,
      fields
    };
  }

  private async decideWithoutGtc(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    amounts: Readonly<ReconciledAmounts>
  ): Promise<ReconciliationResult> {
    if (amounts.marketSpot.isZero() && amounts.marketContract.isZero()) {
      return this.transitionFailure(
        entered,
        orders,
        'FAILED',
        'NO_FILL',
        amounts.fields
      );
    }
    if (amounts.marketDelta.isZero()) {
      return this.transitionSuccess(
        entered,
        orders,
        'HEDGED',
        amounts.fields
      );
    }

    const largerRole = amounts.marketDelta.gt(0)
      ? 'SPOT_MARKET'
      : 'CONTRACT_MARKET';
    const largerOrder = orders.find(({ role }) => role === largerRole);
    const reference = positiveDecimal(largerOrder?.snapshot?.averagePrice);
    if (largerOrder === undefined || reference === null) {
      return this.transitionFailure(
        entered,
        orders,
        'HEDGE_INCOMPLETE',
        'MISSING_AVERAGE_PRICE',
        amounts.fields
      );
    }

    let referencePrice: string;
    try {
      referencePrice = canonicalDecimal(reference);
    } catch (error) {
      if (!(error instanceof ExactArithmeticUnavailable)) throw error;
      return this.pending(
        entered,
        orders,
        exactUnavailable(amounts.fields.exposureKnown)
      );
    }
    const role = amounts.marketDelta.gt(0)
      ? 'CONTRACT_HEDGE_GTC'
      : 'SPOT_HEDGE_GTC';
    return this.authorizeGtc(
      entered,
      orders,
      role,
      amounts,
      referencePrice
    );
  }

  private decideExistingGtc(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    gtc: Readonly<StrategyOrderRecord>,
    amounts: Readonly<ReconciledAmounts>
  ): ReconciliationResult {
    const expectedRole = amounts.marketDelta.gt(0)
      ? 'CONTRACT_HEDGE_GTC'
      : amounts.marketDelta.lt(0)
        ? 'SPOT_HEDGE_GTC'
        : null;
    let request: Decimal;
    try {
      request = requiredDecimal(gtc.request.baseQuantity);
    } catch (error) {
      if (!(error instanceof ExactArithmeticUnavailable)) throw error;
      return this.pending(
        entered,
        orders,
        exactUnavailable(amounts.fields.exposureKnown)
      );
    }
    if (
      expectedRole === null
      || gtc.role !== expectedRole
      || !request.eq(amounts.preGtcResidual)
    ) {
      return this.transitionFailure(
        entered,
        orders,
        'HEDGE_INCOMPLETE',
        'INCONSISTENT_ORDER_STATE',
        amounts.fields
      );
    }

    if (gtc.submissionDisposition === 'DEFINITELY_NOT_SUBMITTED') {
      const failureCode = gtc.submissionFailureCode;
      if (failureCode === null) {
        return this.transitionFailure(
          entered,
          orders,
          'HEDGE_INCOMPLETE',
          'INCONSISTENT_ORDER_STATE',
          amounts.fields
        );
      }
      return this.transitionFailure(
        entered,
        orders,
        'HEDGE_INCOMPLETE',
        failureCode,
        amounts.fields
      );
    }

    const snapshot = gtc.snapshot;
    if (snapshot === null) {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'ORDER_EVIDENCE_MISMATCH',
        exposureKnown: amounts.fields.exposureKnown,
        strategyOrderId: gtc.id,
        clientOrderId: gtc.clientOrderId,
        exchangeId: gtc.exchangeId,
        expected: 'persisted order snapshot',
        actual: 'missing'
      });
    }

    let conserved: boolean;
    try {
      conserved = exactSum([amounts.gtcFilled, amounts.gtcRemaining])
        .eq(request);
    } catch (error) {
      if (!(error instanceof ExactArithmeticUnavailable)) throw error;
      return this.pending(
        entered,
        orders,
        exactUnavailable(amounts.fields.exposureKnown)
      );
    }
    const crossed = amounts.marketDelta.gt(0)
      ? amounts.totalDelta.lt(0)
      : amounts.totalDelta.gt(0);
    const structurallyValid = conserved
      && amounts.gtcFilled.lte(amounts.preGtcResidual)
      && amounts.gtcRemaining.eq(amounts.currentResidual)
      && !crossed;
    if (!structurallyValid) {
      return this.transitionFailure(
        entered,
        orders,
        'HEDGE_INCOMPLETE',
        'INCONSISTENT_ORDER_STATE',
        amounts.fields
      );
    }

    switch (snapshot.status) {
      case 'unknown':
        return this.pending(entered, orders, {
          kind: 'pending',
          reason: 'GTC_STATUS_UNKNOWN',
          exposureKnown: amounts.fields.exposureKnown,
          strategyOrderId: gtc.id,
          clientOrderId: gtc.clientOrderId,
          exchangeId: gtc.exchangeId
        });
      case 'open':
        if (!amounts.gtcRemaining.gt(0)) {
          return this.transitionFailure(
            entered,
            orders,
            'HEDGE_INCOMPLETE',
            'INCONSISTENT_ORDER_STATE',
            amounts.fields
          );
        }
        if (entered.state === 'WAITING_HEDGE') {
          return { kind: 'waiting_gtc' };
        }
        return this.transitionSuccess(
          entered,
          orders,
          'WAITING_HEDGE',
          amounts.fields
        );
      case 'closed':
        if (!this.isFullyHedgedGtc(request, amounts)) {
          return this.transitionFailure(
            entered,
            orders,
            'HEDGE_INCOMPLETE',
            'INCONSISTENT_ORDER_STATE',
            amounts.fields
          );
        }
        return this.transitionSuccess(
          entered,
          orders,
          'HEDGED',
          amounts.fields
        );
      case 'canceled':
        if (this.isFullyHedgedGtc(request, amounts)) {
          return this.transitionSuccess(
            entered,
            orders,
            'HEDGED',
            amounts.fields
          );
        }
        return this.transitionFailure(
          entered,
          orders,
          'HEDGE_INCOMPLETE',
          'HEDGE_ORDER_CANCELED',
          amounts.fields
        );
      case 'rejected':
        if (!amounts.gtcFilled.isZero()) {
          return this.transitionFailure(
            entered,
            orders,
            'HEDGE_INCOMPLETE',
            'INCONSISTENT_ORDER_STATE',
            amounts.fields
          );
        }
        return this.transitionFailure(
          entered,
          orders,
          'HEDGE_INCOMPLETE',
          'HEDGE_ORDER_REJECTED',
          amounts.fields
        );
    }
  }

  private isFullyHedgedGtc(
    request: Decimal,
    amounts: Readonly<ReconciledAmounts>
  ): boolean {
    return amounts.gtcFilled.eq(request)
      && amounts.gtcRemaining.isZero()
      && amounts.currentResidual.isZero()
      && amounts.totalSpot.gt(0)
      && amounts.totalContract.gt(0)
      && amounts.totalSpot.eq(amounts.totalContract);
  }

  private async authorizeGtc(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    role: GtcTarget['role'],
    amounts: Readonly<ReconciledAmounts>,
    referencePrice: string
  ): Promise<ReconciliationResult> {
    const target = targetFor(entered, role);
    let gateway: ExchangeGateway;
    let market: MarketRules;
    try {
      gateway = this.registry.get(target.exchangeId);
      market = await gateway.loadMarket(entered.symbol, target.kind);
    } catch {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'MARKET_RULES_UNAVAILABLE',
        exposureKnown: amounts.fields.exposureKnown,
        exchangeId: target.exchangeId
      });
    }

    let rules: ParsedMarketRules | null;
    try {
      rules = marketIdentityMatches(
        market,
        target.expectedMarket,
        target,
        entered.symbol
      )
        ? parsedMarketRules(market)
        : null;
    } catch (error) {
      if (error instanceof ExactArithmeticUnavailable) {
        rules = null;
      } else {
        throw error;
      }
    }
    if (rules === null) {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'MARKET_RULES_UNAVAILABLE',
        exposureKnown: amounts.fields.exposureKnown,
        exchangeId: target.exchangeId
      });
    }

    let candidateValue: string;
    try {
      candidateValue = await gateway.quantizePrice(
        entered.symbol,
        target.kind,
        referencePrice
      );
    } catch {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'PRICE_QUANTIZATION_FAILED',
        exposureKnown: amounts.fields.exposureKnown,
        exchangeId: target.exchangeId
      });
    }
    const candidatePrice = positiveDecimal(candidateValue);
    if (candidatePrice === null) {
      return this.pending(entered, orders, {
        kind: 'pending',
        reason: 'PRICE_QUANTIZATION_FAILED',
        exposureKnown: amounts.fields.exposureKnown,
        exchangeId: target.exchangeId
      });
    }

    let priceAligned: boolean;
    let tradable: boolean;
    try {
      priceAligned = exactModuloIsZero(candidatePrice, rules.priceStep);
      if (!priceAligned) {
        return this.pending(entered, orders, {
          kind: 'pending',
          reason: 'PRICE_QUANTIZATION_FAILED',
          exposureKnown: amounts.fields.exposureKnown,
          exchangeId: target.exchangeId
        });
      }
      const baseStep = exactProduct(rules.amountStep, rules.contractSize);
      const stepAligned = exactModuloIsZero(
        amounts.preGtcResidual,
        baseStep
      );
      const wholeContracts = target.kind === 'spot'
        || exactModuloIsZero(amounts.preGtcResidual, rules.contractSize);
      const withinBaseRange = amounts.preGtcResidual.gte(
        rules.minBaseAmount
      ) && (
        rules.maxBaseAmount === undefined
        || amounts.preGtcResidual.lte(rules.maxBaseAmount)
      );
      const notional = exactProduct(amounts.preGtcResidual, candidatePrice);
      const withinNotionalRange = (
        rules.minQuoteNotional === undefined
        || notional.gte(rules.minQuoteNotional)
      ) && (
        rules.maxQuoteNotional === undefined
        || notional.lte(rules.maxQuoteNotional)
      );
      tradable = stepAligned
        && wholeContracts
        && withinBaseRange
        && withinNotionalRange;
    } catch (error) {
      if (!(error instanceof ExactArithmeticUnavailable)) throw error;
      return this.pending(
        entered,
        orders,
        exactUnavailable(amounts.fields.exposureKnown)
      );
    }

    if (!tradable) {
      return this.transitionFailure(
        entered,
        orders,
        'HEDGE_INCOMPLETE',
        'HEDGE_RESIDUAL_NOT_TRADABLE',
        amounts.fields
      );
    }
    const result = {
      kind: 'need_gtc',
      role,
      baseQuantity: amounts.fields.preGtcResidual,
      referencePrice
    } as const;
    this.logConclusion(entered, result, amounts.fields);
    return result;
  }

  private transitionSuccess(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    state: 'HEDGED' | 'WAITING_HEDGE',
    amounts: Readonly<AmountFields>
  ): ReconciliationResult {
    return this.transition(entered, orders, state, undefined, amounts);
  }

  private transitionFailure(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    state: 'FAILED' | 'HEDGE_INCOMPLETE',
    failureCode: StrategyFailureCode,
    amounts: Readonly<AmountFields>
  ): ReconciliationResult {
    return this.transition(entered, orders, state, failureCode, amounts);
  }

  private transition(
    entered: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    state: 'HEDGED' | 'WAITING_HEDGE' | 'FAILED' | 'HEDGE_INCOMPLETE',
    failureCode: StrategyFailureCode | undefined,
    amounts: Readonly<AmountFields>
  ): ReconciliationResult {
    let written = false;
    try {
      written = this.repository.transition(
        entered.id,
        [activeState(entered)],
        state,
        failureCode
      );
    } catch {
      written = false;
    }
    if (written) {
      const result: ReconciliationResult = failureCode === undefined
        ? { kind: 'written', state: state as 'HEDGED' | 'WAITING_HEDGE' }
        : {
            kind: 'written',
            state: state as 'FAILED' | 'HEDGE_INCOMPLETE',
            failureCode
          };
      this.logConclusion(entered, result, amounts);
      return result;
    }

    const current = this.repository.getStrategy(entered.id);
    const expectedFailureCode = failureCode ?? null;
    if (
      current.state === state
      && current.failureCode === expectedFailureCode
    ) {
      const observed = { kind: 'observed_state', state: current.state } as const;
      this.logConclusion(entered, observed, amounts);
      return observed;
    }
    return this.pending(entered, this.repository.listOrders(entered.id), {
      kind: 'pending',
      reason: 'STATE_WRITE_CONFLICT',
      exposureKnown: amounts.exposureKnown,
      expected: failureCode === undefined
        ? state
        : `${state}:${failureCode}`,
      actual: current.failureCode === null
        ? current.state
        : `${current.state}:${current.failureCode}`
    });
  }

  private pending(
    entered: Readonly<StrategyRecord>,
    orders: readonly Readonly<StrategyOrderRecord>[],
    input: Readonly<PendingInput>
  ): ReconciliationResult {
    const strategyState = activeState(entered);
    const result = {
      ...input,
      strategyState
    };
    const revisions = [...orders]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, updatedAt }) => `${id}:${updatedAt}`)
      .join(',');
    const warningKey = [
      entered.id,
      input.reason,
      input.strategyOrderId ?? '',
      revisions
    ].join('|');
    if (!this.pendingWarningKeys.has(warningKey)) {
      this.pendingWarningKeys.add(warningKey);
      this.operationalLog?.warn('hedge_reconciliation_pending', {
        strategyId: entered.id,
        strategyState,
        reason: input.reason,
        exposureKnown: input.exposureKnown,
        ...(input.strategyOrderId === undefined
          ? {}
          : { strategyOrderId: input.strategyOrderId }),
        ...(input.clientOrderId === undefined
          ? {}
          : { clientOrderId: input.clientOrderId }),
        ...(input.exchangeId === undefined
          ? {}
          : { exchangeId: input.exchangeId }),
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.actual === undefined ? {} : { actual: input.actual })
      });
    }
    return result;
  }

  private logConclusion(
    entered: Readonly<StrategyRecord>,
    result: Readonly<ReconciliationResult>,
    amounts?: Readonly<AmountFields>
  ): void {
    const fields: OperationalFields = {
      strategyId: entered.id,
      strategyState: entered.state,
      conclusion: result.kind === 'written' ? result.state : result.kind,
      ...(result.kind === 'written' && 'failureCode' in result
        ? { failureCode: result.failureCode }
        : {}),
      ...(result.kind === 'need_gtc' ? { role: result.role } : {}),
      ...(amounts === undefined ? {} : amounts)
    };
    this.operationalLog?.info('hedge_reconciliation_conclusion', fields);
  }
}
