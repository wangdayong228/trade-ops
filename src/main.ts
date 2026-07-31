import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type {
  FastifyInstance,
  FastifyListenOptions,
  FastifyServerOptions
} from 'fastify';
import type { ExchangeCredentials } from './config/exchange-credentials.js';
import { loadExchangeCredentials } from './config/exchange-credentials.js';
import { CcxtExchangeGateway } from './exchanges/ccxt-exchange-gateway.js';
import type { ExchangeGateway } from './exchanges/exchange-gateway.js';
import { ExchangeRegistry } from './exchanges/exchange-registry.js';
import { buildServer } from './http/server.js';
import { SqliteStrategyRepository } from './storage/sqlite-strategy-repository.js';
import { HedgeCoordinator } from './strategy/hedge-coordinator.js';
import { OrderMonitor } from './strategy/order-monitor.js';
import { PreflightService } from './strategy/preflight-service.js';

export type ConfiguredExchangeId = 'bitget' | 'okx';
export type Clock = () => Date;

export interface RuntimeConfig {
  readonly exchangeIds: readonly ConfiguredExchangeId[];
  readonly credentials: ReadonlyMap<ConfiguredExchangeId, ExchangeCredentials>;
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

export interface ComposeServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly gatewayFactory?: GatewayFactory;
  readonly databaseFactory?: DatabaseFactory;
  readonly clock?: Clock;
  readonly logger?: FastifyServerOptions['logger'];
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
  readonly server: FastifyInstance;
}

export interface RunnableComposition {
  readonly config: {
    readonly host: '127.0.0.1' | '::1';
    readonly port: number;
  };
  readonly monitor: {
    start(intervalMs: number): () => void;
    stop(): Promise<void>;
  };
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

function invalidConfiguration(field: string): never {
  throw new Error(`invalid ${field} configuration`);
}

function exchangeIds(
  raw: string | undefined
): readonly ConfiguredExchangeId[] {
  if (raw === undefined) {
    return invalidConfiguration('TRADING_EXCHANGES');
  }
  const tokens = raw.split(',').map((value) => value.trim());
  if (
    tokens.some((value) => value === '')
    || new Set(tokens).size !== tokens.length
    || tokens.length !== REQUIRED_EXCHANGE_IDS.length
    || tokens.some((value) => !REQUIRED_EXCHANGE_SET.has(value))
  ) {
    return invalidConfiguration('TRADING_EXCHANGES');
  }
  return [...REQUIRED_EXCHANGE_IDS];
}

function databasePath(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_DATABASE_PATH;
  }
  if (raw.trim() === '' || raw.includes('\0')) {
    return invalidConfiguration('TRADING_DATABASE_PATH');
  }
  return raw;
}

function loopbackHost(
  raw: string | undefined
): RuntimeConfig['host'] {
  if (raw === undefined) {
    return DEFAULT_HOST;
  }
  if (raw !== '127.0.0.1' && raw !== '::1') {
    return invalidConfiguration('HOST');
  }
  return raw;
}

function canonicalPort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) {
    return invalidConfiguration('PORT');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) {
    return invalidConfiguration('PORT');
  }
  return value;
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
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
  return new Database(path);
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
  const gatewayFactory = options.gatewayFactory ?? defaultGatewayFactory;
  const gateways = new Map<string, ExchangeGateway>();
  for (const exchangeId of config.exchangeIds) {
    const credentials = config.credentials.get(exchangeId);
    if (credentials === undefined) {
      throw new Error(
        `missing credentials for configured exchange ${exchangeId}`
      );
    }
    gateways.set(
      exchangeId,
      gatewayFactory(exchangeId, credentials, env)
    );
  }
  const registry = new ExchangeRegistry(gateways);

  mkdirSync(dirname(resolve(config.databasePath)), {
    recursive: true,
    mode: 0o700
  });
  const databaseFactory = options.databaseFactory ?? defaultDatabaseFactory;
  const database = databaseFactory(config.databasePath);
  try {
    const clock = options.clock ?? (() => new Date());
    const repository = new SqliteStrategyRepository(database, clock);
    const preflightService = new PreflightService(registry, clock);
    const coordinator = new HedgeCoordinator(registry, repository);
    const monitor = new OrderMonitor(registry, repository);
    const server = buildServer({
      registry,
      preflightService,
      repository,
      coordinator,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.publicDirectory === undefined
        ? {}
        : { publicDirectory: options.publicDirectory })
    });
    return {
      config,
      database,
      registry,
      repository,
      preflightService,
      coordinator,
      monitor,
      server
    };
  } catch (error) {
    return closeDatabaseAfterConstructionFailure(database, error);
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
  let signalsInstalled = false;
  let shutdownPromise: Promise<void> | null = null;

  const removeSignalListeners = (): void => {
    if (!signalsInstalled) {
      return;
    }
    signalsInstalled = false;
    signalTarget.removeListener('SIGINT', handleSignal);
    signalTarget.removeListener('SIGTERM', handleSignal);
  };

  const closeResources = async (): Promise<void> => {
    let firstError: unknown;
    try {
      await composition.monitor.stop();
    } catch (error) {
      firstError = error;
    }
    try {
      await composition.server.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      composition.database.close();
    } catch (error) {
      firstError ??= error;
    }
    removeSignalListeners();
    if (firstError !== undefined) {
      throw firstError;
    }
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= closeResources();
    return shutdownPromise;
  };

  const handleSignal = (): void => {
    signalTarget.exitCode = 0;
    void shutdown().catch(() => {
      signalTarget.exitCode = 1;
    });
  };

  signalTarget.on('SIGINT', handleSignal);
  signalTarget.on('SIGTERM', handleSignal);
  signalsInstalled = true;
  try {
    composition.monitor.start(MONITOR_INTERVAL_MS);
    await listen(composition.server, {
      host: composition.config.host,
      port: composition.config.port
    });
    return { composition, shutdown };
  } catch (startupError) {
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
  const composition = composeService(options);
  return startService(composition, options);
}

export function isEntrypoint(
  moduleUrl: string,
  argument: string | undefined
): boolean {
  return argument !== undefined
    && fileURLToPath(moduleUrl) === resolve(argument);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void run().catch(() => {
    process.exitCode = 1;
    console.error('trade-ops service startup failed');
  });
}
