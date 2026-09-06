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

type InvalidData = (detail: string) => never;

function ownDataDescriptors(
  value: unknown,
  expectedKind: 'object' | 'array',
  subject: string,
  invalid: InvalidData
): ReadonlyMap<string, PropertyDescriptor> {
  if (typeof value !== 'object' || value === null) {
    return invalid(`${subject} must be an ${expectedKind}`);
  }

  let isArray: boolean;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid(`${subject} could not be inspected`);
  }
  if (expectedKind === 'array') {
    if (!isArray || prototype !== Array.prototype) {
      return invalid(`${subject} must be an array`);
    }
  } else if (isArray || prototype !== Object.prototype) {
    return invalid(`${subject} must be an object`);
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (typeof key === 'symbol') {
      return invalid(`${subject} must not contain symbol properties`);
    }
    const stringKey = String(key);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(
        `${subject} property ${JSON.stringify(stringKey)} could not be inspected`
      );
    }
    if (descriptor === undefined) {
      return invalid(
        `${subject} property ${JSON.stringify(stringKey)} has no descriptor`
      );
    }
    if (!('value' in descriptor)) {
      return invalid(
        `${subject} property ${JSON.stringify(stringKey)} must be an own data property`
      );
    }
    descriptors.set(stringKey, descriptor);
  }
  return descriptors;
}

function requiredOwnDataValue(
  descriptors: ReadonlyMap<string, PropertyDescriptor>,
  key: string,
  subject: string,
  invalid: InvalidData
): unknown {
  const descriptor = descriptors.get(key);
  if (descriptor === undefined) {
    return invalid(`${subject} property ${JSON.stringify(key)} is required`);
  }
  return descriptor.value;
}

function invalidCoverageLease(detail: string): never {
  throw new Error(`invalid coverage lease: ${detail}`);
}

function identityString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value;
}

function coverageLeaseSnapshot(value: unknown): CoverageLease {
  const subject = 'coverage lease';
  const descriptors = ownDataDescriptors(
    value,
    'object',
    subject,
    invalidCoverageLease
  );
  const exchangeId = requiredOwnDataValue(
    descriptors,
    'exchangeId',
    subject,
    invalidCoverageLease
  );
  const exchangeMarketId = requiredOwnDataValue(
    descriptors,
    'exchangeMarketId',
    subject,
    invalidCoverageLease
  );
  const symbol = requiredOwnDataValue(
    descriptors,
    'symbol',
    subject,
    invalidCoverageLease
  );
  const generation = requiredOwnDataValue(
    descriptors,
    'generation',
    subject,
    invalidCoverageLease
  );
  const kind = requiredOwnDataValue(
    descriptors,
    'kind',
    subject,
    invalidCoverageLease
  );
  const cutoffMs = requiredOwnDataValue(
    descriptors,
    'cutoffMs',
    subject,
    invalidCoverageLease
  );
  const okxResumeAfterMs = requiredOwnDataValue(
    descriptors,
    'okxResumeAfterMs',
    subject,
    invalidCoverageLease
  );
  const requiredBitgetBoundaryMs = requiredOwnDataValue(
    descriptors,
    'requiredBitgetBoundaryMs',
    subject,
    invalidCoverageLease
  );

  if (exchangeId !== 'bitget' && exchangeId !== 'okx') {
    return invalidCoverageLease('exchangeId must be bitget or okx');
  }
  if (!identityString(exchangeMarketId)) {
    return invalidCoverageLease('exchangeMarketId must be a non-empty identity string');
  }
  if (!identityString(symbol)) {
    return invalidCoverageLease('symbol must be a non-empty identity string');
  }
  if (!nonNegativeSafeInteger(generation)) {
    return invalidCoverageLease('generation must be a non-negative safe integer');
  }
  if (
    kind !== 'INITIAL'
    && kind !== 'PERIODIC'
    && kind !== 'INACTIVE_FINAL'
    && kind !== 'REACTIVATION'
  ) {
    return invalidCoverageLease('kind is not supported');
  }
  if (!nonNegativeSafeInteger(cutoffMs)) {
    return invalidCoverageLease('cutoffMs must be a non-negative safe integer');
  }
  if (exchangeId === 'bitget') {
    if (okxResumeAfterMs !== null) {
      return invalidCoverageLease('Bitget okxResumeAfterMs must be null');
    }
    if (
      requiredBitgetBoundaryMs !== null
      && !nonNegativeSafeInteger(requiredBitgetBoundaryMs)
    ) {
      return invalidCoverageLease(
        'Bitget requiredBitgetBoundaryMs must be null or a non-negative safe integer'
      );
    }
    return Object.freeze({
      exchangeId,
      exchangeMarketId,
      symbol,
      generation,
      kind,
      cutoffMs,
      okxResumeAfterMs,
      requiredBitgetBoundaryMs
    });
  }

  if (requiredBitgetBoundaryMs !== null) {
    return invalidCoverageLease('OKX requiredBitgetBoundaryMs must be null');
  }
  if (okxResumeAfterMs !== null && !nonNegativeSafeInteger(okxResumeAfterMs)) {
    return invalidCoverageLease(
      'OKX okxResumeAfterMs must be null or a non-negative safe integer'
    );
  }
  return Object.freeze({
    exchangeId,
    exchangeMarketId,
    symbol,
    generation,
    kind,
    cutoffMs,
    okxResumeAfterMs,
    requiredBitgetBoundaryMs
  });
}

type CursorSnapshot =
  | { readonly exchangeId: 'bitget'; readonly pageNo: unknown }
  | { readonly exchangeId: 'okx'; readonly afterMs: unknown }
  | { readonly exchangeId: null };

interface FundingPageSnapshot {
  readonly cursor: CursorSnapshot;
  readonly records: readonly SettledFundingRate[];
  readonly nextCursor: CursorSnapshot | null;
  readonly recoveryAnchorMs: unknown;
}

function pageInvalid(lease: CoverageLease): InvalidData {
  return (detail) => sourceResponseInvalid(lease, detail);
}

function cursorSnapshot(
  value: unknown,
  lease: CoverageLease,
  subject: string
): CursorSnapshot {
  const invalid = pageInvalid(lease);
  const descriptors = ownDataDescriptors(value, 'object', subject, invalid);
  const exchangeId = requiredOwnDataValue(
    descriptors,
    'exchangeId',
    subject,
    invalid
  );
  if (exchangeId === 'bitget') {
    return Object.freeze({
      exchangeId,
      pageNo: requiredOwnDataValue(descriptors, 'pageNo', subject, invalid)
    });
  }
  if (exchangeId === 'okx') {
    return Object.freeze({
      exchangeId,
      afterMs: requiredOwnDataValue(descriptors, 'afterMs', subject, invalid)
    });
  }
  return Object.freeze({ exchangeId: null });
}

function sameCursor(value: CursorSnapshot, expected: FundingPageCursor): boolean {
  if (value.exchangeId !== expected.exchangeId) return false;
  return expected.exchangeId === 'bitget'
    ? value.exchangeId === 'bitget' && value.pageNo === expected.pageNo
    : value.exchangeId === 'okx' && value.afterMs === expected.afterMs;
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
  const invalid = pageInvalid(lease);
  const subject = 'records';
  const descriptors = ownDataDescriptors(value, 'array', subject, invalid);
  const length = requiredOwnDataValue(
    descriptors,
    'length',
    subject,
    invalid
  );
  if (!nonNegativeSafeInteger(length)) {
    return sourceResponseInvalid(lease, 'records length must be a safe integer');
  }
  if (length > maximumRecords) {
    return sourceResponseInvalid(
      lease,
      `record count ${length} exceeds page size ${maximumRecords}`
    );
  }

  const byTimestamp = new Map<number, SettledFundingRate>();
  for (let index = 0; index < length; index += 1) {
    const recordSubject = `records[${index}]`;
    const valueRecord = requiredOwnDataValue(
      descriptors,
      String(index),
      subject,
      invalid
    );
    const recordDescriptors = ownDataDescriptors(
      valueRecord,
      'object',
      recordSubject,
      invalid
    );
    const exchangeId = requiredOwnDataValue(
      recordDescriptors,
      'exchangeId',
      recordSubject,
      invalid
    );
    const exchangeMarketId = requiredOwnDataValue(
      recordDescriptors,
      'exchangeMarketId',
      recordSubject,
      invalid
    );
    const symbol = requiredOwnDataValue(
      recordDescriptors,
      'symbol',
      recordSubject,
      invalid
    );
    const fundingTimestampMs = requiredOwnDataValue(
      recordDescriptors,
      'fundingTimestampMs',
      recordSubject,
      invalid
    );
    const fundingRate = requiredOwnDataValue(
      recordDescriptors,
      'fundingRate',
      recordSubject,
      invalid
    );
    const rawJson = requiredOwnDataValue(
      recordDescriptors,
      'rawJson',
      recordSubject,
      invalid
    );
    const contentHash = requiredOwnDataValue(
      recordDescriptors,
      'contentHash',
      recordSubject,
      invalid
    );
    if (
      exchangeId !== lease.exchangeId
      || exchangeMarketId !== lease.exchangeMarketId
      || symbol !== lease.symbol
    ) {
      return sourceResponseInvalid(lease, 'record market identity mismatch');
    }
    if (!nonNegativeSafeInteger(fundingTimestampMs)) {
      return sourceResponseInvalid(lease, 'record timestamp must be a safe integer');
    }
    if (typeof rawJson !== 'string') {
      return sourceResponseInvalid(lease, 'record raw_json must be JSON text');
    }

    let raw: unknown;
    let normalized: SettledFundingRate;
    try {
      raw = JSON.parse(rawJson);
      normalized = settledFundingRate(
        lease,
        fundingRate,
        fundingTimestampMs,
        raw
      );
    } catch {
      return sourceResponseInvalid(lease, 'record normalization failed');
    }
    if (
      normalized.rawJson !== rawJson
      || normalized.contentHash !== contentHash
    ) {
      return sourceResponseInvalid(lease, 'record canonical content mismatch');
    }

    const existing = byTimestamp.get(normalized.fundingTimestampMs);
    if (existing !== undefined && !sameRecord(existing, normalized)) {
      return sourceResponseInvalid(lease, 'duplicate record content conflict');
    }
    byTimestamp.set(normalized.fundingTimestampMs, normalized);
  }
  return Object.freeze(
    [...byTimestamp.values()].sort(
      (left, right) => right.fundingTimestampMs - left.fundingTimestampMs
    )
  );
}

function fundingPage(
  value: unknown,
  lease: CoverageLease,
  pageSize: number
): FundingPageSnapshot {
  const invalid = pageInvalid(lease);
  const subject = 'response';
  const descriptors = ownDataDescriptors(value, 'object', subject, invalid);
  const cursorValue = requiredOwnDataValue(
    descriptors,
    'cursor',
    subject,
    invalid
  );
  const recordsValue = requiredOwnDataValue(
    descriptors,
    'records',
    subject,
    invalid
  );
  const nextCursorValue = requiredOwnDataValue(
    descriptors,
    'nextCursor',
    subject,
    invalid
  );
  const recoveryAnchorMs = requiredOwnDataValue(
    descriptors,
    'recoveryAnchorMs',
    subject,
    invalid
  );
  return Object.freeze({
    cursor: cursorSnapshot(cursorValue, lease, 'response cursor'),
    records: normalizedPageRecords(recordsValue, lease, pageSize),
    nextCursor: nextCursorValue === null
      ? null
      : cursorSnapshot(nextCursorValue, lease, 'response next cursor'),
    recoveryAnchorMs
  });
}

function validateBitgetPage(
  value: unknown,
  lease: BitgetLease,
  requestedPageNo: number,
  pageSize: number
): ValidatedBitgetPage {
  const page = fundingPage(value, lease, pageSize);
  const requestedCursor = {
    exchangeId: 'bitget',
    pageNo: requestedPageNo
  } as const;
  if (!sameCursor(page.cursor, requestedCursor)) {
    return sourceResponseInvalid(lease, 'response cursor does not match request');
  }
  const { records } = page;
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
  const page = fundingPage(value, lease, pageSize);
  const requestedCursor = {
    exchangeId: 'okx',
    afterMs: requestedAfterMs
  } as const;
  if (!sameCursor(page.cursor, requestedCursor)) {
    return sourceResponseInvalid(lease, 'response cursor does not match request');
  }
  const { records } = page;
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

function diagnosticPageRequest(
  lease: CoverageLease,
  cursor: FundingPageCursor
): FundingRequestMetadata {
  if (cursor.exchangeId === 'bitget') {
    return {
      method: 'GET',
      path: '/api/v2/mix/market/history-fund-rate',
      query: {
        symbol: lease.exchangeMarketId,
        productType: 'USDT-FUTURES',
        pageNo: cursor.pageNo,
        pageSize: 100
      },
      body: null
    };
  }
  return {
    method: 'GET',
    path: '/api/v5/public/funding-rate-history',
    query: cursor.afterMs === null
      ? {
          instId: lease.exchangeMarketId,
          limit: 400
        }
      : {
          instId: lease.exchangeMarketId,
          after: String(cursor.afterMs),
          limit: 400
        },
    body: null
  };
}

class CoveragePageTask implements FundingPageTask {
  readonly key: string;
  readonly category: 'backfill' | 'reconcile';
  private finished = false;
  private running = false;
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
    if (this.running) {
      throw new Error(`funding page task ${this.key} is already running`);
    }
    this.running = true;
    try {
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
          diagnosticPageRequest(this.lease, cursor),
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
    } finally {
      this.running = false;
    }
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
      ? Object.freeze({ exchangeId: 'bitget', pageNo: this.bitgetPageNo })
      : Object.freeze({ exchangeId: 'okx', afterMs: this.okxAfterMs });
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
    const snapshot = coverageLeaseSnapshot(lease);
    if (snapshot.exchangeId !== this.sourceExchangeId) {
      throw new Error(
        `funding source and coverage lease exchange identity mismatch: `
        + `expected ${this.sourceExchangeId}, actual ${snapshot.exchangeId}`
      );
    }
    if (!this.options.repository.isCoverageLeaseCurrent(snapshot)) {
      throw new StaleFundingTaskError();
    }
    return new CoveragePageTask(
      this.options.source,
      this.pageSize,
      this.options.repository,
      this.options.requestExecutor,
      this.events,
      this.options.now,
      snapshot
    );
  }
}
