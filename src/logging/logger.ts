import pino, { type DestinationStream, type Logger } from 'pino';

export const LOGGER_REDACT_PATHS: readonly string[] = [
  'req.url',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.apiKey',
  'req.body.secret',
  'req.body.password',
  'req.body.signature',
  'req.body.credentials.apiKey',
  'req.body.credentials.secret',
  'req.body.credentials.password',
  'req.body.credentials.signature',
  'req.body.auth.apiKey',
  'req.body.auth.secret',
  'req.body.auth.password',
  'req.body.auth.signature'
];

const CREDENTIAL_KEYS = [
  'TRADING_BITGET_API_KEY',
  'TRADING_BITGET_SECRET',
  'TRADING_BITGET_PASSWORD',
  'TRADING_OKX_API_KEY',
  'TRADING_OKX_SECRET',
  'TRADING_OKX_PASSWORD'
] as const;

export interface SafeError {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

export interface OperationalFields {
  readonly phase?: string;
  readonly host?: string;
  readonly port?: number;
  readonly databasePath?: string;
  readonly exchangeIds?: readonly string[];
  readonly strategyId?: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly url?: string;
}

export interface OperationalLog {
  info(event: string, fields?: Readonly<OperationalFields>): void;
  error(
    event: string,
    error: unknown,
    fields?: Readonly<OperationalFields>
  ): void;
  fatal(
    event: string,
    error: unknown,
    fields?: Readonly<OperationalFields>
  ): void;
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function nonEmptySecrets(
  secrets: readonly string[]
): readonly string[] {
  return [...new Set(secrets.filter((secret) => secret.length !== 0))]
    .map((secret, index) => ({ secret, index }))
    .sort((left, right) => (
      Buffer.byteLength(right.secret, 'utf8')
      - Buffer.byteLength(left.secret, 'utf8')
      || left.index - right.index
    ))
    .map(({ secret }) => secret);
}

export function redactText(
  value: string,
  secrets: readonly string[]
): string {
  let redacted = value;
  for (const secret of nonEmptySecrets(secrets)) {
    redacted = redacted.replaceAll(secret, '[Redacted]');
  }
  return redacted;
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function nonThrowingLogCall(call: () => unknown): void {
  try {
    const result = call();
    void Promise.resolve(result).catch(() => {});
  } catch {
    // Logging is never allowed to change service behavior.
  }
}

export function requestPathForLog(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function operationalFields(
  event: string,
  fields: Readonly<OperationalFields> | undefined,
  secrets: readonly string[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    event: redactText(event, secrets)
  };
  if (fields?.phase !== undefined) {
    output.phase = redactText(fields.phase, secrets);
  }
  if (fields?.host !== undefined) {
    output.host = redactText(fields.host, secrets);
  }
  if (fields?.port !== undefined) output.port = fields.port;
  if (fields?.databasePath !== undefined) {
    output.databasePath = redactText(fields.databasePath, secrets);
  }
  if (fields?.exchangeIds !== undefined) {
    output.exchangeIds = fields.exchangeIds.map(
      (exchangeId) => redactText(exchangeId, secrets)
    );
  }
  if (fields?.strategyId !== undefined) {
    output.strategyId = redactText(fields.strategyId, secrets);
  }
  if (fields?.requestId !== undefined) {
    output.requestId = redactText(fields.requestId, secrets);
  }
  if (fields?.method !== undefined) {
    output.method = redactText(fields.method, secrets);
  }
  if (fields?.url !== undefined) {
    output.url = redactText(requestPathForLog(fields.url), secrets);
  }
  return output;
}

export function configuredSecretValues(env: NodeJS.ProcessEnv): string[] {
  return CREDENTIAL_KEYS.flatMap((key) => {
    const value = env[key];
    return value === undefined || value.length === 0 ? [] : [value];
  });
}

export function safeError(
  error: unknown,
  secrets: readonly string[] = []
): SafeError {
  const type = stringProperty(error, 'name') ?? 'UnknownError';
  const rawMessage = stringProperty(error, 'message')
    ?? (typeof error === 'string' ? error : 'Unknown error');
  const code = stringProperty(error, 'code');
  const stack = stringProperty(error, 'stack');
  return {
    type: redactText(type, secrets),
    message: redactText(rawMessage, secrets),
    ...(code === undefined ? {} : { code: redactText(code, secrets) }),
    ...(stack === undefined ? {} : { stack: redactText(stack, secrets) })
  };
}

export function createAppLogger(destination?: DestinationStream): Logger {
  const options = {
    level: 'info',
    base: { service: 'trade-ops', version: '1.0.0' },
    redact: {
      paths: [...LOGGER_REDACT_PATHS],
      censor: '[Redacted]'
    }
  };
  return destination === undefined
    ? pino(options)
    : pino(options, destination);
}

export function createOperationalLog(
  logger: Logger,
  secretProvider: () => readonly string[]
): OperationalLog {
  return {
    info(event, fields): void {
      try {
        const secrets = secretProvider();
        const safeEvent = redactText(event, secrets);
        logger.info(operationalFields(event, fields, secrets), safeEvent);
      } catch {
        // Logging is never allowed to change service behavior.
      }
    },
    error(event, error, fields): void {
      try {
        const secrets = secretProvider();
        const safeEvent = redactText(event, secrets);
        logger.error({
          ...operationalFields(event, fields, secrets),
          error: safeError(error, secrets)
        }, safeEvent);
      } catch {
        // Logging is never allowed to change service behavior.
      }
    },
    fatal(event, error, fields): void {
      try {
        const secrets = secretProvider();
        const safeEvent = redactText(event, secrets);
        logger.fatal({
          ...operationalFields(event, fields, secrets),
          error: safeError(error, secrets)
        }, safeEvent);
      } catch {
        // Logging is never allowed to change service behavior.
      }
    }
  };
}

export function nonThrowingOperationalLog(
  logger: OperationalLog | undefined
): OperationalLog | undefined {
  if (logger === undefined) {
    return undefined;
  }
  return {
    info(event, fields): void {
      try {
        const result: unknown = logger.info(event, fields);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Injected logging is never allowed to change service behavior.
      }
    },
    error(event, error, fields): void {
      try {
        const result: unknown = logger.error(event, error, fields);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Injected logging is never allowed to change service behavior.
      }
    },
    fatal(event, error, fields): void {
      try {
        const result: unknown = logger.fatal(event, error, fields);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Injected logging is never allowed to change service behavior.
      }
    }
  };
}
