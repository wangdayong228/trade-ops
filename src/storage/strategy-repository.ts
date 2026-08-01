import type {
  ExecutionMode,
  OrderRequest,
  OrderRole,
  OrderSnapshot,
  StrategyState
} from '../domain/types.js';
import type { PreflightResult } from '../strategy/preflight-service.js';

export class StrategyNotFoundError extends Error {
  readonly name = 'StrategyNotFoundError';

  constructor() {
    super('unknown strategy');
  }
}

export type StrategyFailureCode =
  | 'ORDER_SUBMISSION_FAILED'
  | 'ORDER_SUBMISSION_UNKNOWN'
  | 'ORDER_NOT_FOUND'
  | 'NO_FILL'
  | 'MISSING_AVERAGE_PRICE'
  | 'HEDGE_ORDER_REJECTED'
  | 'HEDGE_ORDER_CANCELED'
  | 'ORDER_RECONCILIATION_FAILED'
  | 'INCONSISTENT_ORDER_STATE';

export interface StrategyRecord {
  readonly id: string;
  readonly state: StrategyState;
  readonly mode: ExecutionMode;
  readonly spotExchangeId: string;
  readonly contractExchangeId: string;
  readonly symbol: string;
  readonly requestedBaseQuantity: string;
  readonly effectiveBaseQuantity: string;
  readonly preflight: PreflightResult;
  readonly failureCode: StrategyFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StrategyOrderStatus = 'planned' | OrderSnapshot['status'];

export interface StrategyOrderRecord {
  readonly id: string;
  readonly strategyId: string;
  readonly role: OrderRole;
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly request: OrderRequest;
  readonly snapshot: OrderSnapshot | null;
  readonly status: StrategyOrderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StrategyOrderPlan {
  readonly role: OrderRole;
  readonly request: OrderRequest;
}

export interface StrategyRepository {
  createPending(preflight: PreflightResult): StrategyRecord;
  getStrategy(id: string): StrategyRecord;
  claimForExecution(id: string): boolean;
  planOrder(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord;
  /** Persists every plan in one transaction, or persists none of them. */
  planOrdersAtomically(
    strategyId: string,
    plans: readonly Readonly<StrategyOrderPlan>[]
  ): StrategyOrderRecord[];
  attachOrderSnapshot(
    strategyOrderId: string,
    snapshot: OrderSnapshot
  ): void;
  listOrders(strategyId: string): StrategyOrderRecord[];
  listOrderEvents(strategyOrderId: string): OrderSnapshot[];
  transition(
    strategyId: string,
    from: StrategyState[],
    to: StrategyState,
    failureCode?: StrategyFailureCode
  ): boolean;
  listRecoverable(): StrategyRecord[];
}
