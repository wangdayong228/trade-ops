/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { BitgetFundingRateSource } from '../../src/funding-rates/bitget-funding-rate-source.js';
import {
  createCcxtFundingRateSources
} from '../../src/funding-rates/ccxt-funding-rate-source-factory.js';
import { OkxFundingRateSource } from '../../src/funding-rates/okx-funding-rate-source.js';
import type { FundingRateSource } from '../../src/funding-rates/funding-rate-source.js';

interface ConstructorCapture {
  readonly bitgetOptions: unknown[];
  readonly okxOptions: unknown[];
  bitgetDiscoveryCalls: number;
  bitgetHistoryCalls: number;
  okxDiscoveryCalls: number;
  okxHistoryCalls: number;
}

function fakeConstructors(capture: ConstructorCapture) {
  class FakeBitgetClient {
    constructor(options: unknown) {
      capture.bitgetOptions.push(options);
    }

    safeCurrencyCode(currencyId?: string): string | undefined {
      return currencyId;
    }

    async publicMixGetV2MixMarketContracts(_params: object): Promise<unknown> {
      capture.bitgetDiscoveryCalls += 1;
      return { code: '00000', msg: 'success', requestTime: 1, data: [] };
    }

    async publicMixGetV2MixMarketHistoryFundRate(
      _params: object
    ): Promise<unknown> {
      capture.bitgetHistoryCalls += 1;
      return { code: '00000', msg: 'success', requestTime: 1, data: [] };
    }
  }

  class FakeOkxClient {
    constructor(options: unknown) {
      capture.okxOptions.push(options);
    }

    safeCurrencyCode(currencyId?: string): string | undefined {
      return currencyId;
    }

    async publicGetPublicInstruments(_params: object): Promise<unknown> {
      capture.okxDiscoveryCalls += 1;
      return { code: '0', msg: '', data: [] };
    }

    async publicGetPublicFundingRateHistory(_params: object): Promise<unknown> {
      capture.okxHistoryCalls += 1;
      return { code: '0', msg: '', data: [] };
    }
  }

  return {
    bitget: FakeBitgetClient,
    okx: FakeOkxClient
  };
}

function emptyCapture(): ConstructorCapture {
  return {
    bitgetOptions: [],
    okxOptions: [],
    bitgetDiscoveryCalls: 0,
    bitgetHistoryCalls: 0,
    okxDiscoveryCalls: 0,
    okxHistoryCalls: 0
  };
}

test('constructs both public sources with only rate limiting and a 15000ms timeout', () => {
  const capture = emptyCapture();
  const sources = createCcxtFundingRateSources(fakeConstructors(capture));

  assert.deepEqual(capture.bitgetOptions, [{
    enableRateLimit: true,
    timeout: 15_000
  }]);
  assert.deepEqual(capture.okxOptions, [{
    enableRateLimit: true,
    timeout: 15_000
  }]);
  assert.deepEqual(
    sources.map((source: FundingRateSource) => source.exchangeId),
    ['bitget', 'okx']
  );
  assert.ok(sources[0] instanceof BitgetFundingRateSource);
  assert.ok(sources[1] instanceof OkxFundingRateSource);
});

test('ignores credential-shaped constructor extensions and extra call arguments', () => {
  type FactoryInput = NonNullable<
    Parameters<typeof createCcxtFundingRateSources>[0]
  >;
  type ForbiddenFactoryKey = Extract<
    keyof FactoryInput,
    'env' | 'credentials' | 'apiKey' | 'secret' | 'password' | 'headers'
  >;
  const factorySignatureHasNoCredentialKeys: ForbiddenFactoryKey extends never
    ? true
    : false = true;
  const factoryAcceptsAtMostOneArgument:
    Parameters<typeof createCcxtFundingRateSources>['length'] extends 0 | 1
      ? true
      : false = true;
  const capture = emptyCapture();
  const unsafeConstructors = Object.assign(fakeConstructors(capture), {
    apiKey: 'SYNTHETIC-API-KEY',
    secret: 'SYNTHETIC-SECRET',
    password: 'SYNTHETIC-PASSWORD',
    headers: { authorization: 'SYNTHETIC-AUTHORIZATION' }
  });

  const sources = Reflect.apply(createCcxtFundingRateSources, undefined, [
    unsafeConstructors,
    {
      env: { TRADING_OKX_API_KEY: 'SYNTHETIC-ENV-KEY' },
      credentials: { apiKey: 'SYNTHETIC-NESTED-KEY' }
    }
  ]) as ReturnType<typeof createCcxtFundingRateSources>;

  assert.equal(factorySignatureHasNoCredentialKeys, true);
  assert.equal(factoryAcceptsAtMostOneArgument, true);
  assert.equal(sources.length, 2);
  assert.deepEqual(capture.bitgetOptions, [{
    enableRateLimit: true,
    timeout: 15_000
  }]);
  assert.deepEqual(capture.okxOptions, [{
    enableRateLimit: true,
    timeout: 15_000
  }]);
});

test('source construction performs no discovery or history request', () => {
  const capture = emptyCapture();

  createCcxtFundingRateSources(fakeConstructors(capture));

  assert.deepEqual({
    bitgetDiscoveryCalls: capture.bitgetDiscoveryCalls,
    bitgetHistoryCalls: capture.bitgetHistoryCalls,
    okxDiscoveryCalls: capture.okxDiscoveryCalls,
    okxHistoryCalls: capture.okxHistoryCalls
  }, {
    bitgetDiscoveryCalls: 0,
    bitgetHistoryCalls: 0,
    okxDiscoveryCalls: 0,
    okxHistoryCalls: 0
  });
});

test('the default factory returns the two production source adapters without I/O', () => {
  const sources = createCcxtFundingRateSources();

  assert.equal(sources.length, 2);
  assert.ok(sources[0] instanceof BitgetFundingRateSource);
  assert.ok(sources[1] instanceof OkxFundingRateSource);
  assert.deepEqual(
    sources.map((source: FundingRateSource) => source.exchangeId),
    ['bitget', 'okx']
  );
});
