/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { OkxFundingRateSource } from '../../src/funding-rates/okx-funding-rate-source.js';
import type {
  FundingMarketIdentity,
  SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import type { FundingPageCursor } from '../../src/funding-rates/funding-rate-source.js';

interface OkxHistoryRecord {
  readonly instType: unknown;
  readonly instId: unknown;
  readonly fundingRate: unknown;
  readonly realizedRate: unknown;
  readonly fundingTime: unknown;
}

class FakeOkxClient {
  readonly discoveryCalls: unknown[] = [];
  readonly historyCalls: unknown[] = [];
  readonly forbiddenCalls: string[] = [];

  constructor(public historyResponse: unknown) {}

  safeCurrencyCode(currencyId?: string): unknown {
    return currencyId;
  }

  async publicGetPublicInstruments(params?: object): Promise<unknown> {
    this.discoveryCalls.push(params);
    return { code: '0', msg: '', data: [] };
  }

  async publicGetPublicFundingRateHistory(params?: object): Promise<unknown> {
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
  exchangeId: 'okx',
  exchangeMarketId: 'BTC-USDT-SWAP',
  symbol: 'BTC/USDT:USDT'
};

function historyRecord(
  overrides: Partial<OkxHistoryRecord> = {}
): OkxHistoryRecord {
  return {
    instType: 'SWAP',
    instId: 'BTC-USDT-SWAP',
    fundingRate: '0.018',
    realizedRate: '0.017',
    fundingTime: '1700000000000',
    ...overrides
  };
}

function historyEnvelope(data: readonly unknown[]): object {
  return {
    code: '0',
    msg: '',
    data
  };
}

function sourceFor(response: unknown): {
  readonly client: FakeOkxClient;
  readonly source: OkxFundingRateSource;
} {
  const client = new FakeOkxClient(response);
  return {
    client,
    source: new OkxFundingRateSource(client)
  };
}

async function rejectsWithLocation(
  field: RegExp,
  operation: () => Promise<unknown>
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /OKX/i);
    assert.match(error.message, field);
    return true;
  });
}

test('uses exact OKX requests and only realizedRate as the settled decimal', async () => {
  const { client, source } = sourceFor(historyEnvelope([
    historyRecord({
      fundingRate: '999',
      realizedRate: '0',
      fundingTime: '1699999999997'
    }),
    historyRecord({
      fundingRate: '-999',
      realizedRate: '1.2300000000000000000000000000000000000001e-1234',
      fundingTime: '1699999999999'
    }),
    historyRecord({
      fundingRate: '888',
      realizedRate: '-0.0003',
      fundingTime: '1699999999998'
    })
  ]));
  const cursor = { exchangeId: 'okx', afterMs: 1_700_000_000_000 } as const;

  assert.equal(source.exchangeId, 'okx');
  assert.equal(source.pageSize, 400);
  assert.equal(source.minimumRequestSpacingMs, 250);
  assert.deepEqual(source.pageRequest(market, cursor), {
    method: 'GET',
    path: '/api/v5/public/funding-rate-history',
    query: {
      instId: 'BTC-USDT-SWAP',
      after: '1700000000000',
      limit: 400
    },
    body: null
  });

  const page = await source.fetchPage(market, cursor);

  assert.deepEqual(client.historyCalls, [{
    instId: 'BTC-USDT-SWAP',
    after: '1700000000000',
    limit: 400
  }]);
  assert.deepEqual(page.cursor, cursor);
  assert.deepEqual(
    page.records.map((record: SettledFundingRate) => [
      record.fundingTimestampMs,
      record.fundingRate
    ]),
    [
      [1_699_999_999_999, '1.2300000000000000000000000000000000000001e-1234'],
      [1_699_999_999_998, '-0.0003'],
      [1_699_999_999_997, '0']
    ]
  );
  assert.ok(page.records.every((record: SettledFundingRate) =>
    record.exchangeMarketId === market.exchangeMarketId
    && record.symbol === market.symbol
    && record.rawJson.includes('"fundingRate"')
    && record.rawJson.includes('"realizedRate"')));
  assert.deepEqual(page.nextCursor, {
    exchangeId: 'okx',
    afterMs: 1_699_999_999_997
  });
  assert.equal(page.recoveryAnchorMs, 1_699_999_999_999);
  assert.equal(client.discoveryCalls.length, 0);
  assert.deepEqual(client.forbiddenCalls, []);
});

test('OKX omits after on the first page', async () => {
  const { client, source } = sourceFor(historyEnvelope([]));
  const cursor = { exchangeId: 'okx', afterMs: null } as const;

  assert.deepEqual(source.pageRequest(market, cursor), {
    method: 'GET',
    path: '/api/v5/public/funding-rate-history',
    query: {
      instId: 'BTC-USDT-SWAP',
      limit: 400
    },
    body: null
  });
  await source.fetchPage(market, cursor);
  assert.deepEqual(client.historyCalls, [{
    instId: 'BTC-USDT-SWAP',
    limit: 400
  }]);
});

test('OKX derives next=min and recovery anchor=max even for a short page', async () => {
  const { source } = sourceFor(historyEnvelope([
    historyRecord({ fundingTime: '1699999999995' }),
    historyRecord({ fundingTime: '1699999999998' }),
    historyRecord({ fundingTime: '1699999999996' })
  ]));

  const page = await source.fetchPage(market, {
    exchangeId: 'okx',
    afterMs: 1_700_000_000_000
  });

  assert.equal(page.records.length, 3);
  assert.deepEqual(page.nextCursor, {
    exchangeId: 'okx',
    afterMs: 1_699_999_999_995
  });
  assert.equal(page.recoveryAnchorMs, 1_699_999_999_998);
});

test('only an explicit OKX empty page terminates pagination', async () => {
  const { source } = sourceFor(historyEnvelope([]));
  const page = await source.fetchPage(market, {
    exchangeId: 'okx',
    afterMs: 1_700_000_000_000
  });

  assert.deepEqual(page.records, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.recoveryAnchorMs, null);
});

test('OKX rejects every timestamp that is not strictly older than requested after', async () => {
  for (const fundingTime of ['1700000000000', '1700000000001']) {
    const { source } = sourceFor(historyEnvelope([historyRecord({ fundingTime })]));
    await rejectsWithLocation(/after|cursor|fundingTime/i, () => source.fetchPage(
      market,
      { exchangeId: 'okx', afterMs: 1_700_000_000_000 }
    ));
  }
});

test('OKX cursors are null or valid non-negative safe integer timestamps', async () => {
  const invalidCursors: readonly FundingPageCursor[] = [
    { exchangeId: 'okx', afterMs: -1 },
    { exchangeId: 'okx', afterMs: 1.5 },
    { exchangeId: 'okx', afterMs: Number.MAX_SAFE_INTEGER + 1 },
    { exchangeId: 'bitget', pageNo: 1 }
  ];

  for (const cursor of invalidCursors) {
    const { client, source } = sourceFor(historyEnvelope([]));
    await rejectsWithLocation(/cursor|after|exchange/i, () =>
      source.fetchPage(market, cursor));
    assert.equal(client.historyCalls.length, 0);
  }

  const zero = sourceFor(historyEnvelope([]));
  await zero.source.fetchPage(market, { exchangeId: 'okx', afterMs: 0 });
  assert.deepEqual(zero.client.historyCalls, [{
    instId: 'BTC-USDT-SWAP',
    after: '0',
    limit: 400
  }]);
});

test('OKX rejects wrong market identity before issuing a public request', async () => {
  const invalidMarkets: readonly FundingMarketIdentity[] = [
    { ...market, exchangeId: 'bitget' },
    { ...market, exchangeMarketId: '' },
    { ...market, exchangeMarketId: ' BTC-USDT-SWAP' },
    { ...market, symbol: '' },
    { ...market, symbol: 'BTC/USDT:USDT ' }
  ];

  for (const invalidMarket of invalidMarkets) {
    const { client, source } = sourceFor(historyEnvelope([]));
    await rejectsWithLocation(/market|identity|exchange|symbol/i, () =>
      source.fetchPage(invalidMarket, { exchangeId: 'okx', afterMs: null }));
    assert.equal(client.historyCalls.length, 0);
  }
});

test('OKX validates its complete success envelope and maximum page size', async () => {
  const invalidResponses: readonly [string, unknown][] = [
    ['root', null],
    ['code', { code: '1', msg: 'failure', data: [] }],
    ['code', { msg: '', data: [] }],
    ['msg', { code: '0', data: [] }],
    ['msg', { code: '0', msg: 0, data: [] }],
    ['data', { code: '0', msg: '' }],
    ['data', { code: '0', msg: '', data: {} }]
  ];

  for (const [field, response] of invalidResponses) {
    const { source } = sourceFor(response);
    await rejectsWithLocation(new RegExp(field, 'i'), () => source.fetchPage(
      market,
      { exchangeId: 'okx', afterMs: null }
    ));
  }

  const oversized = sourceFor(historyEnvelope(Array.from(
    { length: 401 },
    (_, index) => historyRecord({ fundingTime: String(1_700_000_000_000 - index) })
  )));
  await rejectsWithLocation(/page|size|400/i, () => oversized.source.fetchPage(
    market,
    { exchangeId: 'okx', afterMs: null }
  ));
});

test('OKX rejects missing, malformed, or mismatched record identity and settlement data', async () => {
  const invalidRecords: readonly [RegExp, OkxHistoryRecord][] = [
    [/instType/i, historyRecord({ instType: undefined })],
    [/instType/i, historyRecord({ instType: 'FUTURES' })],
    [/instId|market/i, historyRecord({ instId: undefined })],
    [/instId|market/i, historyRecord({ instId: 7 })],
    [/instId|market/i, historyRecord({ instId: '' })],
    [/instId|market/i, historyRecord({ instId: ' BTC-USDT-SWAP' })],
    [/instId|market/i, historyRecord({ instId: 'ETH-USDT-SWAP' })],
    [/rate/i, historyRecord({ realizedRate: undefined })],
    [/rate/i, historyRecord({ realizedRate: 0 })],
    [/rate/i, historyRecord({ realizedRate: ' ' })],
    [/rate/i, historyRecord({ realizedRate: 'Infinity' })],
    [/time|timestamp/i, historyRecord({ fundingTime: undefined })],
    [/time|timestamp/i, historyRecord({ fundingTime: '01' })],
    [/time|timestamp/i, historyRecord({ fundingTime: '-1' })]
  ];

  for (const [field, record] of invalidRecords) {
    const { source } = sourceFor(historyEnvelope([record]));
    await rejectsWithLocation(field, () => source.fetchPage(
      market,
      { exchangeId: 'okx', afterMs: null }
    ));
  }
});

test('OKX ignores malformed predicted fundingRate when realizedRate is valid', async () => {
  const { source } = sourceFor(historyEnvelope([historyRecord({
    fundingRate: 'not-a-decimal',
    realizedRate: '0.000125'
  })]));
  const page = await source.fetchPage(market, {
    exchangeId: 'okx',
    afterMs: null
  });
  assert.equal(page.records[0]?.fundingRate, '0.000125');
});

test('OKX collapses exact duplicates and rejects conflicting duplicate natural keys', async () => {
  const raw = historyRecord({ realizedRate: '0.000100', fundingTime: '1700000000000' });
  const identical = sourceFor(historyEnvelope([raw, { ...raw }]));
  const identicalPage = await identical.source.fetchPage(
    market,
    { exchangeId: 'okx', afterMs: null }
  );
  assert.equal(identicalPage.records.length, 1);
  assert.equal(identicalPage.records[0]?.fundingRate, '0.000100');

  const conflicting = sourceFor(historyEnvelope([
    raw,
    { ...raw, realizedRate: '0.000101' }
  ]));
  await rejectsWithLocation(/duplicate|conflict|timestamp/i, () =>
    conflicting.source.fetchPage(
      market,
      { exchangeId: 'okx', afterMs: null }
    ));
});
