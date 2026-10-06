import type { ErrorEvidence } from '../errors/error-evidence.js';
import { projectErrorEvidence } from '../errors/trade-ops-error.js';
import type { FundingRateEvent, FundingRateEventSink } from '../funding-rates/funding-rate-events.js';
import type { FundingExchangeId } from '../funding-rates/funding-rate-record.js';
import { redactText } from '../logging/logger.js';
import type { FundingMarketState, FundingRateRepository } from '../storage/funding-rate-repository.js';

type ServicePhase = 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED';
type FundingStatus = 'NOT_STARTED' | 'RUNNING' | 'STOPPED' | 'FAILED';

interface DiscoveryStatus {
  readonly status: 'NEVER' | 'SUCCEEDED' | 'INCOMPLETE';
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly observedActiveCount: number | null;
  readonly observedInactiveCount: number | null;
  readonly error: ErrorEvidence | null;
}

interface RuntimeStatusOptions {
  readonly repository: Pick<FundingRateRepository, 'listMarketStates'>;
  readonly checkDatabase: () => void;
  readonly nowMs: () => number;
  readonly intervalMs: number;
  readonly secretProvider: () => readonly string[];
}

function emptyDiscovery(): DiscoveryStatus {
  return {
    status: 'NEVER', lastAttemptAt: null, lastSuccessAt: null,
    observedActiveCount: null, observedInactiveCount: null, error: null
  };
}

function marketStatus(state: FundingMarketState, secrets: readonly string[]) {
  const text = (value: string | null) => value === null ? null : redactText(value, secrets);
  return {
    exchangeId: state.exchangeId,
    exchangeMarketId: redactText(state.exchangeMarketId, secrets),
    symbol: redactText(state.symbol, secrets),
    active: state.active,
    activeObservedAt: state.activeObservedAt,
    reactivationRequired: state.reactivationRequired,
    coverageStatus: state.coverageStatus,
    coverageTaskKind: state.coverageTaskKind,
    coverageGeneration: state.coverageGeneration,
    coverageCutoffMs: state.coverageCutoffMs,
    lastCaughtUpCutoffMs: state.lastCaughtUpCutoffMs,
    oldestFundingTimestampMs: state.oldestFundingTimestampMs,
    latestFundingTimestampMs: state.latestFundingTimestampMs,
    coverageStartedAt: state.coverageStartedAt,
    coverageEndedAt: state.coverageEndedAt,
    coverageLastSuccessAt: state.coverageLastSuccessAt,
    coverageErrorCode: state.coverageErrorCode,
    coverageErrorSummary: text(state.coverageErrorSummary),
    incrementalStatus: state.incrementalStatus,
    incrementalGeneration: state.incrementalGeneration,
    incrementalStartedAt: state.incrementalStartedAt,
    incrementalEndedAt: state.incrementalEndedAt,
    incrementalLastSuccessAt: state.incrementalLastSuccessAt,
    incrementalErrorCode: state.incrementalErrorCode,
    incrementalErrorSummary: text(state.incrementalErrorSummary)
  };
}

/** Observation only: no gateway, scheduling, or database write capability. */
export class RuntimeStatus implements FundingRateEventSink {
  private phase: ServicePhase = 'STARTING';
  private startedAtMs: number | null = null;
  private fundingStatus: FundingStatus = 'NOT_STARTED';
  private lastFatal: { readonly at: string; readonly error: ErrorEvidence } | null = null;
  private readonly discoveries: Record<FundingExchangeId, DiscoveryStatus> = {
    bitget: emptyDiscovery(), okx: emptyDiscovery()
  };

  constructor(private readonly options: RuntimeStatusOptions) {}

  setPhase(phase: ServicePhase): void {
    if (phase === 'RUNNING' && this.startedAtMs === null) {
      this.startedAtMs = this.options.nowMs();
    }
    this.phase = phase;
  }

  record(event: Readonly<FundingRateEvent>): void {
    switch (event.event) {
      case 'funding_sync_started':
        if (this.lastFatal === null) this.fundingStatus = 'RUNNING';
        break;
      case 'funding_sync_stopped':
        if (this.lastFatal === null) this.fundingStatus = 'STOPPED';
        break;
      case 'funding_sync_fatal':
        this.fundingStatus = 'FAILED';
        this.lastFatal = { at: this.now(), error: this.publicError(event.error) };
        break;
      case 'funding_market_discovery_completed': {
        const at = this.now();
        this.discoveries[event.exchangeId] = {
          status: 'SUCCEEDED', lastAttemptAt: at, lastSuccessAt: at,
          observedActiveCount: event.observedActiveCount,
          observedInactiveCount: event.observedInactiveCount, error: null
        };
        break;
      }
      case 'funding_market_discovery_incomplete':
        this.discoveries[event.exchangeId] = {
          ...this.discoveries[event.exchangeId],
          status: 'INCOMPLETE', lastAttemptAt: this.now(),
          error: this.publicError(event.error)
        };
        break;
    }
  }

  health() {
    let database: { status: 'ok' } | { status: 'error'; error: ErrorEvidence };
    try {
      this.options.checkDatabase();
      database = { status: 'ok' };
    } catch (error) {
      database = { status: 'error', error: this.publicError(error) };
    }
    return {
      status: this.phase === 'RUNNING' && database.status === 'ok' ? 'ready' : 'not_ready',
      service: {
        phase: this.phase,
        startedAt: this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
        uptimeMs: this.startedAtMs === null ? 0 : Math.max(0, this.options.nowMs() - this.startedAtMs)
      },
      database
    };
  }

  snapshot() {
    // Synchronous reads share the service's exclusive connection. No await can
    // interleave a sync task between these two exchanges' state snapshots.
    const exchanges = (['bitget', 'okx'] as const).map((exchangeId) => {
      const states = this.options.repository.listMarketStates(exchangeId);
      const counts = {
        total: states.length, active: 0, inactive: 0,
        coverage: { PENDING: 0, BACKFILLING: 0, CAUGHT_UP: 0, INCOMPLETE: 0 },
        incremental: { IDLE: 0, RUNNING: 0, INCOMPLETE: 0 }
      };
      for (const state of states) {
        counts[state.active ? 'active' : 'inactive'] += 1;
        counts.coverage[state.coverageStatus] += 1;
        counts.incremental[state.incrementalStatus] += 1;
      }
      const discovery = this.discoveries[exchangeId];
      return {
        exchangeId, counts,
        discovery: {
          ...discovery,
          error: discovery.error === null ? null : this.publicError(discovery.error)
        },
        markets: states.map((state) => marketStatus(state, this.options.secretProvider()))
      };
    });
    return {
      generatedAt: this.now(),
      ...this.health(),
      funding: {
        status: this.fundingStatus,
        intervalMs: this.options.intervalMs,
        lastFatal: this.lastFatal === null ? null : {
          at: this.lastFatal.at, error: this.publicError(this.lastFatal.error)
        },
        exchanges
      }
    };
  }

  private now(): string {
    return new Date(this.options.nowMs()).toISOString();
  }

  private publicError(error: unknown): ErrorEvidence {
    return projectErrorEvidence(error, this.options.secretProvider(), false);
  }
}
