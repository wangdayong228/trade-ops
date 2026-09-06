import { NetworkError } from 'ccxt';
import {
  fundingRateEvent,
  nonThrowingFundingRateEventSink,
  type FundingRateEventInput,
  type FundingRateEventSink
} from './funding-rate-events.js';
import {
  FundingRateMarketSync,
  type FundingPageTask
} from './funding-rate-market-sync.js';
import type {
  FundingMarketIdentity
} from './funding-rate-record.js';
import {
  FundingRequestCanceledError,
  FundingRequestRetryExhaustedError,
  type FundingRateSource,
  type FundingRequestExecutor,
  type FundingRequestMetadata,
  type FundingRequestRetryObserver
} from './funding-rate-source.js';
import {
  IncompleteFundingDiscoveryError,
  type FundingCoverageKind,
  type FundingDiscoveryResult,
  type FundingMarketState,
  type FundingRateRepository
} from '../storage/funding-rate-repository.js';

export type FundingSleep = (
  delayMs: number,
  signal: AbortSignal
) => Promise<void>;

export interface FundingRateExchangeWorkerOptions {
  readonly source: FundingRateSource;
  readonly repository: FundingRateRepository;
  readonly events: FundingRateEventSink;
  readonly intervalMs: number;
  readonly nowMs: () => number;
  readonly sleep: FundingSleep;
  readonly onFatal?: (error: unknown) => void;
}

type QueueCategory = 'discovery' | FundingPageTask['category'];
type TaskResult = 'requeue' | 'done';

interface WorkerTask {
  readonly key: string;
  readonly category: QueueCategory;
  runNextPage(): Promise<TaskResult>;
}

const QUEUE_CATEGORIES = [
  'discovery',
  'incremental',
  'backfill',
  'reconcile'
] as const satisfies readonly QueueCategory[];

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const PERIODIC_COVERAGE_INTERVAL_MS = 86_400_000;

class ExchangeRequestExecutor implements FundingRequestExecutor {
  private lastAttemptStartedAtMs: number | null = null;

  constructor(
    private readonly minimumSpacingMs: number,
    private readonly nowMs: () => number,
    private readonly sleep: FundingSleep,
    private readonly signal: AbortSignal
  ) {}

  async execute<Value>(
    _request: FundingRequestMetadata,
    operation: () => Promise<Value>,
    onRetry: FundingRequestRetryObserver
  ): Promise<Value> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      await this.waitForSpacing();
      this.throwIfCanceled();
      this.lastAttemptStartedAtMs = this.nowMs();
      try {
        return await operation();
      } catch (error) {
        if (this.signal.aborted) {
          throw new FundingRequestCanceledError();
        }
        if (!(error instanceof NetworkError)) throw error;
        const retryDelayMs = RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw new FundingRequestRetryExhaustedError();
        }
        try {
          onRetry({
            retryAttempt: attempt + 1,
            retryDelayMs,
            error
          });
        } catch {
          // Observability must not change retry behavior.
        }
        await this.wait(retryDelayMs);
      }
    }
    throw new FundingRequestRetryExhaustedError();
  }

  private async waitForSpacing(): Promise<void> {
    if (this.lastAttemptStartedAtMs === null) return;
    const remaining = this.lastAttemptStartedAtMs
      + this.minimumSpacingMs
      - this.nowMs();
    if (remaining > 0) await this.wait(remaining);
  }

  private async wait(delayMs: number): Promise<void> {
    this.throwIfCanceled();
    try {
      await this.sleep(delayMs, this.signal);
    } catch (error) {
      if (this.signal.aborted) throw new FundingRequestCanceledError();
      throw error;
    }
    this.throwIfCanceled();
  }

  private throwIfCanceled(): void {
    if (this.signal.aborted) throw new FundingRequestCanceledError();
  }
}

function marketIdentity(state: FundingMarketState): FundingMarketIdentity {
  return {
    exchangeId: state.exchangeId,
    exchangeMarketId: state.exchangeMarketId,
    symbol: state.symbol
  };
}

function timestampMs(value: string, context: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid funding scheduler ${context}`);
  }
  return parsed;
}

function isDue(
  timestamp: string,
  delayMs: number,
  nowMs: number,
  context: string
): boolean {
  return nowMs >= timestampMs(timestamp, context) + delayMs;
}

function discoveryRequestFor(
  source: FundingRateSource
): FundingRequestMetadata {
  return source.exchangeId === 'bitget'
    ? {
        method: 'GET',
        path: '/api/v2/mix/market/contracts',
        query: { productType: 'USDT-FUTURES' },
        body: null
      }
    : {
        method: 'GET',
        path: '/api/v5/public/instruments',
        query: { instType: 'SWAP' },
        body: null
      };
}

export class FundingRateExchangeWorker {
  private readonly events: FundingRateEventSink;
  private readonly abortController = new AbortController();
  private readonly requestExecutor: FundingRequestExecutor;
  private readonly marketSync: FundingRateMarketSync;
  private readonly queues: Record<QueueCategory, WorkerTask[]> = {
    discovery: [],
    incremental: [],
    backfill: [],
    reconcile: []
  };
  private readonly taskKeys = new Set<string>();
  private readonly reportedReactivationBlocks = new Set<string>();
  private lifecycle: 'new' | 'running' | 'stopping' | 'stopped' = 'new';
  private lastCategoryIndex = QUEUE_CATEGORIES.length - 1;
  private wake: (() => void) | null = null;
  private rootPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private fatalPresent = false;
  private fatalError: unknown;

  constructor(private readonly options: FundingRateExchangeWorkerOptions) {
    if (options.source.exchangeId !== 'bitget' && options.source.exchangeId !== 'okx') {
      throw new Error('invalid funding worker exchange identity');
    }
    this.events = nonThrowingFundingRateEventSink(options.events);
    this.requestExecutor = new ExchangeRequestExecutor(
      options.source.minimumRequestSpacingMs,
      options.nowMs,
      options.sleep,
      this.abortController.signal
    );
    this.marketSync = new FundingRateMarketSync({
      source: options.source,
      repository: options.repository,
      requestExecutor: this.requestExecutor,
      events: this.events,
      now: () => this.now()
    });
  }

  start(): void {
    if (this.lifecycle !== 'new') return;
    this.lifecycle = 'running';
    this.scheduleDiscovery();
    this.rootPromise = this.runRoot().catch((error: unknown) => {
      this.fatalPresent = true;
      this.fatalError = error;
      this.requestStop();
      try {
        this.options.onFatal?.(error);
      } catch {
        // A lifecycle observer cannot replace the worker failure.
      }
    });
  }

  scheduleDiscovery(): void {
    if (this.lifecycle !== 'running') return;
    const key = `discovery:${this.options.source.exchangeId}`;
    this.enqueue({
      key,
      category: 'discovery',
      runNextPage: () => this.runDiscovery()
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.requestStop();
    const root = this.rootPromise ?? Promise.resolve();
    this.stopPromise = root.then(() => {
      this.lifecycle = 'stopped';
      if (this.fatalPresent) throw this.fatalError;
    });
    return this.stopPromise;
  }

  private requestStop(): void {
    if (this.lifecycle === 'stopped' || this.lifecycle === 'stopping') return;
    this.lifecycle = 'stopping';
    this.abortController.abort();
    for (const category of QUEUE_CATEGORIES) this.queues[category].length = 0;
    this.taskKeys.clear();
    this.wakeRoot();
  }

  private async runRoot(): Promise<void> {
    this.recoverInterruptedTasks();
    this.schedulePersistedWork();
    while (this.lifecycle === 'running') {
      const task = this.dequeue();
      if (task === null) {
        await this.waitForWork();
        continue;
      }

      let result: TaskResult;
      try {
        result = await task.runNextPage();
      } catch (error) {
        if (
          error instanceof FundingRequestCanceledError
          && this.lifecycle !== 'running'
        ) {
          result = 'done';
        } else {
          throw error;
        }
      }

      if (result === 'requeue' && this.lifecycle === 'running') {
        this.queues[task.category].push(task);
      } else {
        this.taskKeys.delete(task.key);
      }
      if (this.lifecycle === 'running') this.schedulePersistedWork();
    }
  }

  private recoverInterruptedTasks(): void {
    const states = this.options.repository.listMarketStates(
      this.options.source.exchangeId
    );
    for (const state of states) {
      if (this.lifecycle !== 'running') return;
      const market = marketIdentity(state);
      if (state.coverageStatus === 'BACKFILLING') {
        const lease = this.options.repository.resumeInterruptedCoverage(
          market,
          this.now()
        );
        this.enqueue(this.marketSync.createCoverageTask(lease));
      }
      if (state.incrementalStatus === 'RUNNING') {
        const lease = this.options.repository.restartInterruptedIncremental(
          market,
          this.now()
        );
        this.enqueue(this.marketSync.createIncrementalTask(lease));
      }
    }
  }

  private schedulePersistedWork(): void {
    const nowMs = this.options.nowMs();
    const states = this.options.repository.listMarketStates(
      this.options.source.exchangeId
    );
    for (const state of states) {
      if (this.lifecycle !== 'running') return;
      this.recordReactivationBlock(state);
      if (this.lifecycle !== 'running') return;
      if (state.coverageStatus !== 'BACKFILLING') {
        const coverageKind = this.coverageKindDue(state, nowMs);
        if (coverageKind !== null) {
          const lease = this.options.repository.startCoverage(
            marketIdentity(state),
            coverageKind,
            nowMs,
            new Date(nowMs)
          );
          this.enqueue(this.marketSync.createCoverageTask(lease));
        }
      }
      if (this.incrementalDue(state, nowMs)) {
        const lease = this.options.repository.startIncremental(
          marketIdentity(state),
          new Date(nowMs)
        );
        this.enqueue(this.marketSync.createIncrementalTask(lease));
      }
    }
  }

  private recordReactivationBlock(state: FundingMarketState): void {
    const key = state.exchangeMarketId;
    if (!state.active || !state.reactivationRequired) {
      this.reportedReactivationBlocks.delete(key);
      return;
    }
    if (this.reportedReactivationBlocks.has(key)) return;
    this.reportedReactivationBlocks.add(key);
    this.recordEvent({
      event: 'funding_incremental_blocked',
      ...marketIdentity(state),
      phase: 'incremental-blocked-by-reactivation',
      generation: state.incrementalGeneration
    });
  }

  private coverageKindDue(
    state: FundingMarketState,
    nowMs: number
  ): FundingCoverageKind | null {
    if (state.reactivationRequired) {
      return this.coverageRetryDue(state, 'REACTIVATION', nowMs)
        ? 'REACTIVATION'
        : null;
    }
    if (!state.active) {
      if (state.inactiveFinalCaughtUpAt !== null) return null;
      return this.coverageRetryDue(state, 'INACTIVE_FINAL', nowMs)
        ? 'INACTIVE_FINAL'
        : null;
    }
    if (state.lastCaughtUpGeneration === null) {
      if (state.coverageStatus === 'PENDING') return 'INITIAL';
      return this.coverageRetryDue(state, 'INITIAL', nowMs)
        ? 'INITIAL'
        : null;
    }
    if (state.coverageStatus === 'INCOMPLETE') {
      return this.coverageRetryDue(state, 'PERIODIC', nowMs)
        ? 'PERIODIC'
        : null;
    }
    if (
      state.coverageLastSuccessAt !== null
      && isDue(
        state.coverageLastSuccessAt,
        PERIODIC_COVERAGE_INTERVAL_MS,
        nowMs,
        'coverage_last_success_at'
      )
    ) {
      return 'PERIODIC';
    }
    return null;
  }

  private coverageRetryDue(
    state: FundingMarketState,
    kind: FundingCoverageKind,
    nowMs: number
  ): boolean {
    if (state.coverageStatus !== 'INCOMPLETE') return true;
    if (state.coverageTaskKind !== kind) return true;
    return state.coverageEndedAt !== null
      && isDue(
        state.coverageEndedAt,
        this.options.intervalMs,
        nowMs,
        'coverage_ended_at'
      );
  }

  private incrementalDue(state: FundingMarketState, nowMs: number): boolean {
    if (
      !state.active
      || state.reactivationRequired
      || state.incrementalStatus === 'RUNNING'
      || state.coverageLastSuccessAt === null
      || state.lastCaughtUpGeneration === null
    ) {
      return false;
    }
    if (state.incrementalEndedAt === null) return true;
    return isDue(
      state.incrementalEndedAt,
      this.options.intervalMs,
      nowMs,
      'incremental attempt boundary'
    );
  }

  private async runDiscovery(): Promise<TaskResult> {
    let request: FundingRequestMetadata;
    try {
      request = this.options.source.discoveryRequest();
    } catch (error) {
      this.recordDiscoveryIncomplete(
        discoveryRequestFor(this.options.source),
        error
      );
      return 'done';
    }

    let observations;
    try {
      observations = await this.requestExecutor.execute(
        request,
        () => this.options.source.discoverMarkets(),
        (notice) => this.recordEvent({
          event: 'funding_request_retry',
          taskCategory: 'discovery',
          exchangeId: this.options.source.exchangeId,
          phase: 'market-discovery-request-retry',
          retryAttempt: notice.retryAttempt,
          retryDelayMs: notice.retryDelayMs,
          request,
          error: notice.error
        })
      );
    } catch (error) {
      if (error instanceof FundingRequestCanceledError) throw error;
      this.recordDiscoveryIncomplete(request, error);
      return 'done';
    }

    let discoveryResult: FundingDiscoveryResult;
    try {
      discoveryResult = this.options.repository.applyCompleteDiscovery(
        this.options.source.exchangeId,
        observations,
        this.now()
      );
    } catch (error) {
      if (!(error instanceof IncompleteFundingDiscoveryError)) throw error;
      this.recordDiscoveryIncomplete(request, error);
      return 'done';
    }
    this.recordEvent({
      event: 'funding_market_discovery_completed',
      exchangeId: this.options.source.exchangeId,
      phase: 'market-discovery-complete',
      observedActiveCount: discoveryResult.observedActiveCount,
      observedInactiveCount: discoveryResult.observedInactiveCount,
      createdActiveCount: discoveryResult.createdActiveMarketIds.length,
      becameInactiveCount: discoveryResult.becameInactiveMarketIds.length,
      reactivatedCount: discoveryResult.reactivatedMarketIds.length
    });
    return 'done';
  }

  private recordDiscoveryIncomplete(
    request: FundingRequestMetadata,
    error: unknown
  ): void {
    this.recordEvent({
      event: 'funding_market_discovery_incomplete',
      exchangeId: this.options.source.exchangeId,
      phase: 'market-discovery-incomplete',
      request,
      error
    });
  }

  private recordEvent(input: FundingRateEventInput): void {
    try {
      this.events.record(fundingRateEvent(input));
    } catch {
      // Event reporting cannot change worker behavior.
    }
  }

  private enqueue(task: WorkerTask): void {
    if (this.lifecycle !== 'running' || this.taskKeys.has(task.key)) return;
    this.taskKeys.add(task.key);
    this.queues[task.category].push(task);
    this.wakeRoot();
  }

  private dequeue(): WorkerTask | null {
    for (let offset = 1; offset <= QUEUE_CATEGORIES.length; offset += 1) {
      const index = (this.lastCategoryIndex + offset) % QUEUE_CATEGORIES.length;
      const category = QUEUE_CATEGORIES[index];
      if (category === undefined) continue;
      const task = this.queues[category].shift();
      if (task !== undefined) {
        this.lastCategoryIndex = index;
        return task;
      }
    }
    return null;
  }

  private waitForWork(): Promise<void> {
    if (this.lifecycle !== 'running' || this.hasQueuedWork()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private hasQueuedWork(): boolean {
    return QUEUE_CATEGORIES.some((category) => (
      this.queues[category].length > 0
    ));
  }

  private wakeRoot(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private now(): Date {
    const value = this.options.nowMs();
    const date = new Date(value);
    if (!Number.isSafeInteger(value) || Number.isNaN(date.getTime())) {
      throw new Error('invalid funding worker clock');
    }
    return date;
  }
}
