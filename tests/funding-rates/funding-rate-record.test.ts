/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  settledFundingRate,
  type FundingMarketIdentity,
  type SettledFundingRate
} from '../../src/funding-rates/funding-rate-record.js';
import type {
  FundingPageCursor,
  FundingRatePage,
  FundingRateSource,
  FundingRequestExecutor,
  FundingRequestMetadata
} from '../../src/funding-rates/funding-rate-source.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;
type IsAny<Value> = 0 extends (1 & Value) ? true : false;
type NoneAreAny<Values extends readonly unknown[]> =
  Values extends readonly [infer Head, ...infer Tail]
    ? IsAny<Head> extends true
      ? false
      : NoneAreAny<Tail>
    : true;

type ExpectedFundingPageCursor =
  | { readonly exchangeId: 'bitget'; readonly pageNo: number }
  | { readonly exchangeId: 'okx'; readonly afterMs: number | null };
type ExpectedFundingExchangeId = 'bitget' | 'okx';
interface ExpectedFundingMarketIdentity {
  readonly exchangeId: ExpectedFundingExchangeId;
  readonly exchangeMarketId: string;
  readonly symbol: string;
}
interface ExpectedFundingMarketObservation extends ExpectedFundingMarketIdentity {
  readonly active: boolean;
}
interface ExpectedSettledFundingRate extends ExpectedFundingMarketIdentity {
  readonly fundingTimestampMs: number;
  readonly fundingRate: string;
  readonly rawJson: string;
  readonly contentHash: string;
}
interface ExpectedFundingRequestMetadata {
  readonly method: 'GET';
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
  readonly body: null;
}
interface ExpectedFundingRatePage {
  readonly cursor: ExpectedFundingPageCursor;
  readonly records: readonly ExpectedSettledFundingRate[];
  readonly nextCursor: ExpectedFundingPageCursor | null;
  readonly recoveryAnchorMs: number | null;
}
interface ExpectedFundingRateSource {
  readonly exchangeId: ExpectedFundingExchangeId;
  readonly pageSize: 100 | 400;
  readonly minimumRequestSpacingMs: 100 | 250;
  discoveryRequest(): ExpectedFundingRequestMetadata;
  discoverMarkets(): Promise<readonly ExpectedFundingMarketObservation[]>;
  pageRequest(
    market: ExpectedFundingMarketIdentity,
    cursor: ExpectedFundingPageCursor
  ): ExpectedFundingRequestMetadata;
  fetchPage(
    market: ExpectedFundingMarketIdentity,
    cursor: ExpectedFundingPageCursor
  ): Promise<ExpectedFundingRatePage>;
}
interface ExpectedFundingRequestExecutor {
  execute<Value>(
    request: ExpectedFundingRequestMetadata,
    operation: () => Promise<Value>
  ): Promise<Value>;
}

type ActualSourceContracts = readonly [
  FundingPageCursor,
  FundingRequestMetadata,
  FundingRatePage,
  FundingRateSource,
  FundingRequestExecutor
];
type ExpectedSourceContracts = readonly [
  ExpectedFundingPageCursor,
  ExpectedFundingRequestMetadata,
  ExpectedFundingRatePage,
  ExpectedFundingRateSource,
  ExpectedFundingRequestExecutor
];
type SourceContracts = Expect<
  NoneAreAny<ActualSourceContracts> extends true
    ? Equal<ActualSourceContracts, ExpectedSourceContracts>
    : false
>;
const sourceContractsCompile: SourceContracts = true;
void sourceContractsCompile;

const identity: FundingMarketIdentity = {
  exchangeId: 'okx',
  exchangeMarketId: 'BTC-USDT-SWAP',
  symbol: 'BTC/USDT:USDT'
};
const timestampMs = 1_728_000_000_000;

function record(
  rawRate: unknown,
  rawTimestampMs: unknown = timestampMs,
  rawRecord: unknown = { fundingRate: rawRate, fundingTime: String(rawTimestampMs) },
  market: FundingMarketIdentity = identity
): SettledFundingRate {
  return settledFundingRate(market, rawRate, rawTimestampMs, rawRecord);
}

test('preserves positive, zero, and negative funding rate strings', () => {
  for (const rate of ['0.0001', '0', '-0.0001']) {
    assert.equal(record(rate).fundingRate, rate);
  }
});

test('preserves high-precision and scientific notation without number conversion', () => {
  const rates = [
    '0.12345678901234567890123456789012345678901234567890',
    '1.2300e-1234',
    '+.5000E+7',
    '1.'
  ];

  for (const rate of rates) {
    assert.equal(record(rate).fundingRate, rate);
  }
});

test('trims outer whitespace from a valid rate while preserving its representation', () => {
  assert.equal(record(' \t-0.0000E+7\n').fundingRate, '-0.0000E+7');
});

test('rejects missing, non-string, malformed, and non-finite funding rates', () => {
  const invalidRates: readonly unknown[] = [
    undefined,
    null,
    0,
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '.',
    '+',
    '-',
    '1_000',
    '0x10',
    '1,0',
    '1 0',
    '--1',
    '1e',
    '1e+',
    'e1',
    '1.2.3',
    '1e9000000000000001'
  ];

  for (const rate of invalidRates) {
    assert.throws(
      () => record(rate),
      /rate/i,
      `expected ${String(rate)} to be rejected`
    );
  }
});

test('normalizes canonical timestamp strings and safe integer numbers identically', () => {
  const raw = { realizedRate: '0.000100', fundingTime: String(timestampMs) };
  const fromString = record('0.000100', String(timestampMs), raw);
  const fromNumber = record('0.000100', timestampMs, raw);

  assert.equal(fromString.fundingTimestampMs, timestampMs);
  assert.equal(fromNumber.fundingTimestampMs, timestampMs);
  assert.equal(fromString.contentHash, fromNumber.contentHash);
});

test('accepts the minimum and maximum valid JavaScript date timestamps', () => {
  assert.equal(record('0', '0', {}).fundingTimestampMs, 0);
  assert.equal(
    record('0', 8_640_000_000_000_000, {}).fundingTimestampMs,
    8_640_000_000_000_000
  );
});

test('rejects missing, non-canonical, unsafe, and invalid-date timestamps', () => {
  assert.throws(
    () => settledFundingRate(identity, '0', undefined, {}),
    /timestamp/i,
    'expected undefined to be rejected'
  );

  const invalidTimestamps: readonly unknown[] = [
    null,
    true,
    {},
    [],
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER,
    '',
    ' ',
    ' 1',
    '1 ',
    '+1',
    '-1',
    '01',
    '1.0',
    '1e3',
    'not-a-timestamp',
    '8640000000000001',
    '9007199254740992'
  ];

  for (const value of invalidTimestamps) {
    assert.throws(
      () => record('0', value, {}),
      /timestamp/i,
      `expected ${String(value)} to be rejected`
    );
  }
});

test('sorts raw keys recursively and produces the independently checked SHA-256', () => {
  const raw = {
    z: 1,
    a: { y: true, x: 'raw' },
    list: [{ b: 2, a: 1 }, null]
  };
  const settled = record('0.000100', timestampMs, raw);

  assert.equal(
    settled.rawJson,
    '{"a":{"x":"raw","y":true},"list":[{"a":1,"b":2},null],"z":1}'
  );
  assert.equal(
    settled.contentHash,
    '1928c0b0ba90a2226e34dd6ee6aa4a7ce302bbb1eeffa22613414bd37edbb62d'
  );
  assert.match(settled.contentHash, /^[0-9a-f]{64}$/);
});

test('uses Unicode code-unit key order at every object level', () => {
  const settled = record('0', timestampMs, {
    '\uE000': 'private-use',
    '\u{10000}': 'supplementary',
    a: 'ascii'
  });

  assert.equal(
    settled.rawJson,
    '{"a":"ascii","\u{10000}":"supplementary","\uE000":"private-use"}'
  );
});

test('gives semantically identical raw objects the same JSON and hash', () => {
  const first = record('0.000100', String(timestampMs), {
    z: 1,
    nested: { second: 2, first: 1 }
  });
  const second = record('0.000100', timestampMs, {
    nested: { first: 1, second: 2 },
    z: 1
  });

  assert.equal(first.rawJson, second.rawJson);
  assert.equal(first.contentHash, second.contentHash);
});

test('includes every normalized semantic field in the content hash', () => {
  const raw = { value: 1 };
  const baseline = record('0.0001', timestampMs, raw);
  const variants = [
    record('0.0002', timestampMs, raw),
    record('0.0001', timestampMs + 1, raw),
    record('0.0001', timestampMs, { value: 2 }),
    record('0.0001', timestampMs, raw, {
      ...identity,
      exchangeId: 'bitget'
    }),
    record('0.0001', timestampMs, raw, {
      ...identity,
      exchangeMarketId: 'ETH-USDT-SWAP'
    }),
    record('0.0001', timestampMs, raw, {
      ...identity,
      symbol: 'XBT/USDT:USDT'
    })
  ];

  for (const variant of variants) {
    assert.notEqual(variant.contentHash, baseline.contentHash);
  }
});

test('rejects empty, padded, and non-string market identity fields', () => {
  const invalidIdentities: readonly [string, FundingMarketIdentity][] = [
    ['exchangeMarketId', { ...identity, exchangeMarketId: '' }],
    ['exchangeMarketId', { ...identity, exchangeMarketId: ' BTC-USDT-SWAP' }],
    ['exchangeMarketId', { ...identity, exchangeMarketId: 'BTC-USDT-SWAP ' }],
    ['symbol', { ...identity, symbol: '' }],
    ['symbol', { ...identity, symbol: ' BTC/USDT:USDT' }],
    ['symbol', { ...identity, symbol: 'BTC/USDT:USDT ' }],
    [
      'exchangeMarketId',
      { ...identity, exchangeMarketId: 1 } as unknown as FundingMarketIdentity
    ],
    ['symbol', { ...identity, symbol: null } as unknown as FundingMarketIdentity]
  ];

  for (const [field, market] of invalidIdentities) {
    assert.throws(
      () => record('0', timestampMs, {}, market),
      new RegExp(field, 'i')
    );
  }
});

test('accepts all supported JSON value kinds without mutating the raw record', () => {
  const raw = Object.freeze({
    nullValue: null,
    booleanValue: false,
    stringValue: 'value',
    numberValue: -12.5,
    arrayValue: Object.freeze([null, true, 'value', 3, Object.freeze({ b: 2, a: 1 })])
  });

  assert.equal(
    record('0', timestampMs, raw).rawJson,
    '{"arrayValue":[null,true,"value",3,{"a":1,"b":2}],"booleanValue":false,"nullValue":null,"numberValue":-12.5,"stringValue":"value"}'
  );
});

test('allows repeated object references that do not form a cycle', () => {
  const shared = { value: 1 };

  assert.equal(
    record('0', timestampMs, { left: shared, right: shared }).rawJson,
    '{"left":{"value":1},"right":{"value":1}}'
  );
});

test('rejects non-object roots and unsupported nested JSON values', () => {
  const invalidRawRecords: readonly [string, unknown][] = [
    ['null root', null],
    ['array root', []],
    ['string root', 'raw'],
    ['number root', 1],
    ['boolean root', true],
    ['undefined value', { value: undefined }],
    ['bigint value', { value: 1n }],
    ['function value', { value: () => undefined }],
    ['symbol value', { value: Symbol('value') }],
    ['NaN value', { value: Number.NaN }],
    ['positive infinity', { value: Number.POSITIVE_INFINITY }],
    ['negative infinity', { value: Number.NEGATIVE_INFINITY }]
  ];

  for (const [name, raw] of invalidRawRecords) {
    assert.throws(
      () => record('0', timestampMs, raw),
      /raw/i,
      `expected ${name} to be rejected`
    );
  }
});

test('rejects symbol keys even when their values are otherwise valid', () => {
  const raw = { visible: true } as Record<PropertyKey, unknown>;
  raw[Symbol('hidden')] = 'value';

  assert.throws(() => record('0', timestampMs, raw), /raw/i);
});

test('rejects non-plain prototypes at the root and when nested', () => {
  class RawRecord {
    readonly value = 1;
  }

  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.value = 1;

  for (const raw of [
    nullPrototype,
    new Date(0),
    new RawRecord(),
    { nested: new Date(0) }
  ]) {
    assert.throws(() => record('0', timestampMs, raw), /raw/i);
  }
});

test('rejects accessors before invoking a getter', () => {
  let getterCalls = 0;
  const raw: Record<string, unknown> = { visible: true };
  Object.defineProperty(raw, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must-not-be-read';
    }
  });

  assert.throws(() => record('0', timestampMs, raw), /raw/i);
  assert.equal(getterCalls, 0);
});

test('rejects setters and custom toJSON functions without invoking them', () => {
  let toJsonCalls = 0;
  const setterRecord: Record<string, unknown> = {};
  Object.defineProperty(setterRecord, 'secret', {
    enumerable: true,
    set(_value: unknown) {}
  });
  const customJson = {
    value: 1,
    toJSON() {
      toJsonCalls += 1;
      return { altered: true };
    }
  };

  assert.throws(() => record('0', timestampMs, setterRecord), /raw/i);
  assert.throws(() => record('0', timestampMs, customJson), /raw/i);
  assert.equal(toJsonCalls, 0);
});

test('rejects direct and indirect cycles', () => {
  const direct: Record<string, unknown> = {};
  direct.self = direct;
  const first: Record<string, unknown> = {};
  const second: Record<string, unknown> = { first };
  first.second = second;

  assert.throws(() => record('0', timestampMs, direct), /raw/i);
  assert.throws(() => record('0', timestampMs, first), /raw/i);
});
