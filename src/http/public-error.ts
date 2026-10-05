import {
  projectTradeOpsError,
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
    return projectTradeOpsError(trusted, secrets, false);
  } catch {
    return undefined;
  }
}
