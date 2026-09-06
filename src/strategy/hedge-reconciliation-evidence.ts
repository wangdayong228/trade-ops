import { Decimal } from 'decimal.js';
import type { ExecutionMode, OrderSnapshot } from '../domain/types.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import {
  NOOP_TRADE_EVENT_SINK,
  nonThrowingTradeEventSink,
  orderEvent,
  type TradeEventSink
} from '../logging/trade-events.js';
import {
  OrderSnapshotValidationError,
  OrderSnapshotWriteConflictError,
  type StrategyOrderRecord,
  type StrategyOrderStatus,
  type StrategyRecord,
  type StrategyRepository
} from '../storage/strategy-repository.js';

export type EvidencePendingReason =
  | 'INVALID_LOCAL_TOPOLOGY'
  | 'ORDER_LOOKUP_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'SUBMISSION_UNCERTAIN'
  | 'ORDER_SNAPSHOT_INVALID'
  | 'ORDER_EVIDENCE_MISMATCH'
  | 'SNAPSHOT_WRITE_CONFLICT';

export interface EvidencePending {
  readonly kind: 'pending';
  readonly reason: EvidencePendingReason;
  readonly exposureKnown: boolean;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeId?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export type LocalTopologyResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'valid'; readonly orders: readonly StrategyOrderRecord[] }
  | EvidencePending;

export type EvidenceCollectionResult =
  | {
      readonly kind: 'ready';
      readonly orders: readonly StrategyOrderRecord[];
    }
  | EvidencePending;

interface PendingContext {
  readonly reason: EvidencePendingReason;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeId?: string;
  readonly expected?: string;
  readonly actual?: string;
}

interface MismatchContext {
  readonly expected: string;
  readonly actual: string;
}

const LEGAL_ROLE_SETS: Readonly<Record<
  ExecutionMode,
  ReadonlySet<string>
>> = {
  CONTRACT_FIRST: new Set([
    'CONTRACT_MARKET',
    'CONTRACT_MARKET|SPOT_HEDGE_GTC'
  ]),
  SPOT_FIRST: new Set([
    'SPOT_MARKET',
    'CONTRACT_HEDGE_GTC|SPOT_MARKET'
  ]),
  CONCURRENT: new Set([
    'CONTRACT_MARKET|SPOT_MARKET',
    'CONTRACT_HEDGE_GTC|CONTRACT_MARKET|SPOT_MARKET',
    'CONTRACT_MARKET|SPOT_HEDGE_GTC|SPOT_MARKET'
  ])
};

const REQUIRED_MARKET_ROLES: Readonly<Record<
  ExecutionMode,
  ReadonlySet<string>
>> = {
  CONTRACT_FIRST: new Set(['CONTRACT_MARKET']),
  SPOT_FIRST: new Set(['SPOT_MARKET']),
  CONCURRENT: new Set(['SPOT_MARKET', 'CONTRACT_MARKET'])
};

const TERMINAL_ORDER_STATUSES = new Set<OrderSnapshot['status']>([
  'closed',
  'canceled',
  'rejected'
]);

const SNAPSHOT_STATUSES = new Set<OrderSnapshot['status']>([
  'open',
  'closed',
  'canceled',
  'rejected',
  'unknown'
]);

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

const ReconciliationDecimal = Decimal.clone({
  precision: 1_000_000,
  rounding: Decimal.ROUND_DOWN,
  minE: -9_000_000_000_000_000,
  maxE: 9_000_000_000_000_000,
  toExpNeg: -7,
  toExpPos: 21
});
const DECIMAL_STRING_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

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

function decimalEquals(left: unknown, right: unknown): boolean {
  const parsedLeft = parsedDecimal(left);
  const parsedRight = parsedDecimal(right);
  return parsedLeft !== null
    && parsedRight !== null
    && parsedLeft.eq(parsedRight);
}

function positiveFillKnown(
  order: Readonly<StrategyOrderRecord>
): boolean {
  const filled = parsedDecimal(order.snapshot?.filledBaseQuantity);
  return filled !== null && filled.gt(0);
}

function exposureKnown(
  orders: readonly Readonly<StrategyOrderRecord>[]
): boolean {
  return orders.some(positiveFillKnown);
}

function invalidTopology(
  orders: readonly Readonly<StrategyOrderRecord>[]
): EvidencePending {
  return {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    exposureKnown: exposureKnown(orders)
  };
}

function gtcFollowsRequiredMarkets(
  strategy: Readonly<StrategyRecord>,
  orders: readonly Readonly<StrategyOrderRecord>[]
): boolean {
  const requiredRoles = REQUIRED_MARKET_ROLES[strategy.mode];
  let lastRequiredMarketIndex = -1;
  for (const [index, order] of orders.entries()) {
    if (requiredRoles.has(order.role)) {
      lastRequiredMarketIndex = index;
    }
  }
  return orders.every((order, index) => (
    !order.role.endsWith('_HEDGE_GTC')
    || index > lastRequiredMarketIndex
  ));
}

function orderPending(
  order: Readonly<StrategyOrderRecord>,
  reason: EvidencePendingReason,
  mismatch?: Readonly<MismatchContext>
): PendingContext {
  const context: PendingContext = {
    reason,
    strategyOrderId: order.id,
    clientOrderId: order.clientOrderId,
    exchangeId: order.exchangeId
  };
  return mismatch === undefined
    ? context
    : { ...context, ...mismatch };
}

function withExposure(
  context: Readonly<PendingContext>,
  known: boolean
): EvidencePending {
  return {
    kind: 'pending',
    ...context,
    exposureKnown: known
  };
}

function terminalOrderStatus(
  status: OrderSnapshot['status'] | undefined
): boolean {
  return status !== undefined && TERMINAL_ORDER_STATUSES.has(status);
}

function scalarMismatch(
  expected: string,
  actual: string
): MismatchContext {
  return { expected, actual };
}

function remoteEvidenceMismatch(
  order: Readonly<StrategyOrderRecord>,
  snapshot: Readonly<OrderSnapshot>
): MismatchContext | null {
  if (snapshot.exchangeId !== order.exchangeId) {
    return scalarMismatch(order.exchangeId, snapshot.exchangeId);
  }
  if (snapshot.clientOrderId !== order.clientOrderId) {
    return scalarMismatch(order.clientOrderId, snapshot.clientOrderId);
  }
  if (snapshot.symbol !== order.request.symbol) {
    return scalarMismatch(order.request.symbol, snapshot.symbol);
  }
  if (snapshot.kind !== order.request.kind) {
    return scalarMismatch(order.request.kind, snapshot.kind);
  }
  if (snapshot.type !== order.request.type) {
    return scalarMismatch(order.request.type, snapshot.type);
  }
  if (snapshot.side !== order.request.side) {
    return scalarMismatch(order.request.side, snapshot.side);
  }

  const requested = parsedDecimal(snapshot.requestedBaseQuantity);
  if (
    requested !== null
    && !decimalEquals(
      snapshot.requestedBaseQuantity,
      order.request.baseQuantity
    )
  ) {
    return scalarMismatch(
      order.request.baseQuantity,
      snapshot.requestedBaseQuantity
    );
  }
  if (
    order.exchangeOrderId !== null
    && snapshot.exchangeOrderId !== order.exchangeOrderId
  ) {
    return scalarMismatch(order.exchangeOrderId, snapshot.exchangeOrderId);
  }
  if (
    SNAPSHOT_STATUSES.has(snapshot.status)
    && !STATUS_TRANSITIONS[order.status].has(snapshot.status)
  ) {
    return scalarMismatch(order.status, snapshot.status);
  }
  return null;
}

export function inspectLocalTopology(
  strategy: Readonly<StrategyRecord>,
  orders: readonly StrategyOrderRecord[]
): LocalTopologyResult {
  if (orders.length === 0 && strategy.state === 'EXECUTING') {
    return { kind: 'empty' };
  }

  const roles = orders.map(({ role }) => role).sort().join('|');
  const legalRoleSet = LEGAL_ROLE_SETS[strategy.mode];
  const waitingWithoutGtc = strategy.state === 'WAITING_HEDGE'
    && !orders.some(({ role }) => role.endsWith('_HEDGE_GTC'));
  const marketQuantitiesMatch = orders.every((order) => (
    !order.role.endsWith('_MARKET')
    || decimalEquals(
      order.request.baseQuantity,
      strategy.effectiveBaseQuantity
    )
  ));
  if (
    !legalRoleSet.has(roles)
    || waitingWithoutGtc
    || !marketQuantitiesMatch
    || !gtcFollowsRequiredMarkets(strategy, orders)
  ) {
    return invalidTopology(orders);
  }
  return { kind: 'valid', orders };
}

export class HedgeOrderEvidenceCollector {
  private readonly tradeEvents: TradeEventSink;

  constructor(
    private readonly registry: ExchangeRegistry,
    private readonly repository: StrategyRepository,
    tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK
  ) {
    this.tradeEvents = nonThrowingTradeEventSink(tradeEvents);
  }

  async collect(
    strategy: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[]
  ): Promise<EvidenceCollectionResult> {
    let firstPending: PendingContext | null = null;
    let validatedUnpersistedExposure = false;

    for (const lookupOrder of orders) {
      let snapshot: OrderSnapshot | null;
      try {
        snapshot = await this.lookup(lookupOrder);
      } catch {
        firstPending ??= orderPending(lookupOrder, 'ORDER_LOOKUP_FAILED');
        continue;
      }

      const order = this.repository.listOrders(strategy.id)
        .find(({ id }) => id === lookupOrder.id);
      if (order === undefined) {
        firstPending ??= orderPending(
          lookupOrder,
          'ORDER_EVIDENCE_MISMATCH',
          scalarMismatch(lookupOrder.id, 'missing')
        );
        continue;
      }

      if (snapshot === null) {
        const reason = this.missingOrderReason(order);
        if (reason !== null) {
          firstPending ??= orderPending(order, reason);
        }
        continue;
      }

      const mismatch = remoteEvidenceMismatch(order, snapshot);
      if (mismatch !== null) {
        firstPending ??= orderPending(
          order,
          'ORDER_EVIDENCE_MISMATCH',
          mismatch
        );
        continue;
      }

      const originalDisposition = order.submissionDisposition;
      let attachment: 'attached' | 'unchanged';
      try {
        attachment = this.repository.attachOrderSnapshot(order.id, snapshot);
      } catch (error) {
        if (error instanceof OrderSnapshotValidationError) {
          firstPending ??= orderPending(order, 'ORDER_SNAPSHOT_INVALID');
        } else if (error instanceof OrderSnapshotWriteConflictError) {
          const filled = parsedDecimal(snapshot.filledBaseQuantity);
          validatedUnpersistedExposure ||= filled !== null && filled.gt(0);
          firstPending ??= orderPending(order, 'SNAPSHOT_WRITE_CONFLICT');
        } else {
          throw error;
        }
        continue;
      }

      if (attachment === 'attached') {
        this.recordAttachedEvents(strategy, order, snapshot);
      }
      if (originalDisposition === 'DEFINITELY_NOT_SUBMITTED') {
        firstPending ??= orderPending(
          order,
          'ORDER_EVIDENCE_MISMATCH',
          scalarMismatch('DEFINITELY_NOT_SUBMITTED', 'REMOTE_OBSERVED')
        );
      }
    }

    const persistedOrders = this.repository.listOrders(strategy.id);
    if (firstPending !== null) {
      return withExposure(
        firstPending,
        validatedUnpersistedExposure || exposureKnown(persistedOrders)
      );
    }
    return { kind: 'ready', orders: persistedOrders };
  }

  private async lookup(
    order: Readonly<StrategyOrderRecord>
  ): Promise<OrderSnapshot | null> {
    const gateway = this.registry.get(order.exchangeId);
    if (order.exchangeOrderId === null) {
      return gateway.findOrderByClientId(
        order.clientOrderId,
        order.request.symbol,
        order.request.kind
      );
    }
    try {
      return await gateway.fetchOrder(
        order.exchangeOrderId,
        order.request.symbol,
        order.request.kind
      );
    } catch {
      return gateway.findOrderByClientId(
        order.clientOrderId,
        order.request.symbol,
        order.request.kind
      );
    }
  }

  private missingOrderReason(
    order: Readonly<StrategyOrderRecord>
  ): EvidencePendingReason | null {
    switch (order.submissionDisposition) {
      case 'DEFINITELY_NOT_SUBMITTED':
        return null;
      case 'SUBMISSION_UNCERTAIN':
        return 'SUBMISSION_UNCERTAIN';
      case 'REMOTE_OBSERVED':
        return 'ORDER_NOT_FOUND';
    }
  }

  private recordAttachedEvents(
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>,
    snapshot: Readonly<OrderSnapshot>
  ): void {
    const details = {
      mode: strategy.mode,
      strategyState: strategy.state
    } as const;
    this.tradeEvents.record(orderEvent(
      'order_status_changed',
      order,
      snapshot,
      details
    ));
    if (
      !terminalOrderStatus(order.snapshot?.status)
      && terminalOrderStatus(snapshot.status)
    ) {
      this.tradeEvents.record(orderEvent(
        'order_terminal',
        order,
        snapshot,
        details
      ));
    }
  }
}
