import {
  fundingRateEvent,
  nonThrowingFundingRateEventSink,
  type FundingRateEventSink
} from './funding-rate-events.js';
import {
  FundingRateExchangeWorker,
  type FundingSleep
} from './funding-rate-exchange-worker.js';
import type { FundingRateSource } from './funding-rate-source.js';
import type { FundingRateRepository } from '../storage/funding-rate-repository.js';

export interface FundingRateSyncServiceOptions {
  readonly bitgetSource: FundingRateSource;
  readonly okxSource: FundingRateSource;
  readonly repository: FundingRateRepository;
  readonly events: FundingRateEventSink;
  readonly intervalMs: number;
  readonly nowMs: () => number;
  readonly sleep: FundingSleep;
}

export class FundingRateSyncService {
  private readonly events: FundingRateEventSink;
  private readonly bitgetWorker: FundingRateExchangeWorker;
  private readonly okxWorker: FundingRateExchangeWorker;
  private lifecycle: 'new' | 'running' | 'stopping' | 'stopped' = 'new';
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: FundingRateSyncServiceOptions) {
    if (options.bitgetSource.exchangeId !== 'bitget') {
      throw new Error('invalid Bitget funding source identity');
    }
    if (options.okxSource.exchangeId !== 'okx') {
      throw new Error('invalid OKX funding source identity');
    }
    this.events = nonThrowingFundingRateEventSink(options.events);
    const common = {
      repository: options.repository,
      events: this.events,
      intervalMs: options.intervalMs,
      nowMs: options.nowMs,
      sleep: options.sleep,
      onFatal: (error: unknown) => this.handleFatal(error)
    } as const;
    this.bitgetWorker = new FundingRateExchangeWorker({
      ...common,
      source: options.bitgetSource
    });
    this.okxWorker = new FundingRateExchangeWorker({
      ...common,
      source: options.okxSource
    });
    this.options = options;
  }

  private readonly options: FundingRateSyncServiceOptions;

  start(): void {
    if (this.lifecycle !== 'new') return;
    this.lifecycle = 'running';
    this.recordStarted();
    this.bitgetWorker.start();
    this.okxWorker.start();
    this.interval = setInterval(() => {
      if (this.lifecycle !== 'running') return;
      this.bitgetWorker.scheduleDiscovery();
      this.okxWorker.scheduleDiscovery();
    }, this.options.intervalMs);
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.lifecycle = 'stopping';
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const bitget = this.bitgetWorker.stop();
    const okx = this.okxWorker.stop();
    this.stopPromise = Promise.allSettled([bitget, okx]).then((results) => {
      this.lifecycle = 'stopped';
      this.recordStopped();
      const bitgetResult = results[0];
      if (bitgetResult?.status === 'rejected') throw bitgetResult.reason;
      const okxResult = results[1];
      if (okxResult?.status === 'rejected') throw okxResult.reason;
    });
    return this.stopPromise;
  }

  private handleFatal(error: unknown): void {
    try {
      this.events.record(fundingRateEvent({
        event: 'funding_sync_fatal',
        phase: 'worker-root',
        error
      }));
    } catch {
      // Event reporting cannot change service shutdown.
    }
    void this.stop().catch(() => undefined);
  }

  private recordStarted(): void {
    try {
      this.events.record(fundingRateEvent({
        event: 'funding_sync_started',
        phase: 'service-start'
      }));
    } catch {
      // Event reporting cannot change service startup.
    }
  }

  private recordStopped(): void {
    try {
      this.events.record(fundingRateEvent({
        event: 'funding_sync_stopped',
        phase: 'service-stop'
      }));
    } catch {
      // Event reporting cannot change service shutdown.
    }
  }
}
