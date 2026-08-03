/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_ERROR_TEXT_LIMIT,
  publicErrorDetail
} from '../../src/http/public-error.js';

const TRUNCATION_SUFFIX = '…[truncated]';

test('returns only bounded redacted type code and message', () => {
  const error = Object.assign(
    new Error(`credential-value failed ${'x'.repeat(2_100)}`),
    {
      name: 'AuthenticationError',
      code: 401,
      apiKey: 'credential-value',
      request: { apiKey: 'credential-value' },
      response: { body: 'credential-value' },
      cause: new Error('credential-value nested')
    }
  );

  const detail = publicErrorDetail(error, ['credential-value']);

  assert.equal(detail.type, 'AuthenticationError');
  assert.equal(detail.code, 401);
  assert.match(detail.message, /\[Redacted\]/);
  assert.match(detail.message, /…\[truncated\]$/);
  assert.ok(detail.message.length <= PUBLIC_ERROR_TEXT_LIMIT);
  assert.deepEqual(Object.keys(detail).sort(), ['code', 'message', 'type']);
  assert.doesNotMatch(
    JSON.stringify(detail),
    /credential-value|apiKey|request|response|cause|stack/
  );
});

test('preserves a redacted string code and handles primitive throws', () => {
  const coded = Object.assign(new Error('request failed'), {
    code: 'AUTH-secret-value'
  });

  assert.deepEqual(publicErrorDetail(coded, ['secret-value']), {
    type: 'Error',
    message: 'request failed',
    code: 'AUTH-[Redacted]'
  });
  assert.deepEqual(publicErrorDetail('plain failure', []), {
    type: 'UnknownError',
    message: 'plain failure'
  });
});

test('fails safely when error property getters throw', () => {
  const hostile = {};
  for (const property of ['name', 'message', 'code', 'stack']) {
    Object.defineProperty(hostile, property, {
      get(): never {
        throw new Error(`blocked ${property}`);
      }
    });
  }

  assert.doesNotThrow(() => publicErrorDetail(hostile, []));
  assert.deepEqual(publicErrorDetail(hostile, []), {
    type: 'UnknownError',
    message: 'Unknown error'
  });
});

test('omits non-finite numeric codes and ignores empty secrets', () => {
  const error = Object.assign(new Error('visible message'), {
    code: Number.POSITIVE_INFINITY
  });

  assert.deepEqual(publicErrorDetail(error, ['', '']), {
    type: 'Error',
    message: 'visible message'
  });
});

test('bounds oversized type and string code fields', () => {
  const error = Object.assign(new Error('short message'), {
    name: `Type-${'t'.repeat(2_100)}`,
    code: `CODE-${'c'.repeat(2_100)}`
  });

  const detail = publicErrorDetail(error, []);

  assert.equal(detail.type.length, PUBLIC_ERROR_TEXT_LIMIT);
  assert.equal(String(detail.code).length, PUBLIC_ERROR_TEXT_LIMIT);
  assert.equal(detail.type.endsWith(TRUNCATION_SUFFIX), true);
  assert.equal(String(detail.code).endsWith(TRUNCATION_SUFFIX), true);
  assert.equal(detail.message, 'short message');
});
