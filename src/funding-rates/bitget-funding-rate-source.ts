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
  sourceArrayItems,
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

interface BitgetDiscoveryParams {
  readonly productType: 'USDT-FUTURES';
}

interface BitgetHistoryParams extends BitgetDiscoveryParams {
  readonly symbol: string;
  readonly pageNo: number;
  readonly pageSize: 100;
}

interface BitgetFundingRateClient extends FundingCurrencyCodeClient {
  publicMixGetV2MixMarketContracts(
    params: BitgetDiscoveryParams
  ): Promise<unknown>;
  publicMixGetV2MixMarketHistoryFundRate(
    params: BitgetHistoryParams
  ): Promise<unknown>;
}

const BITGET_INACTIVE_STATUSES = new Set([
  'listed',
  'maintain',
  'limit_open',
  'restrictedAPI',
  'off'
]);

function bitgetActiveStatus(value: unknown, field: string): boolean {
  const status = strictSourceString('Bitget', value, field);
  if (status === 'normal') {
    return true;
  }
  if (BITGET_INACTIVE_STATUSES.has(status)) {
    return false;
  }
  return invalidSourceValue(
    'Bitget',
    field,
    'normal or a documented inactive symbolStatus',
    status
  );
}

function bitgetCandidate(
  client: BitgetFundingRateClient,
  record: object,
  index: number
): FundingDiscoveryCandidate {
  const prefix = `discovery.data[${index}]`;
  const exchangeMarketId = strictSourceString(
    'Bitget',
    ownSourceValue('Bitget', record, 'symbol', `${prefix}.symbol`),
    `${prefix}.symbol`
  );
  const baseId = strictSourceString(
    'Bitget',
    ownSourceValue('Bitget', record, 'baseCoin', `${prefix}.baseCoin`),
    `${prefix}.baseCoin`
  );
  const quoteId = strictSourceString(
    'Bitget',
    ownSourceValue('Bitget', record, 'quoteCoin', `${prefix}.quoteCoin`),
    `${prefix}.quoteCoin`
  );
  const supportMarginCoins = sourceArrayItems(
    'Bitget',
    ownSourceValue(
      'Bitget',
      record,
      'supportMarginCoins',
      `${prefix}.supportMarginCoins`
    ),
    `${prefix}.supportMarginCoins`
  ).map((currencyId, supportIndex) => strictSourceString(
    'Bitget',
    currencyId,
    `${prefix}.supportMarginCoins[${supportIndex}]`
  ));
  if (supportMarginCoins.length === 0) {
    return invalidSourceValue(
      'Bitget',
      `${prefix}.supportMarginCoins`,
      'a non-empty settlement currency list',
      supportMarginCoins
    );
  }

  const firstSettleId = supportMarginCoins[0];
  if (firstSettleId === undefined) {
    return invalidSourceValue(
      'Bitget',
      `${prefix}.supportMarginCoins`,
      'a first settlement currency',
      firstSettleId
    );
  }
  const settleId = supportMarginCoins.includes(baseId)
    ? baseId
    : supportMarginCoins.includes(quoteId)
      ? quoteId
      : firstSettleId;

  const symbolType = strictSourceString(
    'Bitget',
    ownSourceValue('Bitget', record, 'symbolType', `${prefix}.symbolType`),
    `${prefix}.symbolType`
  );
  const active = bitgetActiveStatus(
    ownSourceValue('Bitget', record, 'symbolStatus', `${prefix}.symbolStatus`),
    `${prefix}.symbolStatus`
  );
  const base = normalizedCurrencyCode(
    'Bitget',
    client,
    baseId,
    `${prefix}.base`
  );
  const quote = normalizedCurrencyCode(
    'Bitget',
    client,
    quoteId,
    `${prefix}.quote`
  );
  const settle = normalizedCurrencyCode(
    'Bitget',
    client,
    settleId,
    `${prefix}.settle`
  );

  if (
    symbolType !== 'perpetual'
    || quote !== 'USDT'
    || settle !== 'USDT'
    || base === settle
  ) {
    return { exchangeMarketId, observation: null };
  }

  return {
    exchangeMarketId,
    observation: {
      exchangeId: 'bitget',
      exchangeMarketId,
      symbol: `${base}/${quote}:${settle}`,
      active
    }
  };
}

function bitgetPageNo(cursor: FundingPageCursor): number {
  if (cursor.exchangeId !== 'bitget') {
    return invalidSourceValue(
      'Bitget',
      'cursor.exchangeId',
      'bitget',
      cursor.exchangeId
    );
  }
  if (!Number.isSafeInteger(cursor.pageNo) || cursor.pageNo <= 0) {
    return invalidSourceValue(
      'Bitget',
      'cursor.pageNo',
      'a positive safe integer',
      cursor.pageNo
    );
  }
  return cursor.pageNo;
}

function bitgetHistoryParams(
  market: FundingMarketIdentity,
  cursor: FundingPageCursor
): BitgetHistoryParams {
  requireFundingMarketIdentity('Bitget', 'bitget', market);
  return {
    symbol: market.exchangeMarketId,
    productType: 'USDT-FUTURES',
    pageNo: bitgetPageNo(cursor),
    pageSize: 100
  };
}

function bitgetHistoryRecord(
  market: FundingMarketIdentity,
  record: object,
  index: number
): SettledFundingRate {
  const prefix = `history.data[${index}]`;
  const marketId = strictSourceString(
    'Bitget',
    ownSourceValue('Bitget', record, 'symbol', `${prefix}.symbol`),
    `${prefix}.symbol`
  );
  if (marketId !== market.exchangeMarketId) {
    return invalidSourceValue(
      'Bitget',
      `${prefix}.symbol market identity`,
      market.exchangeMarketId,
      marketId
    );
  }
  return sourceSettledFundingRate(
    'Bitget',
    market,
    ownSourceValue('Bitget', record, 'fundingRate', `${prefix}.fundingRate`),
    ownSourceValue('Bitget', record, 'fundingTime', `${prefix}.fundingTime`),
    record
  );
}

export class BitgetFundingRateSource implements FundingRateSource {
  readonly exchangeId = 'bitget';
  readonly pageSize = 100;
  readonly minimumRequestSpacingMs = 100;

  constructor(private readonly client: BitgetFundingRateClient) {}

  discoveryRequest(): FundingRequestMetadata {
    return {
      method: 'GET',
      path: '/api/v2/mix/market/contracts',
      query: { productType: 'USDT-FUTURES' },
      body: null
    };
  }

  async discoverMarkets(): Promise<readonly FundingMarketObservation[]> {
    const response = await this.client.publicMixGetV2MixMarketContracts({
      productType: 'USDT-FUTURES'
    });
    const records = fundingResponseRecords('Bitget', response, {
      successCode: '00000',
      requireRequestTime: true,
      maximumRecords: null,
      context: 'discovery'
    });
    return completeFundingMarketDiscovery(
      'Bitget',
      records.map((record, index) => bitgetCandidate(this.client, record, index))
    );
  }

  pageRequest(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): FundingRequestMetadata {
    const params = bitgetHistoryParams(market, cursor);
    return {
      method: 'GET',
      path: '/api/v2/mix/market/history-fund-rate',
      query: { ...params },
      body: null
    };
  }

  async fetchPage(
    market: FundingMarketIdentity,
    cursor: FundingPageCursor
  ): Promise<FundingRatePage> {
    const params = bitgetHistoryParams(market, cursor);
    const response = await this.client.publicMixGetV2MixMarketHistoryFundRate(params);
    const rawRecords = fundingResponseRecords('Bitget', response, {
      successCode: '00000',
      requireRequestTime: true,
      maximumRecords: this.pageSize,
      context: 'history'
    });
    const records = uniqueSettledPageRecords(
      'Bitget',
      rawRecords.map((record, index) => bitgetHistoryRecord(market, record, index))
    );

    if (records.length === 0) {
      return {
        cursor,
        records,
        nextCursor: null,
        recoveryAnchorMs: null
      };
    }
    if (params.pageNo === Number.MAX_SAFE_INTEGER) {
      return invalidSourceValue(
        'Bitget',
        'history pageNo overflow',
        'a page number that can be safely incremented',
        params.pageNo
      );
    }
    return {
      cursor,
      records,
      nextCursor: { exchangeId: 'bitget', pageNo: params.pageNo + 1 },
      recoveryAnchorMs: null
    };
  }
}
