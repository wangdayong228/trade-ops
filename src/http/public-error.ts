import {
  createTradeOpsError,
  withErrorPhase,
  type ErrorDetail,
  type TradeOpsError
} from '../errors/trade-ops-error.js';

export type PublicErrorDetail = ErrorDetail;

export function publicErrorDetail(
  error: unknown,
  secrets: readonly string[]
): PublicErrorDetail | undefined {
  let trusted: TradeOpsError;
  try {
    trusted = error as TradeOpsError;
    withErrorPhase(trusted, 'request');
  } catch {
    return undefined;
  }

  try {
    const detail = trusted.detail;
    return createTradeOpsError({
      code: detail.code,
      phase: detail.phase,
      subject: detail.subject,
      expected: detail.expected,
      actual: detail.actual,
      occurredAt: detail.occurredAt
    }, secrets).detail;
  } catch {
    return undefined;
  }
}
