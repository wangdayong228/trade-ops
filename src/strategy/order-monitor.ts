import {
  nonThrowingOperationalLog,
  type OperationalLog
} from '../logging/logger.js';
import type {
  StrategyRepository
} from '../storage/strategy-repository.js';

export interface ExecutionContinuation {
  confirmAndExecute(strategyId: string): Promise<void>;
}

const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

export class OrderMonitor {
  private readonly activeReconciliations = new Map<string, Promise<void>>();
  private activeRecovery: Promise<void> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private activeStop: (() => void) | null = null;
  private readonly operationalLog: OperationalLog | undefined;

  constructor(
    private readonly repository: StrategyRepository,
    private readonly executionContinuation: ExecutionContinuation,
    operationalLog?: OperationalLog
  ) {
    this.operationalLog = nonThrowingOperationalLog(operationalLog);
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
    await this.executionContinuation.confirmAndExecute(strategyId);
  }
}
