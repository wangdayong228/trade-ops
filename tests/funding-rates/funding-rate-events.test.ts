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

const SYNTHETIC_ERROR = {
  name: 'SyntheticExchangeError',
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
    {
      event: 'funding_market_discovery_completed',
      exchangeId: 'bitget',
      phase: 'discovery'
    },
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
    {
      event: 'funding_request_retry',
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
    },
    {
      event: 'funding_task_incomplete',
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
    },
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

test('builder allowlists event, request, query, and safe error fields independently', () => {
  const unsafeInput = {
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

  assert.deepEqual(event, {
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
  }), {
    apiKey: forbidden,
    secret: forbidden,
    headers: { authorization: forbidden },
    rawResponse: forbidden,
    cause: new Error(forbidden),
    exchangeId: `okx-${secret}`,
    exchangeMarketId: `BTC-${secret}-SWAP`,
    symbol: `BTC/${secret}:USDT`,
    phase: `coverage-${secret}`,
    cursor: {
      exchangeId: `okx-${secret}`,
      afterMs: 1_700_000_000_000,
      apiKey: forbidden
    },
    request: {
      method: `GET-${secret}`,
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
  assert.equal(line.exchangeId, 'okx-[Redacted]');
  assert.equal(line.exchangeMarketId, 'BTC-[Redacted]-SWAP');
  assert.equal(line.symbol, 'BTC/[Redacted]:USDT');
  assert.equal(line.phase, 'coverage-[Redacted]');
  assert.deepEqual(line.cursor, {
    exchangeId: 'okx-[Redacted]',
    afterMs: 1_700_000_000_000
  });
  assert.deepEqual(line.request, {
    method: 'GET-[Redacted]',
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
