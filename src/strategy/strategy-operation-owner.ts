const ACTIVE_STRATEGY_OPERATIONS = new Set<string>();

export function tryAcquireStrategyOperation(strategyId: string): boolean {
  if (ACTIVE_STRATEGY_OPERATIONS.has(strategyId)) {
    return false;
  }
  ACTIVE_STRATEGY_OPERATIONS.add(strategyId);
  return true;
}

export function releaseStrategyOperation(strategyId: string): void {
  ACTIVE_STRATEGY_OPERATIONS.delete(strategyId);
}
