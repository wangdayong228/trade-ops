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
    operation: () => Promise<Value>
  ): Promise<Value>;
}
