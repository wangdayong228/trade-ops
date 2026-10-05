/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTradeOpsError,
  parseErrorDetail
} from '../../src/errors/trade-ops-error.js';
import { publicErrorDetail } from '../../src/http/public-error.js';

const projectPublicError = publicErrorDetail as unknown as (
  error: unknown,
  secrets?: readonly string[]
) => unknown;

test('projects only a trusted TradeOpsError detail', () => {
  const error = createTradeOpsError({
    code: 'BALANCE_INSUFFICIENT',
    phase: 'preflight',
    subject: {
      type: 'account',
      exchangeId: 'bitget',
      symbol: 'BTC/USDT',
      field: 'balance'
    },
    expected: '60000.00000000000000000001 USDT',
    actual: '59999.99999999999999999999 USDT',
    occurredAt: '2026-10-03T00:00:00.000Z'
  });

  const projected = projectPublicError(error, []);

  assert.deepEqual(projected, error.detail);
  assert.deepEqual(parseErrorDetail(projected), error.detail);
  assert.deepEqual(
    Object.keys(projected as unknown as Record<string, unknown>).sort(),
    ['actual', 'code', 'expected', 'message', 'occurredAt', 'phase', 'subject']
  );
});

test('projects trusted cause status and body without stack or configured secrets', () => {
  const configuredSecret = 'SYNTHETIC-PUBLIC-CONFIGURED-SECRET';
  const nativeFailure = Object.assign(
    new Error(`gateway request rejected ${configuredSecret}`, {
      cause: new Error(`upstream socket closed ${configuredSecret}`)
    }),
    {
      code: 'GATEWAY_REJECTED',
      response: {
        status: 429,
        body: `rate limit exceeded ${configuredSecret}`
      }
    }
  );
  nativeFailure.stack = `Error: gateway request rejected ${configuredSecret}\nsynthetic-stack`;
  const error = createTradeOpsError({
    code: 'REQUEST_OPERATION_FAILED',
    phase: 'request',
    subject: { type: 'request', field: 'preflight' },
    expected: 'successful preflight',
    actual: 'object-failure',
    occurredAt: '2026-10-03T00:00:00.000Z'
  }, undefined, { cause: nativeFailure });

  const projected = parseErrorDetail(
    projectPublicError(error, [configuredSecret])
  );
  const serialized = JSON.stringify(projected);

  assert.equal(projected.code, error.detail.code);
  assert.equal(projected.phase, error.detail.phase);
  assert.equal(projected.occurredAt, error.detail.occurredAt);
  assert.match(serialized, /gateway request rejected/);
  assert.match(serialized, /upstream socket closed/);
  assert.match(serialized, /GATEWAY_REJECTED/);
  assert.match(serialized, /429/);
  assert.match(serialized, /rate limit exceeded/);
  assert.doesNotMatch(serialized, new RegExp(configuredSecret));
  assert.doesNotMatch(serialized, /"stack"|synthetic-stack/);
});

test('redacts configured secrets from branded details before public projection', async (t) => {
  const configuredSecret = 'CONFIGURED-PROJECTION-SECRET';
  const occurredAt = '2026-10-03T00:00:00.000Z';
  const cases = [
    {
      name: 'subject',
      input: {
        code: 'EXCHANGE_NOT_CONFIGURED',
        phase: 'preflight',
        subject: {
          type: 'exchange',
          exchangeId: `exchange-${configuredSecret}`,
          operation: 'preflight'
        },
        expected: 'configured exchange',
        actual: 'missing',
        occurredAt
      }
    },
    {
      name: 'expected',
      input: {
        code: 'BALANCE_INSUFFICIENT',
        phase: 'preflight',
        subject: {
          type: 'account',
          exchangeId: 'bitget',
          symbol: 'BTC/USDT',
          field: 'balance'
        },
        expected: `required-${configuredSecret}`,
        actual: 'insufficient balance',
        occurredAt
      }
    },
    {
      name: 'actual list item',
      input: {
        code: 'ACCOUNT_SETTINGS_CONFLICT',
        phase: 'confirmation',
        subject: {
          type: 'account',
          exchangeId: 'okx',
          symbol: 'BTC/USDT',
          field: 'marginMode'
        },
        expected: 'one consistent setting',
        actual: [`observed-${configuredSecret}`],
        occurredAt
      }
    }
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const branded = createTradeOpsError(item.input);
      const expected = createTradeOpsError(
        item.input,
        [configuredSecret]
      ).detail;

      const projected = projectPublicError(branded, [configuredSecret]);

      assert.deepEqual(projected, expected);
      assert.deepEqual(parseErrorDetail(projected), expected);
      assert.doesNotMatch(
        JSON.stringify(projected),
        new RegExp(configuredSecret)
      );
      assert.equal(expected.code, branded.detail.code);
      assert.equal(expected.phase, branded.detail.phase);
      assert.equal(expected.occurredAt, branded.detail.occurredAt);
    });
  }
});

test('does not project arbitrary third-party error properties', () => {
  const sentinel = 'THIRD-PARTY-SECRET-SENTINEL';
  const error = Object.assign(new Error(`${sentinel} raw response`), {
    name: 'AuthenticationError',
    code: '40101',
    apiKey: sentinel,
    request: { authorization: sentinel },
    response: { body: sentinel },
    cause: new Error(`${sentinel} nested`)
  });
  error.stack = `${sentinel} stack`;

  let projected: unknown;
  let thrown: unknown;
  try {
    projected = projectPublicError(error, [sentinel]);
  } catch (failure) {
    thrown = failure;
  }

  assert.equal(
    projected,
    undefined,
    'unknown errors require conversion at a boundary that knows the operation'
  );
  assert.doesNotMatch(
    JSON.stringify(projected) + String(thrown ?? ''),
    new RegExp(sentinel)
  );
});

test('rejects hostile unknown values without invoking property getters', () => {
  let getterCalls = 0;
  const hostile = {};
  for (const property of ['name', 'message', 'code', 'stack', 'cause']) {
    Object.defineProperty(hostile, property, {
      enumerable: true,
      get(): never {
        getterCalls += 1;
        throw new Error(`HOSTILE-${property}`);
      }
    });
  }

  let projected: unknown;
  let thrown: unknown;
  try {
    projected = projectPublicError(hostile, []);
  } catch (failure) {
    thrown = failure;
  }

  assert.equal(getterCalls, 0);
  assert.equal(projected, undefined);
  assert.doesNotMatch(String(thrown ?? ''), /HOSTILE-/);
});
