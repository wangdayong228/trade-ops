import type {
  FundingExchangeId,
  FundingMarketIdentity,
  FundingMarketObservation,
  SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import type {
  FundingPageCursor,
  FundingRatePage,
  FundingRateSource,
  FundingRequestExecutor,
  FundingRequestMetadata
} from '../../src/funding-rates/funding-rate-source.js';

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: Deferred<Value>['resolve'];
  let reject!: Deferred<Value>['reject'];
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class FakeAsyncGate {
  readonly entered: Promise<void>;
  readonly #entered: Deferred<void>;
  readonly #released: Deferred<void>;

  constructor() {
    this.#entered = deferred<void>();
    this.#released = deferred<void>();
    this.entered = this.#entered.promise;
  }

  async wait(): Promise<void> {
    this.#entered.resolve();
    await this.#released.promise;
  }

  release(): void {
    this.#released.resolve();
  }

  reject(error: unknown): void {
    this.#released.reject(error);
  }
}

export interface FakeFundingPageStep {
  readonly marketId: string;
  readonly cursor: FundingPageCursor;
  readonly page?: FundingRatePage;
  readonly pageRequestError?: unknown;
  readonly responseError?: unknown;
  readonly responseGate?: FakeAsyncGate;
  readonly parseError?: unknown;
  readonly parseGate?: FakeAsyncGate;
}

export interface FakeFundingDiscoveryStep {
  readonly observations?: readonly FundingMarketObservation[];
  readonly requestError?: unknown;
  readonly responseError?: unknown;
  readonly gate?: FakeAsyncGate;
}

export interface FakeFundingOperationCall {
  readonly kind: 'discovery' | 'page';
  readonly marketId: string | null;
  readonly startedAtMs: number | null;
}

export interface FakeFundingFetchCall {
  readonly market: FundingMarketIdentity;
  readonly cursor: FundingPageCursor;
}

function cursorText(cursor: FundingPageCursor): string {
  return cursor.exchangeId === 'bitget'
    ? `bitget:${cursor.pageNo}`
    : `okx:${cursor.afterMs === null ? 'null' : cursor.afterMs}`;
}

function sameCursor(left: FundingPageCursor, right: FundingPageCursor): boolean {
  return left.exchangeId === right.exchangeId
    && (left.exchangeId === 'bitget'
      ? right.exchangeId === 'bitget' && left.pageNo === right.pageNo
      : right.exchangeId === 'okx' && left.afterMs === right.afterMs);
}

function bitgetRequest(
  market: FundingMarketIdentity,
  pageNo: number
): FundingRequestMetadata {
  return {
    method: 'GET',
    path: '/api/v2/mix/market/history-fund-rate',
    query: {
      symbol: market.exchangeMarketId,
      productType: 'USDT-FUTURES',
      pageNo,
      pageSize: 100
    },
    body: null
  };
}

function okxRequest(
  market: FundingMarketIdentity,
  afterMs: number | null
): FundingRequestMetadata {
  return {
    method: 'GET',
    path: '/api/v5/public/funding-rate-history',
    query: {
      instId: market.exchangeMarketId,
      ...(afterMs === null ? {} : { after: String(afterMs) }),
      limit: 400
    },
    body: null
  };
}

export class FakeFundingRateSource implements FundingRateSource {
  readonly pageSize: 100 | 400;
  readonly minimumRequestSpacingMs: 100 | 250;
  readonly pageRequestCalls: FakeFundingFetchCall[] = [];
  readonly fetchCalls: FakeFundingFetchCall[] = [];
  readonly discoveryRequestCalls: FundingRequestMetadata[] = [];
  readonly discoveryCalls: FakeFundingOperationCall[] = [];
  readonly operationCalls: FakeFundingOperationCall[] = [];
  maximumConcurrentOperations = 0;
  readonly #steps: readonly FakeFundingPageStep[];
  readonly #discoverySteps: readonly FakeFundingDiscoveryStep[];
  readonly #trace: string[];
  readonly #nowMs: (() => number) | undefined;
  #nextStep = 0;
  #nextDiscoveryStep = 0;
  #activeOperations = 0;

  constructor(
    readonly exchangeId: FundingExchangeId,
    steps: readonly FakeFundingPageStep[],
    trace: string[] = [],
    discoverySteps: readonly FakeFundingDiscoveryStep[] = [],
    nowMs?: () => number
  ) {
    this.pageSize = exchangeId === 'bitget' ? 100 : 400;
    this.minimumRequestSpacingMs = exchangeId === 'bitget' ? 100 : 250;
    this.#steps = steps;
    this.#discoverySteps = discoverySteps;
    this.#trace = trace;
    this.#nowMs = nowMs;
  }

  discoveryRequest(): FundingRequestMetadata {
    const step = this.#discoverySteps[this.#nextDiscoveryStep];
    if (step === undefined) {
      throw new Error('unexpected discovery request in market sync test');
    }
    if (step.requestError !== undefined) {
      throw step.requestError;
    }
    const request: FundingRequestMetadata = this.exchangeId === 'bitget'
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
    this.discoveryRequestCalls.push(request);
    this.#trace.push(`discoveryRequest:${this.exchangeId}`);
    return request;
  }

  async discoverMarkets(): Promise<readonly FundingMarketObservation[]> {
    const step = this.#discoverySteps[this.#nextDiscoveryStep];
    if (step === undefined) {
      throw new Error('unexpected discovery fetch in market sync test');
    }
    this.#nextDiscoveryStep += 1;
    const call: FakeFundingOperationCall = {
      kind: 'discovery',
      marketId: null,
      startedAtMs: this.#nowMs?.() ?? null
    };
    this.discoveryCalls.push(call);
    this.operationCalls.push(call);
    this.#trace.push(`discover:${this.exchangeId}`);
    this.#activeOperations += 1;
    this.maximumConcurrentOperations = Math.max(
      this.maximumConcurrentOperations,
      this.#activeOperations
    );
    try {
      if (step.gate !== undefined) {
        await step.gate.wait();
      }
      if (step.responseError !== undefined) {
        throw step.responseError;
      }
      if (step.observations === undefined) {
        throw new Error('fake funding discovery step has no observations or error');
      }
      return step.observations;
    } finally {
      this.#activeOperations -= 1;
    }
  }

  pageRequest(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): FundingRequestMetadata {
    const call = { market: { ...market }, cursor: { ...cursor } };
    this.pageRequestCalls.push(call);
    this.#trace.push(`pageRequest:${market.exchangeMarketId}:${cursorText(cursor)}`);
    const step = this.#steps[this.#nextStep];
    if (step?.pageRequestError !== undefined) {
      throw step.pageRequestError;
    }
    return cursor.exchangeId === 'bitget'
      ? bitgetRequest(market, cursor.pageNo)
      : okxRequest(market, cursor.afterMs);
  }

  async fetchPage(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): Promise<FundingRatePage> {
    const step = this.#steps[this.#nextStep];
    if (step === undefined) {
      throw new Error(
        `unexpected fake funding page request for ${market.exchangeMarketId} ${cursorText(cursor)}`
      );
    }
    this.#nextStep += 1;
    const call = { market: { ...market }, cursor: { ...cursor } };
    this.fetchCalls.push(call);
    const operationCall: FakeFundingOperationCall = {
      kind: 'page',
      marketId: market.exchangeMarketId,
      startedAtMs: this.#nowMs?.() ?? null
    };
    this.operationCalls.push(operationCall);
    this.#trace.push(`fetch:${market.exchangeMarketId}:${cursorText(cursor)}`);
    if (step.marketId !== market.exchangeMarketId || !sameCursor(step.cursor, cursor)) {
      throw new Error(
        `unexpected fake funding cursor for ${market.exchangeMarketId}: ${cursorText(cursor)}`
      );
    }
    this.#activeOperations += 1;
    this.maximumConcurrentOperations = Math.max(
      this.maximumConcurrentOperations,
      this.#activeOperations
    );
    try {
      if (step.responseGate !== undefined) {
        await step.responseGate.wait();
      }
      if (step.responseError !== undefined) {
        throw step.responseError;
      }
      this.#trace.push(`parse:${market.exchangeMarketId}:${cursorText(cursor)}`);
      if (step.parseGate !== undefined) {
        await step.parseGate.wait();
      }
      if (step.parseError !== undefined) {
        throw step.parseError;
      }
      if (step.page === undefined) {
        throw new Error('fake funding page step has no page or error');
      }
      return step.page;
    } finally {
      this.#activeOperations -= 1;
    }
  }
}

export interface FakeExecutorStep {
  readonly gate?: FakeAsyncGate;
  readonly error?: unknown;
  readonly onExecute?: () => void;
  readonly retryNotices?: readonly FakeFundingRequestRetryNotice[];
}

export interface FakeFundingRequestRetryNotice {
  readonly retryAttempt: number;
  readonly retryDelayMs: number;
  readonly error: unknown;
}

export type FakeFundingRequestRetryObserver = (
  notice: FakeFundingRequestRetryNotice
) => void;

export class FakeFundingRequestExecutor implements FundingRequestExecutor {
  readonly calls: FundingRequestMetadata[] = [];
  readonly retryObserverCalls: Array<
    FakeFundingRequestRetryObserver | undefined
  > = [];
  readonly #steps: readonly FakeExecutorStep[];
  readonly #trace: string[];

  constructor(
    steps: readonly FakeExecutorStep[] = [],
    trace: string[] = []
  ) {
    this.#steps = steps;
    this.#trace = trace;
  }

  async execute<Value>(
    request: FundingRequestMetadata,
    operation: () => Promise<Value>,
    onRetry?: FakeFundingRequestRetryObserver
  ): Promise<Value> {
    const index = this.calls.length;
    this.calls.push(request);
    this.retryObserverCalls.push(onRetry);
    this.#trace.push(`execute:${request.path}`);
    const step = this.#steps[index];
    step?.onExecute?.();
    for (const notice of step?.retryNotices ?? []) {
      if (onRetry === undefined) {
        throw new Error('funding request retry observer is required');
      }
      this.#trace.push(
        `retry:${request.path}:${notice.retryAttempt}:${notice.retryDelayMs}`
      );
      onRetry(notice);
    }
    if (step?.gate !== undefined) {
      await step.gate.wait();
    }
    if (step?.error !== undefined) {
      throw step.error;
    }
    return await operation();
  }
}

export function fakeBitgetPage(
  pageNo: number,
  records: readonly SettledFundingRate[]
): FundingRatePage {
  return {
    cursor: { exchangeId: 'bitget', pageNo },
    records,
    nextCursor: records.length === 0
      ? null
      : { exchangeId: 'bitget', pageNo: pageNo + 1 },
    recoveryAnchorMs: null
  };
}

export function fakeOkxPage(
  afterMs: number | null,
  records: readonly SettledFundingRate[]
): FundingRatePage {
  const timestamps = records.map(({ fundingTimestampMs }) => fundingTimestampMs);
  return {
    cursor: { exchangeId: 'okx', afterMs },
    records,
    nextCursor: timestamps.length === 0
      ? null
      : { exchangeId: 'okx', afterMs: Math.min(...timestamps) },
    recoveryAnchorMs: timestamps.length === 0 ? null : Math.max(...timestamps)
  };
}
