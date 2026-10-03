/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { fundingRateSyncIntervalMs } from '../../src/config/funding-rate-config.js';
import {
  withErrorPhase,
  type ErrorDetail,
  type TradeOpsError
} from '../../src/errors/trade-ops-error.js';

function startupDetail(error: unknown): ErrorDetail {
  return withErrorPhase(error as TradeOpsError, 'startup').detail;
}

function assertInvalidInterval(error: unknown, raw: string): boolean {
  const detail = startupDetail(error);
  assert.equal(detail.code, 'CONFIG_FIELD_INVALID');
  assert.equal(detail.phase, 'startup');
  assert.deepEqual(detail.subject, {
    type: 'configuration',
    field: 'FUNDING_RATE_SYNC_INTERVAL_MS'
  });
  assert.equal(detail.actual, raw);
  assert.equal(typeof detail.expected, 'string');
  assert.match(detail.occurredAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  return true;
}

test('defaults the funding rate sync interval to one hour when it is missing', () => {
  assert.equal(fundingRateSyncIntervalMs(undefined), 3_600_000);
});

test('accepts the closed interval boundaries and a representative value', () => {
  for (const [raw, expected] of [
    ['60000', 60_000],
    ['3600000', 3_600_000],
    ['86400000', 86_400_000]
  ] as const) {
    assert.equal(fundingRateSyncIntervalMs(raw), expected);
  }
});

test('rejects empty, padded, signed, and non-canonical interval values', () => {
  for (const raw of [
    '',
    ' ',
    ' 60000',
    '60000 ',
    '+1',
    '+60000',
    '-1',
    '060000',
    '1.0',
    '60000.0',
    '1e6',
    '6e4',
    'not-a-number'
  ]) {
    assert.throws(
      () => fundingRateSyncIntervalMs(raw),
      (error: unknown) => assertInvalidInterval(error, raw),
      `expected ${JSON.stringify(raw)} to be rejected`
    );
  }
});

test('rejects values outside the closed interval and non-safe integers', () => {
  for (const raw of ['59999', '86400001', '9007199254740992']) {
    assert.throws(
      () => fundingRateSyncIntervalMs(raw),
      (error: unknown) => assertInvalidInterval(error, raw),
      `expected ${raw} to be rejected`
    );
  }
});
