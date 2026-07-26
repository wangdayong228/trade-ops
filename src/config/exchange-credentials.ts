export interface ExchangeCredentials {
  apiKey: string;
  secret: string;
  password?: string;
}

const PASSWORD_REQUIRED_EXCHANGES = new Set(['bitget', 'okx']);

function requiredCredential(
  value: string | undefined,
  exchangeId: string
): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing credentials for configured exchange ${exchangeId}`);
  }
  return value;
}

export function loadExchangeCredentials(
  exchangeId: string,
  env: NodeJS.ProcessEnv = process.env
): ExchangeCredentials {
  const prefix = `TRADING_${exchangeId.replaceAll('-', '_').toUpperCase()}`;
  const apiKey = requiredCredential(env[`${prefix}_API_KEY`], exchangeId);
  const secret = requiredCredential(env[`${prefix}_SECRET`], exchangeId);
  const password = env[`${prefix}_PASSWORD`];

  if (password === undefined) {
    if (PASSWORD_REQUIRED_EXCHANGES.has(exchangeId)) {
      throw new Error(`missing credentials for configured exchange ${exchangeId}`);
    }
    return { apiKey, secret };
  }
  if (password.trim() === '') {
    throw new Error(`missing credentials for configured exchange ${exchangeId}`);
  }
  return { apiKey, secret, password };
}
