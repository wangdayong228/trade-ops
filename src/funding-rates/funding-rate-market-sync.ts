import {
  fundingRateEvent,
  nonThrowingFundingRateEventSink,
  type FundingRateEventInput,
  type FundingRateEventSink
} from './funding-rate-events.js';
import {
  settledFundingRate,
  type FundingMarketIdentity,
  type SettledFundingRate
} from './funding-rate-record.js';
import type {
  FundingPageCursor,
  FundingRatePage,
  FundingRateSource,
  FundingRequestExecutor,
  FundingRequestMetadata
} from './funding-rate-source.js';
import {
  StaleFundingTaskError,
  fundingTaskFailure,
  type CoverageLease,
  type CoveragePageCheckpoint,
  type FundingPageWriteResult,
  type FundingRateRepository,
  type FundingTaskFailureCode
} from '../storage/funding-rate-repository.js';

export interface FundingPageTask {
  readonly key: string;
  readonly category: 'backfill' | 'reconcile' | 'incremental';
  runNextPage(): Promise<'requeue' | 'done'>;
}

interface FundingRateMarketSyncOptions {
  readonly source: FundingRateSource;
  readonly repository: FundingRateRepository;
  readonly requestExecutor: FundingRequestExecutor;
  readonly events: FundingRateEventSink;
  readonly now: () => Date;
}

type BitgetLease = Extract<CoverageLease, { readonly exchangeId: 'bitget' }>;
type OkxLease = Extract<CoverageLease, { readonly exchangeId: 'okx' }>;
type PageTaskResult = 'requeue' | 'done';
type PageValidationFailureCode = Extract<
  FundingTaskFailureCode,
  'SOURCE_RESPONSE_INVALID' | 'CURSOR_NOT_ADVANCING'
>;

type ValidatedBitgetPage =
  | { readonly empty: true }
  | {
      readonly empty: false;
      readonly records: readonly SettledFundingRate[];
      readonly nextPageNo: number;
      readonly boundaryObserved: boolean;
    };

type ValidatedOkxPage =
  | { readonly empty: true }
  | {
      readonly empty: false;
      readonly records: readonly SettledFundingRate[];
      readonly nextAfterMs: number;
      readonly recoveryAnchorMs: number;
    };

class PageValidationFailure extends Error {
  constructor(
    readonly code: PageValidationFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'PageValidationFailure';
  }
}

function pageContext(lease: CoverageLease): string {
  return `${lease.exchangeId}/${lease.exchangeMarketId}/${lease.symbol}`;
}

function sourceResponseInvalid(lease: CoverageLease, detail: string): never {
  throw new PageValidationFailure(
    'SOURCE_RESPONSE_INVALID',
    `invalid funding page for ${pageContext(lease)}: ${detail}`
  );
}

function cursorNotAdvancing(lease: CoverageLease, detail: string): never {
  throw new PageValidationFailure(
    'CURSOR_NOT_ADVANCING',
    `funding cursor did not advance for ${pageContext(lease)}: ${detail}`
  );
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0;
}

function sameCursor(value: unknown, expected: FundingPageCursor): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const cursor = value as Partial<FundingPageCursor>;
  if (cursor.exchangeId !== expected.exchangeId) return false;
  return expected.exchangeId === 'bitget'
    ? cursor.exchangeId === 'bitget' && cursor.pageNo === expected.pageNo
    : cursor.exchangeId === 'okx' && cursor.afterMs === expected.afterMs;
}

function sameRecord(
  left: SettledFundingRate,
  right: SettledFundingRate
): boolean {
  return left.exchangeId === right.exchangeId
    && left.exchangeMarketId === right.exchangeMarketId
    && left.symbol === right.symbol
    && left.fundingTimestampMs === right.fundingTimestampMs
    && left.fundingRate === right.fundingRate
    && left.rawJson === right.rawJson
    && left.contentHash === right.contentHash;
}

function normalizedPageRecords(
  value: unknown,
  lease: CoverageLease,
  maximumRecords: number
): readonly SettledFundingRate[] {
  if (!Array.isArray(value)) {
    return sourceResponseInvalid(lease, 'records must be an array');
  }
  if (value.length > maximumRecords) {
    return sourceResponseInvalid(
      lease,
      `record count ${value.length} exceeds page size ${maximumRecords}`
    );
  }

  const byTimestamp = new Map<number, SettledFundingRate>();
  for (const valueRecord of value) {
    if (typeof valueRecord !== 'object' || valueRecord === null) {
      return sourceResponseInvalid(lease, 'record must be an object');
    }
    const record = valueRecord as Partial<SettledFundingRate>;
    if (
      record.exchangeId !== lease.exchangeId
      || record.exchangeMarketId !== lease.exchangeMarketId
      || record.symbol !== lease.symbol
    ) {
      return sourceResponseInvalid(lease, 'record market identity mismatch');
    }
    if (!nonNegativeSafeInteger(record.fundingTimestampMs)) {
      return sourceResponseInvalid(lease, 'record timestamp must be a safe integer');
    }
    if (typeof record.rawJson !== 'string') {
      return sourceResponseInvalid(lease, 'record raw_json must be JSON text');
    }

    let raw: unknown;
    let normalized: SettledFundingRate;
    try {
      raw = JSON.parse(record.rawJson);
      normalized = settledFundingRate(
        lease,
        record.fundingRate,
        record.fundingTimestampMs,
        raw
      );
    } catch {
      return sourceResponseInvalid(lease, 'record normalization failed');
    }
    if (
      normalized.rawJson !== record.rawJson
      || normalized.contentHash !== record.contentHash
    ) {
      return sourceResponseInvalid(lease, 'record canonical content mismatch');
    }

    const existing = byTimestamp.get(normalized.fundingTimestampMs);
    if (existing !== undefined && !sameRecord(existing, normalized)) {
      return sourceResponseInvalid(lease, 'duplicate record content conflict');
    }
    byTimestamp.set(normalized.fundingTimestampMs, normalized);
  }
  return [...byTimestamp.values()].sort(
    (left, right) => right.fundingTimestampMs - left.fundingTimestampMs
  );
}

function fundingPage(value: unknown, lease: CoverageLease): FundingRatePage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return sourceResponseInvalid(lease, 'response must be a page object');
  }
  return value as FundingRatePage;
}

function validateBitgetPage(
  value: unknown,
  lease: BitgetLease,
  requestedPageNo: number,
  pageSize: number
): ValidatedBitgetPage {
  const page = fundingPage(value, lease);
  const requestedCursor = {
    exchangeId: 'bitget',
    pageNo: requestedPageNo
  } as const;
  if (!sameCursor(page.cursor, requestedCursor)) {
    return sourceResponseInvalid(lease, 'response cursor does not match request');
  }
  const records = normalizedPageRecords(page.records, lease, pageSize);
  if (page.recoveryAnchorMs !== null) {
    return sourceResponseInvalid(lease, 'Bitget page carried a recovery anchor');
  }
  if (records.length === 0) {
    if (page.nextCursor !== null) {
      return sourceResponseInvalid(
        lease,
        'empty Bitget page must be an explicit terminal page'
      );
    }
    return { empty: true };
  }
  if (
    page.nextCursor === null
    || typeof page.nextCursor !== 'object'
    || page.nextCursor.exchangeId !== 'bitget'
  ) {
    return cursorNotAdvancing(lease, 'non-empty Bitget page has no next page');
  }
  if (
    requestedPageNo === Number.MAX_SAFE_INTEGER
    || !positiveSafeInteger(page.nextCursor.pageNo)
    || page.nextCursor.pageNo !== requestedPageNo + 1
  ) {
    return cursorNotAdvancing(
      lease,
      `expected page ${requestedPageNo + 1}`
    );
  }
  return {
    empty: false,
    records,
    nextPageNo: page.nextCursor.pageNo,
    boundaryObserved: lease.requiredBitgetBoundaryMs !== null
      && records.some(({ fundingTimestampMs }) => (
        fundingTimestampMs === lease.requiredBitgetBoundaryMs
      ))
  };
}

function validateOkxPage(
  value: unknown,
  lease: OkxLease,
  requestedAfterMs: number | null,
  pageSize: number
): ValidatedOkxPage {
  const page = fundingPage(value, lease);
  const requestedCursor = {
    exchangeId: 'okx',
    afterMs: requestedAfterMs
  } as const;
  if (!sameCursor(page.cursor, requestedCursor)) {
    return sourceResponseInvalid(lease, 'response cursor does not match request');
  }
  const records = normalizedPageRecords(page.records, lease, pageSize);
  if (records.length === 0) {
    if (page.nextCursor !== null || page.recoveryAnchorMs !== null) {
      return sourceResponseInvalid(
        lease,
        'empty OKX page must have null next cursor and recovery anchor'
      );
    }
    return { empty: true };
  }

  if (
    requestedAfterMs !== null
    && records.some(({ fundingTimestampMs }) => (
      fundingTimestampMs >= requestedAfterMs
    ))
  ) {
    return cursorNotAdvancing(
      lease,
      `record timestamp must be less than after ${requestedAfterMs}`
    );
  }
  const newest = records[0];
  const oldest = records[records.length - 1];
  if (newest === undefined || oldest === undefined) {
    return sourceResponseInvalid(lease, 'non-empty OKX page has no bounds');
  }
  if (
    page.nextCursor === null
    || typeof page.nextCursor !== 'object'
    || page.nextCursor.exchangeId !== 'okx'
    || !nonNegativeSafeInteger(page.nextCursor.afterMs)
    || page.nextCursor.afterMs !== oldest.fundingTimestampMs
  ) {
    return cursorNotAdvancing(
      lease,
      `next after must equal page minimum ${oldest.fundingTimestampMs}`
    );
  }
  if (
    !nonNegativeSafeInteger(page.recoveryAnchorMs)
    || page.recoveryAnchorMs !== newest.fundingTimestampMs
  ) {
    return cursorNotAdvancing(
      lease,
      `recovery anchor must equal page maximum ${newest.fundingTimestampMs}`
    );
  }
  if (
    requestedAfterMs !== null
    && page.nextCursor.afterMs >= requestedAfterMs
  ) {
    return cursorNotAdvancing(
      lease,
      `next after ${page.nextCursor.afterMs} must be less than ${requestedAfterMs}`
    );
  }
  return {
    empty: false,
    records,
    nextAfterMs: page.nextCursor.afterMs,
    recoveryAnchorMs: page.recoveryAnchorMs
  };
}

class CoveragePageTask implements FundingPageTask {
  readonly key: string;
  readonly category: 'backfill' | 'reconcile';
  private finished = false;
  private bitgetRound: 1 | 2 | 3 = 1;
  private bitgetPageNo = 1;
  private previousBitgetEmptyPageNo: number | null = null;
  private bitgetBoundarySeen = false;
  private okxAfterMs: number | null;

  constructor(
    private readonly source: FundingRateSource,
    private readonly pageSize: number,
    private readonly repository: FundingRateRepository,
    private readonly requestExecutor: FundingRequestExecutor,
    private readonly events: FundingRateEventSink,
    private readonly now: () => Date,
    private readonly lease: CoverageLease
  ) {
    this.key = [
      'coverage',
      lease.exchangeId,
      lease.exchangeMarketId,
      lease.kind,
      lease.generation
    ].join(':');
    this.category = lease.kind === 'INITIAL' ? 'backfill' : 'reconcile';
    this.okxAfterMs = lease.exchangeId === 'okx'
      ? lease.okxResumeAfterMs
      : null;
    this.recordEvent({
      event: 'funding_coverage_started',
      exchangeId: lease.exchangeId,
      exchangeMarketId: lease.exchangeMarketId,
      symbol: lease.symbol,
      phase: 'coverage-start',
      taskKind: lease.kind,
      generation: lease.generation,
      coverageCutoffMs: lease.cutoffMs,
      cursor: this.currentCursor()
    });
  }

  async runNextPage(): Promise<PageTaskResult> {
    if (this.finished) return 'done';
    if (!this.repository.isCoverageLeaseCurrent(this.lease)) {
      this.finished = true;
      return 'done';
    }

    const cursor = this.currentCursor();
    let request: FundingRequestMetadata;
    try {
      request = this.source.pageRequest(this.lease, cursor);
    } catch (error) {
      return this.finishWithFailure(
        'SOURCE_RESPONSE_INVALID',
        cursor,
        null,
        error
      );
    }

    let page: FundingRatePage;
    try {
      page = await this.requestExecutor.execute(
        request,
        () => this.source.fetchPage(this.lease, cursor)
      );
    } catch (error) {
      return this.finishWithFailure(
        'SOURCE_RESPONSE_INVALID',
        cursor,
        request,
        error
      );
    }

    if (this.lease.exchangeId === 'bitget') {
      return this.runBitgetPage(
        this.lease,
        page,
        cursor,
        request
      );
    }
    return this.runOkxPage(this.lease, page, cursor, request);
  }

  private runBitgetPage(
    lease: BitgetLease,
    page: FundingRatePage,
    cursor: FundingPageCursor,
    request: FundingRequestMetadata
  ): PageTaskResult {
    let validated: ValidatedBitgetPage;
    try {
      validated = validateBitgetPage(
        page,
        lease,
        this.bitgetPageNo,
        this.pageSize
      );
    } catch (error) {
      return this.finishValidationFailure(error, cursor, request);
    }

    if (validated.empty) {
      return this.finishBitgetRound(lease, cursor, request);
    }
    const committed = this.commitPage(
      lease,
      validated.records,
      { exchangeId: 'bitget', round: this.bitgetRound },
      cursor,
      request
    );
    if (!committed) return 'done';

    this.bitgetBoundarySeen = this.bitgetBoundarySeen
      || validated.boundaryObserved;
    this.bitgetPageNo = validated.nextPageNo;
    return 'requeue';
  }

  private finishBitgetRound(
    lease: BitgetLease,
    cursor: FundingPageCursor,
    request: FundingRequestMetadata
  ): PageTaskResult {
    if (
      lease.requiredBitgetBoundaryMs !== null
      && !this.bitgetBoundarySeen
    ) {
      return this.finishWithFailure(
        'BITGET_BOUNDARY_NOT_SEEN',
        cursor,
        request,
        new Error(
          `Bitget saved boundary ${lease.requiredBitgetBoundaryMs} was not observed`
        )
      );
    }

    if (this.bitgetRound === 1) {
      this.previousBitgetEmptyPageNo = this.bitgetPageNo;
      this.startNextBitgetRound(2);
      return 'requeue';
    }

    const leftRound = this.bitgetRound === 2 ? 1 : 2;
    const sameEmptyPage = this.previousBitgetEmptyPageNo === this.bitgetPageNo;
    let sameRecords = false;
    if (sameEmptyPage) {
      try {
        sameRecords = this.repository.bitgetRoundsEqual(
          lease,
          leftRound,
          this.bitgetRound
        );
      } catch (error) {
        if (error instanceof StaleFundingTaskError) {
          this.finished = true;
          return 'done';
        }
        return this.finishWithFailure(
          'DATABASE_WRITE_FAILED',
          cursor,
          request,
          error
        );
      }
    }

    if (sameEmptyPage && sameRecords) {
      return this.completeCoverage(
        {
          exchangeId: 'bitget',
          generation: lease.generation,
          cutoffMs: lease.cutoffMs,
          matchingRounds: leftRound === 1 ? [1, 2] : [2, 3],
          emptyPageNo: this.bitgetPageNo
        },
        cursor,
        request
      );
    }
    if (this.bitgetRound === 3) {
      return this.finishWithFailure(
        'BITGET_SCAN_NOT_CONVERGED',
        cursor,
        request,
        new Error('Bitget funding scans did not converge after three rounds')
      );
    }

    this.previousBitgetEmptyPageNo = this.bitgetPageNo;
    this.startNextBitgetRound(3);
    return 'requeue';
  }

  private startNextBitgetRound(round: 2 | 3): void {
    this.bitgetRound = round;
    this.bitgetPageNo = 1;
    this.bitgetBoundarySeen = false;
  }

  private runOkxPage(
    lease: OkxLease,
    page: FundingRatePage,
    cursor: FundingPageCursor,
    request: FundingRequestMetadata
  ): PageTaskResult {
    let validated: ValidatedOkxPage;
    try {
      validated = validateOkxPage(
        page,
        lease,
        this.okxAfterMs,
        this.pageSize
      );
    } catch (error) {
      return this.finishValidationFailure(error, cursor, request);
    }

    if (validated.empty) {
      return this.completeCoverage(
        {
          exchangeId: 'okx',
          generation: lease.generation,
          cutoffMs: lease.cutoffMs,
          explicitEmpty: true,
          finalRequestAfterMs: this.okxAfterMs
        },
        cursor,
        request
      );
    }
    const committed = this.commitPage(
      lease,
      validated.records,
      {
        exchangeId: 'okx',
        recoveryAnchorMs: validated.recoveryAnchorMs
      },
      cursor,
      request
    );
    if (!committed) return 'done';

    this.okxAfterMs = validated.nextAfterMs;
    return 'requeue';
  }

  private commitPage(
    lease: CoverageLease,
    records: readonly SettledFundingRate[],
    checkpoint: CoveragePageCheckpoint,
    cursor: FundingPageCursor,
    request: FundingRequestMetadata
  ): boolean {
    let result: FundingPageWriteResult;
    try {
      result = this.repository.commitCoveragePage(
        lease,
        records,
        checkpoint,
        this.now()
      );
    } catch (error) {
      if (error instanceof StaleFundingTaskError) {
        this.finished = true;
        return false;
      }
      this.finishWithFailure(
        'DATABASE_WRITE_FAILED',
        cursor,
        request,
        error
      );
      return false;
    }

    this.recordEvent({
      event: 'funding_page_committed',
      exchangeId: lease.exchangeId,
      exchangeMarketId: lease.exchangeMarketId,
      symbol: lease.symbol,
      phase: 'coverage-page',
      taskKind: lease.kind,
      generation: lease.generation,
      cursor,
      inserted: result.inserted,
      unchanged: result.unchanged,
      revised: result.revised
    });
    for (const revision of result.revisedKeys) {
      this.recordEvent({
        event: 'funding_rate_revised',
        exchangeId: lease.exchangeId,
        exchangeMarketId: lease.exchangeMarketId,
        symbol: lease.symbol,
        phase: 'coverage-page',
        fundingTimestampMs: revision.fundingTimestampMs,
        previousContentHash: revision.previousContentHash,
        currentContentHash: revision.currentContentHash
      });
    }
    return true;
  }

  private completeCoverage(
    evidence: Parameters<FundingRateRepository['completeCoverage']>[1],
    cursor: FundingPageCursor,
    request: FundingRequestMetadata
  ): PageTaskResult {
    try {
      this.repository.completeCoverage(this.lease, evidence, this.now());
    } catch (error) {
      if (error instanceof StaleFundingTaskError) {
        this.finished = true;
        return 'done';
      }
      return this.finishWithFailure(
        'DATABASE_WRITE_FAILED',
        cursor,
        request,
        error
      );
    }
    this.finished = true;
    this.recordEvent({
      event: 'funding_coverage_completed',
      exchangeId: this.lease.exchangeId,
      exchangeMarketId: this.lease.exchangeMarketId,
      symbol: this.lease.symbol,
      phase: 'coverage-complete',
      taskKind: this.lease.kind,
      generation: this.lease.generation,
      coverageCutoffMs: this.lease.cutoffMs,
      lastCaughtUpCutoffMs: this.lease.cutoffMs
    });
    return 'done';
  }

  private finishValidationFailure(
    error: unknown,
    cursor: FundingPageCursor,
    request: FundingRequestMetadata
  ): PageTaskResult {
    const failure = error instanceof PageValidationFailure
      ? error
      : new PageValidationFailure(
          'SOURCE_RESPONSE_INVALID',
          `invalid funding page for ${pageContext(this.lease)}`
        );
    return this.finishWithFailure(
      failure.code,
      cursor,
      request,
      failure
    );
  }

  private finishWithFailure(
    code: FundingTaskFailureCode,
    cursor: FundingPageCursor,
    request: FundingRequestMetadata | null,
    error: unknown
  ): PageTaskResult {
    try {
      this.repository.failCoverage(
        this.lease,
        fundingTaskFailure(code),
        this.now()
      );
    } catch (failureError) {
      if (!(failureError instanceof StaleFundingTaskError)) {
        throw failureError;
      }
      this.finished = true;
      return 'done';
    }
    this.finished = true;
    if (request !== null) {
      this.recordEvent({
        event: 'funding_task_incomplete',
        exchangeId: this.lease.exchangeId,
        exchangeMarketId: this.lease.exchangeMarketId,
        symbol: this.lease.symbol,
        phase: 'coverage-incomplete',
        taskKind: this.lease.kind,
        generation: this.lease.generation,
        taskCategory: 'coverage',
        coverageCutoffMs: this.lease.cutoffMs,
        cursor,
        request,
        error
      });
    }
    return 'done';
  }

  private currentCursor(): FundingPageCursor {
    return this.lease.exchangeId === 'bitget'
      ? { exchangeId: 'bitget', pageNo: this.bitgetPageNo }
      : { exchangeId: 'okx', afterMs: this.okxAfterMs };
  }

  private recordEvent(input: FundingRateEventInput): void {
    try {
      this.events.record(fundingRateEvent(input));
    } catch {
      // Event reporting cannot change funding synchronization state.
    }
  }
}

export class FundingRateMarketSync {
  private readonly sourceExchangeId: 'bitget' | 'okx';
  private readonly pageSize: 100 | 400;
  private readonly events: FundingRateEventSink;

  constructor(private readonly options: FundingRateMarketSyncOptions) {
    const { source } = options;
    if (source.exchangeId !== 'bitget' && source.exchangeId !== 'okx') {
      throw new Error('invalid funding rate source exchange identity');
    }
    const expectedPageSize = source.exchangeId === 'bitget' ? 100 : 400;
    if (source.pageSize !== expectedPageSize) {
      throw new Error(
        `invalid ${source.exchangeId} funding source page size: `
        + `expected ${expectedPageSize}, actual ${source.pageSize}`
      );
    }
    this.sourceExchangeId = source.exchangeId;
    this.pageSize = source.pageSize;
    this.events = nonThrowingFundingRateEventSink(options.events);
  }

  createCoverageTask(lease: CoverageLease): FundingPageTask {
    if (lease.exchangeId !== this.sourceExchangeId) {
      throw new Error(
        `funding source and coverage lease exchange identity mismatch: `
        + `expected ${this.sourceExchangeId}, actual ${lease.exchangeId}`
      );
    }
    return new CoveragePageTask(
      this.options.source,
      this.pageSize,
      this.options.repository,
      this.options.requestExecutor,
      this.events,
      this.options.now,
      lease
    );
  }
}
