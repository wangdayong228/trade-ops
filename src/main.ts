import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyListenOptions,
  FastifyServerOptions
} from 'fastify';
import type { Logger } from 'pino';
import { loadEnvironmentFile } from './config/environment-loader.js';
import type { ExchangeCredentials } from './config/exchange-credentials.js';
import { loadExchangeCredentials } from './config/exchange-credentials.js';
import { fundingRateSyncIntervalMs } from './config/funding-rate-config.js';
import {
  createTradeOpsError,
  safeFailureCategory,
  withErrorPhase,
  type DatabaseErrorSubject,
  type ErrorCode,
  type ErrorSubject,
  type SafeDiagnosticValue,
  type TradeOpsError
} from './errors/trade-ops-error.js';
import { CcxtExchangeGateway } from './exchanges/ccxt-exchange-gateway.js';
import type { ExchangeGateway } from './exchanges/exchange-gateway.js';
import { ExchangeRegistry } from './exchanges/exchange-registry.js';
import { createCcxtFundingRateSources } from './funding-rates/ccxt-funding-rate-source-factory.js';
import {
  NOOP_FUNDING_RATE_EVENT_SINK,
  PinoFundingRateEventSink,
  type FundingRateEventSink
} from './funding-rates/funding-rate-events.js';
import type { FundingSleep } from './funding-rates/funding-rate-exchange-worker.js';
import type { FundingRateSource } from './funding-rates/funding-rate-source.js';
import {
  FundingRateSyncService,
  type FundingRateSyncServiceOptions
} from './funding-rates/funding-rate-sync-service.js';
import { buildServer } from './http/server.js';
import {
  configuredSecretValues,
  createAppLogger,
  createOperationalLog,
  nonThrowingOperationalLog,
  type OperationalFields,
  type OperationalLog
} from './logging/logger.js';
import {
  NOOP_TRADE_EVENT_SINK,
  PinoTradeEventSink,
  type TradeEventSink
} from './logging/trade-events.js';
import type { FundingRateRepository } from './storage/funding-rate-repository.js';
import { SqliteFundingRateRepository } from './storage/sqlite-funding-rate-repository.js';
import { claimSqliteProcessOwnership } from './storage/sqlite-process-owner.js';
import { SqliteStrategyRepository } from './storage/sqlite-strategy-repository.js';
import { HedgeCoordinator } from './strategy/hedge-coordinator.js';
import { HedgeReconciliation } from './strategy/hedge-reconciliation.js';
import { OrderMonitor } from './strategy/order-monitor.js';
import { PreflightService } from './strategy/preflight-service.js';
import { ConfirmationService } from './strategy/confirmation-service.js';

export type ConfiguredExchangeId = 'bitget' | 'okx';
export type Clock = () => Date;

export interface RuntimeConfig {
  readonly exchangeIds: readonly ConfiguredExchangeId[];
  readonly credentials: ReadonlyMap<ConfiguredExchangeId, ExchangeCredentials>;
  readonly fundingRateSyncIntervalMs: number;
  readonly databasePath: string;
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
}

export type GatewayFactory = (
  exchangeId: ConfiguredExchangeId,
  credentials: Readonly<ExchangeCredentials>,
  env: NodeJS.ProcessEnv
) => ExchangeGateway;

export type DatabaseFactory = (path: string) => Database.Database;

export interface FundingRateSyncLifecycle {
  start(): void;
  stop(): Promise<void>;
}

export type FundingRateSourceFactory = () => readonly [
  FundingRateSource,
  FundingRateSource
];

export type FundingRateRepositoryFactory = (
  database: Database.Database
) => FundingRateRepository;

export type FundingRateSyncFactory = (
  options: FundingRateSyncServiceOptions
) => FundingRateSyncLifecycle;

export interface ComposeServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly gatewayFactory?: GatewayFactory;
  readonly databaseFactory?: DatabaseFactory;
  readonly fundingRateSourceFactory?: FundingRateSourceFactory;
  readonly fundingRateRepositoryFactory?: FundingRateRepositoryFactory;
  readonly fundingRateSyncFactory?: FundingRateSyncFactory;
  readonly fundingRateEvents?: FundingRateEventSink;
  readonly fundingRateNowMs?: () => number;
  readonly fundingRateSleep?: FundingSleep;
  readonly clock?: Clock;
  readonly logger?: FastifyServerOptions['logger'];
  readonly loggerInstance?: Logger;
  readonly operationalLog?: OperationalLog;
  readonly tradeEvents?: TradeEventSink;
  readonly publicDirectory?: string;
}

export interface ServiceComposition {
  readonly config: RuntimeConfig;
  readonly database: Database.Database;
  readonly registry: ExchangeRegistry;
  readonly repository: SqliteStrategyRepository;
  readonly preflightService: PreflightService;
  readonly coordinator: HedgeCoordinator;
  readonly monitor: OrderMonitor;
  readonly fundingRateSync: FundingRateSyncLifecycle;
  readonly server: FastifyInstance;
}

export interface RunnableComposition {
  readonly config: {
    readonly host: '127.0.0.1' | '::1';
    readonly port: number;
    readonly databasePath?: string;
    readonly exchangeIds?: readonly string[];
  };
  readonly monitor: {
    start(intervalMs: number): () => void;
    stop(): Promise<void>;
  };
  readonly fundingRateSync: FundingRateSyncLifecycle;
  readonly server: {
    listen(options: FastifyListenOptions): Promise<string>;
    close(): Promise<void>;
  };
  readonly database: {
    close(): void;
  };
}

export interface SignalTarget {
  exitCode: number | undefined;
  on(
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void
  ): unknown;
  removeListener(
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void
  ): unknown;
}

export interface StartServiceOptions {
  readonly signalTarget?: SignalTarget;
  readonly listen?: (
    server: RunnableComposition['server'],
    options: FastifyListenOptions
  ) => Promise<unknown>;
  readonly operationalLog?: OperationalLog;
}

export interface StartedService<T extends RunnableComposition> {
  readonly composition: T;
  shutdown(): Promise<void>;
}

export interface RunOptions
  extends ComposeServiceOptions, StartServiceOptions {}

const REQUIRED_EXCHANGE_IDS = [
  'bitget',
  'okx'
] as const satisfies readonly ConfiguredExchangeId[];
const REQUIRED_EXCHANGE_SET = new Set<string>(REQUIRED_EXCHANGE_IDS);
const DEFAULT_DATABASE_PATH = './data/trade-ops.sqlite';
const DEFAULT_HOST: RuntimeConfig['host'] = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MONITOR_INTERVAL_MS = 5000;
const DIAGNOSTIC_STRING_LIMIT = 2_000;
const DATABASE_PATH_LIMIT = 512;

interface StartupFailureContext {
  readonly code: ErrorCode;
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
}

function trustedStartupFailure(error: unknown): TradeOpsError | undefined {
  try {
    return withErrorPhase(error as TradeOpsError, 'startup');
  } catch {
    return undefined;
  }
}

function startupFailure(
  error: unknown,
  context: StartupFailureContext
): TradeOpsError {
  return trustedStartupFailure(error) ?? createTradeOpsError({
    code: context.code,
    phase: 'startup',
    subject: context.subject,
    expected: context.expected,
    actual: safeFailureCategory(error)
  });
}

function runStartupBoundary<Value>(
  action: () => Value,
  context: StartupFailureContext
): Value {
  try {
    return action();
  } catch (error) {
    throw startupFailure(error, context);
  }
}

function componentContext(
  component: string,
  operation: 'constructed' | 'started' | 'stopped'
): StartupFailureContext {
  return {
    code: 'SERVICE_COMPONENT_FAILED',
    subject: {
      type: 'configuration',
      field: `service-component:${component}`
    },
    expected: `component ${operation} successfully`
  };
}

function databasePathSubject(
  path: string,
  operation: string
): DatabaseErrorSubject {
  return {
    type: 'database',
    ...(path.length <= DATABASE_PATH_LIMIT
      ? { path }
      : { field: `path-length:${path.length}` }),
    operation
  };
}

function configurationActual(raw: string): string {
  return raw.length <= DIAGNOSTIC_STRING_LIMIT
    ? raw
    : `string-length:${raw.length}`;
}

export interface ResolvedRuntimeEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly fileStatus: 'loaded' | 'missing' | 'skipped';
}

export function resolveRuntimeEnvironment(
  explicitEnv: NodeJS.ProcessEnv | undefined,
  load: typeof loadEnvironmentFile = loadEnvironmentFile
): ResolvedRuntimeEnvironment {
  if (explicitEnv !== undefined) {
    return { env: explicitEnv, fileStatus: 'skipped' };
  }
  const fileStatus = load({ processEnv: process.env });
  return { env: process.env, fileStatus };
}

function invalidConfiguration(
  field: string,
  raw: string | undefined,
  expected: string
): never {
  throw createTradeOpsError({
    code: raw === undefined
      ? 'CONFIG_FIELD_MISSING'
      : 'CONFIG_FIELD_INVALID',
    phase: 'startup',
    subject: { type: 'configuration', field },
    expected,
    actual: raw === undefined ? 'missing' : configurationActual(raw)
  });
}

function exchangeIds(
  raw: string | undefined
): readonly ConfiguredExchangeId[] {
  if (raw === undefined) {
    return invalidConfiguration(
      'TRADING_EXCHANGES',
      raw,
      'exact exchange set bitget,okx'
    );
  }
  const tokens = raw.split(',').map((value) => value.trim());
  if (
    tokens.some((value) => value === '')
    || new Set(tokens).size !== tokens.length
    || tokens.length !== REQUIRED_EXCHANGE_IDS.length
    || tokens.some((value) => !REQUIRED_EXCHANGE_SET.has(value))
  ) {
    return invalidConfiguration(
      'TRADING_EXCHANGES',
      raw,
      'exact exchange set bitget,okx'
    );
  }
  return [...REQUIRED_EXCHANGE_IDS];
}

function databasePath(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_DATABASE_PATH;
  const trimmed = raw.trim();
  if (
    trimmed === ''
    || raw.includes('\0')
    || trimmed === ':memory:'
    || /^file:/i.test(trimmed)
  ) {
    return invalidConfiguration(
      'TRADING_DATABASE_PATH',
      raw,
      'non-empty local SQLite file path'
    );
  }
  return trimmed;
}

function loopbackHost(
  raw: string | undefined
): RuntimeConfig['host'] {
  if (raw === undefined) {
    return DEFAULT_HOST;
  }
  if (raw !== '127.0.0.1' && raw !== '::1') {
    return invalidConfiguration(
      'HOST',
      raw,
      'loopback address 127.0.0.1 or ::1'
    );
  }
  return raw;
}

function canonicalPort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) {
    return invalidConfiguration(
      'PORT',
      raw,
      'canonical decimal port from 1 to 65535'
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) {
    return invalidConfiguration(
      'PORT',
      raw,
      'canonical decimal port from 1 to 65535'
    );
  }
  return value;
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const configuredFundingRateSyncIntervalMs = fundingRateSyncIntervalMs(
    env.FUNDING_RATE_SYNC_INTERVAL_MS
  );
  const configuredExchangeIds = exchangeIds(env.TRADING_EXCHANGES);
  const credentials = new Map<
    ConfiguredExchangeId,
    ExchangeCredentials
  >();
  for (const exchangeId of configuredExchangeIds) {
    credentials.set(exchangeId, loadExchangeCredentials(exchangeId, env));
  }
  return {
    exchangeIds: configuredExchangeIds,
    credentials,
    fundingRateSyncIntervalMs: configuredFundingRateSyncIntervalMs,
    databasePath: databasePath(env.TRADING_DATABASE_PATH),
    host: loopbackHost(env.HOST),
    port: canonicalPort(env.PORT)
  };
}

function defaultGatewayFactory(
  exchangeId: ConfiguredExchangeId,
  _credentials: Readonly<ExchangeCredentials>,
  env: NodeJS.ProcessEnv
): ExchangeGateway {
  return new CcxtExchangeGateway(exchangeId, undefined, env);
}

function defaultDatabaseFactory(path: string): Database.Database {
  return new Database(path, { timeout: 0 });
}

function defaultFundingRateRepositoryFactory(
  database: Database.Database
): FundingRateRepository {
  return new SqliteFundingRateRepository(database);
}

function defaultFundingRateSyncFactory(
  options: FundingRateSyncServiceOptions
): FundingRateSyncLifecycle {
  return new FundingRateSyncService(options);
}

function defaultFundingRateSleep(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) {
      rejectSleep(new Error('funding rate sleep canceled'));
      return;
    }
    const handleAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', handleAbort);
      rejectSleep(new Error('funding rate sleep canceled'));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolveSleep();
    }, delayMs);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function closeDatabaseAfterConstructionFailure(
  database: Database.Database,
  cause: unknown
): never {
  try {
    database.close();
  } catch {
    // Preserve the construction error without retaining a close-time cause.
  }
  throw cause;
}

export function composeService(
  options: ComposeServiceOptions = {}
): ServiceComposition {
  const env = options.env ?? process.env;
  const config = loadRuntimeConfig(env);
  runStartupBoundary(() => mkdirSync(dirname(resolve(config.databasePath)), {
    recursive: true,
    mode: 0o700
  }), {
    code: 'STORAGE_OPERATION_FAILED',
    subject: databasePathSubject(
      config.databasePath,
      'create-parent-directory'
    ),
    expected: 'database parent directory created or already available'
  });
  const databaseFactory = options.databaseFactory ?? defaultDatabaseFactory;
  const database = runStartupBoundary(
    () => databaseFactory(config.databasePath),
    {
      code: 'DATABASE_OPEN_FAILED',
      subject: databasePathSubject(config.databasePath, 'open-database'),
      expected: 'SQLite database opened successfully'
    }
  );
  try {
    runStartupBoundary(
      () => claimSqliteProcessOwnership(database, config.databasePath),
      {
        code: 'DATABASE_OWNERSHIP_UNAVAILABLE',
        subject: databasePathSubject(
          config.databasePath,
          'claim-exclusive-ownership'
        ),
        expected: 'exclusive SQLite process ownership'
      }
    );
    const clock = options.clock ?? (() => new Date());
    const repository = runStartupBoundary(
      () => new SqliteStrategyRepository(database, clock),
      {
        code: 'STORAGE_OPERATION_FAILED',
        subject: {
          type: 'database',
          table: 'strategies',
          operation: 'initialize-strategy-repository'
        },
        expected: 'strategy repository initialized successfully'
      }
    );

    const fundingRateRepositoryFactory = options.fundingRateRepositoryFactory
      ?? defaultFundingRateRepositoryFactory;
    const fundingRateRepository = runStartupBoundary(
      () => fundingRateRepositoryFactory(database),
      {
        code: 'STORAGE_OPERATION_FAILED',
        subject: {
          type: 'database',
          operation: 'initialize-funding-rate-repository'
        },
        expected: 'funding rate repository initialized successfully'
      }
    );

    const fundingRateSourceFactory = options.fundingRateSourceFactory
      ?? createCcxtFundingRateSources;
    const [bitgetSource, okxSource] = runStartupBoundary(
      () => fundingRateSourceFactory(),
      componentContext('funding-rate-sources', 'constructed')
    );
    const fundingRateEvents = runStartupBoundary(
      () => options.fundingRateEvents
        ?? (options.loggerInstance === undefined
          ? NOOP_FUNDING_RATE_EVENT_SINK
          : new PinoFundingRateEventSink(
              options.loggerInstance,
              () => configuredSecretValues(env)
            )),
      componentContext('funding-rate-events', 'constructed')
    );
    const fundingRateSyncFactory = options.fundingRateSyncFactory
      ?? defaultFundingRateSyncFactory;
    const fundingRateSync = runStartupBoundary(
      () => fundingRateSyncFactory({
        bitgetSource,
        okxSource,
        repository: fundingRateRepository,
        events: fundingRateEvents,
        intervalMs: config.fundingRateSyncIntervalMs,
        nowMs: options.fundingRateNowMs ?? Date.now,
        sleep: options.fundingRateSleep ?? defaultFundingRateSleep
      }),
      componentContext('funding-rate-sync', 'constructed')
    );

    const gatewayFactory = options.gatewayFactory ?? defaultGatewayFactory;
    const gateways = new Map<string, ExchangeGateway>();
    for (const exchangeId of config.exchangeIds) {
      const credentials = config.credentials.get(exchangeId);
      if (credentials === undefined) {
        throw createTradeOpsError({
          code: 'SERVICE_COMPONENT_FAILED',
          phase: 'startup',
          subject: {
            type: 'configuration',
            field: `service-component:${exchangeId}-gateway`
          },
          expected: 'configured credentials available for gateway construction',
          actual: 'credentials-map-missing'
        });
      }
      gateways.set(
        exchangeId,
        runStartupBoundary(
          () => gatewayFactory(exchangeId, credentials, env),
          componentContext(`${exchangeId}-gateway`, 'constructed')
        )
      );
    }
    const registry = runStartupBoundary(
      () => new ExchangeRegistry(gateways),
      componentContext('exchange-registry', 'constructed')
    );
    const preflightService = runStartupBoundary(
      () => new PreflightService(registry, clock),
      componentContext('preflight-service', 'constructed')
    );
    const confirmationService = runStartupBoundary(
      () => new ConfirmationService(repository, preflightService),
      componentContext('confirmation-service', 'constructed')
    );
    const operationalLog = runStartupBoundary(
      () => nonThrowingOperationalLog(
        options.operationalLog
          ?? (options.loggerInstance === undefined
            ? undefined
            : createOperationalLog(
                options.loggerInstance,
                () => configuredSecretValues(env)
              ))
      ),
      componentContext('operational-log', 'constructed')
    );
    const tradeEvents = runStartupBoundary(
      () => options.tradeEvents
        ?? (options.loggerInstance === undefined
          ? NOOP_TRADE_EVENT_SINK
          : new PinoTradeEventSink(
              options.loggerInstance.child({ component: 'trade' }),
              () => configuredSecretValues(env)
            )),
      componentContext('trade-events', 'constructed')
    );
    const reconciliation = runStartupBoundary(
      () => new HedgeReconciliation(
        registry,
        repository,
        tradeEvents,
        operationalLog
      ),
      componentContext('hedge-reconciliation', 'constructed')
    );
    const coordinator = runStartupBoundary(
      () => new HedgeCoordinator(
        registry,
        repository,
        reconciliation,
        tradeEvents,
        operationalLog
      ),
      componentContext('hedge-coordinator', 'constructed')
    );
    const monitor = runStartupBoundary(
      () => new OrderMonitor(repository, coordinator, operationalLog),
      componentContext('order-monitor', 'constructed')
    );
    const server = runStartupBoundary(
      () => buildServer({
        registry,
        preflightService,
        confirmationService,
        repository,
        coordinator,
        secretProvider: () => configuredSecretValues(env),
        ...(options.loggerInstance === undefined
          ? (options.logger === undefined ? {} : { logger: options.logger })
          : { loggerInstance: options.loggerInstance as FastifyBaseLogger }),
        ...(operationalLog === undefined ? {} : { operationalLog }),
        ...(options.publicDirectory === undefined
          ? {}
          : { publicDirectory: options.publicDirectory })
      }),
      componentContext('http-server', 'constructed')
    );
    return {
      config,
      database,
      registry,
      repository,
      preflightService,
      coordinator,
      monitor,
      fundingRateSync,
      server
    };
  } catch (error) {
    return closeDatabaseAfterConstructionFailure(
      database,
      startupFailure(
        error,
        componentContext('service-composition', 'constructed')
      )
    );
  }
}

function defaultListen(
  server: RunnableComposition['server'],
  options: FastifyListenOptions
): Promise<unknown> {
  return server.listen(options);
}

function processSignalTarget(): SignalTarget {
  return process as SignalTarget;
}

export async function startService<T extends RunnableComposition>(
  composition: T,
  options: StartServiceOptions = {}
): Promise<StartedService<T>> {
  const signalTarget = options.signalTarget ?? processSignalTarget();
  const listen = options.listen ?? defaultListen;
  const operationalLog = nonThrowingOperationalLog(options.operationalLog);
  const runtimeFields: Readonly<OperationalFields> = {
    host: composition.config.host,
    port: composition.config.port,
    ...(composition.config.databasePath === undefined
      ? {}
      : { databasePath: composition.config.databasePath }),
    ...(composition.config.exchangeIds === undefined
      ? {}
      : { exchangeIds: composition.config.exchangeIds })
  };
  let sigintRegistrationAttempted = false;
  let sigtermRegistrationAttempted = false;
  let shutdownPromise: Promise<void> | null = null;

  const removeSignalListeners = (): void => {
    let hasFirstError = false;
    let firstError: unknown;
    if (sigintRegistrationAttempted) {
      sigintRegistrationAttempted = false;
      try {
        signalTarget.removeListener('SIGINT', handleSignal);
      } catch (error) {
        hasFirstError = true;
        firstError = error;
      }
    }
    if (sigtermRegistrationAttempted) {
      sigtermRegistrationAttempted = false;
      try {
        signalTarget.removeListener('SIGTERM', handleSignal);
      } catch (error) {
        if (!hasFirstError) {
          hasFirstError = true;
          firstError = error;
        }
      }
    }
    if (hasFirstError) {
      throw firstError;
    }
  };

  const closeResources = async (): Promise<void> => {
    let hasFirstError = false;
    let firstError!: TradeOpsError;
    const rememberFailure = (
      error: unknown,
      context: StartupFailureContext
    ): void => {
      const failure = startupFailure(error, context);
      if (!hasFirstError) {
        hasFirstError = true;
        firstError = failure;
      }
    };
    try {
      await composition.fundingRateSync.stop();
    } catch (error) {
      rememberFailure(
        error,
        componentContext('funding-rate-sync', 'stopped')
      );
    }
    try {
      await composition.monitor.stop();
    } catch (error) {
      rememberFailure(error, componentContext('order-monitor', 'stopped'));
    }
    try {
      await composition.server.close();
    } catch (error) {
      rememberFailure(error, componentContext('http-server', 'stopped'));
    }
    try {
      composition.database.close();
    } catch (error) {
      rememberFailure(error, componentContext('database', 'stopped'));
    }
    try {
      removeSignalListeners();
    } catch (error) {
      rememberFailure(error, componentContext('signal-listeners', 'stopped'));
    }
    if (hasFirstError) {
      operationalLog?.error('service_stop_failed', firstError, runtimeFields);
      throw firstError;
    }
    operationalLog?.info('service_stopped', runtimeFields);
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise === null) {
      operationalLog?.info('service_stopping', runtimeFields);
      shutdownPromise = closeResources();
    }
    return shutdownPromise;
  };

  const handleSignal = (): void => {
    signalTarget.exitCode = 0;
    void shutdown().catch(() => {
      signalTarget.exitCode = 1;
    });
  };

  try {
    runStartupBoundary(() => {
      sigintRegistrationAttempted = true;
      signalTarget.on('SIGINT', handleSignal);
      sigtermRegistrationAttempted = true;
      signalTarget.on('SIGTERM', handleSignal);
    }, componentContext('signal-listeners', 'started'));
    operationalLog?.info('service_starting', runtimeFields);
    runStartupBoundary(
      () => composition.monitor.start(MONITOR_INTERVAL_MS),
      componentContext('order-monitor', 'started')
    );
    const listenContext: StartupFailureContext = {
      code: 'SERVICE_LISTEN_FAILED',
      subject: {
        type: 'configuration',
        field: 'service-listener'
      },
      expected: 'HTTP listener bound successfully'
    };
    const listening = runStartupBoundary(
      () => listen(composition.server, {
        host: composition.config.host,
        port: composition.config.port
      }),
      listenContext
    );
    try {
      await listening;
    } catch (error) {
      throw startupFailure(error, listenContext);
    }
    if (shutdownPromise === null) {
      runStartupBoundary(
        () => composition.fundingRateSync.start(),
        componentContext('funding-rate-sync', 'started')
      );
      operationalLog?.info('service_started', runtimeFields);
    }
    return { composition, shutdown };
  } catch (startupError) {
    operationalLog?.error('service_start_failed', startupError, runtimeFields);
    try {
      await shutdown();
    } catch {
      // The fixed startup error remains the primary failure.
    }
    throw startupError;
  }
}

export async function run(
  options: RunOptions = {}
): Promise<StartedService<ServiceComposition>> {
  const runtime = resolveRuntimeEnvironment(options.env);
  const operationalLog = nonThrowingOperationalLog(
    options.operationalLog
      ?? (options.loggerInstance === undefined
        ? undefined
        : createOperationalLog(
            options.loggerInstance,
            () => configuredSecretValues(runtime.env)
          ))
  );
  if (runtime.fileStatus === 'loaded') {
    operationalLog?.info('environment_loaded');
  } else if (runtime.fileStatus === 'missing') {
    operationalLog?.info('environment_file_missing');
  }
  const resolvedOptions = {
    ...options,
    env: runtime.env,
    ...(operationalLog === undefined ? {} : { operationalLog })
  };
  const composition = composeService(resolvedOptions);
  return startService(composition, resolvedOptions);
}

export function isEntrypoint(
  moduleUrl: string,
  argument: string | undefined
): boolean {
  return argument !== undefined
    && fileURLToPath(moduleUrl) === resolve(argument);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const logger = createAppLogger();
  const operations = createOperationalLog(
    logger,
    () => configuredSecretValues(process.env)
  );
  void run({ loggerInstance: logger, operationalLog: operations })
    .catch((error) => {
      process.exitCode = 1;
      operations.fatal('service_startup_failed', error);
    });
}
