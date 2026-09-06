import { Decimal } from 'decimal.js';
import { makeClientOrderId } from '../domain/client-order-id.js';
import type {
  AccountSettings,
  MarketKind,
  OrderRequest,
  OrderSnapshot
} from '../domain/types.js';
import {
  NoOrderSubmittedError,
  type ExchangeGateway
} from '../exchanges/exchange-gateway.js';
import type { ExchangeRegistry } from '../exchanges/exchange-registry.js';
import {
  nonThrowingOperationalLog,
  type OperationalLog
} from '../logging/logger.js';
import {
  NOOP_TRADE_EVENT_SINK,
  nonThrowingTradeEventSink,
  orderEvent,
  type OrderEventDetails,
  type OrderLifecycleEventName,
  type TradeEventSink
} from '../logging/trade-events.js';
import type {
  OrderSubmissionFailureCode,
  StrategyFailureCode,
  StrategyOrderPlan,
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../storage/strategy-repository.js';
import type {
  ReconciliationResult,
  ReconciliationRunner
} from './hedge-reconciliation.js';
import {
  releaseStrategyOperation,
  tryAcquireStrategyOperation
} from './strategy-operation-owner.js';

type ConfirmedMarginMode = 'isolated' | 'cross';

interface PreparedOrder {
  readonly gateway: ExchangeGateway;
  readonly record: Readonly<StrategyOrderRecord>;
  readonly strategy: Pick<StrategyRecord, 'mode' | 'state'>;
}

const CoordinatorDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: -9_000_000_000_000_000,
  maxE: 9_000_000_000_000_000,
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

function positivePrice(value: unknown): value is string {
  return parsedDecimal(value, false) !== null;
}

function accountSettingsMatch(
  confirmed: Readonly<AccountSettings>,
  current: Readonly<AccountSettings>
): boolean {
  const confirmedLeverage = parsedDecimal(confirmed.leverage, false);
  const currentLeverage = parsedDecimal(current.leverage, false);
  return (
    confirmed.positionMode === 'hedged'
    && current.positionMode === 'hedged'
    && (
      confirmed.marginMode === 'isolated'
      || confirmed.marginMode === 'cross'
    )
    && current.marginMode === confirmed.marginMode
    && confirmedLeverage !== null
    && currentLeverage !== null
    && confirmedLeverage.eq(currentLeverage)
  );
}

function safeStringProperty(
  value: unknown,
  property: string
): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export class HedgeCoordinator {
  private readonly tradeEvents: TradeEventSink;
  private readonly operationalLog: OperationalLog | undefined;
  private readonly guardWarningKeys = new Set<string>();

  constructor(
    private readonly registry: ExchangeRegistry,
    private readonly repository: StrategyRepository,
    private readonly reconciliation: ReconciliationRunner,
    tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK,
    operationalLog?: OperationalLog
  ) {
    this.tradeEvents = nonThrowingTradeEventSink(tradeEvents);
    this.operationalLog = nonThrowingOperationalLog(operationalLog);
  }

  async confirmAndExecute(strategyId: string): Promise<void> {
    if (!tryAcquireStrategyOperation(strategyId)) {
      return;
    }
    try {
      await this.confirmAndExecuteOwned(strategyId);
    } finally {
      releaseStrategyOperation(strategyId);
    }
  }

  private async confirmAndExecuteOwned(strategyId: string): Promise<void> {
    let strategy = this.repository.getStrategy(strategyId);
    if (strategy.state === 'PENDING_CONFIRMATION') {
      if (!this.repository.claimForExecution(strategyId)) return;
      strategy = this.repository.getStrategy(strategyId);
    }
    if (strategy.state !== 'EXECUTING' && strategy.state !== 'WAITING_HEDGE') {
      return;
    }

    let result = await this.reconciliation.run(strategyId);
    if (result.kind === 'awaiting_market_submission') {
      if (!await this.newSubmissionAllowed(strategy, false)) return;
      const orders = this.planInitialMarketOrders(strategy);
      const settled = await Promise.allSettled(
        orders.map((order) => this.submitNew(strategy, order))
      );
      this.warnRejectedSubmissions(strategy, orders, settled);
      result = await this.reconciliation.run(strategyId);
    }
    if (result.kind === 'need_gtc') {
      if (!await this.newSubmissionAllowed(strategy, true)) return;
      const order = await this.planAuthorizedGtc(strategy, result);
      if (order === null) return;
      const settled = await Promise.allSettled([
        this.submitNew(strategy, order)
      ]);
      this.warnRejectedSubmissions(strategy, [order], settled);
      await this.reconciliation.run(strategyId);
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
      strategy
    };
  }

  private planInitialMarketOrders(
    strategy: Readonly<StrategyRecord>
  ): StrategyOrderRecord[] {
    if (this.repository.listOrders(strategy.id).length !== 0) return [];
    const marginMode = strategy.preflight.accountSettings.marginMode;
    if (marginMode !== 'isolated' && marginMode !== 'cross') return [];
    const plans: StrategyOrderPlan[] = strategy.mode === 'CONCURRENT'
      ? [
          {
            role: 'SPOT_MARKET',
            request: this.marketRequest(strategy, 'spot', marginMode)
          },
          {
            role: 'CONTRACT_MARKET',
            request: this.marketRequest(strategy, 'contract', marginMode)
          }
        ]
      : strategy.mode === 'CONTRACT_FIRST'
        ? [{
            role: 'CONTRACT_MARKET',
            request: this.marketRequest(strategy, 'contract', marginMode)
          }]
        : [{
            role: 'SPOT_MARKET',
            request: this.marketRequest(strategy, 'spot', marginMode)
          }];
    const records = strategy.mode === 'CONCURRENT'
      ? this.repository.planOrdersAtomically(strategy.id, plans)
      : plans.map(({ role, request }) => (
          this.repository.planOrder(strategy.id, role, request)
        ));
    for (const record of records) {
      this.recordOrderEvent(
        'order_planned',
        this.prepareExisting(strategy, record)
      );
    }
    return records;
  }

  private async planAuthorizedGtc(
    strategy: Readonly<StrategyRecord>,
    authorization: Extract<ReconciliationResult, { kind: 'need_gtc' }>
  ): Promise<StrategyOrderRecord | null> {
    if (
      this.repository.listOrders(strategy.id)
        .some(({ role }) => role.endsWith('_HEDGE_GTC'))
    ) {
      return null;
    }
    const leg = authorization.role === 'SPOT_HEDGE_GTC'
      ? 'spot'
      : 'contract';
    const kind = leg === 'spot' ? 'spot' : 'swap';
    const gateway = this.registry.get(
      leg === 'spot'
        ? strategy.spotExchangeId
        : strategy.contractExchangeId
    );
    const price = await this.quantizedPrice(
      gateway,
      strategy.symbol,
      kind,
      authorization.referencePrice
    );
    if (price === null) {
      this.operationalLog?.warn('hedge_submission_price_pending', {
        strategyId: strategy.id,
        strategyState: strategy.state,
        conclusion: 'pending',
        reason: 'PRICE_QUANTIZATION_FAILED',
        role: authorization.role,
        exchangeId: gateway.exchangeId,
        exposureKnown: true
      });
      return null;
    }
    const marginMode = strategy.preflight.accountSettings.marginMode;
    if (marginMode !== 'isolated' && marginMode !== 'cross') return null;
    const request = this.hedgeRequest(
      strategy,
      leg,
      authorization.baseQuantity,
      price,
      marginMode
    );
    const record = this.repository.planOrder(
      strategy.id,
      authorization.role,
      request
    );
    this.recordOrderEvent(
      'order_planned',
      this.prepareExisting(strategy, record)
    );
    return record;
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

  private safeAccountSettingsSummary(
    settings: Readonly<AccountSettings>
  ): string {
    const marginMode = settings.marginMode === 'isolated'
      || settings.marginMode === 'cross'
      || settings.marginMode === 'unknown'
      ? settings.marginMode
      : 'invalid';
    const positionMode = settings.positionMode === 'hedged'
      || settings.positionMode === 'one-way'
      || settings.positionMode === 'unknown'
      ? settings.positionMode
      : 'invalid';
    let leverage = 'invalid';
    if (typeof settings.leverage === 'string') {
      try {
        const parsed = new Decimal(settings.leverage);
        if (parsed.isFinite() && parsed.gt(0)) leverage = parsed.toString();
      } catch {
        // Invalid runtime data is represented only by the fixed token above.
      }
    }
    return [
      `marginMode=${marginMode}`,
      `positionMode=${positionMode}`,
      `leverage=${leverage}`
    ].join(',');
  }

  private warnSubmissionGuard(
    strategy: Readonly<StrategyRecord>,
    event: 'hedge_submission_guard_pending' | 'hedge_submission_guard_changed',
    reason: 'ACCOUNT_SETTINGS_UNAVAILABLE' | 'ACCOUNT_SETTINGS_CHANGED',
    exposureKnown: boolean,
    current?: Readonly<AccountSettings>
  ): void {
    const key = `${strategy.id}:${reason}:${strategy.updatedAt}`;
    if (this.guardWarningKeys.has(key)) return;
    this.guardWarningKeys.add(key);
    this.operationalLog?.warn(event, {
      strategyId: strategy.id,
      strategyState: strategy.state,
      conclusion: 'pending',
      reason,
      expected: this.safeAccountSettingsSummary(
        strategy.preflight.accountSettings
      ),
      ...(current === undefined
        ? {}
        : { actual: this.safeAccountSettingsSummary(current) }),
      exposureKnown
    });
  }

  private async newSubmissionAllowed(
    strategy: Readonly<StrategyRecord>,
    exposureKnown: boolean
  ): Promise<boolean> {
    let current: AccountSettings;
    try {
      current = await this.registry.get(strategy.contractExchangeId)
        .fetchAccountSettings(strategy.symbol);
    } catch {
      this.warnSubmissionGuard(
        strategy,
        'hedge_submission_guard_pending',
        'ACCOUNT_SETTINGS_UNAVAILABLE',
        exposureKnown
      );
      return false;
    }
    if (!accountSettingsMatch(strategy.preflight.accountSettings, current)) {
      this.warnSubmissionGuard(
        strategy,
        'hedge_submission_guard_changed',
        'ACCOUNT_SETTINGS_CHANGED',
        exposureKnown,
        current
      );
      return false;
    }
    return true;
  }

  private warnRejectedSubmissions(
    strategy: Readonly<StrategyRecord>,
    orders: readonly StrategyOrderRecord[],
    settled: readonly PromiseSettledResult<void>[]
  ): void {
    for (const [index, result] of settled.entries()) {
      if (result.status !== 'rejected') continue;
      const order = orders[index];
      if (order === undefined) continue;
      this.operationalLog?.warn('hedge_submission_internal_failure', {
        strategyId: strategy.id,
        strategyState: strategy.state,
        conclusion: 'pending',
        reason: 'SUBMISSION_INTERNAL_FAILURE',
        role: order.role,
        exchangeId: order.exchangeId,
        strategyOrderId: order.id,
        clientOrderId: order.clientOrderId,
        exposureKnown: order.role.endsWith('_HEDGE_GTC')
      });
    }
  }

  private warnSubmissionEvidenceConflict(
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>,
    exposureKnown: boolean
  ): void {
    this.operationalLog?.warn('hedge_submission_evidence_conflict', {
      strategyId: strategy.id,
      strategyState: strategy.state,
      conclusion: 'pending',
      reason: 'SUBMISSION_EVIDENCE_WRITE_CONFLICT',
      role: order.role,
      exchangeId: order.exchangeId,
      strategyOrderId: order.id,
      clientOrderId: order.clientOrderId,
      exposureKnown
    });
  }

  private async submitNew(
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>
  ): Promise<void> {
    const prepared = this.prepareExisting(strategy, order);
    this.recordOrderEvent('order_submit_started', prepared, null);
    let snapshot: OrderSnapshot;
    try {
      snapshot = await prepared.gateway.createOrder(order.request);
    } catch (error) {
      if (error instanceof NoOrderSubmittedError) {
        const failureCode: OrderSubmissionFailureCode =
          error.reason === 'UNTRADABLE_REQUEST'
          && order.role.endsWith('_HEDGE_GTC')
            ? 'HEDGE_RESIDUAL_NOT_TRADABLE'
            : 'ORDER_SUBMISSION_FAILED';
        this.recordSubmissionFailure(
          'order_rejected_before_submit',
          prepared,
          failureCode,
          error
        );
        try {
          const written = this.repository.markDefinitelyNotSubmitted(
            order.id,
            failureCode
          );
          if (!written) {
            this.warnSubmissionEvidenceConflict(
              strategy,
              order,
              order.role.endsWith('_HEDGE_GTC')
            );
          }
        } catch {
          this.warnSubmissionEvidenceConflict(
            strategy,
            order,
            order.role.endsWith('_HEDGE_GTC')
          );
        }
        return;
      }
      this.recordSubmissionFailure(
        'order_submit_uncertain',
        prepared,
        'ORDER_SUBMISSION_UNKNOWN',
        error
      );
      return;
    }
    this.recordOrderEvent('order_submit_succeeded', prepared, snapshot);
  }

  private recordOrderEvent(
    name: OrderLifecycleEventName,
    prepared: Readonly<PreparedOrder>,
    snapshot?: Readonly<OrderSnapshot> | null,
    details: Readonly<OrderEventDetails> = {}
  ): void {
    try {
      this.tradeEvents.record(orderEvent(
        name,
        prepared.record,
        snapshot,
        {
          mode: prepared.strategy.mode,
          strategyState: prepared.strategy.state,
          ...(details.failureCode === undefined
            ? {}
            : { failureCode: details.failureCode }),
          ...(details.errorType === undefined
            ? {}
            : { errorType: details.errorType }),
          ...(details.errorCode === undefined
            ? {}
            : { errorCode: details.errorCode })
        }
      ));
    } catch {
      // Logging is never allowed to change order execution behavior.
    }
  }

  private recordSubmissionFailure(
    name: 'order_rejected_before_submit' | 'order_submit_uncertain',
    prepared: Readonly<PreparedOrder>,
    failureCode: StrategyFailureCode,
    error: unknown
  ): void {
    const errorCode = safeStringProperty(error, 'code');
    this.recordOrderEvent(name, prepared, null, {
      failureCode,
      errorType: safeStringProperty(error, 'name') ?? 'UnknownError',
      ...(errorCode === undefined ? {} : { errorCode })
    });
  }
}
