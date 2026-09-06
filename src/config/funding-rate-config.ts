const DEFAULT_FUNDING_RATE_SYNC_INTERVAL_MS = 3_600_000;
const MIN_FUNDING_RATE_SYNC_INTERVAL_MS = 60_000;
const MAX_FUNDING_RATE_SYNC_INTERVAL_MS = 86_400_000;
const CANONICAL_UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;

export function fundingRateSyncIntervalMs(
  raw: string | undefined
): number {
  if (raw === undefined) {
    return DEFAULT_FUNDING_RATE_SYNC_INTERVAL_MS;
  }
  if (typeof raw !== 'string' || !CANONICAL_UNSIGNED_INTEGER.test(raw)) {
    throw new Error(
      'Invalid FUNDING_RATE_SYNC_INTERVAL_MS: expected a canonical unsigned decimal integer'
    );
  }

  const intervalMs = Number(raw);
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_FUNDING_RATE_SYNC_INTERVAL_MS
    || intervalMs > MAX_FUNDING_RATE_SYNC_INTERVAL_MS
  ) {
    throw new Error(
      `Invalid FUNDING_RATE_SYNC_INTERVAL_MS: expected ${MIN_FUNDING_RATE_SYNC_INTERVAL_MS}..${MAX_FUNDING_RATE_SYNC_INTERVAL_MS} milliseconds`
    );
  }
  return intervalMs;
}
