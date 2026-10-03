import { createTradeOpsError } from '../errors/trade-ops-error.js';

const DEFAULT_FUNDING_RATE_SYNC_INTERVAL_MS = 3_600_000;
const MIN_FUNDING_RATE_SYNC_INTERVAL_MS = 60_000;
const MAX_FUNDING_RATE_SYNC_INTERVAL_MS = 86_400_000;
const CANONICAL_UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const DIAGNOSTIC_STRING_LIMIT = 2_000;

function invalidInterval(raw: string): never {
  throw createTradeOpsError({
    code: 'CONFIG_FIELD_INVALID',
    phase: 'startup',
    subject: {
      type: 'configuration',
      field: 'FUNDING_RATE_SYNC_INTERVAL_MS'
    },
    expected: 'canonical unsigned decimal milliseconds from 60000 to 86400000',
    actual: raw.length <= DIAGNOSTIC_STRING_LIMIT
      ? raw
      : `string-length:${raw.length}`
  });
}

export function fundingRateSyncIntervalMs(
  raw: string | undefined
): number {
  if (raw === undefined) {
    return DEFAULT_FUNDING_RATE_SYNC_INTERVAL_MS;
  }
  if (typeof raw !== 'string' || !CANONICAL_UNSIGNED_INTEGER.test(raw)) {
    return invalidInterval(raw);
  }

  const intervalMs = Number(raw);
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_FUNDING_RATE_SYNC_INTERVAL_MS
    || intervalMs > MAX_FUNDING_RATE_SYNC_INTERVAL_MS
  ) {
    return invalidInterval(raw);
  }
  return intervalMs;
}
