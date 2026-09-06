/// <reference types="node" />

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import type { Logger } from 'pino';
import {
  createAppLogger
} from '../../src/logging/logger.js';
import {
  MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES,
  NOOP_FUNDING_RATE_EVENT_SINK,
  PinoFundingRateEventSink,
  fundingRateEvent,
  nonThrowingFundingRateEventSink,
  type FundingRateEvent,
  type FundingRateEventInput
} from '../../src/funding-rates/funding-rate-events.js';

const APPROVED_EVENT_NAMES = [
  'funding_sync_started',
  'funding_sync_stopped',
  'funding_market_discovery_completed',
  'funding_market_discovery_incomplete',
  'funding_coverage_started',
  'funding_page_committed',
  'funding_coverage_completed',
  'funding_incremental_completed',
  'funding_incremental_blocked',
  'funding_request_retry',
  'funding_task_incomplete',
  'funding_rate_revised',
  'funding_sync_fatal'
] as const;

type ApprovedEventName = typeof APPROVED_EVENT_NAMES[number];
type IsAny<Value> = 0 extends (1 & Value) ? true : false;
type MissingDiscriminant = {
  [Name in ApprovedEventName]: Extract<
    FundingRateEvent,
    { readonly event: Name }
  > extends never ? Name : never;
}[ApprovedEventName];
type ExtraDiscriminant = Exclude<
  FundingRateEvent['event'],
  ApprovedEventName
>;
type IsExactDiscriminatedEventUnion = IsAny<FundingRateEvent> extends true
  ? false
  : MissingDiscriminant extends never
    ? ExtraDiscriminant extends never
      ? true
      : false
    : false;
type EnforcedEventUnionContract = IsAny<FundingRateEvent> extends true
  ? boolean
  : IsExactDiscriminatedEventUnion;
const IS_EXACT_DISCRIMINATED_EVENT_UNION: EnforcedEventUnionContract = true;

type TypeEqual<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (
  <Value>() => Value extends Right ? 1 : 2
) ? true : false;
type AssertType<Condition extends true> = Condition;
type EventWithName<Name extends FundingRateEvent['event']> = Extract<
  FundingRateEvent,
  { readonly event: Name }
>;
type EventWithCategory<Event, Category extends string> = Extract<
  Event,
  { readonly taskCategory: Category }
>;
type TaskCategoryOf<Event> = Event extends {
  readonly taskCategory: infer Category;
} ? Category : never;

type RetryEvent = EventWithName<'funding_request_retry'>;
type IncompleteEvent = EventWithName<'funding_task_incomplete'>;
type RetryCategoriesAreExact = AssertType<TypeEqual<
  TaskCategoryOf<RetryEvent>,
  'coverage' | 'incremental' | 'discovery'
>>;
type IncompleteCategoriesAreExact = AssertType<TypeEqual<
  TaskCategoryOf<IncompleteEvent>,
  'coverage' | 'incremental'
>>;
type CoverageRetryKeysAreExact = AssertType<TypeEqual<
  keyof EventWithCategory<RetryEvent, 'coverage'>,
  | 'event'
  | 'taskCategory'
  | 'exchangeId'
  | 'exchangeMarketId'
  | 'symbol'
  | 'phase'
  | 'taskKind'
  | 'generation'
  | 'coverageCutoffMs'
  | 'cursor'
  | 'retryAttempt'
  | 'retryDelayMs'
  | 'request'
  | 'error'
>>;
type IncrementalRetryKeysAreExact = AssertType<TypeEqual<
  keyof EventWithCategory<RetryEvent, 'incremental'>,
  | 'event'
  | 'taskCategory'
  | 'exchangeId'
  | 'exchangeMarketId'
  | 'symbol'
  | 'phase'
  | 'generation'
  | 'frozenBoundaryMs'
  | 'cursor'
  | 'retryAttempt'
  | 'retryDelayMs'
  | 'request'
  | 'error'
>>;
type DiscoveryRetryKeysAreExact = AssertType<TypeEqual<
  keyof EventWithCategory<RetryEvent, 'discovery'>,
  | 'event'
  | 'taskCategory'
  | 'exchangeId'
  | 'phase'
  | 'retryAttempt'
  | 'retryDelayMs'
  | 'request'
  | 'error'
>>;
type CoverageIncompleteKeysAreExact = AssertType<TypeEqual<
  keyof EventWithCategory<IncompleteEvent, 'coverage'>,
  | 'event'
  | 'taskCategory'
  | 'exchangeId'
  | 'exchangeMarketId'
  | 'symbol'
  | 'phase'
  | 'taskKind'
  | 'generation'
  | 'coverageCutoffMs'
  | 'cursor'
  | 'request'
  | 'error'
>>;
type IncrementalIncompleteKeysAreExact = AssertType<TypeEqual<
  keyof EventWithCategory<IncompleteEvent, 'incremental'>,
  | 'event'
  | 'taskCategory'
  | 'exchangeId'
  | 'exchangeMarketId'
  | 'symbol'
  | 'phase'
  | 'generation'
  | 'frozenBoundaryMs'
  | 'cursor'
  | 'request'
  | 'error'
>>;

const SYNTHETIC_ERROR = {
  name: 'SyntheticExchangeError',
  message: 'public request failed',
  code: 'ETIMEDOUT',
  stack: 'SyntheticExchangeError: public request failed\n    at synthetic:test'
};

const SAFE_SYNTHETIC_ERROR = {
  type: 'SyntheticExchangeError',
  message: 'public request failed',
  code: 'ETIMEDOUT',
  stack: 'SyntheticExchangeError: public request failed\n    at synthetic:test'
};

const BITGET_REQUEST = {
  method: 'GET',
  path: '/api/v2/mix/market/history-fund-rate',
  query: {
    symbol: 'BTCUSDT',
    productType: 'USDT-FUTURES',
    pageNo: 3,
    pageSize: 100
  },
  body: null
} as const;

const OKX_REQUEST = {
  method: 'GET',
  path: '/api/v5/public/funding-rate-history',
  query: {
    instId: 'BTC-USDT-SWAP',
    after: '1700000000000',
    limit: 400
  },
  body: null
} as const;

const OKX_DISCOVERY_REQUEST = {
  method: 'GET',
  path: '/api/v5/public/instruments',
  query: { instType: 'SWAP' },
  body: null
} as const;

const DISCOVERY_COMPLETED_INPUT = {
  event: 'funding_market_discovery_completed',
  exchangeId: 'bitget',
  phase: 'market-discovery-complete',
  observedActiveCount: 3,
  observedInactiveCount: 2,
  createdActiveCount: 1,
  becameInactiveCount: 1,
  reactivatedCount: 1
} as const;

function captureDestination(output: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    }
  });
}

function eventByName<Name extends FundingRateEvent['event']>(
  events: readonly FundingRateEvent[],
  name: Name
): Extract<FundingRateEvent, { readonly event: Name }> {
  const found = events.find((event) => event.event === name);
  assert.ok(found);
  return found as Extract<FundingRateEvent, { readonly event: Name }>;
}

test('builds the closed discriminated union of thirteen production events', () => {
  const inputs: readonly FundingRateEventInput[] = [
    { event: 'funding_sync_started', phase: 'startup' },
    { event: 'funding_sync_stopped', phase: 'shutdown' },
    DISCOVERY_COMPLETED_INPUT,
    {
      event: 'funding_market_discovery_incomplete',
      exchangeId: 'okx',
      phase: 'discovery',
      request: OKX_REQUEST,
      error: SYNTHETIC_ERROR
    },
    {
      event: 'funding_coverage_started',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'INITIAL',
      generation: 7,
      coverageCutoffMs: 1_700_000_000_000,
      cursor: { exchangeId: 'bitget', pageNo: 1 }
    },
    {
      event: 'funding_page_committed',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'INITIAL',
      generation: 7,
      cursor: { exchangeId: 'bitget', pageNo: 3 },
      inserted: 2,
      unchanged: 1,
      revised: 0
    },
    {
      event: 'funding_coverage_completed',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'INITIAL',
      generation: 7,
      coverageCutoffMs: 1_700_000_000_000,
      lastCaughtUpCutoffMs: 1_700_000_000_000
    },
    {
      event: 'funding_incremental_completed',
      exchangeId: 'okx',
      exchangeMarketId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
      phase: 'incremental',
      generation: 8,
      inserted: 1,
      unchanged: 3,
      revised: 1
    },
    {
      event: 'funding_incremental_blocked',
      exchangeId: 'okx',
      exchangeMarketId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
      phase: 'incremental',
      generation: 8
    },
    ({
      event: 'funding_request_retry',
      taskCategory: 'coverage',
      exchangeId: 'okx',
      exchangeMarketId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'PERIODIC',
      generation: 9,
      coverageCutoffMs: 1_700_000_000_001,
      cursor: { exchangeId: 'okx', afterMs: 1_700_000_000_000 },
      retryAttempt: 2,
      retryDelayMs: 2_000,
      request: OKX_REQUEST,
      error: SYNTHETIC_ERROR
    } as unknown as FundingRateEventInput),
    ({
      event: 'funding_task_incomplete',
      taskCategory: 'coverage',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'INACTIVE_FINAL',
      generation: 10,
      coverageCutoffMs: 1_700_000_000_002,
      cursor: { exchangeId: 'bitget', pageNo: 4 },
      request: BITGET_REQUEST,
      error: SYNTHETIC_ERROR
    } as unknown as FundingRateEventInput),
    {
      event: 'funding_rate_revised',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'repository',
      fundingTimestampMs: 1_700_000_000_000,
      previousContentHash: 'a'.repeat(64),
      currentContentHash: 'b'.repeat(64)
    },
    {
      event: 'funding_sync_fatal',
      phase: 'lifecycle',
      error: SYNTHETIC_ERROR
    }
  ];

  const events = inputs.map((input) => fundingRateEvent(input));

  assert.equal(IS_EXACT_DISCRIMINATED_EVENT_UNION, true);
  assert.deepEqual(
    events.map((event: FundingRateEvent) => event.event),
    APPROVED_EVENT_NAMES
  );
  assert.deepEqual(eventByName(events, 'funding_page_committed'), {
    event: 'funding_page_committed',
    exchangeId: 'bitget',
    exchangeMarketId: 'BTCUSDT',
    symbol: 'BTC/USDT:USDT',
    phase: 'coverage',
    taskKind: 'INITIAL',
    generation: 7,
    cursor: { exchangeId: 'bitget', pageNo: 3 },
    inserted: 2,
    unchanged: 1,
    revised: 0
  });
  assert.deepEqual(eventByName(events, 'funding_coverage_completed'), {
    event: 'funding_coverage_completed',
    exchangeId: 'bitget',
    exchangeMarketId: 'BTCUSDT',
    symbol: 'BTC/USDT:USDT',
    phase: 'coverage',
    taskKind: 'INITIAL',
    generation: 7,
    coverageCutoffMs: 1_700_000_000_000,
    lastCaughtUpCutoffMs: 1_700_000_000_000
  });
  assert.throws(
    () => Reflect.apply(fundingRateEvent, undefined, [{
      event: 'funding_not_approved',
      phase: 'test'
    }]),
    /event|approved|unsupported/i
  );
});

test('discovery completion builder keeps only the committed count summary', () => {
  const input = {
    ...DISCOVERY_COMPLETED_INPUT,
    createdActiveMarketIds: ['BTCUSDT'],
    becameInactiveMarketIds: ['ETHUSDT'],
    reactivatedMarketIds: ['SOLUSDT'],
    credentials: 'MUST-NOT-BE-LOGGED'
  };

  assert.deepEqual(fundingRateEvent(input), DISCOVERY_COMPLETED_INPUT);
});

test('discovery completion counts are required non-negative safe integers', () => {
  const countFields = [
    'observedActiveCount',
    'observedInactiveCount',
    'createdActiveCount',
    'becameInactiveCount',
    'reactivatedCount'
  ] as const;
  const invalidValues = [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    Number.NaN
  ] as const;

  for (const field of countFields) {
    const missing = { ...DISCOVERY_COMPLETED_INPUT };
    Reflect.deleteProperty(missing, field);
    assert.throws(
      () => Reflect.apply(fundingRateEvent, undefined, [missing]),
      new RegExp(field)
    );
    for (const invalidValue of invalidValues) {
      assert.throws(
        () => Reflect.apply(fundingRateEvent, undefined, [{
          ...DISCOVERY_COMPLETED_INPUT,
          [field]: invalidValue
        }]),
        new RegExp(field)
      );
    }
    for (const boundary of [0, Number.MAX_SAFE_INTEGER]) {
      const event = Reflect.apply(fundingRateEvent, undefined, [{
        ...DISCOVERY_COMPLETED_INPUT,
        [field]: boundary
      }]);
      assert.equal(Reflect.get(event, field), boundary);
    }
  }
});

test('Pino sink preserves discovery counts without logging transition IDs', () => {
  const output: string[] = [];
  const sink = new PinoFundingRateEventSink(
    createAppLogger(captureDestination(output))
  );
  const event = {
    ...DISCOVERY_COMPLETED_INPUT,
    createdActiveMarketIds: ['BTCUSDT'],
    becameInactiveMarketIds: ['ETHUSDT'],
    reactivatedMarketIds: ['SOLUSDT']
  };

  sink.record(event);

  assert.equal(output.length, 1);
  const logged = JSON.parse(output[0] ?? '') as Record<string, unknown>;
  assert.deepEqual({
    event: logged.event,
    exchangeId: logged.exchangeId,
    phase: logged.phase,
    observedActiveCount: logged.observedActiveCount,
    observedInactiveCount: logged.observedInactiveCount,
    createdActiveCount: logged.createdActiveCount,
    becameInactiveCount: logged.becameInactiveCount,
    reactivatedCount: logged.reactivatedCount
  }, DISCOVERY_COMPLETED_INPUT);
  assert.doesNotMatch(
    JSON.stringify(logged),
    /createdActiveMarketIds|becameInactiveMarketIds|reactivatedMarketIds|BTCUSDT|ETHUSDT|SOLUSDT/
  );
});

test('builder allowlists event, request, query, and safe error fields independently', () => {
  const unsafeInput = {
    event: 'funding_request_retry',
    taskCategory: 'coverage',
    exchangeId: 'okx',
    exchangeMarketId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    phase: 'coverage',
    taskKind: 'REACTIVATION',
    generation: 12,
    coverageCutoffMs: 1_700_000_000_003,
    cursor: { exchangeId: 'okx', afterMs: 1_700_000_000_000 },
    retryAttempt: 3,
    retryDelayMs: 4_000,
    request: {
      method: 'GET',
      path: '/api/v5/public/funding-rate-history',
      query: {
        symbol: 'BTCUSDT',
        productType: 'USDT-FUTURES',
        pageNo: 2,
        pageSize: 100,
        instType: 'SWAP',
        instId: 'BTC-USDT-SWAP',
        after: '1700000000000',
        limit: 400,
        apiKey: 'FORBIDDEN-QUERY-KEY',
        nested: { secret: 'FORBIDDEN-NESTED-QUERY' }
      },
      body: { secret: 'FORBIDDEN-BODY' },
      headers: { authorization: 'FORBIDDEN-HEADER' },
      rawResponse: { body: 'FORBIDDEN-RESPONSE' }
    },
    error: {
      ...SYNTHETIC_ERROR,
      apiKey: 'FORBIDDEN-ERROR-KEY',
      headers: { authorization: 'FORBIDDEN-ERROR-HEADER' },
      rawResponse: 'FORBIDDEN-ERROR-RESPONSE',
      cause: new Error('FORBIDDEN-CAUSE')
    },
    apiKey: 'FORBIDDEN-ROOT-API-KEY',
    secret: 'FORBIDDEN-ROOT-SECRET',
    headers: { authorization: 'FORBIDDEN-ROOT-HEADER' },
    rawResponse: 'FORBIDDEN-ROOT-RESPONSE',
    cause: new Error('FORBIDDEN-ROOT-CAUSE')
  } as unknown as FundingRateEventInput;

  const event = fundingRateEvent(unsafeInput);
  const {
    taskCategory: _taskCategory,
    ...eventWithoutTaskCategory
  } = event as FundingRateEvent & { readonly taskCategory?: unknown };

  assert.deepEqual(eventWithoutTaskCategory, {
    event: 'funding_request_retry',
    exchangeId: 'okx',
    exchangeMarketId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    phase: 'coverage',
    taskKind: 'REACTIVATION',
    generation: 12,
    coverageCutoffMs: 1_700_000_000_003,
    cursor: { exchangeId: 'okx', afterMs: 1_700_000_000_000 },
    retryAttempt: 3,
    retryDelayMs: 4_000,
    request: {
      method: 'GET',
      path: '/api/v5/public/funding-rate-history',
      query: {
        symbol: 'BTCUSDT',
        productType: 'USDT-FUTURES',
        pageNo: 2,
        pageSize: 100,
        instType: 'SWAP',
        instId: 'BTC-USDT-SWAP',
        after: '1700000000000',
        limit: 400
      },
      body: null
    },
    error: {
      type: 'SyntheticExchangeError',
      message: 'public request failed',
      code: 'ETIMEDOUT',
      stack: 'SyntheticExchangeError: public request failed\n    at synthetic:test'
    }
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /apiKey|secret|headers|rawResponse|cause|FORBIDDEN|nested/
  );

  const withoutStringCode = fundingRateEvent({
    event: 'funding_sync_fatal',
    phase: 'lifecycle',
    error: {
      name: 'SyntheticError',
      message: 'failed',
      code: 503
    }
  });
  assert.deepEqual(withoutStringCode.error, {
    type: 'SyntheticError',
    message: 'failed'
  });
});

test('Pino sink reapplies nested allowlists, redacts every emitted string, and truncates UTF-8 safely', () => {
  const secret = 'SYNTHETIC-CREDENTIAL-VALUE';
  const forbidden = 'MUST-NOT-BE-LOGGED';
  const output: string[] = [];
  const sink = new PinoFundingRateEventSink(
    createAppLogger(captureDestination(output)),
    () => [secret]
  );
  const redaction = '[Redacted]';
  assert.ok(
    MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES
      > Buffer.byteLength(redaction, 'utf8') + 1
  );
  const asciiAfterRedaction = 'x'.repeat(
    MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES
      - Buffer.byteLength(redaction, 'utf8')
      - 1
  );
  const longMessage = `${secret}${asciiAfterRedaction}界`;
  const unsafeEvent = Object.assign(fundingRateEvent({
    event: 'funding_request_retry',
    taskCategory: 'coverage',
    exchangeId: 'okx',
    exchangeMarketId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    phase: 'coverage',
    taskKind: 'PERIODIC',
    generation: 13,
    coverageCutoffMs: 1_700_000_000_004,
    cursor: { exchangeId: 'okx', afterMs: 1_700_000_000_000 },
    retryAttempt: 1,
    retryDelayMs: 1_000,
    request: OKX_REQUEST,
    error: SYNTHETIC_ERROR
  } as unknown as FundingRateEventInput), {
    apiKey: forbidden,
    secret: forbidden,
    headers: { authorization: forbidden },
    rawResponse: forbidden,
    cause: new Error(forbidden),
    exchangeId: 'okx',
    exchangeMarketId: `BTC-${secret}-SWAP`,
    symbol: `BTC/${secret}:USDT`,
    phase: `coverage-${secret}`,
    cursor: {
      exchangeId: 'okx',
      afterMs: 1_700_000_000_000,
      apiKey: forbidden
    },
    request: {
      method: 'GET',
      path: `/api/${secret}/funding-rate-history`,
      query: {
        symbol: `BTC-${secret}`,
        instId: `BTC-${secret}-SWAP`,
        after: `1700000000000-${secret}`,
        limit: 400,
        authorization: forbidden,
        pageNo: { apiKey: forbidden }
      },
      body: null,
      headers: { authorization: forbidden },
      rawResponse: forbidden
    },
    error: {
      type: `Synthetic-${secret}`,
      message: longMessage,
      code: `E-${secret}`,
      stack: `Synthetic-${secret}: ${secret}`,
      apiKey: forbidden,
      cause: new Error(forbidden)
    }
  }) as FundingRateEvent;

  sink.record(unsafeEvent);

  assert.equal(Number.isSafeInteger(
    MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES
  ), true);
  assert.ok(MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES > 0);
  const line = JSON.parse(output.join('').trim()) as Record<string, unknown>;
  assert.equal(line.component, 'funding-rates');
  assert.equal(line.exchangeId, 'okx');
  assert.equal(line.exchangeMarketId, 'BTC-[Redacted]-SWAP');
  assert.equal(line.symbol, 'BTC/[Redacted]:USDT');
  assert.equal(line.phase, 'coverage-[Redacted]');
  assert.deepEqual(line.cursor, {
    exchangeId: 'okx',
    afterMs: 1_700_000_000_000
  });
  assert.deepEqual(line.request, {
    method: 'GET',
    path: '/api/[Redacted]/funding-rate-history',
    query: {
      symbol: 'BTC-[Redacted]',
      instId: 'BTC-[Redacted]-SWAP',
      after: '1700000000000-[Redacted]',
      limit: 400
    },
    body: null
  });
  const error = line.error as Record<string, unknown>;
  assert.equal(error.type, 'Synthetic-[Redacted]');
  assert.equal(error.code, 'E-[Redacted]');
  assert.equal(error.stack, 'Synthetic-[Redacted]: [Redacted]');
  assert.equal(typeof error.message, 'string');
  assert.equal(error.message, `${redaction}${asciiAfterRedaction}`);
  assert.equal(
    Buffer.byteLength(error.message as string, 'utf8'),
    MAX_FUNDING_RATE_EVENT_ERROR_FIELD_BYTES - 1
  );
  assert.doesNotMatch(error.message as string, /\uFFFD/);
  assert.doesNotMatch(error.message as string, /[\uD800-\uDBFF]$/);
  assert.doesNotMatch(
    JSON.stringify(line),
    new RegExp(`${secret}|${forbidden}|apiKey|headers|rawResponse|cause|authorization`)
  );
});

test('builder rejects object-valued scalars and sink emits nothing for the same pollution', () => {
  const secret = 'SYNTHETIC-SCALAR-SECRET';
  const pollution = {
    apiKey: secret,
    headers: { authorization: secret },
    cause: { message: secret }
  };
  const validInput = {
    event: 'funding_request_retry',
    taskCategory: 'coverage',
    exchangeId: 'bitget',
    exchangeMarketId: 'BTCUSDT',
    symbol: 'BTC/USDT:USDT',
    phase: 'coverage',
    taskKind: 'INITIAL',
    generation: 14,
    coverageCutoffMs: 1_700_000_000_005,
    cursor: { exchangeId: 'bitget', pageNo: 2 },
    retryAttempt: 1,
    retryDelayMs: 1_000,
    request: BITGET_REQUEST,
    error: SYNTHETIC_ERROR
  };
  const invalidInputs: readonly [string, FundingRateEventInput][] = [
    ['phase', { ...validInput, phase: pollution } as unknown as FundingRateEventInput],
    [
      'exchangeId',
      { ...validInput, exchangeId: pollution } as unknown as FundingRateEventInput
    ],
    [
      'exchangeMarketId',
      {
        ...validInput,
        exchangeMarketId: pollution
      } as unknown as FundingRateEventInput
    ],
    [
      'symbol',
      { ...validInput, symbol: pollution } as unknown as FundingRateEventInput
    ],
    [
      'request.method',
      {
        ...validInput,
        request: { ...BITGET_REQUEST, method: pollution }
      } as unknown as FundingRateEventInput
    ],
    [
      'request.path',
      {
        ...validInput,
        request: { ...BITGET_REQUEST, path: pollution }
      } as unknown as FundingRateEventInput
    ],
    [
      'cursor.exchangeId',
      {
        ...validInput,
        cursor: { exchangeId: pollution, pageNo: 2 }
      } as unknown as FundingRateEventInput
    ],
    [
      'cursor.pageNo',
      {
        ...validInput,
        cursor: { exchangeId: 'bitget', pageNo: pollution }
      } as unknown as FundingRateEventInput
    ]
  ];
  const acceptedScalarFields: string[] = [];

  for (const [field, input] of invalidInputs) {
    try {
      fundingRateEvent(input);
      acceptedScalarFields.push(field);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
    }
  }

  const output: string[] = [];
  const sink = new PinoFundingRateEventSink(
    createAppLogger(captureDestination(output)),
    () => [secret]
  );
  const pollutedEvent = {
    event: 'funding_request_retry',
    taskCategory: 'coverage',
    exchangeId: pollution,
    exchangeMarketId: pollution,
    symbol: pollution,
    phase: pollution,
    taskKind: 'INITIAL',
    generation: 14,
    coverageCutoffMs: 1_700_000_000_005,
    cursor: { exchangeId: pollution, pageNo: pollution },
    retryAttempt: 1,
    retryDelayMs: 1_000,
    request: {
      ...BITGET_REQUEST,
      method: pollution,
      path: pollution,
      apiKey: secret,
      headers: { authorization: secret },
      cause: { message: secret }
    },
    error: SAFE_SYNTHETIC_ERROR,
    apiKey: secret,
    headers: { authorization: secret },
    cause: { message: secret }
  } as unknown as FundingRateEvent;

  sink.record(pollutedEvent);

  assert.deepEqual({
    acceptedScalarFields,
    loggedLineCount: output.length,
    sensitiveOutput: output.join('').includes(secret)
  }, {
    acceptedScalarFields: [],
    loggedLineCount: 0,
    sensitiveOutput: false
  });
});

test('retry and incomplete events preserve only their discovery, coverage, or incremental contract', () => {
  const expectedEvents = [
    {
      event: 'funding_request_retry',
      taskCategory: 'coverage',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'PERIODIC',
      generation: 15,
      coverageCutoffMs: 1_700_000_000_006,
      cursor: { exchangeId: 'bitget', pageNo: 3 },
      retryAttempt: 2,
      retryDelayMs: 2_000,
      request: BITGET_REQUEST,
      error: SAFE_SYNTHETIC_ERROR
    },
    {
      event: 'funding_request_retry',
      taskCategory: 'incremental',
      exchangeId: 'okx',
      exchangeMarketId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
      phase: 'incremental',
      generation: 16,
      frozenBoundaryMs: 1_699_999_999_999,
      cursor: { exchangeId: 'okx', afterMs: 1_700_000_000_000 },
      retryAttempt: 3,
      retryDelayMs: 4_000,
      request: OKX_REQUEST,
      error: SAFE_SYNTHETIC_ERROR
    },
    {
      event: 'funding_request_retry',
      taskCategory: 'discovery',
      exchangeId: 'okx',
      phase: 'discovery',
      retryAttempt: 1,
      retryDelayMs: 1_000,
      request: OKX_DISCOVERY_REQUEST,
      error: SAFE_SYNTHETIC_ERROR
    },
    {
      event: 'funding_task_incomplete',
      taskCategory: 'coverage',
      exchangeId: 'bitget',
      exchangeMarketId: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      phase: 'coverage',
      taskKind: 'INACTIVE_FINAL',
      generation: 17,
      coverageCutoffMs: 1_700_000_000_007,
      cursor: { exchangeId: 'bitget', pageNo: 4 },
      request: BITGET_REQUEST,
      error: SAFE_SYNTHETIC_ERROR
    },
    {
      event: 'funding_task_incomplete',
      taskCategory: 'incremental',
      exchangeId: 'okx',
      exchangeMarketId: 'BTC-USDT-SWAP',
      symbol: 'BTC/USDT:USDT',
      phase: 'incremental',
      generation: 18,
      frozenBoundaryMs: 1_699_999_999_998,
      cursor: { exchangeId: 'okx', afterMs: 1_699_999_999_999 },
      request: OKX_REQUEST,
      error: SAFE_SYNTHETIC_ERROR
    }
  ] as const;
  const builderInputs = [
    {
      ...expectedEvents[0],
      error: SYNTHETIC_ERROR,
      frozenBoundaryMs: 9
    },
    {
      ...expectedEvents[1],
      error: SYNTHETIC_ERROR,
      taskKind: 'PERIODIC',
      coverageCutoffMs: 9
    },
    {
      ...expectedEvents[2],
      error: SYNTHETIC_ERROR,
      exchangeMarketId: 'MUST-BE-DROPPED',
      symbol: 'MUST-BE-DROPPED',
      taskKind: 'INITIAL',
      generation: 9,
      coverageCutoffMs: 9,
      frozenBoundaryMs: 9,
      cursor: { exchangeId: 'okx', afterMs: null }
    },
    {
      ...expectedEvents[3],
      error: SYNTHETIC_ERROR,
      frozenBoundaryMs: 9
    },
    {
      ...expectedEvents[4],
      error: SYNTHETIC_ERROR,
      taskKind: 'REACTIVATION',
      coverageCutoffMs: 9
    }
  ] as const;
  const builtEvents = builderInputs.map((input) => {
    try {
      return fundingRateEvent(input as unknown as FundingRateEventInput);
    } catch (error) {
      return {
        threw: error instanceof Error ? error.message : 'non-Error thrown'
      };
    }
  });
  const ambiguousInput = {
    ...builderInputs[0],
    taskCategory: undefined
  } as unknown as FundingRateEventInput;
  let ambiguousBuilderRejected = false;
  try {
    fundingRateEvent(ambiguousInput);
  } catch {
    ambiguousBuilderRejected = true;
  }

  const output: string[] = [];
  const sink = new PinoFundingRateEventSink(
    createAppLogger(captureDestination(output))
  );
  const sinkInputs = [
    { ...expectedEvents[0], frozenBoundaryMs: 9 },
    {
      ...expectedEvents[1],
      taskKind: 'PERIODIC',
      coverageCutoffMs: 9
    },
    {
      ...expectedEvents[2],
      exchangeMarketId: 'MUST-BE-DROPPED',
      symbol: 'MUST-BE-DROPPED',
      taskKind: 'INITIAL',
      generation: 9,
      coverageCutoffMs: 9,
      frozenBoundaryMs: 9,
      cursor: { exchangeId: 'okx', afterMs: null }
    },
    { ...expectedEvents[3], frozenBoundaryMs: 9 },
    {
      ...expectedEvents[4],
      taskKind: 'REACTIVATION',
      coverageCutoffMs: 9
    }
  ] as const;
  for (const input of sinkInputs) {
    sink.record(input as unknown as FundingRateEvent);
  }

  const ambiguousOutput: string[] = [];
  const ambiguousSink = new PinoFundingRateEventSink(
    createAppLogger(captureDestination(ambiguousOutput))
  );
  ambiguousSink.record({
    ...expectedEvents[0],
    taskCategory: undefined
  } as unknown as FundingRateEvent);

  const loggedEvents = output.map((entry) => {
    const parsed = JSON.parse(entry) as Record<string, unknown>;
    const event: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(parsed)) {
      if (![
        'level',
        'time',
        'service',
        'version',
        'component',
        'msg'
      ].includes(field)) {
        event[field] = value;
      }
    }
    return event;
  });

  assert.deepEqual({
    builtEvents,
    loggedEvents,
    ambiguousBuilderRejected,
    ambiguousSinkLineCount: ambiguousOutput.length
  }, {
    builtEvents: expectedEvents,
    loggedEvents: expectedEvents,
    ambiguousBuilderRejected: true,
    ambiguousSinkLineCount: 0
  });
});

test('logger, secret provider, and synchronous or asynchronous sink failures never propagate', async () => {
  const event = fundingRateEvent({
    event: 'funding_sync_started',
    phase: 'startup'
  });
  const throwingLogger = {
    child(): Logger {
      return throwingLogger as unknown as Logger;
    },
    info(): never {
      throw new Error('synthetic logger failure');
    }
  } as unknown as Logger;
  const throwingProviderSink = new PinoFundingRateEventSink(
    createAppLogger(captureDestination([])),
    (): readonly string[] => {
      throw new Error('synthetic secret provider failure');
    }
  );
  const syncFailureSink = {
    record(): never {
      throw new Error('synthetic synchronous sink failure');
    }
  };
  const asyncFailureSink = {
    async record(): Promise<void> {
      throw new Error('synthetic asynchronous sink failure');
    }
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    assert.doesNotThrow(() => new PinoFundingRateEventSink(
      throwingLogger,
      () => []
    ).record(event));
    assert.doesNotThrow(() => throwingProviderSink.record(event));
    assert.doesNotThrow(() => nonThrowingFundingRateEventSink(
      syncFailureSink
    ).record(event));
    assert.doesNotThrow(() => nonThrowingFundingRateEventSink(
      asyncFailureSink
    ).record(event));
    assert.doesNotThrow(() => NOOP_FUNDING_RATE_EVENT_SINK.record(event));
    assert.equal(Object.isFrozen(NOOP_FUNDING_RATE_EVENT_SINK), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
