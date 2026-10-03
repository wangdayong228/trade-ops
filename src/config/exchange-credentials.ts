import { createTradeOpsError } from '../errors/trade-ops-error.js';

export interface ExchangeCredentials {
  apiKey: string;
  secret: string;
  password?: string;
}

const PASSWORD_REQUIRED_EXCHANGES = new Set(['bitget', 'okx']);

function requiredCredential(
  value: string | undefined,
  field: string
): string {
  if (value === undefined) {
    throw createTradeOpsError({
      code: 'CONFIG_FIELD_MISSING',
      phase: 'startup',
      subject: { type: 'configuration', field },
      expected: 'non-empty credential',
      actual: 'missing'
    });
  }
  if (value.trim() === '') {
    throw createTradeOpsError({
      code: 'CONFIG_FIELD_INVALID',
      phase: 'startup',
      subject: { type: 'configuration', field },
      expected: 'non-empty credential',
      actual: 'present-but-invalid'
    });
  }
  return value;
}

export function loadExchangeCredentials(
  exchangeId: string,
  env: NodeJS.ProcessEnv = process.env
): ExchangeCredentials {
  const prefix = `TRADING_${exchangeId.replaceAll('-', '_').toUpperCase()}`;
  const apiKeyField = `${prefix}_API_KEY`;
  const secretField = `${prefix}_SECRET`;
  const passwordField = `${prefix}_PASSWORD`;
  const apiKey = requiredCredential(env[apiKeyField], apiKeyField);
  const secret = requiredCredential(env[secretField], secretField);
  const password = env[passwordField];

  if (password === undefined && !PASSWORD_REQUIRED_EXCHANGES.has(exchangeId)) {
    return { apiKey, secret };
  }
  return {
    apiKey,
    secret,
    password: requiredCredential(password, passwordField)
  };
}
