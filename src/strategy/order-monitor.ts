import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../domain/client-order-id.js';
import type {
  OrderRequest,
  OrderRole,
  OrderSnapshot,
  StrategyState
} from '../domain/types.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import {
  nonThrowingOperationalLog,
  type OperationalLog
} from '../logging/logger.js';
import {
  NOOP_TRADE_EVENT_SINK,
  nonThrowingTradeEventSink,
  orderEvent,
  type TradeEventSink
} from '../logging/trade-events.js';
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

type RecoverableState = Extract<
  StrategyState,
  'EXECUTING' | 'WAITING_HEDGE'
>;

interface RawObservation {
  readonly order: StrategyOrderRecord;
  readonly candidate: unknown;
  readonly lookupMissing: boolean;
}

interface ValidatedObservation {
  readonly order: StrategyOrderRecord;
  readonly candidate: OrderSnapshot | null;
  readonly lookupMissing: boolean;
}

interface ExposureTotals {
  readonly spot: Decimal;
  readonly contract: Decimal;
}

export interface ExecutionContinuation {
  confirmAndExecute(strategyId: string): Promise<void>;
}

const RECOVERABLE_STATES = new Set<StrategyState>([
  'EXECUTING',
  'WAITING_HEDGE'
]);
const GTC_ROLES = new Set<OrderRole>([
  'SPOT_HEDGE_GTC',
  'CONTRACT_HEDGE_GTC'
]);
const MARKET_ROLES = new Set<OrderRole>([
  'SPOT_MARKET',
  'CONTRACT_MARKET'
]);
const SNAPSHOT_STATUSES = new Set<OrderSnapshot['status']>([
  'open',
  'closed',
  'canceled',
  'rejected',
  'unknown'
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
const STATUS_TRANSITIONS: Readonly<Record<
  StrategyOrderRecord['status'],
  ReadonlySet<OrderSnapshot['status']>
>> = {
  planned: SNAPSHOT_STATUSES,
  unknown: new Set(['unknown', 'open', 'closed', 'canceled', 'rejected']),
  open: new Set(['open', 'closed', 'canceled', 'rejected']),
  closed: new Set(['closed']),
  canceled: new Set(['canceled']),
  rejected: new Set(['rejected'])
};
const MAX_MONITOR_PRECISION = 1_000_000;
const MONITOR_MIN_EXPONENT = -9_000_000_000_000_000;
const MONITOR_MAX_EXPONENT = 9_000_000_000_000_000;
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;
const DECIMAL_STRING_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const MonitorDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: MONITOR_MIN_EXPONENT,
  maxE: MONITOR_MAX_EXPONENT,
  toExpNeg: -7,
  toExpPos: 21
});

function parsedDecimal(value: unknown, allowZero: boolean): Decimal | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 10_000
    || !DECIMAL_STRING_PATTERN.test(value)
  ) {
    return null;
  }
  let parsed: Decimal;
  try {
    parsed = new MonitorDecimal(value);
  } catch {
    return null;
  }
  const coefficient = value.split(/[eE]/, 1)[0] ?? '';
  const lexicalValueIsZero = !/[1-9]/.test(coefficient);
  if (
    !parsed.isFinite()
    || parsed.isNegative()
    || (parsed.isZero() && !lexicalValueIsZero)
    || (!allowZero && parsed.isZero())
  ) {
    return null;
  }
  return parsed;
}

function exactConstructor(
  values: readonly Decimal[]
): Decimal.Constructor | null {
  if (values.length === 0) {
    return MonitorDecimal;
  }
  const highestExponent = Math.max(...values.map((value) => value.e));
  const lowestSignificantExponent = Math.min(...values.map(
    (value) => value.e - value.sd() + 1
  ));
  const carryDigits = Math.ceil(Math.log10(values.length + 1));
  const requiredPrecision =
    highestExponent - lowestSignificantExponent + carryDigits + 4;
  if (
    !Number.isSafeInteger(requiredPrecision)
    || requiredPrecision <= 0
    || requiredPrecision > MAX_MONITOR_PRECISION
  ) {
    return null;
  }
  return MonitorDecimal.clone({
    precision: Math.max(MonitorDecimal.precision, requiredPrecision),
    rounding: Decimal.ROUND_DOWN,
    minE: MONITOR_MIN_EXPONENT,
    maxE: MONITOR_MAX_EXPONENT,
    toExpNeg: -7,
    toExpPos: 21
  });
}

function decimalEquals(left: unknown, right: unknown): boolean {
  const parsedLeft = parsedDecimal(left, true);
  const parsedRight = parsedDecimal(right, true);
  return (
    parsedLeft !== null
    && parsedRight !== null
    && parsedLeft.eq(parsedRight)
  );
}

function exactQuantityConservation(
  requestedValue: string,
  filledValue: string,
  remainingValue: string
): boolean {
  const requested = parsedDecimal(requestedValue, false);
  const filled = parsedDecimal(filledValue, true);
  const remaining = parsedDecimal(remainingValue, true);
  if (
    requested === null
    || filled === null
    || remaining === null
    || filled.gt(requested)
    || remaining.gt(requested)
  ) {
    return false;
  }
  const ExactDecimal = exactConstructor([requested, filled, remaining]);
  return (
    ExactDecimal !== null
    && new ExactDecimal(filledValue)
      .plus(remainingValue)
      .eq(requestedValue)
  );
}

function canonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 64
  ) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function nonEmptyString(
  value: unknown,
  maximumLength = 1_024
): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && value.length <= maximumLength
  );
}

function plainSnapshotData(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  let ownKeys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (
    ownKeys.length !== SNAPSHOT_KEYS.size
    || ownKeys.some(
      (key) => typeof key !== 'string' || !SNAPSHOT_KEYS.has(key)
    )
  ) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotFromData(
  value: unknown,
  order: Readonly<StrategyOrderRecord>
): OrderSnapshot | null {
  const data = plainSnapshotData(value);
  if (data === null) {
    return null;
  }
  const {
    exchangeId,
    exchangeOrderId,
    clientOrderId,
    symbol,
    kind,
    type,
    side,
    requestedBaseQuantity,
    filledBaseQuantity,
    remainingBaseQuantity,
    averagePrice,
    status,
    updatedAt
  } = data;
  if (
    exchangeId !== order.exchangeId
    || clientOrderId !== order.clientOrderId
    || symbol !== order.request.symbol
    || kind !== order.request.kind
    || type !== order.request.type
    || side !== order.request.side
    || !nonEmptyString(exchangeOrderId, 256)
    || (
      order.exchangeOrderId !== null
      && exchangeOrderId !== order.exchangeOrderId
    )
    || typeof requestedBaseQuantity !== 'string'
    || typeof filledBaseQuantity !== 'string'
    || typeof remainingBaseQuantity !== 'string'
    || !decimalEquals(requestedBaseQuantity, order.request.baseQuantity)
    || !exactQuantityConservation(
      requestedBaseQuantity,
      filledBaseQuantity,
      remainingBaseQuantity
    )
    || (
      averagePrice !== null
      && parsedDecimal(averagePrice, false) === null
    )
    || typeof status !== 'string'
    || !SNAPSHOT_STATUSES.has(status as OrderSnapshot['status'])
    || !STATUS_TRANSITIONS[order.status].has(
      status as OrderSnapshot['status']
    )
    || !canonicalTimestamp(updatedAt)
  ) {
    return null;
  }
  const previous = order.snapshot;
  if (previous !== null) {
    const candidateFill = parsedDecimal(filledBaseQuantity, true);
    const previousFill = parsedDecimal(previous.filledBaseQuantity, true);
    const candidateRemaining = parsedDecimal(remainingBaseQuantity, true);
    const previousRemaining = parsedDecimal(
      previous.remainingBaseQuantity,
      true
    );
    if (
      candidateFill === null
      || previousFill === null
      || candidateRemaining === null
      || previousRemaining === null
      || candidateFill.lt(previousFill)
      || candidateRemaining.gt(previousRemaining)
      || new Date(updatedAt).getTime()
        < new Date(previous.updatedAt).getTime()
    ) {
      return null;
    }
  }
  return {
    exchangeId: exchangeId as string,
    exchangeOrderId,
    clientOrderId: clientOrderId as string,
    symbol: symbol as string,
    kind: kind as OrderSnapshot['kind'],
    type: type as OrderSnapshot['type'],
    side: side as OrderSnapshot['side'],
    requestedBaseQuantity,
    filledBaseQuantity,
    remainingBaseQuantity,
    averagePrice: averagePrice as string | null,
    status: status as OrderSnapshot['status'],
    updatedAt
  };
}

function requestMatchesRole(
  strategy: Readonly<StrategyRecord>,
  order: Readonly<StrategyOrderRecord>
): boolean {
  const { request } = order;
  const spotRole = order.role.startsWith('SPOT_');
  const gtcRole = GTC_ROLES.has(order.role);
  const expectedExchangeId = spotRole
    ? strategy.spotExchangeId
    : strategy.contractExchangeId;
  if (
    order.strategyId !== strategy.id
    || order.exchangeId !== expectedExchangeId
    || order.clientOrderId !== request.clientOrderId
    || request.clientOrderId !== makeClientOrderId(strategy.id, order.role)
    || request.symbol !== strategy.symbol
    || request.kind !== (spotRole ? 'spot' : 'swap')
    || request.type !== (gtcRole ? 'limit' : 'market')
    || request.side !== (spotRole ? 'buy' : 'sell')
    || parsedDecimal(request.baseQuantity, false) === null
    || (
      !gtcRole
      && !decimalEquals(
        request.baseQuantity,
        strategy.effectiveBaseQuantity
      )
    )
    || (
      gtcRole
        ? request.timeInForce !== 'GTC'
        : request.timeInForce !== undefined
    )
    || (
      gtcRole
        ? parsedDecimal(request.price, false) === null
        : request.price !== undefined
    )
    || (
      spotRole
        ? (
          request.positionSide !== undefined
          || request.marginMode !== undefined
        )
        : (
          request.positionSide !== 'SHORT'
          || request.marginMode
            !== strategy.preflight.accountSettings.marginMode
        )
    )
  ) {
    return false;
  }
  if (
    (order.snapshot === null) !== (order.exchangeOrderId === null)
    || (order.snapshot === null) !== (order.status === 'planned')
  ) {
    return false;
  }
  if (order.snapshot !== null) {
    const validated = snapshotFromData(order.snapshot, {
      ...order,
      status: 'planned',
      exchangeOrderId: null,
      snapshot: null
    });
    return (
      validated !== null
      && validated.status === order.status
      && validated.exchangeOrderId === order.exchangeOrderId
    );
  }
  return true;
}

function sameSnapshot(
  left: Readonly<OrderSnapshot> | null,
  right: Readonly<OrderSnapshot> | null
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOrderVersion(
  left: Readonly<StrategyOrderRecord>,
  right: Readonly<StrategyOrderRecord>
): boolean {
  return (
    left.id === right.id
    && left.strategyId === right.strategyId
    && left.role === right.role
    && left.exchangeId === right.exchangeId
    && left.clientOrderId === right.clientOrderId
    && left.exchangeOrderId === right.exchangeOrderId
    && left.status === right.status
    && JSON.stringify(left.request) === JSON.stringify(right.request)
    && sameSnapshot(left.snapshot, right.snapshot)
  );
}

function topologyIsValid(
  strategy: Readonly<StrategyRecord>,
  orders: readonly StrategyOrderRecord[]
): boolean {
  const roles = new Set(orders.map((order) => order.role));
  if (roles.size !== orders.length) {
    return false;
  }
  switch (strategy.mode) {
    case 'CONTRACT_FIRST':
      return orders.every(
        (order) => (
          order.role === 'CONTRACT_MARKET'
          || order.role === 'SPOT_HEDGE_GTC'
        )
      );
    case 'SPOT_FIRST':
      return orders.every(
        (order) => (
          order.role === 'SPOT_MARKET'
          || order.role === 'CONTRACT_HEDGE_GTC'
        )
      );
    case 'CONCURRENT':
      return (
        orders.every((order) => (
          MARKET_ROLES.has(order.role) || GTC_ROLES.has(order.role)
        ))
        && orders.filter((order) => GTC_ROLES.has(order.role)).length <= 1
      );
  }
}

function requiredRoles(strategy: Readonly<StrategyRecord>): OrderRole[] {
  switch (strategy.mode) {
    case 'CONTRACT_FIRST':
      return ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC'];
    case 'SPOT_FIRST':
      return ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC'];
    case 'CONCURRENT':
      return ['SPOT_MARKET', 'CONTRACT_MARKET'];
  }
}

function exactExposureTotals(
  orders: readonly StrategyOrderRecord[]
): ExposureTotals | null {
  const values: Array<{
    readonly raw: string;
    readonly side: 'spot' | 'contract';
  }> = [];
  for (const order of orders) {
    if (order.snapshot === null) {
      continue;
    }
    if (
      order.request.kind === 'spot'
      && order.request.side === 'buy'
    ) {
      values.push({
        raw: order.snapshot.filledBaseQuantity,
        side: 'spot'
      });
    } else if (
      order.request.kind === 'swap'
      && order.request.side === 'sell'
      && order.request.positionSide === 'SHORT'
    ) {
      values.push({
        raw: order.snapshot.filledBaseQuantity,
        side: 'contract'
      });
    } else {
      return null;
    }
  }
  const parsed = values.map(({ raw }) => parsedDecimal(raw, true));
  if (parsed.some((value) => value === null)) {
    return null;
  }
  const ExactDecimal = exactConstructor(parsed as Decimal[]);
  if (ExactDecimal === null) {
    return null;
  }
  let spot = new ExactDecimal(0);
  let contract = new ExactDecimal(0);
  for (const value of values) {
    if (value.side === 'spot') {
      spot = spot.plus(value.raw);
    } else {
      contract = contract.plus(value.raw);
    }
  }
  if (!spot.isFinite() || !contract.isFinite()) {
    return null;
  }
  return { spot, contract };
}

function hasPositiveExposure(totals: Readonly<ExposureTotals>): boolean {
  return totals.spot.gt(0) || totals.contract.gt(0);
}

function isFullTerminalGtc(order: Readonly<StrategyOrderRecord>): boolean {
  return (
    GTC_ROLES.has(order.role)
    && order.snapshot !== null
    && order.snapshot.status === 'closed'
    && decimalEquals(order.snapshot.remainingBaseQuantity, '0')
    && decimalEquals(
      order.snapshot.filledBaseQuantity,
      order.snapshot.requestedBaseQuantity
    )
  );
}

function orderNeedsObservation(order: Readonly<StrategyOrderRecord>): boolean {
  return (
    order.exchangeOrderId === null
    || order.snapshot?.status === 'open'
    || order.snapshot?.status === 'unknown'
  );
}

function reliableMarketTerminal(
  order: Readonly<StrategyOrderRecord>
): boolean {
  return (
    MARKET_ROLES.has(order.role)
    && order.snapshot !== null
    && (
      order.snapshot.status === 'closed'
      || order.snapshot.status === 'canceled'
    )
  );
}

function continuationTopologyIsReady(
  strategy: Readonly<StrategyRecord>,
  orders: readonly StrategyOrderRecord[]
): boolean {
  if (
    strategy.state !== 'EXECUTING'
    || !topologyIsValid(strategy, orders)
    || orders.some((order) => !requestMatchesRole(strategy, order))
    || orders.some((order) => GTC_ROLES.has(order.role))
    || orders.some((order) => !reliableMarketTerminal(order))
  ) {
    return false;
  }
  const roles = new Set(orders.map((order) => order.role));
  switch (strategy.mode) {
    case 'CONTRACT_FIRST':
      return orders.length === 1 && roles.has('CONTRACT_MARKET');
    case 'SPOT_FIRST':
      return orders.length === 1 && roles.has('SPOT_MARKET');
    case 'CONCURRENT':
      return (
        orders.length === 2
        && roles.has('SPOT_MARKET')
        && roles.has('CONTRACT_MARKET')
      );
  }
}

function safeState(
  repository: StrategyRepository,
  strategyId: string
): StrategyState | null {
  try {
    return repository.getStrategy(strategyId).state;
  } catch {
    return null;
  }
}

function terminalOrderStatus(status: OrderSnapshot['status']): boolean {
  return status === 'closed' || status === 'canceled' || status === 'rejected';
}

export class OrderMonitor {
  private readonly activeReconciliations = new Map<string, Promise<void>>();
  private activeRecovery: Promise<void> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private activeStop: (() => void) | null = null;
  private readonly tradeEvents: TradeEventSink;
  private readonly operationalLog: OperationalLog | undefined;

  constructor(
    private readonly registry: ExchangeRegistry,
    private readonly repository: StrategyRepository,
    private readonly executionContinuation?: ExecutionContinuation,
    tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK,
    operationalLog?: OperationalLog
  ) {
    this.tradeEvents = nonThrowingTradeEventSink(tradeEvents);
    this.operationalLog = nonThrowingOperationalLog(operationalLog);
  }

  private recordObservedSnapshot(
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>,
    snapshot: Readonly<OrderSnapshot>
  ): void {
    try {
      this.tradeEvents.record(orderEvent(
        'order_status_changed',
        order,
        snapshot,
        { mode: strategy.mode, strategyState: strategy.state }
      ));
      if (terminalOrderStatus(snapshot.status)) {
        this.tradeEvents.record(orderEvent(
          'order_terminal',
          order,
          snapshot,
          { mode: strategy.mode, strategyState: strategy.state }
        ));
      }
    } catch {
      // Logging is never allowed to change monitoring behavior.
    }
  }

  async reconcileStrategy(strategyId: string): Promise<void> {
    const active = this.activeReconciliations.get(strategyId);
    if (active !== undefined) {
      await active;
      return;
    }
    const operation = this.reconcileStrategyOwned(strategyId);
    this.activeReconciliations.set(strategyId, operation);
    try {
      await operation;
    } finally {
      if (this.activeReconciliations.get(strategyId) === operation) {
        this.activeReconciliations.delete(strategyId);
      }
    }
  }

  async recover(): Promise<void> {
    if (this.activeRecovery !== null) {
      await this.activeRecovery;
      return;
    }
    const operation = this.recoverOnce();
    this.activeRecovery = operation;
    try {
      await operation;
    } finally {
      if (this.activeRecovery === operation) {
        this.activeRecovery = null;
      }
    }
  }

  start(intervalMs: number): () => void {
    if (
      !Number.isSafeInteger(intervalMs)
      || intervalMs <= 0
      || intervalMs > MAX_TIMER_INTERVAL_MS
    ) {
      throw new Error(
        'monitor interval must be a positive safe integer within the timer range'
      );
    }
    if (this.activeStop !== null) {
      return this.activeStop;
    }
    let stopped = false;
    const run = (): void => {
      void this.recover().catch((error: unknown) => {
        this.operationalLog?.error('monitor_recovery_failed', error);
        // A later interval must still run.
      });
    };
    const timer = setInterval(run, intervalMs);
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (this.activeTimer === timer) {
        this.activeTimer = null;
        this.activeStop = null;
      }
    };
    this.activeTimer = timer;
    this.activeStop = stop;
    run();
    return stop;
  }

  async stop(): Promise<void> {
    this.activeStop?.();
    const recovery = this.activeRecovery;
    if (recovery !== null) {
      await recovery;
    }
  }

  private async recoverOnce(): Promise<void> {
    const strategies = this.repository.listRecoverable();
    for (const strategy of strategies) {
      try {
        await this.reconcileStrategy(strategy.id);
      } catch (error) {
        this.operationalLog?.error(
          'strategy_recovery_failed',
          error,
          { strategyId: strategy.id }
        );
      }
    }
  }

  private async reconcileStrategyOwned(strategyId: string): Promise<void> {
    if (!tryAcquireStrategyOperation(strategyId)) {
      return;
    }
    let shouldContinue = false;
    try {
      await this.reconcileStrategyOnce(strategyId);
      shouldContinue = this.executionCanContinue(strategyId);
    } finally {
      releaseStrategyOperation(strategyId);
    }
    if (shouldContinue) {
      await this.executionContinuation?.confirmAndExecute(strategyId);
    }
  }

  private executionCanContinue(strategyId: string): boolean {
    if (this.executionContinuation === undefined) {
      return false;
    }
    try {
      const strategy = this.repository.getStrategy(strategyId);
      const orders = this.repository.listOrders(strategyId);
      return continuationTopologyIsReady(strategy, orders);
    } catch {
      return false;
    }
  }

  private async reconcileStrategyOnce(strategyId: string): Promise<void> {
    const strategy = this.repository.getStrategy(strategyId);
    if (!RECOVERABLE_STATES.has(strategy.state)) {
      return;
    }
    const initialState = strategy.state as RecoverableState;
    const orders = this.repository.listOrders(strategy.id);
    if (orders.some((order) => !requestMatchesRole(strategy, order))) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }

    const settled = await Promise.allSettled(
      orders.map((order) => this.observeOrder(order))
    );
    if (
      settled.some((result) => result.status === 'rejected')
      || safeState(this.repository, strategy.id) !== initialState
    ) {
      return;
    }
    const observations: ValidatedObservation[] = [];
    for (const result of settled) {
      const observation = (
        result as PromiseFulfilledResult<RawObservation>
      ).value;
      if (observation.candidate === null) {
        observations.push({
          order: observation.order,
          candidate: null,
          lookupMissing: observation.lookupMissing
        });
        continue;
      }
      if (observation.candidate === undefined) {
        observations.push({
          order: observation.order,
          candidate: null,
          lookupMissing: false
        });
        continue;
      }
      const candidate = snapshotFromData(
        observation.candidate,
        observation.order
      );
      if (candidate === null) {
        this.transitionIncomplete(
          strategy.id,
          initialState,
          'INCONSISTENT_ORDER_STATE'
        );
        return;
      }
      observations.push({
        order: observation.order,
        candidate,
        lookupMissing: observation.lookupMissing
      });
    }

    if (
      safeState(this.repository, strategy.id) !== initialState
      || !this.ordersUnchanged(strategy.id, orders)
    ) {
      return;
    }
    for (const observation of observations) {
      if (
        observation.candidate === null
        || sameSnapshot(
          observation.order.snapshot,
          observation.candidate
        )
      ) {
        continue;
      }
      if (safeState(this.repository, strategy.id) !== initialState) {
        return;
      }
      try {
        this.repository.attachOrderSnapshot(
          observation.order.id,
          observation.candidate
        );
      } catch {
        return;
      }
      this.recordObservedSnapshot(
        strategy,
        observation.order,
        observation.candidate
      );
      if (safeState(this.repository, strategy.id) !== initialState) {
        return;
      }
    }

    let latestOrders: StrategyOrderRecord[];
    try {
      if (safeState(this.repository, strategy.id) !== initialState) {
        return;
      }
      latestOrders = this.repository.listOrders(strategy.id);
    } catch {
      return;
    }
    this.classify(
      strategy,
      initialState,
      latestOrders,
      observations.some((observation) => observation.lookupMissing)
    );
  }

  private async observeOrder(
    order: Readonly<StrategyOrderRecord>
  ): Promise<RawObservation> {
    if (!orderNeedsObservation(order)) {
      return {
        order,
        candidate: undefined,
        lookupMissing: false
      };
    }
    const gateway = this.registry.get(order.exchangeId);
    if (order.exchangeOrderId === null) {
      const candidate = await gateway.findOrderByClientId(
        order.clientOrderId,
        order.request.symbol,
        order.request.kind
      );
      return {
        order,
        candidate,
        lookupMissing: candidate === null
      };
    }
    return {
      order,
      candidate: await gateway.fetchOrder(
        order.exchangeOrderId,
        order.request.symbol,
        order.request.kind
      ),
      lookupMissing: false
    };
  }

  private ordersUnchanged(
    strategyId: string,
    expected: readonly StrategyOrderRecord[]
  ): boolean {
    try {
      const current = this.repository.listOrders(strategyId);
      if (current.length !== expected.length) {
        return false;
      }
      const byId = new Map(current.map((order) => [order.id, order]));
      return expected.every((order) => {
        const matching = byId.get(order.id);
        return matching !== undefined && sameOrderVersion(order, matching);
      });
    } catch {
      return false;
    }
  }

  private classify(
    strategy: Readonly<StrategyRecord>,
    initialState: RecoverableState,
    orders: readonly StrategyOrderRecord[],
    lookupMissing: boolean
  ): void {
    if (safeState(this.repository, strategy.id) !== initialState) {
      return;
    }
    const gtcOrders = orders.filter((order) => GTC_ROLES.has(order.role));
    if (
      gtcOrders.some(
        (order) => order.snapshot?.status === 'canceled'
      )
    ) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'HEDGE_ORDER_CANCELED'
      );
      return;
    }
    if (
      gtcOrders.some(
        (order) => order.snapshot?.status === 'rejected'
      )
    ) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'HEDGE_ORDER_REJECTED'
      );
      return;
    }
    if (
      !topologyIsValid(strategy, orders)
      || orders.some((order) => !requestMatchesRole(strategy, order))
    ) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }

    const totals = exactExposureTotals(orders);
    if (totals === null) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }
    const nonterminalMarket = orders.some((order) => (
      MARKET_ROLES.has(order.role)
      && (
        order.snapshot === null
        || order.snapshot.status === 'open'
        || order.snapshot.status === 'unknown'
      )
    ));
    if (nonterminalMarket) {
      if (initialState !== 'EXECUTING') {
        this.transitionIncomplete(
          strategy.id,
          initialState,
          'INCONSISTENT_ORDER_STATE'
        );
      }
      return;
    }
    const rejectedMarket = orders.some((order) => (
      MARKET_ROLES.has(order.role)
      && order.snapshot?.status === 'rejected'
    ));
    if (rejectedMarket) {
      if (hasPositiveExposure(totals)) {
        this.transitionIncomplete(
          strategy.id,
          initialState,
          'INCONSISTENT_ORDER_STATE'
        );
      } else {
        this.transitionFailed(
          strategy.id,
          initialState,
          'ORDER_SUBMISSION_FAILED'
        );
      }
      return;
    }
    const invalidMarketTerminal = orders.some((order) => (
      MARKET_ROLES.has(order.role)
      && order.snapshot !== null
      && order.snapshot.status !== 'closed'
      && order.snapshot.status !== 'canceled'
    ));
    if (invalidMarketTerminal) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }

    const roles = new Set(orders.map((order) => order.role));
    const missingRequiredRole = requiredRoles(strategy).some(
      (role) => !roles.has(role)
    );
    const unconfirmedMarket = orders.some((order) => (
      MARKET_ROLES.has(order.role) && order.snapshot === null
    ));
    if (
      initialState === 'EXECUTING'
      && (
        lookupMissing
        || missingRequiredRole
        || unconfirmedMarket
        || gtcOrders.some(
          (order) => order.snapshot?.status === 'unknown'
        )
      )
    ) {
      return;
    }
    if (missingRequiredRole) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }
    if (
      gtcOrders.some((order) => (
        order.snapshot === null
        || order.snapshot.status === 'open'
        || order.snapshot.status === 'unknown'
      ))
    ) {
      this.transitionWaiting(strategy.id, initialState);
      return;
    }
    if (gtcOrders.some((order) => !isFullTerminalGtc(order))) {
      this.transitionIncomplete(
        strategy.id,
        initialState,
        'INCONSISTENT_ORDER_STATE'
      );
      return;
    }

    const marketsConfirmed = orders
      .filter((order) => MARKET_ROLES.has(order.role))
      .every((order) => (
        order.snapshot?.status === 'closed'
        || order.snapshot?.status === 'canceled'
      ));
    if (
      marketsConfirmed
      && totals.spot.gt(0)
      && totals.contract.gt(0)
      && totals.spot.eq(totals.contract)
    ) {
      this.transitionTerminal(strategy.id, initialState, 'HEDGED');
      return;
    }
    if (
      initialState === 'EXECUTING'
      && strategy.mode === 'CONCURRENT'
      && gtcOrders.length === 0
      && marketsConfirmed
      && hasPositiveExposure(totals)
      && !totals.spot.eq(totals.contract)
    ) {
      return;
    }
    if (
      initialState === 'EXECUTING'
      && !hasPositiveExposure(totals)
    ) {
      return;
    }
    this.transitionIncomplete(
      strategy.id,
      initialState,
      'INCONSISTENT_ORDER_STATE'
    );
  }

  private transitionWaiting(
    strategyId: string,
    initialState: RecoverableState
  ): void {
    if (initialState === 'WAITING_HEDGE') {
      return;
    }
    this.transitionTerminal(strategyId, initialState, 'WAITING_HEDGE');
  }

  private transitionIncomplete(
    strategyId: string,
    initialState: RecoverableState,
    failureCode: StrategyFailureCode
  ): void {
    this.transitionTerminal(
      strategyId,
      initialState,
      'HEDGE_INCOMPLETE',
      failureCode
    );
  }

  private transitionFailed(
    strategyId: string,
    initialState: RecoverableState,
    failureCode: StrategyFailureCode
  ): void {
    if (initialState !== 'EXECUTING') {
      this.transitionIncomplete(strategyId, initialState, failureCode);
      return;
    }
    this.transitionTerminal(
      strategyId,
      initialState,
      'FAILED',
      failureCode
    );
  }

  private transitionTerminal(
    strategyId: string,
    initialState: RecoverableState,
    target: Extract<
      StrategyState,
      'WAITING_HEDGE' | 'HEDGED' | 'HEDGE_INCOMPLETE' | 'FAILED'
    >,
    failureCode?: StrategyFailureCode
  ): void {
    if (safeState(this.repository, strategyId) !== initialState) {
      return;
    }
    try {
      let transitioned: boolean;
      if (failureCode === undefined) {
        transitioned = this.repository.transition(
          strategyId,
          [initialState],
          target
        );
      } else {
        transitioned = this.repository.transition(
          strategyId,
          [initialState],
          target,
          failureCode
        );
      }
      if (!transitioned) {
        return;
      }
    } catch {
      // Never retain, persist, or log a raw repository error.
    }
  }
}
