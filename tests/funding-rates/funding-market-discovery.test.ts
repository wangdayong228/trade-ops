/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { BitgetFundingRateSource } from '../../src/funding-rates/bitget-funding-rate-source.js';
import { OkxFundingRateSource } from '../../src/funding-rates/okx-funding-rate-source.js';

interface BitgetContract {
  readonly symbol: unknown;
  readonly baseCoin: unknown;
  readonly quoteCoin: unknown;
  readonly supportMarginCoins: unknown;
  readonly symbolType: unknown;
  readonly symbolStatus: unknown;
}

interface OkxInstrument {
  readonly instType: unknown;
  readonly instId: unknown;
  readonly uly: unknown;
  readonly settleCcy: unknown;
  readonly ctType: unknown;
  readonly state: unknown;
}

class FakeBitgetClient {
  readonly discoveryCalls: unknown[] = [];
  readonly historyCalls: unknown[] = [];
  readonly forbiddenCalls: string[] = [];

  constructor(
    public discoveryResponse: unknown,
    private readonly currencyCodes: Readonly<Record<string, unknown>> = {}
  ) {}

  safeCurrencyCode(currencyId?: string): unknown {
    if (currencyId === undefined) {
      return undefined;
    }
    return Object.hasOwn(this.currencyCodes, currencyId)
      ? this.currencyCodes[currencyId]
      : currencyId;
  }

  async publicMixGetV2MixMarketContracts(params?: object): Promise<unknown> {
    this.discoveryCalls.push(params);
    return this.discoveryResponse;
  }

  async publicMixGetV2MixMarketHistoryFundRate(params?: object): Promise<unknown> {
    this.historyCalls.push(params);
    throw new Error('unexpected Bitget history request during discovery');
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

  private async forbidden(name: string): Promise<never> {
    this.forbiddenCalls.push(name);
    throw new Error(`${name} must not be called`);
  }
}

class FakeOkxClient {
  readonly discoveryCalls: unknown[] = [];
  readonly historyCalls: unknown[] = [];
  readonly forbiddenCalls: string[] = [];

  constructor(
    public discoveryResponse: unknown,
    private readonly currencyCodes: Readonly<Record<string, unknown>> = {}
  ) {}

  safeCurrencyCode(currencyId?: string): unknown {
    if (currencyId === undefined) {
      return undefined;
    }
    return Object.hasOwn(this.currencyCodes, currencyId)
      ? this.currencyCodes[currencyId]
      : currencyId;
  }

  async publicGetPublicInstruments(params?: object): Promise<unknown> {
    this.discoveryCalls.push(params);
    return this.discoveryResponse;
  }

  async publicGetPublicFundingRateHistory(params?: object): Promise<unknown> {
    this.historyCalls.push(params);
    throw new Error('unexpected OKX history request during discovery');
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

  private async forbidden(name: string): Promise<never> {
    this.forbiddenCalls.push(name);
    throw new Error(`${name} must not be called`);
  }
}

function bitgetContract(
  overrides: Partial<BitgetContract> = {}
): BitgetContract {
  return {
    symbol: 'BTCUSDT',
    baseCoin: 'XBT',
    quoteCoin: 'USDT',
    supportMarginCoins: ['USDT'],
    symbolType: 'perpetual',
    symbolStatus: 'normal',
    ...overrides
  };
}

function bitgetEnvelope(data: readonly unknown[]): object {
  return {
    code: '00000',
    msg: 'success',
    requestTime: 1_788_595_200_000,
    data
  };
}

function okxInstrument(
  overrides: Partial<OkxInstrument> = {}
): OkxInstrument {
  return {
    instType: 'SWAP',
    instId: 'BTC-USDT-SWAP',
    uly: 'XBT-USDT',
    settleCcy: 'USDT',
    ctType: 'linear',
    state: 'live',
    ...overrides
  };
}

function okxEnvelope(data: readonly unknown[]): object {
  return {
    code: '0',
    msg: '',
    data
  };
}

function sourceForBitget(
  response: unknown,
  currencyCodes: Readonly<Record<string, unknown>> = {}
): {
  readonly client: FakeBitgetClient;
  readonly source: BitgetFundingRateSource;
} {
  const client = new FakeBitgetClient(response, currencyCodes);
  return {
    client,
    source: new BitgetFundingRateSource(client)
  };
}

function sourceForOkx(
  response: unknown,
  currencyCodes: Readonly<Record<string, unknown>> = {}
): {
  readonly client: FakeOkxClient;
  readonly source: OkxFundingRateSource;
} {
  const client = new FakeOkxClient(response, currencyCodes);
  return {
    client,
    source: new OkxFundingRateSource(client)
  };
}

async function rejectsWithLocation(
  exchange: 'Bitget' | 'OKX',
  field: RegExp,
  operation: () => Promise<unknown>
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(exchange, 'i'));
    assert.match(error.message, field);
    return true;
  });
}

test('Bitget discovery makes one raw request per round and maps every approved status', async () => {
  const statuses = [
    'normal',
    'listed',
    'maintain',
    'limit_open',
    'restrictedAPI',
    'off'
  ] as const;
  const contracts = statuses.map((symbolStatus, index) => bitgetContract({
    symbol: `COIN${index}USDT`,
    baseCoin: `COIN${index}`,
    symbolStatus
  }));
  const { client, source } = sourceForBitget(
    bitgetEnvelope(contracts),
    { XBT: 'BTC' }
  );

  assert.deepEqual(source.discoveryRequest(), {
    method: 'GET',
    path: '/api/v2/mix/market/contracts',
    query: { productType: 'USDT-FUTURES' },
    body: null
  });

  const first = await source.discoverMarkets();
  const second = await source.discoverMarkets();

  assert.deepEqual(first, statuses.map((_, index) => ({
    exchangeId: 'bitget',
    exchangeMarketId: `COIN${index}USDT`,
    symbol: `COIN${index}/USDT:USDT`,
    active: index === 0
  })));
  assert.deepEqual(second, first);
  assert.deepEqual(client.discoveryCalls, [
    { productType: 'USDT-FUTURES' },
    { productType: 'USDT-FUTURES' }
  ]);
  assert.equal(client.historyCalls.length, 0);
  assert.deepEqual(client.forbiddenCalls, []);
});

test('Bitget discovery follows base, quote, then first support-margin settlement priority', async () => {
  const { source } = sourceForBitget(bitgetEnvelope([
    bitgetContract({
      symbol: 'BASEPRIORITYUSDT',
      baseCoin: 'XBT',
      supportMarginCoins: ['XBT', 'USDT']
    }),
    bitgetContract({
      symbol: 'QUOTEPRIORITYUSDT',
      baseCoin: 'QUOTEPRIORITY',
      supportMarginCoins: ['OTHER', 'USDT']
    }),
    bitgetContract({
      symbol: 'FIRSTFALLBACKUSDT',
      baseCoin: 'FIRSTFALLBACK',
      supportMarginCoins: ['USDt', 'OTHER']
    }),
    bitgetContract({
      symbol: 'DELIVERYUSDT',
      baseCoin: 'DELIVERY',
      symbolType: 'delivery'
    }),
    bitgetContract({
      symbol: 'USDCMARGINUSDT',
      baseCoin: 'USDCMARGIN',
      supportMarginCoins: ['USDC']
    })
  ]), {
    XBT: 'BTC',
    USDt: 'USDT'
  });

  assert.deepEqual(await source.discoverMarkets(), [
    {
      exchangeId: 'bitget',
      exchangeMarketId: 'QUOTEPRIORITYUSDT',
      symbol: 'QUOTEPRIORITY/USDT:USDT',
      active: true
    },
    {
      exchangeId: 'bitget',
      exchangeMarketId: 'FIRSTFALLBACKUSDT',
      symbol: 'FIRSTFALLBACK/USDT:USDT',
      active: true
    }
  ]);
});

test('Bitget discovery rejects malformed raw and normalized identities', async () => {
  const invalidRawCases: readonly [string, keyof BitgetContract, unknown][] = [
    ['missing symbol', 'symbol', undefined],
    ['non-string symbol', 'symbol', 7],
    ['blank symbol', 'symbol', ''],
    ['spaced symbol', 'symbol', ' BTCUSDT'],
    ['missing baseCoin', 'baseCoin', undefined],
    ['non-string baseCoin', 'baseCoin', 7],
    ['blank baseCoin', 'baseCoin', ''],
    ['spaced baseCoin', 'baseCoin', 'BTC '],
    ['missing quoteCoin', 'quoteCoin', undefined],
    ['non-string quoteCoin', 'quoteCoin', 7],
    ['blank quoteCoin', 'quoteCoin', ''],
    ['spaced quoteCoin', 'quoteCoin', ' USDT']
  ];

  for (const [label, field, value] of invalidRawCases) {
    const { source } = sourceForBitget(bitgetEnvelope([
      bitgetContract({ [field]: value })
    ]));
    await rejectsWithLocation('Bitget', new RegExp(String(field), 'i'), async () => {
      await source.discoverMarkets();
    }).catch((error: unknown) => {
      throw new Error(`${label}: ${String(error)}`);
    });
  }

  const invalidSupportLists: readonly unknown[] = [
    undefined,
    null,
    {},
    [],
    [7],
    [''],
    [' USDT'],
    ['USDT', 7],
    ['USDT', ' MARGIN']
  ];
  for (const supportMarginCoins of invalidSupportLists) {
    const { source } = sourceForBitget(bitgetEnvelope([
      bitgetContract({ supportMarginCoins })
    ]));
    await rejectsWithLocation('Bitget', /supportMarginCoins|settle/i, () =>
      source.discoverMarkets());
  }

  const invalidNormalizedValues: readonly unknown[] = [undefined, 7, '', ' ', ' USDT'];
  for (const field of ['base', 'quote', 'settle'] as const) {
    for (const invalidValue of invalidNormalizedValues) {
      const currencyId = field === 'base' ? 'XBT' : 'USDT';
      const contract = field === 'settle'
        ? bitgetContract({ supportMarginCoins: ['MARGIN'] })
        : bitgetContract();
      const mappedId = field === 'settle' ? 'MARGIN' : currencyId;
      const { source } = sourceForBitget(
        bitgetEnvelope([contract]),
        { XBT: field === 'base' ? invalidValue : 'BTC', [mappedId]: invalidValue }
      );
      await rejectsWithLocation('Bitget', new RegExp(field, 'i'), () =>
        source.discoverMarkets());
    }
  }
});

test('Bitget discovery rejects unknown states, duplicate raw IDs, and unified identity conflicts', async () => {
  for (const symbolStatus of [undefined, '', 'mystery']) {
    const { source } = sourceForBitget(bitgetEnvelope([
      bitgetContract({ symbolStatus })
    ]));
    await rejectsWithLocation('Bitget', /symbolStatus|status/i, () =>
      source.discoverMarkets());
  }

  const duplicate = bitgetContract();
  const duplicateSource = sourceForBitget(
    bitgetEnvelope([duplicate, { ...duplicate }]),
    { XBT: 'BTC' }
  ).source;
  await rejectsWithLocation('Bitget', /duplicate|symbol/i, () =>
    duplicateSource.discoverMarkets());

  const conflictSource = sourceForBitget(bitgetEnvelope([
    bitgetContract({ symbol: 'XBTUSDT', baseCoin: 'XBT' }),
    bitgetContract({ symbol: 'BTCUSDT', baseCoin: 'BTC' })
  ]), { XBT: 'BTC' }).source;
  await rejectsWithLocation('Bitget', /conflict|symbol|identity/i, () =>
    conflictSource.discoverMarkets());
});

test('Bitget discovery validates the complete documented envelope', async () => {
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
    const { source } = sourceForBitget(response);
    await rejectsWithLocation('Bitget', new RegExp(field, 'i'), () =>
      source.discoverMarkets());
  }
});

test('OKX discovery makes one raw request per round and maps every approved state', async () => {
  const states = ['live', 'suspend', 'rebase', 'post_only', 'preopen', 'test'] as const;
  const instruments = states.map((state, index) => okxInstrument({
    instId: `COIN${index}-USDT-SWAP`,
    uly: `COIN${index}-USDT`,
    state
  }));
  const { client, source } = sourceForOkx(okxEnvelope(instruments));

  assert.deepEqual(source.discoveryRequest(), {
    method: 'GET',
    path: '/api/v5/public/instruments',
    query: { instType: 'SWAP' },
    body: null
  });

  const first = await source.discoverMarkets();
  const second = await source.discoverMarkets();

  assert.deepEqual(first, states.map((_, index) => ({
    exchangeId: 'okx',
    exchangeMarketId: `COIN${index}-USDT-SWAP`,
    symbol: `COIN${index}/USDT:USDT`,
    active: index === 0
  })));
  assert.deepEqual(second, first);
  assert.deepEqual(client.discoveryCalls, [
    { instType: 'SWAP' },
    { instType: 'SWAP' }
  ]);
  assert.equal(client.historyCalls.length, 0);
  assert.deepEqual(client.forbiddenCalls, []);
});

test('OKX discovery normalizes codes and filters heterogeneous non-target instruments', async () => {
  const { source } = sourceForOkx(okxEnvelope([
    okxInstrument(),
    okxInstrument({
      instId: 'ETH-USDC-SWAP',
      uly: 'ETH-USDC',
      settleCcy: 'USDC'
    }),
    okxInstrument({
      instType: 'FUTURES',
      instId: 'ETH-USDT-260906',
      uly: 'ETH-USDT'
    }),
    okxInstrument({
      instId: 'ETH-USD-SWAP',
      uly: 'ETH-USD',
      settleCcy: 'USD',
      ctType: 'inverse'
    }),
    okxInstrument({
      instId: 'MISMATCH-USDT-SWAP',
      uly: 'MISMATCH-USDT',
      settleCcy: 'USDt'
    }),
    okxInstrument({
      instId: 'USDT-USDT-SWAP',
      uly: 'USDT-USDT'
    })
  ]), { XBT: 'BTC', USDt: 'USDT' });

  assert.deepEqual(await source.discoverMarkets(), [{
    exchangeId: 'okx',
    exchangeMarketId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    active: true
  }]);
});

test('OKX discovery rejects malformed raw and normalized identities', async () => {
  const invalidRawCases: readonly [string, keyof OkxInstrument, unknown][] = [
    ['missing instId', 'instId', undefined],
    ['non-string instId', 'instId', 7],
    ['blank instId', 'instId', ''],
    ['spaced instId', 'instId', ' BTC-USDT-SWAP'],
    ['missing settleCcy', 'settleCcy', undefined],
    ['non-string settleCcy', 'settleCcy', 7],
    ['blank settleCcy', 'settleCcy', ''],
    ['spaced settleCcy', 'settleCcy', 'USDT '],
    ['missing uly', 'uly', undefined],
    ['non-string uly', 'uly', 7],
    ['empty base in uly', 'uly', '-USDT'],
    ['empty quote in uly', 'uly', 'BTC-'],
    ['extra segment in uly', 'uly', 'BTC-USDT-SWAP'],
    ['spaced base in uly', 'uly', ' BTC-USDT'],
    ['spaced quote in uly', 'uly', 'BTC-USDT ']
  ];

  for (const [label, field, value] of invalidRawCases) {
    const { source } = sourceForOkx(okxEnvelope([
      okxInstrument({ [field]: value })
    ]));
    await rejectsWithLocation('OKX', new RegExp(String(field), 'i'), async () => {
      await source.discoverMarkets();
    }).catch((error: unknown) => {
      throw new Error(`${label}: ${String(error)}`);
    });
  }

  const invalidNormalizedValues: readonly unknown[] = [undefined, 7, '', ' ', ' USDT'];
  for (const field of ['base', 'quote', 'settle'] as const) {
    for (const invalidValue of invalidNormalizedValues) {
      const mapping: Record<string, unknown> = { XBT: 'BTC' };
      mapping[field === 'base' ? 'XBT' : 'USDT'] = invalidValue;
      const { source } = sourceForOkx(okxEnvelope([okxInstrument()]), mapping);
      await rejectsWithLocation('OKX', new RegExp(field, 'i'), () =>
        source.discoverMarkets());
    }
  }
});

test('OKX discovery rejects unknown states, duplicate raw IDs, and unified identity conflicts', async () => {
  for (const state of [undefined, '', 'mystery']) {
    const { source } = sourceForOkx(okxEnvelope([okxInstrument({ state })]));
    await rejectsWithLocation('OKX', /state/i, () => source.discoverMarkets());
  }

  const duplicate = okxInstrument();
  const duplicateSource = sourceForOkx(
    okxEnvelope([duplicate, { ...duplicate }]),
    { XBT: 'BTC' }
  ).source;
  await rejectsWithLocation('OKX', /duplicate|instId/i, () =>
    duplicateSource.discoverMarkets());

  const conflictSource = sourceForOkx(okxEnvelope([
    okxInstrument({ instId: 'XBT-USDT-SWAP', uly: 'XBT-USDT' }),
    okxInstrument({ instId: 'BTC-USDT-SWAP', uly: 'BTC-USDT' })
  ]), { XBT: 'BTC' }).source;
  await rejectsWithLocation('OKX', /conflict|symbol|identity/i, () =>
    conflictSource.discoverMarkets());
});

test('OKX discovery validates the complete documented envelope', async () => {
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
    const { source } = sourceForOkx(response);
    await rejectsWithLocation('OKX', new RegExp(field, 'i'), () =>
      source.discoverMarkets());
  }
});
