/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import type { Logger } from 'pino';
import * as loggerModule from '../../src/logging/logger.js';
import {
  configuredSecretValues,
  createAppLogger,
  createOperationalLog,
  nonThrowingOperationalLog,
  safeError,
  type OperationalLog
} from '../../src/logging/logger.js';

function captureDestination(output: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    }
  });
}

interface ReconciliationWarningFields {
  readonly strategyId?: string;
  readonly strategyState?: string;
  readonly conclusion?: string;
  readonly failureCode?: string;
  readonly reason?: string;
  readonly role?: string;
  readonly exchangeId?: string;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeOrderId?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly exposureKnown?: boolean;
  readonly marketSpot?: string;
  readonly marketContract?: string;
  readonly preGtcResidual?: string;
  readonly currentResidual?: string;
}

interface WarningOperationalLog {
  warn(
    event: string,
    fields?: Readonly<ReconciliationWarningFields>
  ): void;
}

function warningLog(value: unknown): WarningOperationalLog {
  return value as WarningOperationalLog;
}

function requireReconciliationWarningContract(logger: OperationalLog): void {
  logger.warn('hedge_reconciliation_pending', {
    strategyId: 'strategy-1',
    strategyState: 'EXECUTING',
    conclusion: 'pending',
    failureCode: 'INCONSISTENT_ORDER_STATE',
    reason: 'ORDER_LOOKUP_FAILED',
    role: 'SPOT_MARKET',
    exchangeId: 'bitget',
    strategyOrderId: 'order-1',
    clientOrderId: 'client-1',
    exchangeOrderId: 'exchange-1',
    expected: 'closed',
    actual: 'unknown',
    exposureKnown: true,
    marketSpot: '1',
    marketContract: '0.6',
    preGtcResidual: '0.4',
    currentResidual: '0.4'
  });
}

void requireReconciliationWarningContract;

function capturedEntries(output: readonly string[]): Record<string, unknown>[] {
  return output
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('writes JSON and replaces configured secrets in errors', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const operations = createOperationalLog(
    logger,
    () => ['api-key-value', 'secret-value']
  );

  operations.error(
    'service_startup_failed',
    new Error('request api-key-value failed with secret-value'),
    { phase: 'configuration' }
  );

  const line = JSON.parse(output.join('').trim()) as Record<string, unknown>;
  assert.equal(line.event, 'service_startup_failed');
  assert.equal(line.phase, 'configuration');
  assert.doesNotMatch(JSON.stringify(line), /api-key-value|secret-value/);
  assert.match(JSON.stringify(line), /\[Redacted\]/);
});

test('replaces configured secrets in non-error operational fields', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const operations = createOperationalLog(
    logger,
    () => ['api-key-value', 'secret-value']
  );

  operations.info('service_starting', {
    databasePath: '/data/secret-value.sqlite',
    exchangeIds: ['bitget', 'api-key-value'],
    url: '/api/hedges/failure?apiKey=unconfigured-token'
  });

  const line = JSON.parse(output.join('').trim()) as Record<string, unknown>;
  assert.equal(line.url, '/api/hedges/failure');
  assert.doesNotMatch(
    JSON.stringify(line),
    /api-key-value|secret-value|unconfigured-token/
  );
  assert.match(JSON.stringify(line), /\[Redacted\]/);
});

test('redacts Fastify request URLs before Pino serialization', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));

  logger.info({
    event: 'request_probe',
    req: { url: '/api/hedges/failure?apiKey=must-not-appear' }
  });

  const line = JSON.parse(output.join('').trim()) as {
    req: { url: string };
  };
  assert.equal(line.req.url, '[Redacted]');
  assert.doesNotMatch(JSON.stringify(line), /must-not-appear/);
});

test('safe errors exclude arbitrary enumerable fields and nested causes', () => {
  const error = Object.assign(new Error('database failed'), {
    code: 'SQLITE_ERROR',
    apiKey: 'must-not-appear',
    request: { headers: { authorization: 'must-not-appear' } },
    response: { body: 'must-not-appear' },
    cause: new Error('must-not-appear')
  });

  const safe = safeError(error, ['must-not-appear']);

  assert.deepEqual(Object.keys(safe).sort(), [
    'code',
    'message',
    'stack',
    'type'
  ]);
  assert.deepEqual(
    { type: safe.type, message: safe.message, code: safe.code },
    {
      type: 'Error',
      message: 'database failed',
      code: 'SQLITE_ERROR'
    }
  );
  assert.doesNotMatch(JSON.stringify(safe), /apiKey|request|response|cause/);
});

test('extracts only the six exact non-empty credential values', () => {
  assert.deepEqual(configuredSecretValues({
    TRADING_BITGET_API_KEY: 'bitget-key',
    TRADING_BITGET_SECRET: 'bitget-secret',
    TRADING_BITGET_PASSWORD: '',
    TRADING_OKX_API_KEY: 'okx-key',
    TRADING_OKX_SECRET: 'okx-secret',
    TRADING_OKX_PASSWORD: 'okx-password',
    UNRELATED_SECRET: 'unrelated'
  }), [
    'bitget-key',
    'bitget-secret',
    'okx-key',
    'okx-secret',
    'okx-password'
  ]);
});

test('logger service version matches package metadata', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const packageData = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
  ) as { version: string };

  logger.info({ event: 'version_check' }, 'version_check');

  const line = JSON.parse(output.join('').trim()) as Record<string, unknown>;
  assert.equal(line.version, packageData.version);
});

test('operational logging failures never propagate', () => {
  const logger = {
    info(): never {
      throw new Error('stdout unavailable');
    },
    error(): never {
      throw new Error('stdout unavailable');
    },
    fatal(): never {
      throw new Error('stdout unavailable');
    }
  } as unknown as Logger;
  const operations = createOperationalLog(logger, () => []);

  assert.doesNotThrow(() => operations.info('service_starting'));
  assert.doesNotThrow(() => operations.error('service_failed', new Error()));
  assert.doesNotThrow(() => operations.fatal('service_failed', new Error()));
});

test('injected async operational failures never become unhandled', async () => {
  const failure = new Error('async logging unavailable');
  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const operations = nonThrowingOperationalLog({
      async info(): Promise<void> {
        throw failure;
      },
      async warn(): Promise<void> {
        throw failure;
      },
      async error(): Promise<void> {
        throw failure;
      },
      async fatal(): Promise<void> {
        throw failure;
      }
    });

    operations?.info('service_starting');
    operations?.error('service_failed', failure);
    operations?.fatal('service_failed', failure);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('redact helpers replace exact overlapping configured values longest first', () => {
  const redactText = (loggerModule as Record<string, unknown>).redactText;
  assert.equal(typeof redactText, 'function');
  const redact = redactText as (value: string, secrets: readonly string[]) => string;

  assert.equal(
    redact('token=abc123&short=abc&again=abc123', ['abc', '', 'abc123', 'abc']),
    'token=[Redacted]&short=[Redacted]&again=[Redacted]'
  );
  assert.equal(redact('ABC abc passwordHint=ordinary', ['abc']), 'ABC [Redacted] passwordHint=ordinary');
});

test('UTF-8 prefix helper respects 8192 and 8193 byte boundaries', () => {
  const utf8Prefix = (loggerModule as Record<string, unknown>).utf8Prefix;
  assert.equal(typeof utf8Prefix, 'function');
  const prefix = utf8Prefix as (value: string, maxBytes: number) => string;
  const exact = 'x'.repeat(8192);
  const over = `${'x'.repeat(8191)}界`;

  assert.equal(prefix(exact, 8192), exact);
  const limited = prefix(over, 8192);
  assert.equal(Buffer.byteLength(limited, 'utf8') <= 8192, true);
  assert.equal(limited.includes('\uFFFD'), false);
  assert.equal(/[\uD800-\uDBFF]$/.test(limited), false);
});

test('generic non-throwing log call absorbs sync throws and rejected thenables', async () => {
  const nonThrowingLogCall = (loggerModule as Record<string, unknown>).nonThrowingLogCall;
  assert.equal(typeof nonThrowingLogCall, 'function');
  const call = nonThrowingLogCall as (operation: () => unknown) => void;
  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => call(() => { throw new Error('sync logger failure'); }));
    call(async () => { throw new Error('async logger failure'); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('writes allowlisted reconciliation warnings with every string redacted', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const operations = warningLog(createOperationalLog(
    logger,
    () => ['test-secret']
  ));
  const fields = {
    strategyId: 'strategy-test-secret',
    strategyState: 'EXECUTING-test-secret',
    conclusion: 'pending-test-secret',
    failureCode: 'INCONSISTENT_ORDER_STATE-test-secret',
    reason: 'ORDER_LOOKUP_FAILED-test-secret',
    role: 'SPOT_MARKET-test-secret',
    exchangeId: 'bitget-test-secret',
    strategyOrderId: 'order-test-secret',
    clientOrderId: 'client-test-secret',
    exchangeOrderId: 'exchange-test-secret',
    expected: 'closed-test-secret',
    actual: 'unknown-test-secret',
    exposureKnown: true,
    marketSpot: '1-test-secret',
    marketContract: '0.6-test-secret',
    preGtcResidual: '0.4-test-secret',
    currentResidual: '0.4-test-secret',
    credentials: { apiKey: 'test-secret' },
    rawResponse: 'test-secret'
  };

  operations.warn('hedge_reconciliation_pending-test-secret', fields);

  const [entry] = capturedEntries(output);
  assert.ok(entry !== undefined);
  assert.equal(entry.level, 40);
  assert.equal(entry.event, 'hedge_reconciliation_pending-[Redacted]');
  assert.equal(entry.msg, 'hedge_reconciliation_pending-[Redacted]');
  assert.equal(entry.strategyId, 'strategy-[Redacted]');
  assert.equal(entry.strategyState, 'EXECUTING-[Redacted]');
  assert.equal(entry.conclusion, 'pending-[Redacted]');
  assert.equal(entry.failureCode, 'INCONSISTENT_ORDER_STATE-[Redacted]');
  assert.equal(entry.reason, 'ORDER_LOOKUP_FAILED-[Redacted]');
  assert.equal(entry.role, 'SPOT_MARKET-[Redacted]');
  assert.equal(entry.exchangeId, 'bitget-[Redacted]');
  assert.equal(entry.strategyOrderId, 'order-[Redacted]');
  assert.equal(entry.clientOrderId, 'client-[Redacted]');
  assert.equal(entry.exchangeOrderId, 'exchange-[Redacted]');
  assert.equal(entry.expected, 'closed-[Redacted]');
  assert.equal(entry.actual, 'unknown-[Redacted]');
  assert.equal(entry.exposureKnown, true);
  assert.equal(entry.marketSpot, '1-[Redacted]');
  assert.equal(entry.marketContract, '0.6-[Redacted]');
  assert.equal(entry.preGtcResidual, '0.4-[Redacted]');
  assert.equal(entry.currentResidual, '0.4-[Redacted]');
  assert.equal('credentials' in entry, false);
  assert.equal('rawResponse' in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /test-secret/);
});

test('writes partial reconciliation warnings without inventing absent fields', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const operations = warningLog(createOperationalLog(logger, () => []));

  operations.warn('reconciliation_without_fields');
  operations.warn('reconciliation_unknown_exposure', {
    exposureKnown: false
  });

  const [withoutFields, unknownExposure] = capturedEntries(output);
  assert.ok(withoutFields !== undefined);
  assert.ok(unknownExposure !== undefined);
  assert.equal('strategyState' in withoutFields, false);
  assert.equal('exposureKnown' in withoutFields, false);
  assert.equal(unknownExposure.exposureKnown, false);
  assert.equal('reason' in unknownExposure, false);
});

test('absorbs createOperationalLog warning failures', () => {
  const throwingPino = {
    warn(): never {
      throw new Error('stdout unavailable');
    }
  } as unknown as Logger;
  const throwingWarning = warningLog(createOperationalLog(
    throwingPino,
    () => []
  ));
  assert.doesNotThrow(() => throwingWarning.warn('sync_warning'));

  let warningCalls = 0;
  const countingPino = {
    warn(): void {
      warningCalls += 1;
    }
  } as unknown as Logger;
  const providerFailure = warningLog(createOperationalLog(countingPino, () => {
    throw new Error('secret provider unavailable');
  }));
  assert.doesNotThrow(() => providerFailure.warn('provider_warning'));
  assert.equal(warningCalls, 0);
});

test('absorbs synchronous and asynchronous warning failures', async () => {
  const synchronousInjected = {
    info(): void {},
    warn(): never {
      throw new Error('sync warning failure');
    },
    error(): void {},
    fatal(): void {}
  };
  const synchronous = warningLog(
    nonThrowingOperationalLog(synchronousInjected)
  );
  assert.doesNotThrow(() => synchronous.warn('sync_warning'));

  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const asynchronousInjected = {
      info(): void {},
      warn(): never {
        return Promise.reject(new Error('async warning failure')) as never;
      },
      error(): void {},
      fatal(): void {}
    };
    const asynchronous = warningLog(
      nonThrowingOperationalLog(asynchronousInjected)
    );
    asynchronous.warn('async_warning');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
