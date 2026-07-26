import type {
  ExecutionMode,
  OrderRequest,
  OrderRole,
  OrderSnapshot,
  StrategyState
} from '../domain/types.js';
import type { PreflightResult } from '../strategy/preflight-service.js';

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
  readonly lastError: string | null;
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

export interface StrategyRepository {
  createPending(preflight: PreflightResult): StrategyRecord;
  getStrategy(id: string): StrategyRecord;
  claimForExecution(id: string): boolean;
  planOrder(
    strategyId: string,
    role: OrderRole,
    request: OrderRequest
  ): StrategyOrderRecord;
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
    error?: string
  ): boolean;
  listRecoverable(): StrategyRecord[];
}
