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
  safeError
} from '../../src/logging/logger.js';

function captureDestination(output: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    }
  });
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
