import pino, { type DestinationStream, type Logger } from 'pino';

export const LOGGER_REDACT_PATHS: readonly string[] = [
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

function redactText(
  value: string,
  secrets: readonly string[]
): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length !== 0) {
      redacted = redacted.replaceAll(secret, '[Redacted]');
    }
  }
  return redacted;
}

function operationalFields(
  event: string,
  fields: Readonly<OperationalFields> | undefined
): Record<string, unknown> {
  const output: Record<string, unknown> = { event };
  if (fields?.phase !== undefined) output.phase = fields.phase;
  if (fields?.host !== undefined) output.host = fields.host;
  if (fields?.port !== undefined) output.port = fields.port;
  if (fields?.databasePath !== undefined) {
    output.databasePath = fields.databasePath;
  }
  if (fields?.exchangeIds !== undefined) {
    output.exchangeIds = [...fields.exchangeIds];
  }
  if (fields?.strategyId !== undefined) output.strategyId = fields.strategyId;
  if (fields?.requestId !== undefined) output.requestId = fields.requestId;
  if (fields?.method !== undefined) output.method = fields.method;
  if (fields?.url !== undefined) output.url = fields.url;
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
        logger.info(operationalFields(event, fields), event);
      } catch {
        // Logging is never allowed to change service behavior.
      }
    },
    error(event, error, fields): void {
      try {
        logger.error({
          ...operationalFields(event, fields),
          error: safeError(error, secretProvider())
        }, event);
      } catch {
        // Logging is never allowed to change service behavior.
      }
    },
    fatal(event, error, fields): void {
      try {
        logger.fatal({
          ...operationalFields(event, fields),
          error: safeError(error, secretProvider())
        }, event);
      } catch {
        // Logging is never allowed to change service behavior.
      }
    }
  };
}
