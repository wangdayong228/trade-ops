import type { Logger } from 'pino';
import type {
  ExecutionMode,
  MarketKind,
  OrderRole,
  OrderSide,
  OrderSnapshot,
  OrderType,
  StrategyState
} from '../domain/types.js';
import type {
  StrategyFailureCode,
  StrategyOrderRecord,
  StrategyOrderStatus
} from '../storage/strategy-repository.js';

export type OrderLifecycleEventName =
  | 'order_planned'
  | 'order_submit_started'
  | 'order_submit_succeeded'
  | 'order_submit_uncertain'
  | 'order_rejected_before_submit'
  | 'order_status_changed'
  | 'order_terminal';

export interface TradeEvent {
  readonly event: OrderLifecycleEventName;
  readonly strategyId: string;
  readonly mode?: ExecutionMode;
  readonly strategyState?: StrategyState;
  readonly role: OrderRole;
  readonly exchangeId: string;
  readonly symbol: string;
  readonly kind: MarketKind;
  readonly type: OrderType;
  readonly side: OrderSide;
  readonly clientOrderId: string;
  readonly exchangeOrderId?: string;
  readonly requestedBaseQuantity: string;
  readonly filledBaseQuantity?: string;
  readonly remainingBaseQuantity?: string;
  readonly price?: string;
  readonly averagePrice?: string | null;
  readonly timeInForce?: 'GTC';
  readonly positionSide?: 'SHORT';
  readonly marginMode?: 'isolated' | 'cross';
  readonly status: StrategyOrderStatus;
  readonly failureCode?: StrategyFailureCode;
  readonly errorType?: string;
  readonly errorCode?: string;
}

export interface OrderEventDetails {
  readonly mode?: ExecutionMode;
  readonly strategyState?: StrategyState;
  readonly failureCode?: StrategyFailureCode;
  readonly errorType?: string;
  readonly errorCode?: string;
}

export interface TradeEventSink {
  record(event: Readonly<TradeEvent>): void;
}

export const NOOP_TRADE_EVENT_SINK: TradeEventSink = Object.freeze({
  record(_event: Readonly<TradeEvent>): void {}
});

type MutableTradeEvent = {
  -readonly [Field in keyof TradeEvent]: TradeEvent[Field];
};

function optionalField<Field extends keyof MutableTradeEvent>(
  output: MutableTradeEvent,
  field: Field,
  value: MutableTradeEvent[Field] | undefined
): void {
  if (value !== undefined) {
    output[field] = value;
  }
}

export function orderEvent(
  name: OrderLifecycleEventName,
  order: Readonly<StrategyOrderRecord>,
  snapshot?: Readonly<OrderSnapshot> | null,
  details: Readonly<OrderEventDetails> = {}
): TradeEvent {
  const effectiveSnapshot = snapshot === undefined
    ? order.snapshot
    : snapshot;
  const output = {
    event: name,
    strategyId: order.strategyId,
    role: order.role,
    exchangeId: order.exchangeId,
    symbol: order.request.symbol,
    kind: order.request.kind,
    type: order.request.type,
    side: order.request.side,
    clientOrderId: order.clientOrderId,
    requestedBaseQuantity: effectiveSnapshot?.requestedBaseQuantity
      ?? order.request.baseQuantity,
    status: effectiveSnapshot?.status ?? order.status
  } as MutableTradeEvent;
  optionalField(output, 'mode', details.mode);
  optionalField(output, 'strategyState', details.strategyState);
  optionalField(
    output,
    'exchangeOrderId',
    effectiveSnapshot?.exchangeOrderId ?? order.exchangeOrderId ?? undefined
  );
  optionalField(
    output,
    'filledBaseQuantity',
    effectiveSnapshot?.filledBaseQuantity
  );
  optionalField(
    output,
    'remainingBaseQuantity',
    effectiveSnapshot?.remainingBaseQuantity
  );
  optionalField(output, 'price', order.request.price);
  if (effectiveSnapshot !== null && effectiveSnapshot !== undefined) {
    output.averagePrice = effectiveSnapshot.averagePrice;
  }
  optionalField(output, 'timeInForce', order.request.timeInForce);
  optionalField(output, 'positionSide', order.request.positionSide);
  optionalField(output, 'marginMode', order.request.marginMode);
  optionalField(output, 'failureCode', details.failureCode);
  optionalField(output, 'errorType', details.errorType);
  optionalField(output, 'errorCode', details.errorCode);
  return output;
}

function allowlistedEvent(event: Readonly<TradeEvent>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    event: event.event,
    strategyId: event.strategyId,
    role: event.role,
    exchangeId: event.exchangeId,
    symbol: event.symbol,
    kind: event.kind,
    type: event.type,
    side: event.side,
    clientOrderId: event.clientOrderId,
    requestedBaseQuantity: event.requestedBaseQuantity,
    status: event.status
  };
  if (event.mode !== undefined) output.mode = event.mode;
  if (event.strategyState !== undefined) {
    output.strategyState = event.strategyState;
  }
  if (event.exchangeOrderId !== undefined) {
    output.exchangeOrderId = event.exchangeOrderId;
  }
  if (event.filledBaseQuantity !== undefined) {
    output.filledBaseQuantity = event.filledBaseQuantity;
  }
  if (event.remainingBaseQuantity !== undefined) {
    output.remainingBaseQuantity = event.remainingBaseQuantity;
  }
  if (event.price !== undefined) output.price = event.price;
  if (event.averagePrice !== undefined) {
    output.averagePrice = event.averagePrice;
  }
  if (event.timeInForce !== undefined) {
    output.timeInForce = event.timeInForce;
  }
  if (event.positionSide !== undefined) {
    output.positionSide = event.positionSide;
  }
  if (event.marginMode !== undefined) {
    output.marginMode = event.marginMode;
  }
  if (event.failureCode !== undefined) {
    output.failureCode = event.failureCode;
  }
  if (event.errorType !== undefined) output.errorType = event.errorType;
  if (event.errorCode !== undefined) output.errorCode = event.errorCode;
  return output;
}

export class PinoTradeEventSink implements TradeEventSink {
  readonly #logger: Pick<Logger, 'info'>;

  constructor(logger: Pick<Logger, 'info'>) {
    this.#logger = logger;
  }

  record(event: Readonly<TradeEvent>): void {
    try {
      this.#logger.info(allowlistedEvent(event), event.event);
    } catch {
      // Logging is never allowed to change order execution behavior.
    }
  }
}
