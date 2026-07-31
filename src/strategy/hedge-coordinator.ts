import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../domain/client-order-id.js';
import type {
  MarketKind,
  OrderRequest,
  OrderRole,
  OrderSnapshot
} from '../domain/types.js';
import type { ExchangeGateway } from '../exchanges/exchange-gateway.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import type {
  StrategyFailureCode,
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../storage/strategy-repository.js';
import {
  releaseStrategyOperation,
  tryAcquireStrategyOperation
} from './strategy-operation-owner.js';

type ConfirmedMarginMode = 'isolated' | 'cross';

interface PreparedOrder {
  readonly gateway: ExchangeGateway;
  readonly record: StrategyOrderRecord;
  readonly existedBeforePreparation: boolean;
}

interface SnapshotOutcome {
  readonly kind: 'snapshot';
  readonly snapshot: OrderSnapshot;
}

interface FailureOutcome {
  readonly kind: 'failure';
  readonly failureCode: StrategyFailureCode;
  readonly exposureKnown: boolean;
}

type SubmissionOutcome = SnapshotOutcome | FailureOutcome;

class SubmissionPersistenceError extends Error {
  readonly name = 'SubmissionPersistenceError';

  constructor(
    readonly failureCode: StrategyFailureCode,
    readonly exposureKnown: boolean
  ) {
    super('order snapshot persistence failed');
  }
}

interface SnapshotValidation {
  readonly valid: boolean;
  readonly exposureKnown: boolean;
  readonly failureCode: StrategyFailureCode;
}

const SNAPSHOT_STATUSES = new Set<OrderSnapshot['status']>([
  'open',
  'closed',
  'canceled',
  'rejected',
  'unknown'
]);
const MAX_COORDINATOR_PRECISION = 1_000_000;
const COORDINATOR_MIN_EXPONENT = -9_000_000_000_000_000;
const COORDINATOR_MAX_EXPONENT = 9_000_000_000_000_000;
const CoordinatorDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: COORDINATOR_MIN_EXPONENT,
  maxE: COORDINATOR_MAX_EXPONENT,
  toExpNeg: -7,
  toExpPos: 21
});

function parsedDecimal(
  value: unknown,
  allowZero: boolean
): Decimal | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 10_000) {
    return null;
  }
  let parsed: Decimal;
  try {
    parsed = new CoordinatorDecimal(value);
  } catch {
    return null;
  }
  if (
    !parsed.isFinite()
    || parsed.isNegative()
    || (!allowZero && parsed.isZero())
  ) {
    return null;
  }
  return parsed;
}

function exactConstructor(values: readonly Decimal[]): Decimal.Constructor | null {
  const highestExponent = Math.max(...values.map((value) => value.e));
  const lowestSignificantExponent = Math.min(...values.map(
    (value) => value.e - value.sd() + 1
  ));
  const requiredPrecision = highestExponent - lowestSignificantExponent + 4;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision <= 0
    || requiredPrecision > MAX_COORDINATOR_PRECISION
  ) {
    return null;
  }
  return CoordinatorDecimal.clone({
    precision: Math.max(CoordinatorDecimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN,
    minE: COORDINATOR_MIN_EXPONENT,
    maxE: COORDINATOR_MAX_EXPONENT,
    toExpNeg: -7,
    toExpPos: 21
  });
}

function exactQuantityDifference(
  largerValue: string,
  smallerValue: string
): string | null {
  const larger = parsedDecimal(largerValue, true);
  const smaller = parsedDecimal(smallerValue, true);
  if (larger === null || smaller === null || larger.lte(smaller)) {
    return null;
  }
  const ExactDecimal = exactConstructor([larger, smaller]);
  if (ExactDecimal === null) {
    return null;
  }
  const difference = new ExactDecimal(largerValue).minus(smallerValue);
  if (!difference.isFinite() || difference.lte(0)) {
    return null;
  }
  return difference.toFixed();
}

function decimalEquals(leftValue: string, rightValue: string): boolean {
  const left = parsedDecimal(leftValue, true);
  const right = parsedDecimal(rightValue, true);
  return left !== null && right !== null && left.eq(right);
}

function positivePrice(value: unknown): value is string {
  return parsedDecimal(value, false) !== null;
}

function positiveFillKnown(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    return (
      parsedDecimal(
        Reflect.get(value, 'filledBaseQuantity'),
        true
      )?.gt(0) ?? false
    );
  } catch {
    return false;
  }
}

function requestMatches(
  actual: Readonly<OrderRequest>,
  expected: Readonly<OrderRequest>
): boolean {
  return (
    actual.symbol === expected.symbol
    && actual.kind === expected.kind
    && actual.type === expected.type
    && actual.side === expected.side
    && decimalEquals(actual.baseQuantity, expected.baseQuantity)
    && actual.clientOrderId === expected.clientOrderId
    && actual.timeInForce === expected.timeInForce
    && actual.positionSide === expected.positionSide
    && actual.marginMode === expected.marginMode
    && (
      actual.price === undefined
        ? expected.price === undefined
        : (
          expected.price !== undefined
          && decimalEquals(actual.price, expected.price)
        )
    )
  );
}

function validateSnapshot(
  snapshot: Readonly<OrderSnapshot>,
  request: Readonly<OrderRequest>,
  exchangeId: string
): SnapshotValidation {
  const filled = parsedDecimal(snapshot.filledBaseQuantity, true);
  const exposureKnown = filled?.gt(0) ?? false;
  const requested = parsedDecimal(snapshot.requestedBaseQuantity, false);
  const remaining = parsedDecimal(snapshot.remainingBaseQuantity, true);
  if (
    snapshot.exchangeId !== exchangeId
    || snapshot.clientOrderId !== request.clientOrderId
    || snapshot.symbol !== request.symbol
    || snapshot.kind !== request.kind
    || snapshot.type !== request.type
    || snapshot.side !== request.side
    || typeof snapshot.exchangeOrderId !== 'string'
    || snapshot.exchangeOrderId.length === 0
    || snapshot.exchangeOrderId.trim() !== snapshot.exchangeOrderId
    || requested === null
    || filled === null
    || remaining === null
    || !requested.eq(request.baseQuantity)
    || filled.gt(requested)
    || remaining.gt(requested)
    || !SNAPSHOT_STATUSES.has(snapshot.status)
  ) {
    return {
      valid: false,
      exposureKnown,
      failureCode: 'INCONSISTENT_ORDER_STATE'
    };
  }
  const ExactDecimal = exactConstructor([requested, filled, remaining]);
  if (
    ExactDecimal === null
    || !new ExactDecimal(snapshot.filledBaseQuantity)
      .plus(snapshot.remainingBaseQuantity)
      .eq(snapshot.requestedBaseQuantity)
  ) {
    return {
      valid: false,
      exposureKnown,
      failureCode: 'INCONSISTENT_ORDER_STATE'
    };
  }
  if (snapshot.averagePrice !== null && !positivePrice(snapshot.averagePrice)) {
    return {
      valid: false,
      exposureKnown,
      failureCode: (
        request.type === 'market' && exposureKnown
          ? 'MISSING_AVERAGE_PRICE'
          : 'INCONSISTENT_ORDER_STATE'
      )
    };
  }
  try {
    if (new Date(snapshot.updatedAt).toISOString() !== snapshot.updatedAt) {
      throw new Error('non-canonical timestamp');
    }
  } catch {
    return {
      valid: false,
      exposureKnown,
      failureCode: 'INCONSISTENT_ORDER_STATE'
    };
  }
  return {
    valid: true,
    exposureKnown,
    failureCode: 'INCONSISTENT_ORDER_STATE'
  };
}

function failed(
  failureCode: StrategyFailureCode,
  exposureKnown: boolean
): FailureOutcome {
  return {
    kind: 'failure',
    failureCode,
    exposureKnown
  };
}

export class HedgeCoordinator {
  constructor(
    private readonly registry: ExchangeRegistry,
    private readonly repository: StrategyRepository
  ) {}

  async confirmAndExecute(strategyId: string): Promise<void> {
    if (!tryAcquireStrategyOperation(strategyId)) {
      return;
    }
    try {
      await this.confirmAndExecuteOwned(strategyId);
    } catch (error) {
      if (
        error instanceof SubmissionPersistenceError
        && this.isExecuting(strategyId)
      ) {
        this.failStrategyBestEffort(
          strategyId,
          error.exposureKnown,
          error.failureCode
        );
      }
      throw error;
    } finally {
      releaseStrategyOperation(strategyId);
    }
  }

  private async confirmAndExecuteOwned(strategyId: string): Promise<void> {
    let strategy = this.repository.getStrategy(strategyId);
    const recovering = strategy.state === 'EXECUTING';
    if (strategy.state === 'PENDING_CONFIRMATION') {
      if (this.repository.listOrders(strategyId).length !== 0) {
        return;
      }
      if (!this.repository.claimForExecution(strategyId)) {
        return;
      }
      strategy = this.repository.getStrategy(strategyId);
    } else if (!recovering) {
      return;
    }

    const marginMode = strategy.preflight.accountSettings.marginMode;
    if (marginMode !== 'isolated' && marginMode !== 'cross') {
      this.failStrategy(strategy.id, false, 'INCONSISTENT_ORDER_STATE');
      return;
    }

    switch (strategy.preflight.mode) {
      case 'CONTRACT_FIRST':
        await this.executeSequential(strategy, 'contract', marginMode);
        return;
      case 'SPOT_FIRST':
        await this.executeSequential(strategy, 'spot', marginMode);
        return;
      case 'CONCURRENT':
        await this.executeConcurrent(strategy, marginMode, recovering);
        return;
    }
  }

  private marketRequest(
    strategy: Readonly<StrategyRecord>,
    leg: 'spot' | 'contract',
    marginMode: ConfirmedMarginMode
  ): OrderRequest {
    const role = leg === 'spot' ? 'SPOT_MARKET' : 'CONTRACT_MARKET';
    const request: OrderRequest = {
      symbol: strategy.symbol,
      kind: leg === 'spot' ? 'spot' : 'swap',
      type: 'market',
      side: leg === 'spot' ? 'buy' : 'sell',
      baseQuantity: strategy.effectiveBaseQuantity,
      clientOrderId: makeClientOrderId(strategy.id, role)
    };
    if (leg === 'contract') {
      request.positionSide = 'SHORT';
      request.marginMode = marginMode;
    }
    return request;
  }

  private hedgeRequest(
    strategy: Readonly<StrategyRecord>,
    leg: 'spot' | 'contract',
    baseQuantity: string,
    price: string,
    marginMode: ConfirmedMarginMode
  ): OrderRequest {
    const role = leg === 'spot' ? 'SPOT_HEDGE_GTC' : 'CONTRACT_HEDGE_GTC';
    const request: OrderRequest = {
      symbol: strategy.symbol,
      kind: leg === 'spot' ? 'spot' : 'swap',
      type: 'limit',
      side: leg === 'spot' ? 'buy' : 'sell',
      baseQuantity,
      price,
      timeInForce: 'GTC',
      clientOrderId: makeClientOrderId(strategy.id, role)
    };
    if (leg === 'contract') {
      request.positionSide = 'SHORT';
      request.marginMode = marginMode;
    }
    return request;
  }

  private prepare(
    strategy: Readonly<StrategyRecord>,
    role: OrderRole,
    request: OrderRequest
  ): PreparedOrder {
    const existing = this.repository.listOrders(strategy.id)
      .filter((order) => order.role === role);
    if (existing.length > 1) {
      throw new Error('strategy order role is not unique');
    }
    const gateway = this.registry.get(
      role.startsWith('SPOT_')
        ? strategy.spotExchangeId
        : strategy.contractExchangeId
    );
    const existingOrder = existing[0];
    if (existingOrder !== undefined) {
      if (!requestMatches(existingOrder.request, request)) {
        throw new Error('persisted order intent does not match execution role');
      }
      return {
        gateway,
        record: existingOrder,
        existedBeforePreparation: true
      };
    }
    if (!this.isExecuting(strategy.id)) {
      throw new Error('strategy execution ended before order planning');
    }
    return {
      gateway,
      record: this.repository.planOrder(strategy.id, role, request),
      existedBeforePreparation: false
    };
  }

  private prepareExisting(
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>
  ): PreparedOrder {
    const gateway = this.registry.get(
      order.role.startsWith('SPOT_')
        ? strategy.spotExchangeId
        : strategy.contractExchangeId
    );
    return {
      gateway,
      record: order,
      existedBeforePreparation: true
    };
  }

  private orderForRole(
    strategyId: string,
    role: OrderRole
  ): StrategyOrderRecord | undefined {
    const matches = this.repository.listOrders(strategyId)
      .filter((order) => order.role === role);
    if (matches.length > 1) {
      throw new Error('strategy order role is not unique');
    }
    return matches[0];
  }

  private async reconcileUnexpectedTopology(
    strategy: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    failureCode: StrategyFailureCode = 'INCONSISTENT_ORDER_STATE'
  ): Promise<void> {
    const settled = await Promise.allSettled(orders.map((order) => (
      this.submit(this.prepareExisting(strategy, order))
    )));
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected !== undefined) {
      this.failStrategyBestEffort(strategy.id, true, failureCode);
      throw rejected.reason;
    }
    this.failStrategy(strategy.id, true, failureCode);
  }

  private async lookupAndPersist(
    prepared: Readonly<PreparedOrder>,
    missingCode: StrategyFailureCode,
    fallbackExposureKnown = false
  ): Promise<SubmissionOutcome> {
    if (!this.isExecuting(prepared.record.strategyId)) {
      return failed('INCONSISTENT_ORDER_STATE', fallbackExposureKnown);
    }
    let found: OrderSnapshot | null;
    try {
      found = await prepared.gateway.findOrderByClientId(
        prepared.record.clientOrderId,
        prepared.record.request.symbol,
        prepared.record.request.kind
      );
    } catch {
      return failed(
        'ORDER_RECONCILIATION_FAILED',
        fallbackExposureKnown
      );
    }
    if (found === null) {
      return failed(missingCode, fallbackExposureKnown);
    }
    return this.persistSnapshot(prepared, found, fallbackExposureKnown);
  }

  private persistSnapshot(
    prepared: Readonly<PreparedOrder>,
    snapshot: OrderSnapshot,
    fallbackExposureKnown = false
  ): SubmissionOutcome {
    let exposureKnown = (
      fallbackExposureKnown
      || positiveFillKnown(snapshot)
      || positiveFillKnown(prepared.record.snapshot)
    );
    let persistedSnapshot = prepared.record.snapshot;
    try {
      const persistedOrder = this.repository
        .listOrders(prepared.record.strategyId)
        .find((order) => order.id === prepared.record.id);
      if (persistedOrder === undefined) {
        return failed('INCONSISTENT_ORDER_STATE', exposureKnown);
      }
      persistedSnapshot = persistedOrder.snapshot;
      exposureKnown = exposureKnown || positiveFillKnown(persistedSnapshot);
    } catch {
      return failed('INCONSISTENT_ORDER_STATE', exposureKnown);
    }

    let validation: SnapshotValidation;
    try {
      validation = validateSnapshot(
        snapshot,
        prepared.record.request,
        prepared.gateway.exchangeId
      );
    } catch {
      return failed('INCONSISTENT_ORDER_STATE', exposureKnown);
    }
    exposureKnown = exposureKnown || validation.exposureKnown;
    if (!validation.valid) {
      return failed(validation.failureCode, exposureKnown);
    }
    if (persistedSnapshot !== null) {
      const persistedFill = parsedDecimal(
        persistedSnapshot.filledBaseQuantity,
        true
      );
      const candidateFill = parsedDecimal(
        snapshot.filledBaseQuantity,
        true
      );
      if (
        persistedFill === null
        || candidateFill === null
        || candidateFill.lt(persistedFill)
      ) {
        return failed('INCONSISTENT_ORDER_STATE', exposureKnown);
      }
    }
    if (!this.isExecuting(prepared.record.strategyId)) {
      return failed('INCONSISTENT_ORDER_STATE', exposureKnown);
    }
    try {
      this.repository.attachOrderSnapshot(prepared.record.id, snapshot);
    } catch {
      this.failStrategyBestEffort(
        prepared.record.strategyId,
        exposureKnown,
        'INCONSISTENT_ORDER_STATE'
      );
      throw new SubmissionPersistenceError(
        'INCONSISTENT_ORDER_STATE',
        exposureKnown
      );
    }
    if (snapshot.status === 'unknown') {
      return failed(
        'ORDER_RECONCILIATION_FAILED',
        exposureKnown
      );
    }
    return { kind: 'snapshot', snapshot };
  }

  private async submit(
    prepared: Readonly<PreparedOrder>
  ): Promise<SubmissionOutcome> {
    const persistedExposureKnown = (
      prepared.record.snapshot !== null
      && (
        parsedDecimal(
          prepared.record.snapshot.filledBaseQuantity,
          true
        )?.gt(0) ?? false
      )
    );
    if (!this.isExecuting(prepared.record.strategyId)) {
      return failed('INCONSISTENT_ORDER_STATE', persistedExposureKnown);
    }
    if (prepared.record.snapshot !== null) {
      if (prepared.record.snapshot.status === 'unknown') {
        return this.lookupAndPersist(
          prepared,
          'ORDER_NOT_FOUND',
          persistedExposureKnown
        );
      }
      return {
        kind: 'snapshot',
        snapshot: prepared.record.snapshot
      };
    }
    if (prepared.existedBeforePreparation) {
      return this.lookupAndPersist(prepared, 'ORDER_NOT_FOUND');
    }

    let snapshot: OrderSnapshot;
    try {
      snapshot = await prepared.gateway.createOrder(prepared.record.request);
    } catch {
      return this.lookupAndPersist(prepared, 'ORDER_SUBMISSION_UNKNOWN');
    }
    if (snapshot.status === 'unknown') {
      const persisted = this.persistSnapshot(prepared, snapshot);
      return this.lookupAndPersist(
        prepared,
        'ORDER_NOT_FOUND',
        persisted.kind === 'failure'
          ? persisted.exposureKnown
          : positiveFillKnown(snapshot)
      );
    }
    return this.persistSnapshot(prepared, snapshot);
  }

  private isExecuting(strategyId: string): boolean {
    try {
      return this.repository.getStrategy(strategyId).state === 'EXECUTING';
    } catch {
      return false;
    }
  }

  private failStrategy(
    strategyId: string,
    exposureKnown: boolean,
    failureCode: StrategyFailureCode
  ): void {
    this.repository.transition(
      strategyId,
      ['EXECUTING'],
      exposureKnown ? 'HEDGE_INCOMPLETE' : 'FAILED',
      failureCode
    );
  }

  private failStrategyBestEffort(
    strategyId: string,
    exposureKnown: boolean,
    failureCode: StrategyFailureCode
  ): void {
    try {
      this.failStrategy(strategyId, exposureKnown, failureCode);
    } catch {
      // Preserve the fixed typed carrier without retaining the unsafe cause.
    }
  }

  private async quantizedPrice(
    gateway: ExchangeGateway,
    symbol: string,
    kind: MarketKind,
    price: string
  ): Promise<string | null> {
    let quantized: string;
    try {
      quantized = await gateway.quantizePrice(symbol, kind, price);
    } catch {
      return null;
    }
    return positivePrice(quantized) ? quantized : null;
  }

  private finishHedge(
    strategyId: string,
    targetQuantity: string,
    outcome: SubmissionOutcome
  ): void {
    if (outcome.kind === 'failure') {
      this.failStrategy(strategyId, true, outcome.failureCode);
      return;
    }
    const { snapshot } = outcome;
    if (snapshot.status === 'rejected') {
      this.failStrategy(strategyId, true, 'HEDGE_ORDER_REJECTED');
      return;
    }
    if (snapshot.status === 'canceled') {
      this.failStrategy(strategyId, true, 'HEDGE_ORDER_CANCELED');
      return;
    }
    if (snapshot.status === 'open') {
      this.repository.transition(
        strategyId,
        ['EXECUTING'],
        'WAITING_HEDGE'
      );
      return;
    }
    if (
      snapshot.status === 'closed'
      && decimalEquals(snapshot.filledBaseQuantity, targetQuantity)
      && decimalEquals(snapshot.remainingBaseQuantity, '0')
    ) {
      this.repository.transition(strategyId, ['EXECUTING'], 'HEDGED');
      return;
    }
    this.failStrategy(strategyId, true, 'INCONSISTENT_ORDER_STATE');
  }

  private async executeSequential(
    strategy: Readonly<StrategyRecord>,
    firstLeg: 'spot' | 'contract',
    marginMode: ConfirmedMarginMode
  ): Promise<void> {
    const firstRole: OrderRole = firstLeg === 'spot'
      ? 'SPOT_MARKET'
      : 'CONTRACT_MARKET';
    const secondLeg = firstLeg === 'spot' ? 'contract' : 'spot';
    const secondRole: OrderRole = secondLeg === 'spot'
      ? 'SPOT_HEDGE_GTC'
      : 'CONTRACT_HEDGE_GTC';
    const existingOrders = this.repository.listOrders(strategy.id);
    const expectedRoles = new Set<OrderRole>([firstRole, secondRole]);
    if (existingOrders.some((order) => !expectedRoles.has(order.role))) {
      await this.reconcileUnexpectedTopology(strategy, existingOrders);
      return;
    }
    const existingFirst = this.orderForRole(strategy.id, firstRole);
    const existingSecond = this.orderForRole(strategy.id, secondRole);
    if (existingFirst === undefined && existingSecond !== undefined) {
      const unexpected = await this.submit(
        this.prepareExisting(strategy, existingSecond)
      );
      if (unexpected.kind === 'failure') {
        this.failStrategy(
          strategy.id,
          true,
          unexpected.failureCode
        );
      } else {
        this.failStrategy(
          strategy.id,
          true,
          'INCONSISTENT_ORDER_STATE'
        );
      }
      return;
    }
    const expectedFirstRequest = this.marketRequest(
      strategy,
      firstLeg,
      marginMode
    );
    const first = existingFirst === undefined
      ? this.prepare(strategy, firstRole, expectedFirstRequest)
      : this.prepareExisting(strategy, existingFirst);
    const firstOutcome = await this.submit(first);
    if (firstOutcome.kind === 'failure') {
      this.failStrategy(
        strategy.id,
        firstOutcome.exposureKnown,
        firstOutcome.failureCode
      );
      return;
    }

    if (!requestMatches(first.record.request, expectedFirstRequest)) {
      this.failStrategy(
        strategy.id,
        parsedDecimal(
          firstOutcome.snapshot.filledBaseQuantity,
          true
        )?.gt(0) ?? false,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }
    const firstSnapshot = firstOutcome.snapshot;
    const filled = parsedDecimal(firstSnapshot.filledBaseQuantity, true);
    if (filled === null) {
      this.failStrategy(strategy.id, false, 'INCONSISTENT_ORDER_STATE');
      return;
    }
    if (filled.isZero()) {
      this.failStrategy(strategy.id, false, 'NO_FILL');
      return;
    }
    if (
      firstSnapshot.averagePrice === null
      || !positivePrice(firstSnapshot.averagePrice)
    ) {
      this.failStrategy(strategy.id, true, 'MISSING_AVERAGE_PRICE');
      return;
    }
    if (
      firstSnapshot.status === 'rejected'
      || firstSnapshot.status === 'open'
    ) {
      this.failStrategy(strategy.id, true, 'INCONSISTENT_ORDER_STATE');
      return;
    }

    const targetQuantity = firstSnapshot.filledBaseQuantity;
    if (existingSecond !== undefined) {
      const second = this.prepareExisting(strategy, existingSecond);
      const secondOutcome = await this.submit(second);
      if (!decimalEquals(
        second.record.request.baseQuantity,
        targetQuantity
      )) {
        this.failStrategy(
          strategy.id,
          true,
          'INCONSISTENT_ORDER_STATE'
        );
        return;
      }
      this.finishHedge(strategy.id, targetQuantity, secondOutcome);
      return;
    }
    const secondGateway = this.registry.get(
      secondLeg === 'spot'
        ? strategy.spotExchangeId
        : strategy.contractExchangeId
    );
    const price = await this.quantizedPrice(
      secondGateway,
      strategy.symbol,
      secondLeg === 'spot' ? 'spot' : 'swap',
      firstSnapshot.averagePrice
    );
    if (price === null) {
      this.failStrategy(strategy.id, true, 'ORDER_RECONCILIATION_FAILED');
      return;
    }
    const second = this.prepare(
      strategy,
      secondRole,
      this.hedgeRequest(
        strategy,
        secondLeg,
        targetQuantity,
        price,
        marginMode
      )
    );
    const secondOutcome = await this.submit(second);
    this.finishHedge(strategy.id, targetQuantity, secondOutcome);
  }

  private async executeConcurrent(
    strategy: Readonly<StrategyRecord>,
    marginMode: ConfirmedMarginMode,
    recovering: boolean
  ): Promise<void> {
    const existingOrders = this.repository.listOrders(strategy.id);
    const marketOrders = existingOrders.filter(
      (order) => (
        order.role === 'SPOT_MARKET'
        || order.role === 'CONTRACT_MARKET'
      )
    );
    const hedgeOrders = existingOrders.filter(
      (order) => order.role.endsWith('_HEDGE_GTC')
    );
    if (
      recovering
      && (
        hedgeOrders.length > 1
        || (marketOrders.length < 2 && hedgeOrders.length !== 0)
      )
    ) {
      await this.reconcileUnexpectedTopology(strategy, existingOrders);
      return;
    }
    if (recovering && marketOrders.length === 1) {
      const incomplete = await this.submit(
        this.prepareExisting(strategy, marketOrders[0] as StrategyOrderRecord)
      );
      if (incomplete.kind === 'failure') {
        this.failStrategy(
          strategy.id,
          incomplete.exposureKnown,
          incomplete.failureCode
        );
      } else {
        const exposureKnown = parsedDecimal(
          incomplete.snapshot.filledBaseQuantity,
          true
        )?.gt(0) ?? false;
        this.failStrategy(
          strategy.id,
          exposureKnown,
          'INCONSISTENT_ORDER_STATE'
        );
      }
      return;
    }
    if (
      recovering
      && marketOrders.length === 0
      && existingOrders.length !== 0
    ) {
      const unexpected = await this.submit(
        this.prepareExisting(
          strategy,
          existingOrders[0] as StrategyOrderRecord
        )
      );
      this.failStrategy(
        strategy.id,
        true,
        unexpected.kind === 'failure'
          ? unexpected.failureCode
          : 'INCONSISTENT_ORDER_STATE'
      );
      return;
    }
    const spot = this.prepare(
      strategy,
      'SPOT_MARKET',
      this.marketRequest(strategy, 'spot', marginMode)
    );
    const contract = this.prepare(
      strategy,
      'CONTRACT_MARKET',
      this.marketRequest(strategy, 'contract', marginMode)
    );

    const settled = await Promise.allSettled([
      this.submit(spot),
      this.submit(contract)
    ]);
    const knownExposure = settled.some((result) => (
      result.status === 'fulfilled'
        ? (
          result.value.kind === 'snapshot'
            ? positiveFillKnown(result.value.snapshot)
            : result.value.exposureKnown
        )
        : (
          result.reason instanceof SubmissionPersistenceError
          && result.reason.exposureKnown
        )
    ));
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected !== undefined) {
      this.failStrategyBestEffort(
        strategy.id,
        knownExposure,
        'INCONSISTENT_ORDER_STATE'
      );
      throw rejected.reason;
    }

    const outcomes = settled.map((result) => (
      (result as PromiseFulfilledResult<SubmissionOutcome>).value
    ));
    const missingAverage = outcomes.some((outcome) => {
      if (outcome.kind === 'failure') {
        return outcome.failureCode === 'MISSING_AVERAGE_PRICE';
      }
      const filled = parsedDecimal(
        outcome.snapshot.filledBaseQuantity,
        true
      );
      return (
        filled !== null
        && filled.gt(0)
        && !positivePrice(outcome.snapshot.averagePrice)
      );
    });
    if (missingAverage) {
      if (hedgeOrders.length !== 0) {
        await this.reconcileUnexpectedTopology(
          strategy,
          existingOrders,
          'MISSING_AVERAGE_PRICE'
        );
      } else {
        this.failStrategy(strategy.id, true, 'MISSING_AVERAGE_PRICE');
      }
      return;
    }
    const submissionFailure = outcomes.find(
      (outcome): outcome is FailureOutcome => outcome.kind === 'failure'
    );
    if (submissionFailure !== undefined) {
      if (hedgeOrders.length !== 0) {
        await this.reconcileUnexpectedTopology(strategy, hedgeOrders);
        return;
      }
      const exposureKnown = outcomes.some((outcome) => (
        outcome.kind === 'failure'
          ? outcome.exposureKnown
          : (
            parsedDecimal(outcome.snapshot.filledBaseQuantity, true)?.gt(0)
            ?? false
          )
      ));
      this.failStrategy(
        strategy.id,
        exposureKnown,
        submissionFailure.failureCode
      );
      return;
    }

    const spotSnapshot = (outcomes[0] as SnapshotOutcome).snapshot;
    const contractSnapshot = (outcomes[1] as SnapshotOutcome).snapshot;
    const spotFilled = parsedDecimal(
      spotSnapshot.filledBaseQuantity,
      true
    );
    const contractFilled = parsedDecimal(
      contractSnapshot.filledBaseQuantity,
      true
    );
    if (spotFilled === null || contractFilled === null) {
      this.failStrategy(strategy.id, false, 'INCONSISTENT_ORDER_STATE');
      return;
    }
    if (
      (spotFilled.gt(0) && !positivePrice(spotSnapshot.averagePrice))
      || (
        contractFilled.gt(0)
        && !positivePrice(contractSnapshot.averagePrice)
      )
    ) {
      this.failStrategy(strategy.id, true, 'MISSING_AVERAGE_PRICE');
      return;
    }
    if (spotFilled.isZero() && contractFilled.isZero()) {
      if (hedgeOrders.length !== 0) {
        await this.reconcileUnexpectedTopology(strategy, existingOrders);
      } else {
        this.failStrategy(strategy.id, false, 'NO_FILL');
      }
      return;
    }
    if (spotFilled.isZero() || contractFilled.isZero()) {
      if (hedgeOrders.length !== 0) {
        await this.reconcileUnexpectedTopology(strategy, existingOrders);
      } else {
        this.failStrategy(strategy.id, true, 'NO_FILL');
      }
      return;
    }
    if (
      spotSnapshot.status !== 'closed'
      || contractSnapshot.status !== 'closed'
    ) {
      if (hedgeOrders.length !== 0) {
        await this.reconcileUnexpectedTopology(strategy, existingOrders);
      } else {
        this.failStrategy(strategy.id, true, 'INCONSISTENT_ORDER_STATE');
      }
      return;
    }
    if (spotFilled.eq(contractFilled)) {
      if (hedgeOrders.length !== 0) {
        await this.reconcileUnexpectedTopology(strategy, existingOrders);
      } else {
        this.repository.transition(strategy.id, ['EXECUTING'], 'HEDGED');
      }
      return;
    }

    const spotIsLarger = spotFilled.gt(contractFilled);
    const largerSnapshot = spotIsLarger ? spotSnapshot : contractSnapshot;
    const difference = exactQuantityDifference(
      largerSnapshot.filledBaseQuantity,
      spotIsLarger
        ? contractSnapshot.filledBaseQuantity
        : spotSnapshot.filledBaseQuantity
    );
    if (
      difference === null
      || largerSnapshot.averagePrice === null
      || !positivePrice(largerSnapshot.averagePrice)
    ) {
      this.failStrategy(strategy.id, true, 'INCONSISTENT_ORDER_STATE');
      return;
    }
    const smallerLeg = spotIsLarger ? 'contract' : 'spot';
    const differenceRole: OrderRole = spotIsLarger
      ? 'CONTRACT_HEDGE_GTC'
      : 'SPOT_HEDGE_GTC';
    if (
      hedgeOrders.some((order) => order.role !== differenceRole)
    ) {
      await this.reconcileUnexpectedTopology(strategy, existingOrders);
      return;
    }
    const smallerGateway = spotIsLarger ? contract.gateway : spot.gateway;
    const existingDifference = this.orderForRole(
      strategy.id,
      differenceRole
    );
    if (existingDifference !== undefined) {
      const hedge = this.prepareExisting(strategy, existingDifference);
      const hedgeOutcome = await this.submit(hedge);
      if (!decimalEquals(
        hedge.record.request.baseQuantity,
        difference
      )) {
        this.failStrategy(
          strategy.id,
          true,
          'INCONSISTENT_ORDER_STATE'
        );
        return;
      }
      this.finishHedge(strategy.id, difference, hedgeOutcome);
      return;
    }
    const price = await this.quantizedPrice(
      smallerGateway,
      strategy.symbol,
      smallerLeg === 'spot' ? 'spot' : 'swap',
      largerSnapshot.averagePrice
    );
    if (price === null) {
      this.failStrategy(strategy.id, true, 'ORDER_RECONCILIATION_FAILED');
      return;
    }
    const hedge = this.prepare(
      strategy,
      differenceRole,
      this.hedgeRequest(
        strategy,
        smallerLeg,
        difference,
        price,
        marginMode
      )
    );
    const hedgeOutcome = await this.submit(hedge);
    this.finishHedge(strategy.id, difference, hedgeOutcome);
  }
}
