/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  composeService,
  loadRuntimeConfig,
  resolveRuntimeEnvironment,
  startService,
  type FundingRateSyncLifecycle
} from '../src/main.js';
import type { FundingRateEventSink } from '../src/funding-rates/funding-rate-events.js';
import type { FundingSleep } from '../src/funding-rates/funding-rate-exchange-worker.js';
import type { FundingRateSyncServiceOptions } from '../src/funding-rates/funding-rate-sync-service.js';
import type {
  OperationalFields,
  OperationalLog
} from '../src/logging/logger.js';
import type { FundingRateRepository } from '../src/storage/funding-rate-repository.js';
import { SqliteFundingRateRepository } from '../src/storage/sqlite-funding-rate-repository.js';
import {
  claimSqliteProcessOwnership,
  SqliteOwnershipError
} from '../src/storage/sqlite-process-owner.js';
import { FakeExchangeGateway } from './support/fake-exchange-gateway.js';
import { FakeFundingRateSource } from './support/fake-funding-rate-source.js';

const VALID_ENV = {
  TRADING_EXCHANGES: 'bitget,okx',
  TRADING_BITGET_API_KEY: 'bitget-api-key-value',
  TRADING_BITGET_SECRET: 'bitget-secret-value',
  TRADING_BITGET_PASSWORD: 'bitget-password-value',
  TRADING_OKX_API_KEY: 'okx-api-key-value',
  TRADING_OKX_SECRET: 'okx-secret-value',
  TRADING_OKX_PASSWORD: 'okx-password-value'
} as const;

async function closeCompositionForCleanup(
  composition: ReturnType<typeof composeService> | undefined
): Promise<void> {
  if (composition === undefined) return;
  try {
    await composition.server.close();
  } catch {
    // Best-effort cleanup must not replace the test's primary failure.
  }
  try {
    if (composition.database.open) composition.database.close();
  } catch {
    // Best-effort cleanup must not replace the test's primary failure.
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('loads the exact two-exchange release configuration', () => {
  const config = loadRuntimeConfig({
    ...VALID_ENV,
    TRADING_EXCHANGES: ' bitget , okx ',
    TRADING_DATABASE_PATH: './state/service.sqlite',
    HOST: '::1',
    PORT: '65535'
  });

  assert.deepEqual(config.exchangeIds, ['bitget', 'okx']);
  assert.equal(config.databasePath, './state/service.sqlite');
  assert.equal(config.host, '::1');
  assert.equal(config.port, 65_535);
  assert.deepEqual(config.credentials.get('bitget'), {
    apiKey: VALID_ENV.TRADING_BITGET_API_KEY,
    secret: VALID_ENV.TRADING_BITGET_SECRET,
    password: VALID_ENV.TRADING_BITGET_PASSWORD
  });
  assert.deepEqual(config.credentials.get('okx'), {
    apiKey: VALID_ENV.TRADING_OKX_API_KEY,
    secret: VALID_ENV.TRADING_OKX_SECRET,
    password: VALID_ENV.TRADING_OKX_PASSWORD
  });
});

test('uses local database, host, and port defaults', () => {
  const config = loadRuntimeConfig(VALID_ENV);

  assert.equal(config.databasePath, './data/trade-ops.sqlite');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
});

test('loads the funding sync interval default and canonical boundaries', () => {
  assert.equal(
    loadRuntimeConfig(VALID_ENV).fundingRateSyncIntervalMs,
    3_600_000
  );
  assert.equal(
    loadRuntimeConfig({
      ...VALID_ENV,
      FUNDING_RATE_SYNC_INTERVAL_MS: '60000'
    }).fundingRateSyncIntervalMs,
    60_000
  );
  assert.equal(
    loadRuntimeConfig({
      ...VALID_ENV,
      FUNDING_RATE_SYNC_INTERVAL_MS: '86400000'
    }).fundingRateSyncIntervalMs,
    86_400_000
  );
});

test('rejects non-canonical or out-of-range funding sync intervals', () => {
  for (const raw of [
    '',
    ' 60000',
    '60000 ',
    '+60000',
    '-60000',
    '060000',
    '60000.0',
    '6e4',
    '59999',
    '86400001',
    '9007199254740992'
  ]) {
    assert.throws(
      () => loadRuntimeConfig({
        ...VALID_ENV,
        FUNDING_RATE_SYNC_INTERVAL_MS: raw
      }),
      /^Error: Invalid FUNDING_RATE_SYNC_INTERVAL_MS:/,
      raw
    );
  }
});

test('validates the funding sync interval before loading credentials', () => {
  assert.throws(
    () => loadRuntimeConfig({
      TRADING_EXCHANGES: 'bitget,okx',
      FUNDING_RATE_SYNC_INTERVAL_MS: '59999'
    }),
    /^Error: Invalid FUNDING_RATE_SYNC_INTERVAL_MS:/
  );
});

test('invalid funding sync interval does not construct gateways or SQLite', () => {
  let gatewayConstructions = 0;
  let databaseConstructions = 0;
  let caught: unknown;

  try {
    composeService({
      env: {
        ...VALID_ENV,
        FUNDING_RATE_SYNC_INTERVAL_MS: '86400001'
      },
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      databaseFactory: () => {
        databaseConstructions += 1;
        throw new Error('database factory must not be called');
      },
      logger: false
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(databaseConstructions, 0);
  assert.equal(gatewayConstructions, 0);
  assert.match(
    (caught as Error | undefined)?.message ?? '',
    /^Invalid FUNDING_RATE_SYNC_INTERVAL_MS:/
  );
});

for (const [name, exchanges] of [
  ['missing', undefined],
  ['empty', ''],
  ['whitespace-only', '   '],
  ['empty first token', ',bitget,okx'],
  ['empty middle token', 'bitget,,okx'],
  ['empty final token', 'bitget,okx,'],
  ['duplicate', 'bitget,okx,bitget'],
  ['unsupported', 'bitget,kraken'],
  ['only bitget', 'bitget'],
  ['only okx', 'okx'],
  ['supported exchange plus extra', 'bitget,okx,kraken']
] as const) {
  test(`rejects ${name} TRADING_EXCHANGES`, () => {
    assert.throws(
      () => loadRuntimeConfig({
        ...VALID_ENV,
        TRADING_EXCHANGES: exchanges
      }),
      /^Error: invalid TRADING_EXCHANGES configuration$/
    );
  });
}

for (const [name, host] of [
  ['wildcard IPv4', '0.0.0.0'],
  ['wildcard IPv6', '::'],
  ['localhost hostname', 'localhost'],
  ['external address', '192.168.1.10'],
  ['external hostname', 'operator.example'],
  ['leading whitespace', ' 127.0.0.1'],
  ['trailing whitespace', '127.0.0.1 '],
  ['host with port', '127.0.0.1:3000'],
  ['bracketed IPv6', '[::1]'],
  ['empty host', '']
] as const) {
  test(`rejects ${name} HOST`, () => {
    assert.throws(
      () => loadRuntimeConfig({ ...VALID_ENV, HOST: host }),
      /^Error: invalid HOST configuration$/
    );
  });
}

for (const [name, port] of [
  ['empty', ''],
  ['whitespace', ' 3000'],
  ['trailing whitespace', '3000 '],
  ['zero', '0'],
  ['negative', '-1'],
  ['plus-prefixed', '+3000'],
  ['decimal', '3000.0'],
  ['exponent', '3e3'],
  ['leading zero', '03000'],
  ['overflow', '65536'],
  ['non-number', 'http']
] as const) {
  test(`rejects ${name} PORT`, () => {
    assert.throws(
      () => loadRuntimeConfig({ ...VALID_ENV, PORT: port }),
      /^Error: invalid PORT configuration$/
    );
  });
}

for (const [exchangeId, field] of [
  ['bitget', 'API_KEY'],
  ['bitget', 'SECRET'],
  ['bitget', 'PASSWORD'],
  ['okx', 'API_KEY'],
  ['okx', 'SECRET'],
  ['okx', 'PASSWORD']
] as const) {
  test(`rejects missing ${exchangeId} ${field} without exposing values`, () => {
    const key = `TRADING_${exchangeId.toUpperCase()}_${field}`;
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      UNRELATED_SECRET: 'must-never-appear'
    };
    delete env[key];

    assert.throws(
      () => loadRuntimeConfig(env),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `missing credentials for configured exchange ${exchangeId}`
        );
        assert.doesNotMatch(error.message, /must-never-appear|api-key-value/);
        return true;
      }
    );
  });
}

test('configuration failure happens before gateway or database construction', () => {
  let gatewayConstructions = 0;
  let databaseConstructions = 0;

  assert.throws(
    () => composeService({
      env: { ...VALID_ENV, HOST: '0.0.0.0' },
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      databaseFactory: () => {
        databaseConstructions += 1;
        return new Database(':memory:');
      },
      logger: false
    }),
    /^Error: invalid HOST configuration$/
  );
  assert.equal(gatewayConstructions, 0);
  assert.equal(databaseConstructions, 0);
});

for (const databasePath of [
  ':memory:',
  ' :memory: ',
  'file:trade-ops.sqlite',
  'FILE:trade-ops.sqlite?mode=memory&cache=shared'
] as const) {
  test(`rejects non-file production database path ${databasePath}`, () => {
    let gatewayConstructions = 0;
    let databaseConstructions = 0;
    assert.throws(
      () => composeService({
        env: { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath },
        gatewayFactory: (exchangeId) => {
          gatewayConstructions += 1;
          return new FakeExchangeGateway(exchangeId);
        },
        databaseFactory: () => {
          databaseConstructions += 1;
          throw new Error('database factory must not be called');
        },
        logger: false
      }),
      /^Error: invalid TRADING_DATABASE_PATH configuration$/
    );
    assert.equal(databaseConstructions, 0);
    assert.equal(gatewayConstructions, 0);
  });
}

test('normalizes a production database path before directory and database use', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-path-'));
  const trimmedPath = './state/trade-ops.sqlite';
  const rawPath = ` ${trimmedPath} `;
  const trimmedDirectory = dirname(resolve(directory, trimmedPath));
  const rawDirectory = dirname(resolve(directory, rawPath));
  let compositionForCleanup: ReturnType<typeof composeService> | undefined;
  t.after(async () => {
    await closeCompositionForCleanup(compositionForCleanup);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not replace the test's primary failure.
    }
  });

  const config = loadRuntimeConfig({
    ...VALID_ENV,
    TRADING_DATABASE_PATH: rawPath
  });
  let databaseFactoryPath: string | undefined;
  const originalWorkingDirectory = process.cwd();
  try {
    process.chdir(directory);
    compositionForCleanup = composeService({
      env: { ...VALID_ENV, TRADING_DATABASE_PATH: rawPath },
      databaseFactory: (path) => {
        databaseFactoryPath = path;
        return new Database(':memory:', { timeout: 0 });
      },
      gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
      logger: false
    });
  } finally {
    process.chdir(originalWorkingDirectory);
  }

  assert.deepEqual({
    loadedPath: config.databasePath,
    composedPath: compositionForCleanup?.config.databasePath,
    databaseFactoryPath,
    trimmedDirectoryExists: await directoryExists(trimmedDirectory),
    rawDirectoryExists: await directoryExists(rawDirectory)
  }, {
    loadedPath: trimmedPath,
    composedPath: trimmedPath,
    databaseFactoryPath: trimmedPath,
    trimmedDirectoryExists: true,
    rawDirectoryExists: false
  });
});

test('opens and claims SQLite before gateway construction', () => {
  let databaseConstructions = 0;
  let database: Database.Database | undefined;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => {
        databaseConstructions += 1;
        database = new Database(':memory:', { timeout: 0 });
        return database;
      },
      gatewayFactory: () => {
        throw new Error('gateway construction failed');
      },
      logger: false
    }),
    /^Error: gateway construction failed$/
  );
  assert.equal(databaseConstructions, 1);
  assert.equal(database?.open, false);
});

test('closes SQLite once when exclusive ownership is busy', () => {
  let closes = 0;
  let gatewayConstructions = 0;
  const database = {
    pragma(): string { return 'exclusive'; },
    exec(): never {
      throw Object.assign(new Error('raw busy detail'), {
        code: 'SQLITE_BUSY'
      });
    },
    close(): void {
      closes += 1;
    }
  } as unknown as Database.Database;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => database,
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => error instanceof SqliteOwnershipError
      && (error as { readonly code: string }).code
        === 'DATABASE_OWNERSHIP_BUSY'
      && !(error as { readonly message: string }).message
        .includes('raw busy detail')
  );
  assert.equal(gatewayConstructions, 0);
  assert.equal(closes, 1);
});

test('closes an owned database once when schema construction fails', () => {
  let closes = 0;
  let gatewayConstructions = 0;
  const statements: string[] = [];
  const database = new Database(':memory:', { timeout: 0 });
  const originalExec = database.exec.bind(database);
  const originalClose = database.close.bind(database);
  database.exec = (statement: string) => {
    statements.push(statement);
    if (statements.length === 2) {
      throw new Error('schema unavailable');
    }
    return originalExec(statement);
  };
  database.close = () => {
    closes += 1;
    return originalClose();
  };

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => database,
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => error instanceof Error
      && error.message === 'SQLite strategy schema migration failed'
      && !error.message.includes('schema unavailable')
  );
  assert.equal(statements[0], 'BEGIN EXCLUSIVE; COMMIT');
  assert.equal(gatewayConstructions, 0);
  assert.equal(closes, 1);
});

test('claims SQLite before gateway construction and releases after close', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-owner-'));
  const databasePath = join(directory, 'trade-ops.sqlite');
  let ownerForCleanup: ReturnType<typeof composeService> | undefined;
  let successorForCleanup: ReturnType<typeof composeService> | undefined;
  t.after(async () => {
    await closeCompositionForCleanup(successorForCleanup);
    await closeCompositionForCleanup(ownerForCleanup);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not replace the test's primary failure.
    }
  });
  const env = { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath };
  const owner = composeService({
    env,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  ownerForCleanup = owner;

  let blockedGatewayConstructions = 0;
  assert.throws(
    () => composeService({
      env,
      gatewayFactory: (exchangeId) => {
        blockedGatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => error instanceof SqliteOwnershipError
      && (error as { readonly code: string }).code
        === 'DATABASE_OWNERSHIP_BUSY'
  );
  assert.equal(blockedGatewayConstructions, 0);

  await owner.server.close();
  owner.database.close();
  ownerForCleanup = undefined;
  const successor = composeService({
    env,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  successorForCleanup = successor;
  await successor.server.close();
  successor.database.close();
  successorForCleanup = undefined;
});

test('releases claimed ownership when gateway construction fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-owner-'));
  const databasePath = join(directory, 'trade-ops.sqlite');
  let successorForCleanup: ReturnType<typeof composeService> | undefined;
  t.after(async () => {
    await closeCompositionForCleanup(successorForCleanup);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not replace the test's primary failure.
    }
  });
  const env = { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath };

  assert.throws(
    () => composeService({
      env,
      gatewayFactory: () => { throw new Error('gateway construction failed'); },
      logger: false
    }),
    /^Error: gateway construction failed$/
  );
  const successor = composeService({
    env,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  successorForCleanup = successor;
  await successor.server.close();
  successor.database.close();
  successorForCleanup = undefined;
});

test('database open failure is propagated before a server can listen', () => {
  let attempts = 0;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
      databaseFactory: () => {
        attempts += 1;
        throw new Error('database open failed');
      },
      logger: false
    }),
    /^Error: database open failed$/
  );
  assert.equal(attempts, 1);
});

test('production CCXT gateway construction performs no startup market load', async (t) => {
  const composition = composeService({
    env: VALID_ENV,
    databaseFactory: () => new Database(':memory:'),
    logger: false
  });
  t.after(async () => {
    await composition.server.close();
    composition.database.close();
  });

  assert.deepEqual(composition.registry.ids(), ['bitget', 'okx']);
  assert.equal(composition.repository.listRecoverable().length, 0);
});

test('composes funding sync on the strategy SQLite without construction I/O', async (t) => {
  const now = new Date('2026-09-06T00:00:00.000Z');
  const fundingRateNowMs = () => now.getTime();
  const bitgetSource = new FakeFundingRateSource('bitget', []);
  const okxSource = new FakeFundingRateSource('okx', []);
  const fundingEvents: FundingRateEventSink = { record(): void {} };
  const fundingSleep: FundingSleep = async () => {};
  const sourceFactoryCalls: unknown[][] = [];
  const repositoryFactoryCalls: unknown[][] = [];
  const syncFactoryCalls: FundingRateSyncServiceOptions[] = [];
  let fundingRateRepository: FundingRateRepository | undefined;
  let databaseConstructions = 0;
  const fundingRateSync: FundingRateSyncLifecycle = {
    start(): void {},
    async stop(): Promise<void> {}
  };
  let composition: ReturnType<typeof composeService> | undefined;
  t.after(async () => {
    await closeCompositionForCleanup(composition);
  });

  composition = composeService({
    env: {
      ...VALID_ENV,
      FUNDING_RATE_SYNC_INTERVAL_MS: '60000'
    },
    databaseFactory: () => {
      databaseConstructions += 1;
      return new Database(':memory:', { timeout: 0 });
    },
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    clock: () => now,
    fundingRateSourceFactory: (...args: unknown[]) => {
      sourceFactoryCalls.push(args);
      return [bitgetSource, okxSource];
    },
    fundingRateRepositoryFactory: (...args: unknown[]) => {
      repositoryFactoryCalls.push(args);
      fundingRateRepository = new SqliteFundingRateRepository(
        args[0] as Database.Database
      );
      return fundingRateRepository;
    },
    fundingRateSyncFactory: (options) => {
      syncFactoryCalls.push(options);
      return fundingRateSync;
    },
    fundingRateEvents: fundingEvents,
    fundingRateNowMs,
    fundingRateSleep: fundingSleep,
    logger: false
  });

  assert.equal(databaseConstructions, 1);
  assert.deepEqual(sourceFactoryCalls, [[]]);
  assert.equal(repositoryFactoryCalls.length, 1);
  assert.equal(repositoryFactoryCalls[0]?.length, 1);
  assert.equal(repositoryFactoryCalls[0]?.[0], composition.database);
  assert.equal(
    Reflect.get(composition.repository, 'database'),
    composition.database
  );
  assert.equal(
    Reflect.get(fundingRateRepository as object, 'database'),
    composition.database
  );
  assert.equal(syncFactoryCalls.length, 1);
  assert.equal(syncFactoryCalls[0]?.bitgetSource, bitgetSource);
  assert.equal(syncFactoryCalls[0]?.okxSource, okxSource);
  assert.equal(
    syncFactoryCalls[0]?.repository,
    fundingRateRepository
  );
  assert.equal(syncFactoryCalls[0]?.events, fundingEvents);
  assert.equal(syncFactoryCalls[0]?.intervalMs, 60_000);
  assert.equal(syncFactoryCalls[0]?.nowMs, fundingRateNowMs);
  assert.equal(syncFactoryCalls[0]?.nowMs(), now.getTime());
  assert.equal(syncFactoryCalls[0]?.sleep, fundingSleep);
  assert.equal(Reflect.has(syncFactoryCalls[0] as object, 'credentials'), false);
  assert.equal(
    Reflect.has(syncFactoryCalls[0] as object, 'strategyRepository'),
    false
  );
  assert.equal(Reflect.has(syncFactoryCalls[0] as object, 'coordinator'), false);
  assert.equal(Reflect.has(syncFactoryCalls[0] as object, 'monitor'), false);
  assert.equal(composition.fundingRateSync, fundingRateSync);
  assert.deepEqual(bitgetSource.discoveryRequestCalls, []);
  assert.deepEqual(bitgetSource.discoveryCalls, []);
  assert.deepEqual(bitgetSource.pageRequestCalls, []);
  assert.deepEqual(bitgetSource.fetchCalls, []);
  assert.deepEqual(okxSource.discoveryRequestCalls, []);
  assert.deepEqual(okxSource.discoveryCalls, []);
  assert.deepEqual(okxSource.pageRequestCalls, []);
  assert.deepEqual(okxSource.fetchCalls, []);
});

test('composition redacts all configured credentials from detailed HTTP errors', async (t) => {
  const composition = composeService({
    env: VALID_ENV,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    databaseFactory: () => new Database(':memory:'),
    logger: false
  });
  t.after(async () => {
    await composition.server.close();
    composition.database.close();
  });
  const credentialMessage = Object.values(VALID_ENV).join(' | ');
  Reflect.set(composition.preflightService, 'run', async () => {
    throw new Error(credentialMessage);
  });

  const response = await composition.server.inject({
    method: 'POST',
    url: '/api/hedges/preflight',
    headers: {
      host: 'localhost:80',
      origin: 'http://localhost:80'
    },
    payload: {
      spotExchangeId: 'bitget',
      contractExchangeId: 'okx',
      symbol: 'BTC/USDT',
      requestedBaseQuantity: '1',
      mode: 'CONCURRENT'
    }
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.message, [
    'bitget,okx',
    '[Redacted]',
    '[Redacted]',
    '[Redacted]',
    '[Redacted]',
    '[Redacted]',
    '[Redacted]'
  ].join(' | '));
  for (const secret of Object.values(VALID_ENV).slice(1)) {
    assert.doesNotMatch(response.body, new RegExp(secret));
  }
});

test('composition shares one safe trade sink with submission and evidence owners', async (t) => {
  const tradeEvents = { record(): void {} };
  const composition = composeService({
    env: VALID_ENV,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    databaseFactory: () => new Database(':memory:'),
    tradeEvents,
    logger: false
  });
  t.after(async () => {
    await composition.server.close();
    composition.database.close();
  });

  const coordinatorSink = Reflect.get(
    composition.coordinator,
    'tradeEvents'
  );
  const reconciliation = Reflect.get(
    composition.coordinator,
    'reconciliation'
  ) as object;
  const evidence = Reflect.get(reconciliation, 'evidence') as object;
  const evidenceSink = Reflect.get(evidence, 'tradeEvents');

  assert.equal(coordinatorSink, evidenceSink);
  assert.notEqual(coordinatorSink, tradeEvents);
  assert.equal(Reflect.has(composition.monitor, 'tradeEvents'), false);
  assert.equal(Reflect.has(composition.monitor, 'registry'), false);
});

test('creates the database parent directory during normal composition', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'trade-ops-main-'));
  const databasePath = join(temporaryDirectory, 'nested', 'trade-ops.sqlite');
  const composition = composeService({
    env: {
      ...VALID_ENV,
      TRADING_DATABASE_PATH: databasePath
    },
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  t.after(async () => {
    await composition.server.close();
    composition.database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const parent = await stat(join(temporaryDirectory, 'nested'));
  assert.equal(parent.isDirectory(), true);
  assert.equal(composition.repository.listRecoverable().length, 0);
});

class SignalTarget extends EventEmitter {
  exitCode: number | undefined;
}

interface CapturedOperation {
  readonly level: 'info' | 'warn' | 'error' | 'fatal';
  readonly event: string;
  readonly error?: unknown;
  readonly fields: Readonly<OperationalFields> | undefined;
}

function captureOperationalLog(entries: CapturedOperation[]): OperationalLog {
  return {
    info(event, fields): void {
      entries.push({ level: 'info', event, fields });
    },
    warn(event, fields): void {
      entries.push({ level: 'warn', event, fields });
    },
    error(event, error, fields): void {
      entries.push({ level: 'error', event, error, fields });
    },
    fatal(event, error, fields): void {
      entries.push({ level: 'fatal', event, error, fields });
    }
  };
}

function runnableFixture(events: string[]) {
  let monitorStarts = 0;
  let monitorStops = 0;
  let serverCloses = 0;
  let databaseCloses = 0;
  return {
    composition: {
      config: {
        host: '127.0.0.1' as const,
        port: 3000,
        databasePath: './fixture.sqlite',
        exchangeIds: ['bitget', 'okx']
      },
      fundingRateSync: {
        start(): void {},
        async stop(): Promise<void> {}
      },
      monitor: {
        start(intervalMs: number): () => void {
          events.push(`monitor.start:${intervalMs}`);
          monitorStarts += 1;
          return () => {};
        },
        async stop(): Promise<void> {
          events.push('monitor.stop');
          monitorStops += 1;
        }
      },
      server: {
        async listen(): Promise<string> {
          throw new Error('fixture listen must be injected');
        },
        async close(): Promise<void> {
          events.push('server.close');
          serverCloses += 1;
        }
      },
      database: {
        close(): void {
          events.push('database.close');
          databaseCloses += 1;
        }
      }
    },
    counts: () => ({
      monitorStarts,
      monitorStops,
      serverCloses,
      databaseCloses
    })
  };
}

interface ManualGate<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
}

function manualGate<Value>(): ManualGate<Value> {
  let resolve!: ManualGate<Value>['resolve'];
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FundingRunnableFixtureOptions {
  readonly stopGate?: Promise<void>;
  readonly stopError?: unknown;
}

function fundingRunnableFixture(
  events: string[],
  options: FundingRunnableFixtureOptions = {}
) {
  const base = runnableFixture(events);
  let fundingStarts = 0;
  let fundingStops = 0;
  let fundingStopError = options.stopError;
  let strategyTransitions = 0;
  let coordinatorActions = 0;
  let monitorTradingActions = 0;

  return {
    composition: {
      ...base.composition,
      fundingRateSync: {
        start(): void {
          events.push('funding.start');
          fundingStarts += 1;
        },
        async stop(): Promise<void> {
          events.push('funding.stop');
          fundingStops += 1;
          await options.stopGate;
          if (fundingStopError !== undefined) throw fundingStopError;
        }
      },
      strategyRepository: {
        transition(): void {
          strategyTransitions += 1;
        }
      },
      coordinator: {
        async confirmAndExecute(): Promise<void> {
          coordinatorActions += 1;
        }
      },
      monitor: {
        ...base.composition.monitor,
        async reconcileStrategy(): Promise<void> {
          monitorTradingActions += 1;
        }
      }
    },
    failFunding(error: unknown): void {
      fundingStopError = error;
    },
    counts: () => ({
      ...base.counts(),
      fundingStarts,
      fundingStops,
      strategyTransitions,
      coordinatorActions,
      monitorTradingActions
    })
  };
}

test('explicit runtime environments skip dotenv loading and preserve identity', () => {
  const explicitEnv: NodeJS.ProcessEnv = {};
  let loaderCalls = 0;

  const resolved = resolveRuntimeEnvironment(explicitEnv, () => {
    loaderCalls += 1;
    return 'loaded';
  });

  assert.equal(resolved.env, explicitEnv);
  assert.equal(resolved.fileStatus, 'skipped');
  assert.equal(loaderCalls, 0);
});

test('logs one successful service lifecycle with safe runtime fields', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const fixture = runnableFixture(events);
  const started = await startService(fixture.composition, {
    signalTarget: new SignalTarget(),
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      events.push('listen');
    }
  });

  await started.shutdown();
  await started.shutdown();

  assert.deepEqual(operations.map(({ event }) => event), [
    'service_starting',
    'service_started',
    'service_stopping',
    'service_stopped'
  ]);
  for (const operation of operations) {
    assert.deepEqual(operation.fields, {
      host: '127.0.0.1',
      port: 3000,
      databasePath: './fixture.sqlite',
      exchangeIds: ['bitget', 'okx']
    });
  }
});

test('listen failures are logged before idempotent cleanup', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const fixture = runnableFixture(events);
  const failure = new Error('address unavailable');

  await assert.rejects(
    startService(fixture.composition, {
      signalTarget: new SignalTarget(),
      operationalLog: captureOperationalLog(operations),
      listen: async () => {
        throw failure;
      }
    }),
    (error: unknown) => error === failure
  );

  assert.deepEqual(operations.map(({ event }) => event), [
    'service_starting',
    'service_start_failed',
    'service_stopping',
    'service_stopped'
  ]);
  assert.equal(operations[1]?.error, failure);
});

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runEntrypoint(cwd: string): Promise<ChildResult> {
  const entrypoint = resolve(process.cwd(), 'dist/src/main.js');
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd,
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectChild);
    child.once('close', (code) => {
      resolveChild({ code, stdout, stderr });
    });
  });
}

function parseJsonLines(output: string): Array<Record<string, unknown>> {
  return output.trim().split('\n').filter(Boolean).map((line) => (
    JSON.parse(line) as Record<string, unknown>
  ));
}

test('entrypoint loads dotenv and logs a safe actionable startup failure', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'trade-ops-entrypoint-env-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, '.env'),
    'TRADING_EXCHANGES=bitget,okx\n',
    { mode: 0o600 }
  );

  const result = await runEntrypoint(cwd);
  const lines = parseJsonLines(result.stdout);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(lines.map(({ event }) => event), [
    'environment_loaded',
    'service_startup_failed'
  ]);
  assert.deepEqual(lines[1]?.error, {
    type: 'Error',
    message: 'missing credentials for configured exchange bitget',
    stack: (lines[1]?.error as Record<string, unknown>)?.stack
  });
  assert.doesNotMatch(result.stdout, /trade-ops service startup failed/);
});

test('entrypoint reports a missing environment file before invalid config', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'trade-ops-entrypoint-missing-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));

  const result = await runEntrypoint(cwd);
  const lines = parseJsonLines(result.stdout);
  const failure = lines[1]?.error as Record<string, unknown> | undefined;

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(lines.map(({ event }) => event), [
    'environment_file_missing',
    'service_startup_failed'
  ]);
  assert.equal(failure?.message, 'invalid TRADING_EXCHANGES configuration');
});

test('starts monitoring before loopback listen and installs each signal once', async () => {
  const events: string[] = [];
  const fixture = runnableFixture(events);
  const signals = new SignalTarget();

  const started = await startService(fixture.composition, {
    signalTarget: signals,
    listen: async (_server, options) => {
      events.push(`listen:${options.host}:${options.port}`);
    }
  });

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen:127.0.0.1:3000'
  ]);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);

  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await started.shutdown();
  await started.shutdown();

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen:127.0.0.1:3000',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(fixture.counts(), {
    monitorStarts: 1,
    monitorStops: 1,
    serverCloses: 1,
    databaseCloses: 1
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.exitCode, 0);
});

test('a signal during listen is owned by the same idempotent shutdown', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const fixture = runnableFixture(events);
  const signals = new SignalTarget();
  let finishListen: (() => void) | undefined;
  const listenGate = new Promise<void>((resolve) => {
    finishListen = resolve;
  });

  const starting = startService(fixture.composition, {
    signalTarget: signals,
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      events.push('listen');
      await listenGate;
    }
  });

  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  signals.emit('SIGINT');
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  finishListen?.();
  const started = await starting;
  await started.shutdown();

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(fixture.counts(), {
    monitorStarts: 1,
    monitorStops: 1,
    serverCloses: 1,
    databaseCloses: 1
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.exitCode, 0);
  assert.deepEqual(operations.map(({ event }) => event), [
    'service_starting',
    'service_stopping',
    'service_stopped'
  ]);
});

test('a throwing operational log cannot interrupt startup or cleanup', async () => {
  const events: string[] = [];
  const fixture = runnableFixture(events);
  const throwingLog: OperationalLog = {
    info(): never {
      throw new Error('logging unavailable');
    },
    warn(): never {
      throw new Error('logging unavailable');
    },
    error(): never {
      throw new Error('logging unavailable');
    },
    fatal(): never {
      throw new Error('logging unavailable');
    }
  };

  const started = await startService(fixture.composition, {
    signalTarget: new SignalTarget(),
    operationalLog: throwingLog,
    listen: async () => {
      events.push('listen');
    }
  });
  await started.shutdown();

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
});

test('repeated signals remain owned until gated shutdown completes', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const fixture = runnableFixture(events);
  const signals = new SignalTarget();
  let monitorStopCalls = 0;
  let finishMonitorStop: (() => void) | undefined;
  const monitorStopGate = new Promise<void>((resolve) => {
    finishMonitorStop = resolve;
  });
  fixture.composition.monitor.stop = async () => {
    monitorStopCalls += 1;
    events.push('monitor.stop');
    await monitorStopGate;
  };
  const started = await startService(fixture.composition, {
    signalTarget: signals,
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      events.push('listen');
    }
  });

  signals.emit('SIGINT');
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop'
  ]);

  finishMonitorStop?.();
  await started.shutdown();
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(fixture.counts(), {
    monitorStarts: 1,
    monitorStops: 0,
    serverCloses: 1,
    databaseCloses: 1
  });
  assert.equal(monitorStopCalls, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.exitCode, 0);
  assert.deepEqual(operations.map(({ event }) => event), [
    'service_starting',
    'service_started',
    'service_stopping',
    'service_stopped'
  ]);
});

test('listen failure stops monitoring and closes server and database', async () => {
  const events: string[] = [];
  const fixture = runnableFixture(events);
  const signals = new SignalTarget();

  await assert.rejects(
    startService(fixture.composition, {
      signalTarget: signals,
      listen: async () => {
        events.push('listen');
        throw new Error('address unavailable');
      }
    }),
    /^Error: address unavailable$/
  );

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(fixture.counts(), {
    monitorStarts: 1,
    monitorStops: 1,
    serverCloses: 1,
    databaseCloses: 1
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('shutdown still closes SQLite when Fastify close fails', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const fixture = runnableFixture(events);
  fixture.composition.server.close = async () => {
    events.push('server.close');
    throw new Error('server close failed');
  };
  const started = await startService(fixture.composition, {
    signalTarget: new SignalTarget(),
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      events.push('listen');
    }
  });

  await assert.rejects(
    started.shutdown(),
    /^Error: server close failed$/
  );
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(operations.map(({ event }) => event), [
    'service_starting',
    'service_started',
    'service_stopping',
    'service_stop_failed'
  ]);
  assert.equal(
    (operations[3]?.error as Error | undefined)?.message,
    'server close failed'
  );
});

test('releases SQLite ownership when server close fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-stop-owner-'));
  const databasePath = join(directory, 'trade-ops.sqlite');
  let databaseForCleanup: Database.Database | undefined;
  let successorForCleanup: Database.Database | undefined;
  t.after(async () => {
    for (const candidate of [successorForCleanup, databaseForCleanup]) {
      try {
        if (candidate?.open) candidate.close();
      } catch {
        // Best-effort cleanup must not replace the test's primary failure.
      }
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not replace the test's primary failure.
    }
  });
  const database = new Database(databasePath, { timeout: 0 });
  databaseForCleanup = database;
  claimSqliteProcessOwnership(database, databasePath);

  const started = await startService({
    config: { host: '127.0.0.1', port: 3000 },
    fundingRateSync: {
      start: () => {},
      stop: async () => {}
    },
    monitor: {
      start: () => () => {},
      stop: async () => {}
    },
    server: {
      listen: async () => 'unused',
      close: async () => { throw new Error('server close failed'); }
    },
    database
  }, {
    signalTarget: new SignalTarget(),
    listen: async () => {}
  });
  await assert.rejects(started.shutdown(), /^Error: server close failed$/);
  assert.equal(database.open, false);
  databaseForCleanup = undefined;

  const successor = new Database(databasePath, { timeout: 0 });
  successorForCleanup = successor;
  assert.doesNotThrow(() => {
    claimSqliteProcessOwnership(successor, databasePath);
  });
  successor.close();
  successorForCleanup = undefined;
});

test('funding sync stays stopped while listen is pending and starts without an await gap', async () => {
  const events: string[] = [];
  const fixture = fundingRunnableFixture(events);
  const listenGate = manualGate<void>();
  const starting = startService(fixture.composition, {
    signalTarget: new SignalTarget(),
    listen: () => {
      events.push('listen');
      return listenGate.promise;
    }
  });

  assert.equal(fixture.counts().fundingStarts, 0);
  assert.deepEqual(events, ['monitor.start:5000', 'listen']);

  listenGate.resolve(undefined);
  await Promise.resolve();
  const startsBeforeTheNextAwait = fixture.counts().fundingStarts;
  const started = await starting;
  try {
    assert.equal(startsBeforeTheNextAwait, 1);
    assert.equal(fixture.counts().fundingStarts, 1);
    assert.deepEqual(events, [
      'monitor.start:5000',
      'listen',
      'funding.start'
    ]);
  } finally {
    await started.shutdown();
  }
});

test('listen rejection never starts funding and preserves the startup error', async () => {
  const events: string[] = [];
  const startupError = new Error('listen failed');
  const cleanupError = new Error('funding cleanup failed');
  const fixture = fundingRunnableFixture(events, {
    stopError: cleanupError
  });
  const signals = new SignalTarget();

  await assert.rejects(
    startService(fixture.composition, {
      signalTarget: signals,
      listen: async () => {
        events.push('listen');
        throw startupError;
      }
    }),
    (error: unknown) => error === startupError
  );

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'funding.stop',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.equal(fixture.counts().fundingStarts, 0);
  assert.equal(fixture.counts().fundingStops, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('a signal during listen joins funding before cleanup and prevents start', async () => {
  const events: string[] = [];
  const fixture = fundingRunnableFixture(events);
  const signals = new SignalTarget();
  const listenGate = manualGate<void>();
  const starting = startService(fixture.composition, {
    signalTarget: signals,
    listen: () => {
      events.push('listen');
      return listenGate.promise;
    }
  });

  signals.emit('SIGTERM');
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  listenGate.resolve(undefined);
  const started = await starting;
  await started.shutdown();

  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'funding.stop',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.equal(fixture.counts().fundingStarts, 0);
  assert.equal(fixture.counts().fundingStops, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.exitCode, 0);
});

test('repeated shutdown waits for funding before closing later resources', async () => {
  const events: string[] = [];
  const stopGate = manualGate<void>();
  const fixture = fundingRunnableFixture(events, {
    stopGate: stopGate.promise
  });
  const signals = new SignalTarget();
  const started = await startService(fixture.composition, {
    signalTarget: signals,
    listen: async () => {
      events.push('listen');
    }
  });

  const firstShutdown = started.shutdown();
  const secondShutdown = started.shutdown();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const eventsBeforeFundingJoin = [...events];
  const countsBeforeFundingJoin = fixture.counts();
  stopGate.resolve(undefined);
  await firstShutdown;
  await secondShutdown;

  assert.equal(firstShutdown, secondShutdown);
  assert.deepEqual(eventsBeforeFundingJoin, [
    'monitor.start:5000',
    'listen',
    'funding.start',
    'funding.stop'
  ]);
  assert.equal(countsBeforeFundingJoin.monitorStops, 0);
  assert.equal(countsBeforeFundingJoin.serverCloses, 0);
  assert.equal(countsBeforeFundingJoin.databaseCloses, 0);
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'funding.start',
    'funding.stop',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(fixture.counts(), {
    monitorStarts: 1,
    monitorStops: 1,
    serverCloses: 1,
    databaseCloses: 1,
    fundingStarts: 1,
    fundingStops: 1,
    strategyTransitions: 0,
    coordinatorActions: 0,
    monitorTradingActions: 0
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('funding worker failure stays trade-isolated and remains the shutdown error', async () => {
  const events: string[] = [];
  const fundingError = new Error('funding worker failed');
  const laterCloseError = new Error('server close failed');
  const stopGate = manualGate<void>();
  const fixture = fundingRunnableFixture(events, {
    stopGate: stopGate.promise
  });
  const signals = new SignalTarget();
  const originalServerClose = fixture.composition.server.close;
  fixture.composition.server.close = async () => {
    await originalServerClose();
    throw laterCloseError;
  };
  const started = await startService(fixture.composition, {
    signalTarget: signals,
    listen: async () => {
      events.push('listen');
    }
  });
  fixture.failFunding(fundingError);

  const outcomePromise = started.shutdown().then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const eventsBeforeFundingJoin = [...events];
  stopGate.resolve(undefined);
  const outcome = await outcomePromise;

  assert.deepEqual(eventsBeforeFundingJoin, [
    'monitor.start:5000',
    'listen',
    'funding.start',
    'funding.stop'
  ]);
  assert.deepEqual(outcome, {
    status: 'rejected',
    error: fundingError
  });
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'funding.start',
    'funding.stop',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.equal(fixture.counts().strategyTransitions, 0);
  assert.equal(fixture.counts().coordinatorActions, 0);
  assert.equal(fixture.counts().monitorTradingActions, 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
