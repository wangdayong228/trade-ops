import type {
  FundingExchangeId,
  FundingMarketIdentity,
  FundingMarketObservation,
  SettledFundingRate
} from '../funding-rates/funding-rate-record.js';

export type FundingCoverageStatus =
  | 'PENDING'
  | 'BACKFILLING'
  | 'CAUGHT_UP'
  | 'INCOMPLETE';

export type FundingIncrementalStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'INCOMPLETE';

export type FundingCoverageKind =
  | 'INITIAL'
  | 'PERIODIC'
  | 'INACTIVE_FINAL'
  | 'REACTIVATION';

interface CommonCoverageLease {
  readonly exchangeMarketId: string;
  readonly symbol: string;
  readonly generation: number;
  readonly kind: FundingCoverageKind;
  readonly cutoffMs: number;
}

export type CoverageLease =
  | (CommonCoverageLease & {
      readonly exchangeId: 'bitget';
      readonly okxResumeAfterMs: null;
      readonly requiredBitgetBoundaryMs: number | null;
    })
  | (CommonCoverageLease & {
      readonly exchangeId: 'okx';
      readonly okxResumeAfterMs: number | null;
      readonly requiredBitgetBoundaryMs: null;
    });

export interface IncrementalLease extends FundingMarketIdentity {
  readonly generation: number;
  readonly frozenBoundaryMs: number | null;
}

export type CoveragePageCheckpoint =
  | {
      readonly exchangeId: 'bitget';
      readonly round: 1 | 2 | 3;
    }
  | {
      readonly exchangeId: 'okx';
      readonly recoveryAnchorMs: number;
    };

export interface FundingPageWriteResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly revised: number;
  readonly revisedKeys: readonly {
    readonly fundingTimestampMs: number;
    readonly previousContentHash: string;
    readonly currentContentHash: string;
  }[];
}

export type FundingTaskFailureCode =
  | 'COVERAGE_CANCELED_BY_MARKET_STATE'
  | 'REQUEST_RETRY_EXHAUSTED'
  | 'SOURCE_RESPONSE_INVALID'
  | 'CURSOR_NOT_ADVANCING'
  | 'BITGET_BOUNDARY_NOT_SEEN'
  | 'BITGET_SCAN_NOT_CONVERGED'
  | 'DATABASE_WRITE_FAILED';

export const MAX_FUNDING_TASK_FAILURE_SUMMARY_BYTES = 512;

export interface FundingTaskFailure {
  readonly code: FundingTaskFailureCode;
  readonly summary: string;
}

const FUNDING_TASK_FAILURE_SUMMARIES: Readonly<Record<
  FundingTaskFailureCode,
  string
>> = {
  COVERAGE_CANCELED_BY_MARKET_STATE:
    'coverage canceled after market state changed',
  REQUEST_RETRY_EXHAUSTED:
    'public funding request retries exhausted',
  SOURCE_RESPONSE_INVALID:
    'public funding response failed validation',
  CURSOR_NOT_ADVANCING:
    'funding history cursor did not advance',
  BITGET_BOUNDARY_NOT_SEEN:
    'saved Bitget boundary was not observed',
  BITGET_SCAN_NOT_CONVERGED:
    'Bitget scans did not converge',
  DATABASE_WRITE_FAILED:
    'funding page transaction failed'
};

export function fundingTaskFailure(
  code: FundingTaskFailureCode
): FundingTaskFailure {
  if (
    typeof code !== 'string'
    || !Object.hasOwn(FUNDING_TASK_FAILURE_SUMMARIES, code)
  ) {
    throw new Error('unsupported funding task failure code');
  }
  const summary = FUNDING_TASK_FAILURE_SUMMARIES[code];
  if (summary === undefined) {
    throw new Error('unsupported funding task failure code');
  }
  return { code, summary };
}

export type FundingExhaustionEvidence =
  | {
      readonly exchangeId: 'bitget';
      readonly generation: number;
      readonly cutoffMs: number;
      readonly matchingRounds: readonly [1, 2] | readonly [2, 3];
      readonly emptyPageNo: number;
    }
  | {
      readonly exchangeId: 'okx';
      readonly generation: number;
      readonly cutoffMs: number;
      readonly explicitEmpty: true;
      readonly finalRequestAfterMs: number | null;
    };

export interface FundingMarketState extends FundingMarketIdentity {
  readonly active: boolean;
  readonly activeObservedAt: string;
  readonly activeChangedAt: string;
  readonly reactivationRequired: boolean;
  readonly reactivationAfterGeneration: number | null;
  readonly inactiveFinalCaughtUpAt: string | null;
  readonly coverageStatus: FundingCoverageStatus;
  readonly coverageGeneration: number;
  readonly coverageTaskKind: FundingCoverageKind | null;
  readonly coverageCutoffMs: number | null;
  readonly coverageRequiredBitgetBoundaryMs: number | null;
  readonly coverageInitialOkxAfterMs: number | null;
  readonly lastCaughtUpGeneration: number | null;
  readonly lastCaughtUpCutoffMs: number | null;
  readonly lastExhaustedAt: string | null;
  readonly lastExhaustionEvidenceJson: string | null;
  readonly okxResumeAfterMs: number | null;
  readonly okxResumeGeneration: number | null;
  readonly oldestFundingTimestampMs: number | null;
  readonly latestFundingTimestampMs: number | null;
  readonly coverageStartedAt: string | null;
  readonly coverageEndedAt: string | null;
  readonly coverageLastSuccessAt: string | null;
  readonly coverageErrorCode: FundingTaskFailureCode | null;
  readonly coverageErrorSummary: string | null;
  readonly incrementalStatus: FundingIncrementalStatus;
  readonly incrementalGeneration: number;
  readonly incrementalFrozenBoundaryMs: number | null;
  readonly incrementalStartedAt: string | null;
  readonly incrementalEndedAt: string | null;
  readonly incrementalLastSuccessAt: string | null;
  readonly incrementalErrorCode: FundingTaskFailureCode | null;
  readonly incrementalErrorSummary: string | null;
}

export interface FundingDiscoveryResult {
  readonly createdActiveMarketIds: readonly string[];
  readonly becameInactiveMarketIds: readonly string[];
  readonly reactivatedMarketIds: readonly string[];
  readonly observedActiveCount: number;
  readonly observedInactiveCount: number;
}

export class StaleFundingTaskError extends Error {
  readonly name = 'StaleFundingTaskError';

  constructor() {
    super('stale funding task');
  }
}

export class IncompleteFundingDiscoveryError extends Error {
  readonly name = 'IncompleteFundingDiscoveryError';

  constructor(context?: Readonly<{
    exchangeId: FundingExchangeId;
    exchangeMarketId: string;
    expectedSymbol: string;
    actualSymbol: string;
  }>) {
    super(context === undefined
      ? 'incomplete funding discovery: known market is missing'
      : 'incomplete funding discovery: known market symbol mismatch for '
        + `${context.exchangeId}/${context.exchangeMarketId}; `
        + `expected ${context.expectedSymbol}; actual ${context.actualSymbol}`);
  }
}

export interface FundingRateRepository {
  applyCompleteDiscovery(
    exchangeId: FundingExchangeId,
    observations: readonly FundingMarketObservation[],
    observedAt: Date
  ): FundingDiscoveryResult;
  listMarketStates(exchangeId: FundingExchangeId): FundingMarketState[];
  listHistory(market: FundingMarketIdentity): SettledFundingRate[];
  startCoverage(
    market: FundingMarketIdentity,
    kind: FundingCoverageKind,
    cutoffMs: number,
    startedAt: Date
  ): CoverageLease;
  resumeInterruptedCoverage(
    market: FundingMarketIdentity,
    resumedAt: Date
  ): CoverageLease;
  isCoverageLeaseCurrent(lease: CoverageLease): boolean;
  commitCoveragePage(
    lease: CoverageLease,
    records: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint,
    observedAt: Date
  ): FundingPageWriteResult;
  bitgetRoundsEqual(
    lease: CoverageLease,
    left: 1 | 2,
    right: 2 | 3
  ): boolean;
  completeCoverage(
    lease: CoverageLease,
    evidence: FundingExhaustionEvidence,
    completedAt: Date
  ): void;
  failCoverage(
    lease: CoverageLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void;
  startIncremental(
    market: FundingMarketIdentity,
    startedAt: Date
  ): IncrementalLease;
  restartInterruptedIncremental(
    market: FundingMarketIdentity,
    restartedAt: Date
  ): IncrementalLease;
  isIncrementalLeaseEligible(lease: IncrementalLease): boolean;
  commitIncrementalPage(
    lease: IncrementalLease,
    records: readonly SettledFundingRate[],
    observedAt: Date
  ): FundingPageWriteResult;
  completeIncremental(lease: IncrementalLease, completedAt: Date): void;
  failIncremental(
    lease: IncrementalLease,
    failure: FundingTaskFailure,
    failedAt: Date
  ): void;
  cancelIncremental(lease: IncrementalLease, canceledAt: Date): void;
}
