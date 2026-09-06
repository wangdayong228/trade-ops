import type {
  FundingMarketIdentity,
  FundingMarketObservation,
  SettledFundingRate
} from './funding-rate-record.js';
import {
  completeFundingMarketDiscovery,
  fundingResponseRecords,
  invalidSourceValue,
  normalizedCurrencyCode,
  ownSourceValue,
  requireFundingMarketIdentity,
  sourceSettledFundingRate,
  strictSourceString,
  uniqueSettledPageRecords
} from './funding-market-discovery.js';
import type {
  FundingCurrencyCodeClient,
  FundingDiscoveryCandidate
} from './funding-market-discovery.js';
import type {
  FundingPageCursor,
  FundingRatePage,
  FundingRateSource,
  FundingRequestMetadata
} from './funding-rate-source.js';

interface OkxDiscoveryParams {
  readonly instType: 'SWAP';
}

type OkxHistoryParams =
  | {
      readonly instId: string;
      readonly limit: 400;
    }
  | {
      readonly instId: string;
      readonly after: string;
      readonly limit: 400;
    };

interface OkxFundingRateClient extends FundingCurrencyCodeClient {
  publicGetPublicInstruments(params: OkxDiscoveryParams): Promise<unknown>;
  publicGetPublicFundingRateHistory(params: OkxHistoryParams): Promise<unknown>;
}

const OKX_INACTIVE_STATES = new Set([
  'suspend',
  'rebase',
  'post_only',
  'preopen',
  'test'
]);

function okxActiveState(value: unknown, field: string): boolean {
  const state = strictSourceString('OKX', value, field);
  if (state === 'live') {
    return true;
  }
  if (OKX_INACTIVE_STATES.has(state)) {
    return false;
  }
  return invalidSourceValue(
    'OKX',
    field,
    'live or a documented inactive state',
    state
  );
}

function okxUnderlyingCodes(value: unknown, field: string): readonly [string, string] {
  const underlying = strictSourceString('OKX', value, field);
  const parts = underlying.split('-');
  if (parts.length !== 2) {
    return invalidSourceValue(
      'OKX',
      field,
      'exactly two currency IDs separated by one hyphen',
      underlying
    );
  }
  const baseId = parts[0];
  const quoteId = parts[1];
  if (baseId === undefined || quoteId === undefined) {
    return invalidSourceValue(
      'OKX',
      field,
      'both underlying currency IDs',
      underlying
    );
  }
  return [
    strictSourceString('OKX', baseId, `${field}.base`),
    strictSourceString('OKX', quoteId, `${field}.quote`)
  ];
}

function okxCandidate(
  client: OkxFundingRateClient,
  record: object,
  index: number
): FundingDiscoveryCandidate {
  const prefix = `discovery.data[${index}]`;
  const exchangeMarketId = strictSourceString(
    'OKX',
    ownSourceValue('OKX', record, 'instId', `${prefix}.instId`),
    `${prefix}.instId`
  );
  const [baseId, quoteId] = okxUnderlyingCodes(
    ownSourceValue('OKX', record, 'uly', `${prefix}.uly`),
    `${prefix}.uly`
  );
  const settleId = strictSourceString(
    'OKX',
    ownSourceValue('OKX', record, 'settleCcy', `${prefix}.settleCcy`),
    `${prefix}.settleCcy`
  );
  const instType = strictSourceString(
    'OKX',
    ownSourceValue('OKX', record, 'instType', `${prefix}.instType`),
    `${prefix}.instType`
  );
  const contractType = strictSourceString(
    'OKX',
    ownSourceValue('OKX', record, 'ctType', `${prefix}.ctType`),
    `${prefix}.ctType`
  );
  const active = okxActiveState(
    ownSourceValue('OKX', record, 'state', `${prefix}.state`),
    `${prefix}.state`
  );
  const base = normalizedCurrencyCode('OKX', client, baseId, `${prefix}.base`);
  const sharedQuoteAndSettle = quoteId === settleId;
  const quote = normalizedCurrencyCode(
    'OKX',
    client,
    quoteId,
    sharedQuoteAndSettle ? `${prefix}.quote/settle` : `${prefix}.quote`
  );
  const settle = sharedQuoteAndSettle
    ? quote
    : normalizedCurrencyCode('OKX', client, settleId, `${prefix}.settle`);

  if (
    instType !== 'SWAP'
    || contractType !== 'linear'
    || quoteId !== settleId
    || baseId === settleId
    || quote !== 'USDT'
    || settle !== 'USDT'
    || base === settle
  ) {
    return { exchangeMarketId, observation: null };
  }

  return {
    exchangeMarketId,
    observation: {
      exchangeId: 'okx',
      exchangeMarketId,
      symbol: `${base}/${quote}:${settle}`,
      active
    }
  };
}

function okxAfterMs(cursor: FundingPageCursor): number | null {
  if (cursor.exchangeId !== 'okx') {
    return invalidSourceValue(
      'OKX',
      'cursor.exchangeId',
      'okx',
      cursor.exchangeId
    );
  }
  if (
    cursor.afterMs !== null
    && (!Number.isSafeInteger(cursor.afterMs) || cursor.afterMs < 0)
  ) {
    return invalidSourceValue(
      'OKX',
      'cursor.afterMs',
      'null or a non-negative safe integer',
      cursor.afterMs
    );
  }
  return cursor.afterMs;
}

function okxHistoryParams(
  market: FundingMarketIdentity,
  cursor: FundingPageCursor
): OkxHistoryParams {
  requireFundingMarketIdentity('OKX', 'okx', market);
  const afterMs = okxAfterMs(cursor);
  if (afterMs === null) {
    return { instId: market.exchangeMarketId, limit: 400 };
  }
  return {
    instId: market.exchangeMarketId,
    after: String(afterMs),
    limit: 400
  };
}

function okxHistoryRecord(
  market: FundingMarketIdentity,
  record: object,
  index: number
): SettledFundingRate {
  const prefix = `history.data[${index}]`;
  const instType = strictSourceString(
    'OKX',
    ownSourceValue('OKX', record, 'instType', `${prefix}.instType`),
    `${prefix}.instType`
  );
  if (instType !== 'SWAP') {
    return invalidSourceValue('OKX', `${prefix}.instType`, 'SWAP', instType);
  }
  const marketId = strictSourceString(
    'OKX',
    ownSourceValue('OKX', record, 'instId', `${prefix}.instId`),
    `${prefix}.instId`
  );
  if (marketId !== market.exchangeMarketId) {
    return invalidSourceValue(
      'OKX',
      `${prefix}.instId market identity`,
      market.exchangeMarketId,
      marketId
    );
  }
  return sourceSettledFundingRate(
    'OKX',
    market,
    ownSourceValue('OKX', record, 'realizedRate', `${prefix}.realizedRate`),
    ownSourceValue('OKX', record, 'fundingTime', `${prefix}.fundingTime`),
    record
  );
}

export class OkxFundingRateSource implements FundingRateSource {
  readonly exchangeId = 'okx';
  readonly pageSize = 400;
  readonly minimumRequestSpacingMs = 250;

  constructor(private readonly client: OkxFundingRateClient) {}

  discoveryRequest(): FundingRequestMetadata {
    return {
      method: 'GET',
      path: '/api/v5/public/instruments',
      query: { instType: 'SWAP' },
      body: null
    };
  }

  async discoverMarkets(): Promise<readonly FundingMarketObservation[]> {
    const response = await this.client.publicGetPublicInstruments({
      instType: 'SWAP'
    });
    const records = fundingResponseRecords('OKX', response, {
      successCode: '0',
      requireRequestTime: false,
      maximumRecords: null,
      context: 'discovery'
    });
    return completeFundingMarketDiscovery(
      'OKX',
      records.map((record, index) => okxCandidate(this.client, record, index))
    );
  }

  pageRequest(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): FundingRequestMetadata {
    const params = okxHistoryParams(market, cursor);
    return {
      method: 'GET',
      path: '/api/v5/public/funding-rate-history',
      query: params,
      body: null
    };
  }

  async fetchPage(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): Promise<FundingRatePage> {
    const params = okxHistoryParams(market, cursor);
    const response = await this.client.publicGetPublicFundingRateHistory(params);
    const rawRecords = fundingResponseRecords('OKX', response, {
      successCode: '0',
      requireRequestTime: false,
      maximumRecords: this.pageSize,
      context: 'history'
    });
    const records = uniqueSettledPageRecords(
      'OKX',
      rawRecords.map((record, index) => okxHistoryRecord(market, record, index))
    );
    const afterMs = okxAfterMs(cursor);
    if (
      afterMs !== null
      && records.some((record) => record.fundingTimestampMs >= afterMs)
    ) {
      return invalidSourceValue(
        'OKX',
        'history fundingTime cursor relation',
        `every timestamp to be strictly less than after ${afterMs}`,
        records.find((record) => record.fundingTimestampMs >= afterMs)
          ?.fundingTimestampMs
      );
    }

    const newest = records[0];
    const oldest = records[records.length - 1];
    if (newest === undefined || oldest === undefined) {
      return {
        cursor,
        records,
        nextCursor: null,
        recoveryAnchorMs: null
      };
    }
    return {
      cursor,
      records,
      nextCursor: {
        exchangeId: 'okx',
        afterMs: oldest.fundingTimestampMs
      },
      recoveryAnchorMs: newest.fundingTimestampMs
    };
  }
}
