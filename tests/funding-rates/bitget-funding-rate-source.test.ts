/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { BitgetFundingRateSource } from '../../src/funding-rates/bitget-funding-rate-source.js';
import type {
  FundingMarketIdentity,
  SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import type { FundingPageCursor } from '../../src/funding-rates/funding-rate-source.js';

interface BitgetHistoryRecord {
  readonly symbol: unknown;
  readonly fundingRate: unknown;
  readonly fundingTime: unknown;
}

class FakeBitgetClient {
  readonly discoveryCalls: unknown[] = [];
  readonly historyCalls: unknown[] = [];
  readonly forbiddenCalls: string[] = [];

  constructor(public historyResponse: unknown) {}

  safeCurrencyCode(currencyId?: string): unknown {
    return currencyId;
  }

  async publicMixGetV2MixMarketContracts(params?: object): Promise<unknown> {
    this.discoveryCalls.push(params);
    return {
      code: '00000',
      msg: 'success',
      requestTime: 1_788_595_200_000,
      data: []
    };
  }

  async publicMixGetV2MixMarketHistoryFundRate(params?: object): Promise<unknown> {
    this.historyCalls.push(params);
    return this.historyResponse;
  }

  get markets(): never {
    this.forbiddenCalls.push('markets');
    throw new Error('market cache must not be read');
  }

  async loadMarkets(): Promise<never> {
    return await this.forbidden('loadMarkets');
  }

  async fetchMarkets(): Promise<never> {
    return await this.forbidden('fetchMarkets');
  }

  async fetchCurrencies(): Promise<never> {
    return await this.forbidden('fetchCurrencies');
  }

  async fetchFundingRateHistory(): Promise<never> {
    return await this.forbidden('fetchFundingRateHistory');
  }

  private async forbidden(name: string): Promise<never> {
    this.forbiddenCalls.push(name);
    throw new Error(`${name} must not be called`);
  }
}

const market: FundingMarketIdentity = {
  exchangeId: 'bitget',
  exchangeMarketId: 'BTCUSDT',
  symbol: 'BTC/USDT:USDT'
};

function historyRecord(
  overrides: Partial<BitgetHistoryRecord> = {}
): BitgetHistoryRecord {
  return {
    symbol: 'BTCUSDT',
    fundingRate: '-0.0003',
    fundingTime: '1700000000000',
    ...overrides
  };
}

function historyEnvelope(data: readonly unknown[]): object {
  return {
    code: '00000',
    msg: 'success',
    requestTime: 1_788_595_200_000,
    data
  };
}

function sourceFor(response: unknown): {
  readonly client: FakeBitgetClient;
  readonly source: BitgetFundingRateSource;
} {
  const client = new FakeBitgetClient(response);
  return {
    client,
    source: new BitgetFundingRateSource(client)
  };
}

async function rejectsWithLocation(
  field: RegExp,
  operation: () => Promise<unknown>
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Bitget/i);
    assert.match(error.message, field);
    return true;
  });
}

test('uses the fixed Bitget Classic V2 request and preserves raw decimal strings', async () => {
  const { client, source } = sourceFor(historyEnvelope([
    historyRecord({ fundingRate: '0', fundingTime: '1699999999999' }),
    historyRecord({
      fundingRate: '1.2300000000000000000000000000000000000001e-1234',
      fundingTime: '1700000000001'
    }),
    historyRecord({ fundingRate: '-0.0003', fundingTime: '1700000000000' })
  ]));
  const cursor = { exchangeId: 'bitget', pageNo: 1 } as const;

  assert.equal(source.exchangeId, 'bitget');
  assert.equal(source.pageSize, 100);
  assert.equal(source.minimumRequestSpacingMs, 100);
  assert.deepEqual(source.pageRequest(market, cursor), {
    method: 'GET',
    path: '/api/v2/mix/market/history-fund-rate',
    query: {
      symbol: 'BTCUSDT',
      productType: 'USDT-FUTURES',
      pageNo: 1,
      pageSize: 100
    },
    body: null
  });

  const page = await source.fetchPage(market, cursor);

  assert.deepEqual(client.historyCalls, [{
    symbol: 'BTCUSDT',
    productType: 'USDT-FUTURES',
    pageNo: 1,
    pageSize: 100
  }]);
  assert.deepEqual(page.cursor, cursor);
  assert.deepEqual(
    page.records.map((record: SettledFundingRate) => [
      record.fundingTimestampMs,
      record.fundingRate
    ]),
    [
      [1_700_000_000_001, '1.2300000000000000000000000000000000000001e-1234'],
      [1_700_000_000_000, '-0.0003'],
      [1_699_999_999_999, '0']
    ]
  );
  assert.ok(page.records.every((record: SettledFundingRate) =>
    record.exchangeMarketId === market.exchangeMarketId
    && record.symbol === market.symbol));
  assert.deepEqual(page.nextCursor, { exchangeId: 'bitget', pageNo: 2 });
  assert.equal(page.recoveryAnchorMs, null);
  assert.equal(client.discoveryCalls.length, 0);
  assert.deepEqual(client.forbiddenCalls, []);
});

test('only an explicit Bitget empty page terminates pagination', async () => {
  const fullTail = Array.from({ length: 100 }, (_, index) => historyRecord({
    fundingTime: String(1_700_000_000_000 - index)
  }));
  const fullPage = sourceFor(historyEnvelope(fullTail));
  assert.deepEqual(
    (await fullPage.source.fetchPage(market, {
      exchangeId: 'bitget',
      pageNo: 7
    })).nextCursor,
    { exchangeId: 'bitget', pageNo: 8 }
  );

  const shortPage = sourceFor(historyEnvelope([historyRecord()]));
  assert.deepEqual(
    (await shortPage.source.fetchPage(market, {
      exchangeId: 'bitget',
      pageNo: 8
    })).nextCursor,
    { exchangeId: 'bitget', pageNo: 9 }
  );

  const emptyPage = sourceFor(historyEnvelope([]));
  const empty = await emptyPage.source.fetchPage(market, {
    exchangeId: 'bitget',
    pageNo: 9
  });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.recoveryAnchorMs, null);
});

test('Bitget page numbers are positive safe integers and cannot overflow', async () => {
  const invalidCursors: readonly FundingPageCursor[] = [
    { exchangeId: 'bitget', pageNo: 0 },
    { exchangeId: 'bitget', pageNo: -1 },
    { exchangeId: 'bitget', pageNo: 1.5 },
    { exchangeId: 'bitget', pageNo: Number.MAX_SAFE_INTEGER + 1 },
    { exchangeId: 'okx', afterMs: null }
  ];

  for (const cursor of invalidCursors) {
    const { client, source } = sourceFor(historyEnvelope([]));
    await rejectsWithLocation(/cursor|pageNo|exchange/i, () =>
      source.fetchPage(market, cursor));
    assert.equal(client.historyCalls.length, 0);
  }

  const lastSafe = sourceFor(historyEnvelope([historyRecord()]));
  await rejectsWithLocation(/pageNo|overflow|safe/i, () => lastSafe.source.fetchPage(
    market,
    { exchangeId: 'bitget', pageNo: Number.MAX_SAFE_INTEGER }
  ));
  assert.equal(lastSafe.client.historyCalls.length, 1);

  const penultimate = sourceFor(historyEnvelope([historyRecord()]));
  assert.deepEqual(
    (await penultimate.source.fetchPage(market, {
      exchangeId: 'bitget',
      pageNo: Number.MAX_SAFE_INTEGER - 1
    })).nextCursor,
    { exchangeId: 'bitget', pageNo: Number.MAX_SAFE_INTEGER }
  );
});

test('Bitget rejects wrong market identity before issuing a public request', async () => {
  const invalidMarkets: readonly FundingMarketIdentity[] = [
    { ...market, exchangeId: 'okx' },
    { ...market, exchangeMarketId: '' },
    { ...market, exchangeMarketId: ' BTCUSDT' },
    { ...market, symbol: '' },
    { ...market, symbol: 'BTC/USDT:USDT ' }
  ];

  for (const invalidMarket of invalidMarkets) {
    const { client, source } = sourceFor(historyEnvelope([]));
    await rejectsWithLocation(/market|identity|exchange|symbol/i, () =>
      source.fetchPage(invalidMarket, { exchangeId: 'bitget', pageNo: 1 }));
    assert.equal(client.historyCalls.length, 0);
  }
});

test('Bitget validates its complete success envelope and maximum page size', async () => {
  const invalidResponses: readonly [string, unknown][] = [
    ['root', null],
    ['code', { code: '40000', msg: 'failure', requestTime: 1, data: [] }],
    ['code', { msg: 'success', requestTime: 1, data: [] }],
    ['msg', { code: '00000', requestTime: 1, data: [] }],
    ['msg', { code: '00000', msg: 0, requestTime: 1, data: [] }],
    ['requestTime', { code: '00000', msg: 'success', data: [] }],
    ['requestTime', { code: '00000', msg: 'success', requestTime: '1', data: [] }],
    ['data', { code: '00000', msg: 'success', requestTime: 1 }],
    ['data', { code: '00000', msg: 'success', requestTime: 1, data: {} }]
  ];

  for (const [field, response] of invalidResponses) {
    const { source } = sourceFor(response);
    await rejectsWithLocation(new RegExp(field, 'i'), () => source.fetchPage(
      market,
      { exchangeId: 'bitget', pageNo: 1 }
    ));
  }

  const oversized = sourceFor(historyEnvelope(Array.from(
    { length: 101 },
    (_, index) => historyRecord({ fundingTime: String(1_700_000_000_000 - index) })
  )));
  await rejectsWithLocation(/page|size|100/i, () => oversized.source.fetchPage(
    market,
    { exchangeId: 'bitget', pageNo: 1 }
  ));
});

test('Bitget rejects missing, malformed, or mismatched record identity and settlement data', async () => {
  const invalidRecords: readonly [RegExp, BitgetHistoryRecord][] = [
    [/symbol|market/i, historyRecord({ symbol: undefined })],
    [/symbol|market/i, historyRecord({ symbol: 7 })],
    [/symbol|market/i, historyRecord({ symbol: '' })],
    [/symbol|market/i, historyRecord({ symbol: ' BTCUSDT' })],
    [/symbol|market/i, historyRecord({ symbol: 'ETHUSDT' })],
    [/rate/i, historyRecord({ fundingRate: undefined })],
    [/rate/i, historyRecord({ fundingRate: 0 })],
    [/rate/i, historyRecord({ fundingRate: ' ' })],
    [/rate/i, historyRecord({ fundingRate: 'NaN' })],
    [/time|timestamp/i, historyRecord({ fundingTime: undefined })],
    [/time|timestamp/i, historyRecord({ fundingTime: '01' })],
    [/time|timestamp/i, historyRecord({ fundingTime: '-1' })]
  ];

  for (const [field, record] of invalidRecords) {
    const { source } = sourceFor(historyEnvelope([record]));
    await rejectsWithLocation(field, () => source.fetchPage(
      market,
      { exchangeId: 'bitget', pageNo: 1 }
    ));
  }
});

test('Bitget collapses exact duplicates and rejects conflicting duplicate natural keys', async () => {
  const raw = historyRecord({ fundingRate: '0.000100', fundingTime: '1700000000000' });
  const identical = sourceFor(historyEnvelope([raw, { ...raw }]));
  const identicalPage = await identical.source.fetchPage(
    market,
    { exchangeId: 'bitget', pageNo: 1 }
  );
  assert.equal(identicalPage.records.length, 1);
  assert.equal(identicalPage.records[0]?.fundingRate, '0.000100');

  const conflicting = sourceFor(historyEnvelope([
    raw,
    { ...raw, fundingRate: '0.000101' }
  ]));
  await rejectsWithLocation(/duplicate|conflict|timestamp/i, () =>
    conflicting.source.fetchPage(
      market,
      { exchangeId: 'bitget', pageNo: 1 }
    ));
});
