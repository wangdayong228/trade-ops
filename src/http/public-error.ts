import { safeError } from '../logging/logger.js';

export const PUBLIC_ERROR_TEXT_LIMIT = 2_000;
const TRUNCATION_SUFFIX = '…[truncated]';

export interface PublicErrorDetail {
  readonly type: string;
  readonly message: string;
  readonly code?: string | number;
}

function bounded(value: string): string {
  if (value.length <= PUBLIC_ERROR_TEXT_LIMIT) {
    return value;
  }
  return `${value.slice(
    0,
    PUBLIC_ERROR_TEXT_LIMIT - TRUNCATION_SUFFIX.length
  )}${TRUNCATION_SUFFIX}`;
}

function numericCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  try {
    const value: unknown = Reflect.get(error, 'code');
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function publicErrorDetail(
  error: unknown,
  secrets: readonly string[]
): PublicErrorDetail {
  const safe = safeError(error, secrets);
  const code = safe.code === undefined
    ? numericCode(error)
    : bounded(safe.code);
  return {
    type: bounded(safe.type),
    message: bounded(safe.message),
    ...(code === undefined ? {} : { code })
  };
}
