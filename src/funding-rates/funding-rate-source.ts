import type {
  FundingExchangeId,
  FundingMarketIdentity,
  FundingMarketObservation,
  SettledFundingRate
} from './funding-rate-record.js';

export type FundingPageCursor =
  | { readonly exchangeId: 'bitget'; readonly pageNo: number }
  | { readonly exchangeId: 'okx'; readonly afterMs: number | null };

export interface FundingRequestMetadata {
  readonly method: 'GET';
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
  readonly body: null;
}

export interface FundingRatePage {
  readonly cursor: FundingPageCursor;
  readonly records: readonly SettledFundingRate[];
  readonly nextCursor: FundingPageCursor | null;
  readonly recoveryAnchorMs: number | null;
}

export interface FundingRequestRetryNotice {
  readonly retryAttempt: number;
  readonly retryDelayMs: number;
  readonly error: unknown;
}

export type FundingRequestRetryObserver = (
  notice: FundingRequestRetryNotice
) => void;

export class FundingRequestCanceledError extends Error {
  readonly name = 'FundingRequestCanceledError';

  constructor() {
    super('funding request canceled');
  }
}

export class FundingRequestRetryExhaustedError extends Error {
  readonly name = 'FundingRequestRetryExhaustedError';

  constructor() {
    super('funding request retries exhausted');
  }
}

export interface FundingRateSource {
  readonly exchangeId: FundingExchangeId;
  readonly pageSize: 100 | 400;
  readonly minimumRequestSpacingMs: 100 | 250;
  discoveryRequest(): FundingRequestMetadata;
  discoverMarkets(): Promise<readonly FundingMarketObservation[]>;
  pageRequest(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): FundingRequestMetadata;
  fetchPage(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): Promise<FundingRatePage>;
}

export interface FundingRequestExecutor {
  execute<Value>(
    request: FundingRequestMetadata,
    operation: () => Promise<Value>,
    onRetry: FundingRequestRetryObserver
  ): Promise<Value>;
}
