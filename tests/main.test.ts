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
import {
  createTradeOpsError,
  parseErrorDetail,
  projectTradeOpsError,
  withErrorPhase,
  type ErrorCode,
  type ErrorDetail,
  type ErrorSubject,
  type TradeOpsError
} from '../src/errors/trade-ops-error.js';
import type {
  OperationalFields,
  OperationalLog
} from '../src/logging/logger.js';
import type { FundingRateRepository } from '../src/storage/funding-rate-repository.js';
import { SqliteFundingRateRepository } from '../src/storage/sqlite-funding-rate-repository.js';
import {
  claimSqliteProcessOwnership
} from '../src/storage/sqlite-process-owner.js';
import { SqliteStrategyRepository } from '../src/storage/sqlite-strategy-repository.js';
import type { PreflightResult } from '../src/strategy/preflight-service.js';
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

function assertStartupDetail(
  error: unknown,
  code: ErrorCode,
  subject?: ErrorSubject
): ErrorDetail {
  const detail = withErrorPhase(error as TradeOpsError, 'startup').detail;
  assert.equal(detail.code, code);
  assert.equal(detail.phase, 'startup');
  if (subject !== undefined) assert.deepEqual(detail.subject, subject);
  assert.match(detail.occurredAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.notEqual(detail.message.length, 0);
  return detail;
}

function configurationSubject(field: string): ErrorSubject {
  return { type: 'configuration', field };
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error: unknown) => error
  );
}

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

function assertBoundedDiagnosticValue(value: ErrorDetail['actual']): void {
  if (Array.isArray(value)) {
    assert.ok(value.length <= 16);
    for (const item of value) assert.ok(item.length <= 2_000);
    return;
  }
  if (typeof value === 'string') {
    assert.ok(value.length <= 2_000);
    return;
  }
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true);
    return;
  }
  assert.ok(value === null || typeof value === 'boolean');
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

test('accepts the minimum canonical port', () => {
  const config = loadRuntimeConfig({ ...VALID_ENV, PORT: '1' });

  assert.equal(config.port, 1);
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
      (error: unknown) => {
        const detail = assertStartupDetail(
          error,
          'CONFIG_FIELD_INVALID',
          configurationSubject('FUNDING_RATE_SYNC_INTERVAL_MS')
        );
        assert.equal(detail.actual, raw);
        return true;
      },
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
    (error: unknown) => {
      assertStartupDetail(
        error,
        'CONFIG_FIELD_INVALID',
        configurationSubject('FUNDING_RATE_SYNC_INTERVAL_MS')
      );
      return true;
    }
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
  assertStartupDetail(
    caught,
    'CONFIG_FIELD_INVALID',
    configurationSubject('FUNDING_RATE_SYNC_INTERVAL_MS')
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
      (error: unknown) => {
        assertStartupDetail(
          error,
          exchanges === undefined
            ? 'CONFIG_FIELD_MISSING'
            : 'CONFIG_FIELD_INVALID',
          configurationSubject('TRADING_EXCHANGES')
        );
        return true;
      }
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
      (error: unknown) => {
        assertStartupDetail(
          error,
          'CONFIG_FIELD_INVALID',
          configurationSubject('HOST')
        );
        return true;
      }
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
      (error: unknown) => {
        assertStartupDetail(
          error,
          'CONFIG_FIELD_INVALID',
          configurationSubject('PORT')
        );
        return true;
      }
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
  test(`rejects missing or invalid ${exchangeId} ${field} without exposing values`, () => {
    const key = `TRADING_${exchangeId.toUpperCase()}_${field}`;
    for (const raw of [undefined, '', '   '] as const) {
      const env: NodeJS.ProcessEnv = {
        ...VALID_ENV,
        UNRELATED_SECRET: 'must-never-appear'
      };
      if (raw === undefined) delete env[key];
      else env[key] = raw;

      assert.throws(
        () => loadRuntimeConfig(env),
        (error: unknown) => {
          const detail = assertStartupDetail(
            error,
            raw === undefined
              ? 'CONFIG_FIELD_MISSING'
              : 'CONFIG_FIELD_INVALID',
            configurationSubject(key)
          );
          assert.equal(
            detail.actual,
            raw === undefined ? 'missing' : 'present-but-invalid'
          );
          assert.doesNotMatch(
            JSON.stringify(detail),
            /must-never-appear|api-key-value|secret-value|password-value/
          );
          return true;
        }
      );
    }
  });
}

test('reports the first invalid configuration field without reading later fields', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly earlierField: string;
    readonly earlierValue: string | undefined;
    readonly laterField: string;
    readonly code: 'CONFIG_FIELD_MISSING' | 'CONFIG_FIELD_INVALID';
  }> = [
    { name: 'funding before exchange', earlierField: 'FUNDING_RATE_SYNC_INTERVAL_MS', earlierValue: '59999', laterField: 'TRADING_EXCHANGES', code: 'CONFIG_FIELD_INVALID' },
    { name: 'exchange before Bitget key', earlierField: 'TRADING_EXCHANGES', earlierValue: 'bitget', laterField: 'TRADING_BITGET_API_KEY', code: 'CONFIG_FIELD_INVALID' },
    { name: 'Bitget key before secret', earlierField: 'TRADING_BITGET_API_KEY', earlierValue: undefined, laterField: 'TRADING_BITGET_SECRET', code: 'CONFIG_FIELD_MISSING' },
    { name: 'Bitget secret before password', earlierField: 'TRADING_BITGET_SECRET', earlierValue: undefined, laterField: 'TRADING_BITGET_PASSWORD', code: 'CONFIG_FIELD_MISSING' },
    { name: 'Bitget password before OKX key', earlierField: 'TRADING_BITGET_PASSWORD', earlierValue: undefined, laterField: 'TRADING_OKX_API_KEY', code: 'CONFIG_FIELD_MISSING' },
    { name: 'OKX key before secret', earlierField: 'TRADING_OKX_API_KEY', earlierValue: undefined, laterField: 'TRADING_OKX_SECRET', code: 'CONFIG_FIELD_MISSING' },
    { name: 'OKX secret before password', earlierField: 'TRADING_OKX_SECRET', earlierValue: undefined, laterField: 'TRADING_OKX_PASSWORD', code: 'CONFIG_FIELD_MISSING' },
    { name: 'OKX password before database path', earlierField: 'TRADING_OKX_PASSWORD', earlierValue: undefined, laterField: 'TRADING_DATABASE_PATH', code: 'CONFIG_FIELD_MISSING' },
    { name: 'database path before host', earlierField: 'TRADING_DATABASE_PATH', earlierValue: ':memory:', laterField: 'HOST', code: 'CONFIG_FIELD_INVALID' },
    { name: 'host before port', earlierField: 'HOST', earlierValue: '0.0.0.0', laterField: 'PORT', code: 'CONFIG_FIELD_INVALID' }
  ];

  for (const item of cases) {
    const env: NodeJS.ProcessEnv = { ...VALID_ENV };
    if (item.earlierValue === undefined) delete env[item.earlierField];
    else env[item.earlierField] = item.earlierValue;
    let laterReads = 0;
    Object.defineProperty(env, item.laterField, {
      configurable: true,
      enumerable: true,
      get(): string {
        laterReads += 1;
        return 'later-field-must-not-be-read';
      }
    });

    assert.throws(
      () => loadRuntimeConfig(env),
      (error: unknown) => {
        assertStartupDetail(
          error,
          item.code,
          configurationSubject(item.earlierField)
        );
        return true;
      },
      item.name
    );
    assert.equal(laterReads, 0, item.name);
  }
});

test('bounds overlong invalid runtime configuration before later reads or construction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-long-config-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly field: string;
    readonly raw: string;
    readonly laterField?: string;
  }> = [
    {
      name: 'funding interval',
      field: 'FUNDING_RATE_SYNC_INTERVAL_MS',
      raw: '9'.repeat(2_001),
      laterField: 'TRADING_EXCHANGES'
    },
    {
      name: 'exchange set',
      field: 'TRADING_EXCHANGES',
      raw: `bitget,okx,${'x'.repeat(2_001)}`,
      laterField: 'TRADING_BITGET_API_KEY'
    },
    {
      name: 'host',
      field: 'HOST',
      raw: 'h'.repeat(2_001),
      laterField: 'PORT'
    },
    {
      name: 'port',
      field: 'PORT',
      raw: '9'.repeat(2_001)
    }
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const databasePath = join(
        directory,
        `case-${index}`,
        'trade-ops.sqlite'
      );
      const env: NodeJS.ProcessEnv = {
        ...VALID_ENV,
        TRADING_DATABASE_PATH: databasePath,
        [item.field]: item.raw
      };
      let laterReads = 0;
      if (item.laterField !== undefined) {
        Object.defineProperty(env, item.laterField, {
          configurable: true,
          enumerable: true,
          get(): string {
            laterReads += 1;
            return 'later-field-must-not-be-read';
          }
        });
      }
      const calls = {
        database: 0,
        fundingRepository: 0,
        fundingSource: 0,
        fundingSync: 0,
        gateway: 0
      };
      let thrown = false;
      let caught: unknown;

      assert.ok(item.raw.length > 2_000);
      try {
        composeService({
          env,
          databaseFactory: () => {
            calls.database += 1;
            throw new Error('database must not be opened');
          },
          fundingRateRepositoryFactory: () => {
            calls.fundingRepository += 1;
            throw new Error('funding repository must not be constructed');
          },
          fundingRateSourceFactory: () => {
            calls.fundingSource += 1;
            throw new Error('funding source must not be constructed');
          },
          fundingRateSyncFactory: () => {
            calls.fundingSync += 1;
            throw new Error('funding sync must not be constructed');
          },
          gatewayFactory: () => {
            calls.gateway += 1;
            throw new Error('gateway must not be constructed');
          },
          logger: false
        });
      } catch (error) {
        thrown = true;
        caught = error;
      }
      assert.equal(thrown, true);
      assert.equal(laterReads, 0);
      assert.deepEqual(calls, {
        database: 0,
        fundingRepository: 0,
        fundingSource: 0,
        fundingSync: 0,
        gateway: 0
      });
      assert.equal(await directoryExists(dirname(databasePath)), false);
      const detail = assertStartupDetail(
        caught,
        'CONFIG_FIELD_INVALID',
        configurationSubject(item.field)
      );
      const persisted = parseErrorDetail(
        JSON.parse(JSON.stringify(detail)) as unknown
      );
      assert.deepEqual(persisted, detail);
      assertBoundedDiagnosticValue(persisted.actual);
    });
  }
});

test('configuration failure happens before storage or component construction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-config-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'must-not-exist', 'trade-ops.sqlite');
  let gatewayConstructions = 0;
  let databaseConstructions = 0;
  let fundingRepositoryConstructions = 0;
  let fundingSourceConstructions = 0;
  let fundingSyncConstructions = 0;

  assert.throws(
    () => composeService({
      env: {
        ...VALID_ENV,
        TRADING_DATABASE_PATH: databasePath,
        HOST: '0.0.0.0'
      },
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      databaseFactory: () => {
        databaseConstructions += 1;
        return new Database(':memory:');
      },
      fundingRateRepositoryFactory: () => {
        fundingRepositoryConstructions += 1;
        throw new Error('funding repository must not be constructed');
      },
      fundingRateSourceFactory: () => {
        fundingSourceConstructions += 1;
        throw new Error('funding source must not be constructed');
      },
      fundingRateSyncFactory: () => {
        fundingSyncConstructions += 1;
        throw new Error('funding sync must not be constructed');
      },
      logger: false
    }),
    (error: unknown) => {
      assertStartupDetail(
        error,
        'CONFIG_FIELD_INVALID',
        configurationSubject('HOST')
      );
      return true;
    }
  );
  assert.equal(gatewayConstructions, 0);
  assert.equal(databaseConstructions, 0);
  assert.equal(fundingRepositoryConstructions, 0);
  assert.equal(fundingSourceConstructions, 0);
  assert.equal(fundingSyncConstructions, 0);
  assert.equal(await directoryExists(dirname(databasePath)), false);
});

for (const [name, databasePath] of [
  ['empty', ''],
  ['whitespace-only', '   '],
  ['NUL-containing', 'state/\0trade-ops.sqlite'],
  ['memory token', ':memory:'],
  ['padded memory token', ' :memory: '],
  ['file URI', 'file:trade-ops.sqlite'],
  ['uppercase file URI', 'FILE:trade-ops.sqlite?mode=memory&cache=shared']
] as const) {
  test(`rejects ${name} production database path`, () => {
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
      (error: unknown) => {
        assertStartupDetail(
          error,
          'CONFIG_FIELD_INVALID',
          configurationSubject('TRADING_DATABASE_PATH')
        );
        return true;
      }
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
    (error: unknown) => {
      const detail = assertStartupDetail(error, 'SERVICE_COMPONENT_FAILED');
      assert.doesNotMatch(JSON.stringify(detail), /gateway construction failed/);
      return true;
    }
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
    (error: unknown) => {
      const detail = assertStartupDetail(
        error,
        'DATABASE_OWNERSHIP_BUSY'
      );
      assert.equal(detail.subject.type, 'database');
      assert.doesNotMatch(JSON.stringify(detail), /raw busy detail/);
      return true;
    }
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
    (error: unknown) => {
      const detail = assertStartupDetail(error, 'STORAGE_OPERATION_FAILED');
      assert.equal(detail.subject.type, 'database');
      assert.doesNotMatch(JSON.stringify(detail), /schema unavailable/);
      return true;
    }
  );
  assert.equal(statements[0], 'BEGIN EXCLUSIVE; COMMIT');
  assert.equal(gatewayConstructions, 0);
  assert.equal(closes, 1);
});

test('preserves a trusted strategy schema mismatch through composition', () => {
  let database: Database.Database | undefined;
  let gatewayConstructions = 0;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => {
        database = new Database(':memory:', { timeout: 0 });
        new SqliteStrategyRepository(database);
        database.pragma('ignore_check_constraints = ON');
        database.prepare(`
          UPDATE strategy_schema_metadata SET version = 99 WHERE singleton = 1
        `).run();
        return database;
      },
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => {
      const detail = assertStartupDetail(
        error,
        'DATABASE_SCHEMA_VERSION_MISMATCH'
      );
      assert.equal(detail.subject.type, 'database');
      assert.equal(
        'table' in detail.subject ? detail.subject.table : undefined,
        'strategies'
      );
      return true;
    }
  );
  assert.equal(database?.open, false);
  assert.equal(gatewayConstructions, 0);
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
    (error: unknown) => {
      assertStartupDetail(error, 'DATABASE_OWNERSHIP_BUSY');
      return true;
    }
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
    (error: unknown) => {
      assertStartupDetail(error, 'SERVICE_COMPONENT_FAILED');
      return true;
    }
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
    (error: unknown) => {
      const detail = assertStartupDetail(error, 'DATABASE_OPEN_FAILED');
      assert.equal(detail.subject.type, 'database');
      assert.doesNotMatch(JSON.stringify(detail), /database open failed/);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test('keeps a long valid database path intact while bounding open failure diagnostics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-long-path-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const segments = [
    'a'.repeat(180),
    'b'.repeat(180),
    'c'.repeat(180)
  ] as const;
  const databasePath = join(directory, ...segments, 'trade-ops.sqlite');
  const env = { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath };
  const rawFailureMessage = 'third-party-database-open-secret';
  let databaseFactoryPath: string | undefined;
  const calls = {
    database: 0,
    fundingRepository: 0,
    fundingSource: 0,
    fundingSync: 0,
    gateway: 0
  };
  let thrown = false;
  let caught: unknown;

  for (const segment of segments) assert.ok(segment.length < 255);
  assert.ok(databasePath.length > 512);
  assert.equal(loadRuntimeConfig(env).databasePath, databasePath);

  try {
    composeService({
      env,
      databaseFactory: (path) => {
        calls.database += 1;
        databaseFactoryPath = path;
        throw new Error(rawFailureMessage);
      },
      fundingRateRepositoryFactory: () => {
        calls.fundingRepository += 1;
        throw new Error('funding repository must not be constructed');
      },
      fundingRateSourceFactory: () => {
        calls.fundingSource += 1;
        throw new Error('funding source must not be constructed');
      },
      fundingRateSyncFactory: () => {
        calls.fundingSync += 1;
        throw new Error('funding sync must not be constructed');
      },
      gatewayFactory: () => {
        calls.gateway += 1;
        throw new Error('gateway must not be constructed');
      },
      logger: false
    });
  } catch (error) {
    thrown = true;
    caught = error;
  }

  assert.equal(thrown, true);
  assert.equal(databaseFactoryPath, databasePath);
  assert.deepEqual(calls, {
    database: 1,
    fundingRepository: 0,
    fundingSource: 0,
    fundingSync: 0,
    gateway: 0
  });
  assert.equal(await directoryExists(dirname(databasePath)), true);

  const detail = assertStartupDetail(caught, 'DATABASE_OPEN_FAILED');
  const persisted = parseErrorDetail(
    JSON.parse(JSON.stringify(detail)) as unknown
  );
  assert.deepEqual(persisted, detail);
  assert.equal(persisted.subject.type, 'database');
  if (persisted.subject.type === 'database') {
    const operation = persisted.subject.operation;
    assert.equal(typeof operation, 'string');
    assert.equal(
      operation?.toLowerCase().includes('open')
        || operation?.includes('打开'),
      true
    );
    if (persisted.subject.path !== undefined) {
      assert.ok(persisted.subject.path.length <= 512);
    }
  }
  assertBoundedDiagnosticValue(persisted.expected);
  assertBoundedDiagnosticValue(persisted.actual);
  assert.equal(typeof persisted.actual, 'string');
  assert.notEqual(persisted.actual, rawFailureMessage);
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /third-party-database-open-secret|stack|cause/
  );
});

test('converts database parent directory failure before opening SQLite', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-parent-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const occupiedParent = join(directory, 'occupied');
  const databasePath = join(occupiedParent, 'trade-ops.sqlite');
  await writeFile(occupiedParent, 'not a directory');
  let databaseConstructions = 0;
  let gatewayConstructions = 0;

  assert.throws(
    () => composeService({
      env: { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath },
      databaseFactory: () => {
        databaseConstructions += 1;
        return new Database(':memory:');
      },
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => {
      const detail = assertStartupDetail(error, 'STORAGE_OPERATION_FAILED');
      assert.deepEqual(detail.subject, {
        type: 'database',
        path: databasePath,
        operation: 'create-parent-directory'
      });
      assert.doesNotMatch(JSON.stringify(detail), /EEXIST|ENOTDIR/);
      return true;
    }
  );
  assert.equal(databaseConstructions, 0);
  assert.equal(gatewayConstructions, 0);
});

test('converts heterogeneous database open failures without later construction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-open-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const failures: readonly unknown[] = [
    new Error('database-error-secret'),
    'database-string-secret',
    { message: 'database-object-secret', cause: 'database-cause-secret' }
  ];

  for (const [index, failure] of failures.entries()) {
    const databasePath = join(directory, `case-${index}`, 'trade-ops.sqlite');
    let sourceConstructions = 0;
    let gatewayConstructions = 0;
    assert.throws(
      () => composeService({
        env: { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath },
        databaseFactory: () => { throw failure; },
        fundingRateSourceFactory: () => {
          sourceConstructions += 1;
          return [
            new FakeFundingRateSource('bitget', []),
            new FakeFundingRateSource('okx', [])
          ];
        },
        gatewayFactory: (exchangeId) => {
          gatewayConstructions += 1;
          return new FakeExchangeGateway(exchangeId);
        },
        logger: false
      }),
      (error: unknown) => {
        const detail = assertStartupDetail(error, 'DATABASE_OPEN_FAILED');
        assert.equal(detail.subject.type, 'database');
        assert.equal(
          'path' in detail.subject ? detail.subject.path : undefined,
          databasePath
        );
        assert.doesNotMatch(JSON.stringify(detail), /database-(?:error|string|object|cause)-secret/);
        return true;
      }
    );
    assert.equal(sourceConstructions, 0);
    assert.equal(gatewayConstructions, 0);
  }
});

test('initializes the funding repository before funding components and gateways', async (t) => {
  const events: string[] = [];
  let composition: ReturnType<typeof composeService> | undefined;
  t.after(async () => closeCompositionForCleanup(composition));

  composition = composeService({
    env: VALID_ENV,
    databaseFactory: () => new Database(':memory:', { timeout: 0 }),
    fundingRateRepositoryFactory: (database) => {
      events.push('funding-repository');
      return new SqliteFundingRateRepository(database);
    },
    fundingRateSourceFactory: () => {
      events.push('funding-source');
      return [
        new FakeFundingRateSource('bitget', []),
        new FakeFundingRateSource('okx', [])
      ];
    },
    fundingRateSyncFactory: () => {
      events.push('funding-sync');
      return { start(): void {}, async stop(): Promise<void> {} };
    },
    gatewayFactory: (exchangeId) => {
      events.push(`${exchangeId}-gateway`);
      return new FakeExchangeGateway(exchangeId);
    },
    logger: false
  });

  assert.deepEqual(events, [
    'funding-repository',
    'funding-source',
    'funding-sync',
    'bitget-gateway',
    'okx-gateway'
  ]);
});

test('funding repository initialization failure precedes component construction', () => {
  const events: string[] = [];
  let caught: unknown;
  try {
    composeService({
      env: VALID_ENV,
      databaseFactory: () => new Database(':memory:', { timeout: 0 }),
      fundingRateRepositoryFactory: () => {
        events.push('funding-repository');
        throw new Error('funding-repository-secret');
      },
      fundingRateSourceFactory: () => {
        events.push('funding-source');
        return [
          new FakeFundingRateSource('bitget', []),
          new FakeFundingRateSource('okx', [])
        ];
      },
      logger: false
    });
  } catch (error) {
    caught = error;
  }
  assert.deepEqual(events, ['funding-repository']);
  const detail = assertStartupDetail(caught, 'STORAGE_OPERATION_FAILED');
  assert.equal(detail.subject.type, 'database');
  assert.doesNotMatch(JSON.stringify(detail), /funding-repository-secret/);
});

test('converts unknown funding repository initialization failures before close errors', () => {
  const configuredSecret = VALID_ENV.TRADING_BITGET_API_KEY;
  const database = new Database(':memory:', { timeout: 0 });
  const originalClose = database.close.bind(database);
  database.close = () => {
    originalClose();
    throw new Error(
      `database close failed after construction ${configuredSecret}`
    );
  };
  let caught: unknown;
  try {
    composeService({
      env: VALID_ENV,
      databaseFactory: () => database,
      fundingRateSourceFactory: () => [
        new FakeFundingRateSource('bitget', []),
        new FakeFundingRateSource('okx', [])
      ],
      fundingRateRepositoryFactory: () => {
        throw new Error(
          `funding repository initialization unavailable ${configuredSecret}`
        );
      },
      logger: false
    });
  } catch (error) {
    caught = error;
  }

  const detail = assertStartupDetail(caught, 'STORAGE_OPERATION_FAILED');
  assert.equal(detail.subject.type, 'database');
  const projected = projectTradeOpsError(
    caught as TradeOpsError,
    Object.values(VALID_ENV),
    false
  );
  const serialized = JSON.stringify(projected);
  const primaryIndex = serialized.indexOf(
    'funding repository initialization unavailable'
  );
  const closeIndex = serialized.indexOf(
    'database close failed after construction'
  );
  assert.ok(primaryIndex >= 0);
  assert.ok(closeIndex > primaryIndex);
  assert.doesNotMatch(serialized, new RegExp(configuredSecret));
  assert.doesNotMatch(serialized, /"stack"/);
  assert.equal(database.open, false);
});

test('converts unknown component construction failures and preserves trusted details', () => {
  const trusted = createTradeOpsError({
    code: 'SERVICE_COMPONENT_FAILED',
    phase: 'startup',
    subject: { type: 'configuration', field: 'trusted-component' },
    expected: 'constructed',
    actual: 'object-failure',
    occurredAt: '2026-10-03T00:00:00.000Z'
  });
  const cases = [
    {
      name: 'funding source undefined',
      point: 'source',
      value: undefined,
    },
    {
      name: 'funding sync string',
      point: 'sync',
      value: 'component-string-secret',
    },
    {
      name: 'gateway object',
      point: 'gateway',
      value: { message: 'component-object-secret' },
    },
    {
      name: 'trusted component detail',
      point: 'source',
      value: trusted,
    }
  ] as const;

  for (const item of cases) {
    let database: Database.Database | undefined;
    let sourceCalls = 0;
    let syncCalls = 0;
    const gatewayCalls: string[] = [];
    let thrown = false;
    let caught: unknown;
    try {
      composeService({
        env: VALID_ENV,
        databaseFactory: () => {
          database = new Database(':memory:', { timeout: 0 });
          return database;
        },
        fundingRateSourceFactory: () => {
          sourceCalls += 1;
          if (item.point === 'source') throw item.value;
          return [
            new FakeFundingRateSource('bitget', []),
            new FakeFundingRateSource('okx', [])
          ];
        },
        fundingRateSyncFactory: () => {
          syncCalls += 1;
          if (item.point === 'sync') throw item.value;
          return { start(): void {}, async stop(): Promise<void> {} };
        },
        gatewayFactory: (exchangeId) => {
          gatewayCalls.push(exchangeId);
          if (item.point === 'gateway') throw item.value;
          return new FakeExchangeGateway(exchangeId);
        },
        logger: false
      });
    } catch (error) {
      thrown = true;
      caught = error;
    }
    assert.equal(thrown, true, item.name);
    const detail = assertStartupDetail(
      caught,
      'SERVICE_COMPONENT_FAILED'
    );
    if (item.value === trusted) assert.deepEqual(detail, trusted.detail);
    else assert.doesNotMatch(JSON.stringify(detail), /component-(?:string|object)-secret/);
    assert.equal(database?.open, false, item.name);
    assert.equal(sourceCalls, 1, item.name);
    assert.equal(syncCalls, item.point === 'source' ? 0 : 1, item.name);
    assert.deepEqual(
      gatewayCalls,
      item.point === 'gateway' ? ['bitget'] : [],
      item.name
    );
  }
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

  assert.equal(response.statusCode, 500);
  const body = response.json() as {
    readonly requestId: string;
    readonly error: unknown;
  };
  assert.notEqual(body.requestId.length, 0);
  const detail = parseErrorDetail(body.error);
  assert.equal(detail.code, 'REQUEST_OPERATION_FAILED');
  assert.equal(detail.phase, 'request');
  for (const secret of Object.values(VALID_ENV).slice(1)) {
    assert.doesNotMatch(response.body, new RegExp(secret));
  }
});

test('composition injects configured credential redaction into confirmation persistence', async (t) => {
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
  const snapshot: PreflightResult = {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: 'BTC/USDT',
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode: 'CONCURRENT',
    spotMarket: {
      exchangeId: 'bitget', symbol: 'BTC/USDT', marketId: 'BTCUSDT',
      kind: 'spot', base: 'BTC', quote: 'USDT', active: true,
      amountStep: '0.001', contractSize: '1', minBaseAmount: '0.001',
      minQuoteNotional: '5', priceStep: '0.1'
    },
    contractMarket: {
      exchangeId: 'okx', symbol: 'BTC/USDT', marketId: 'BTC-USDT-SWAP',
      kind: 'swap', base: 'BTC', quote: 'USDT', active: true,
      amountStep: '1', contractSize: '0.001', minBaseAmount: '0.001',
      minQuoteNotional: '5', priceStep: '0.1'
    },
    accountSettings: {
      marginMode: 'isolated', positionMode: 'hedged', leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-10-03T00:00:00.000Z'
  };
  const pending = composition.repository.createPending(snapshot);
  const credentialMessage = Object.values(VALID_ENV).join(' | ');
  Reflect.set(composition.preflightService, 'run', async () => {
    throw new Error(
      `confirmation account refresh unavailable ${credentialMessage}`
    );
  });

  const response = await composition.server.inject({
    method: 'POST',
    url: `/api/hedges/${pending.id}/confirm`,
    headers: {
      host: 'localhost:80',
      origin: 'http://localhost:80'
    },
    payload: { riskAcknowledged: true }
  });

  assert.equal(response.statusCode, 409);
  const stored = composition.repository.getStrategy(pending.id);
  assert.equal(stored.state, 'PREFLIGHT_INVALIDATED');
  assert.notEqual(stored.preflightFailure, null);
  const persisted = parseErrorDetail(structuredClone(stored.preflightFailure));
  const serialized = JSON.stringify(persisted);
  assert.match(serialized, /confirmation account refresh unavailable/);
  assert.doesNotMatch(serialized, /"stack"/);
  for (const secret of Object.values(VALID_ENV).slice(1)) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.deepEqual(composition.repository.listOrders(pending.id), []);
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

type TestSignal = 'SIGINT' | 'SIGTERM';

interface SignalTargetFailure {
  readonly signal: TestSignal;
  readonly value: unknown;
}

class SignalTarget extends EventEmitter {
  exitCode: number | undefined;
  readonly registrationAttempts: TestSignal[] = [];
  readonly removalAttempts: TestSignal[] = [];

  constructor(
    private readonly registrationFailure?: SignalTargetFailure,
    private readonly removalFailure?: SignalTargetFailure
      | readonly SignalTargetFailure[]
  ) {
    super();
  }

  override on(
    eventName: string | symbol,
    listener: (...args: any[]) => void
  ): this {
    const result = super.on(eventName, listener);
    if (eventName === 'SIGINT' || eventName === 'SIGTERM') {
      this.registrationAttempts.push(eventName);
      if (this.registrationFailure?.signal === eventName) {
        throw this.registrationFailure.value;
      }
    }
    return result;
  }

  override removeListener(
    eventName: string | symbol,
    listener: (...args: any[]) => void
  ): this {
    if (eventName === 'SIGINT' || eventName === 'SIGTERM') {
      this.removalAttempts.push(eventName);
      const failure = Array.isArray(this.removalFailure)
        ? this.removalFailure.find((item) => item.signal === eventName)
        : this.removalFailure;
      if (failure?.signal === eventName) {
        throw failure.value;
      }
    }
    return super.removeListener(eventName, listener);
  }
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

interface TaggedThrow {
  readonly enabled: true;
  readonly value: unknown;
}

function throwConfigured(failure: TaggedThrow | undefined): void {
  if (failure?.enabled === true) throw failure.value;
}

interface FundingRunnableFixtureOptions {
  readonly stopGate?: Promise<void>;
  readonly fundingStartFailure?: TaggedThrow;
  readonly fundingStopFailure?: TaggedThrow;
  readonly monitorStartFailure?: TaggedThrow;
  readonly monitorStopFailure?: TaggedThrow;
  readonly serverCloseFailure?: TaggedThrow;
  readonly databaseCloseFailure?: TaggedThrow;
}

function fundingRunnableFixture(
  events: string[],
  options: FundingRunnableFixtureOptions = {}
) {
  const base = runnableFixture(events);
  let fundingStarts = 0;
  let fundingStops = 0;
  let fundingStopFailure = options.fundingStopFailure;
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
          throwConfigured(options.fundingStartFailure);
        },
        async stop(): Promise<void> {
          events.push('funding.stop');
          fundingStops += 1;
          await options.stopGate;
          throwConfigured(fundingStopFailure);
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
        start(intervalMs: number): () => void {
          const stop = base.composition.monitor.start(intervalMs);
          throwConfigured(options.monitorStartFailure);
          return stop;
        },
        async stop(): Promise<void> {
          await base.composition.monitor.stop();
          throwConfigured(options.monitorStopFailure);
        },
        async reconcileStrategy(): Promise<void> {
          monitorTradingActions += 1;
        }
      },
      server: {
        ...base.composition.server,
        async close(): Promise<void> {
          await base.composition.server.close();
          throwConfigured(options.serverCloseFailure);
        }
      },
      database: {
        close(): void {
          base.composition.database.close();
          throwConfigured(options.databaseCloseFailure);
        }
      }
    },
    failFunding(error: unknown): void {
      fundingStopFailure = { enabled: true, value: error };
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
  const failure = new Error(
    `address unavailable on synthetic listener ${VALID_ENV.TRADING_OKX_SECRET}`
  );

  const error = await rejectedValue(startService(fixture.composition, {
    signalTarget: new SignalTarget(),
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      throw failure;
    }
  }));
  const detail = assertStartupDetail(error, 'SERVICE_LISTEN_FAILED');
  const returnedProjection = projectTradeOpsError(
    error as TradeOpsError,
    Object.values(VALID_ENV),
    true
  );
  const returnedSerialized = JSON.stringify(returnedProjection);
  assert.match(returnedSerialized, /address unavailable on synthetic listener/);
  assert.match(returnedSerialized, /"stack"/);
  assert.doesNotMatch(
    returnedSerialized,
    new RegExp(VALID_ENV.TRADING_OKX_SECRET)
  );

  assert.deepEqual(operations.map(({ event }) => event), [
    'service_starting',
    'service_start_failed',
    'service_stopping',
    'service_stopped'
  ]);
  assert.deepEqual(
    assertStartupDetail(operations[1]?.error, 'SERVICE_LISTEN_FAILED'),
    detail
  );
  assert.deepEqual(
    projectTradeOpsError(
      operations[1]?.error as TradeOpsError,
      Object.values(VALID_ENV),
      true
    ),
    returnedProjection
  );
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
  const detail = parseErrorDetail(lines[1]?.error);
  assert.equal(detail.code, 'CONFIG_FIELD_MISSING');
  assert.equal(detail.phase, 'startup');
  assert.deepEqual(detail.subject, {
    type: 'configuration',
    field: 'TRADING_BITGET_API_KEY'
  });
  assert.equal(detail.actual, 'missing');
  assert.equal('stack' in (lines[1]?.error as object), false);
  assert.equal('cause' in (lines[1]?.error as object), false);
});

test('entrypoint reports a missing environment file before invalid config', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'trade-ops-entrypoint-missing-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));

  const result = await runEntrypoint(cwd);
  const lines = parseJsonLines(result.stdout);
  const failure = parseErrorDetail(lines[1]?.error);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(lines.map(({ event }) => event), [
    'environment_file_missing',
    'service_startup_failed'
  ]);
  assert.equal(failure.code, 'CONFIG_FIELD_MISSING');
  assert.deepEqual(failure.subject, {
    type: 'configuration',
    field: 'TRADING_EXCHANGES'
  });
  assert.equal(failure.actual, 'missing');
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

test('cleans partial signal registration failures before startup actions', async (t) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly registrationSignal: TestSignal;
    readonly registrationFailure: unknown;
    readonly expectedRegistrations: readonly TestSignal[];
    readonly expectedActual: string;
    readonly removalFailure?: Error;
  }> = [
    {
      name: 'first registration installs then throws Error',
      registrationSignal: 'SIGINT',
      registrationFailure: new Error('signal-on-sigint-secret'),
      expectedRegistrations: ['SIGINT'],
      expectedActual: 'object-failure'
    },
    {
      name: 'second registration installs then throws undefined',
      registrationSignal: 'SIGTERM',
      registrationFailure: undefined,
      expectedRegistrations: ['SIGINT', 'SIGTERM'],
      expectedActual: 'undefined-thrown'
    },
    {
      name: 'registration remains primary when listener removal fails',
      registrationSignal: 'SIGTERM',
      registrationFailure: 'signal-on-sigterm-secret',
      expectedRegistrations: ['SIGINT', 'SIGTERM'],
      expectedActual: 'string-thrown',
      removalFailure: new Error('signal-remove-sigint-secret')
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const events: string[] = [];
      const fixture = fundingRunnableFixture(events);
      const signals = new SignalTarget(
        {
          signal: item.registrationSignal,
          value: item.registrationFailure
        },
        item.removalFailure === undefined
          ? undefined
          : { signal: 'SIGINT', value: item.removalFailure }
      );
      const unrelatedSigint = (): void => {};
      const unrelatedSigterm = (): void => {};
      signals.addListener('SIGINT', unrelatedSigint);
      signals.addListener('SIGTERM', unrelatedSigterm);
      let listenCalls = 0;

      const error = await rejectedValue(startService(fixture.composition, {
        signalTarget: signals,
        listen: async () => {
          listenCalls += 1;
        }
      }));

      assert.deepEqual(events, [
        'funding.stop',
        'monitor.stop',
        'server.close',
        'database.close'
      ], item.name);
      assert.deepEqual(fixture.counts(), {
        monitorStarts: 0,
        monitorStops: 1,
        serverCloses: 1,
        databaseCloses: 1,
        fundingStarts: 0,
        fundingStops: 1,
        strategyTransitions: 0,
        coordinatorActions: 0,
        monitorTradingActions: 0
      }, item.name);
      assert.equal(listenCalls, 0, item.name);
      assert.deepEqual(
        signals.registrationAttempts,
        item.expectedRegistrations,
        item.name
      );
      assert.equal(
        signals.listeners('SIGINT').includes(unrelatedSigint),
        true,
        item.name
      );
      assert.equal(
        signals.listeners('SIGTERM').includes(unrelatedSigterm),
        true,
        item.name
      );
      if (item.removalFailure === undefined) {
        assert.equal(signals.listenerCount('SIGINT'), 1, item.name);
        assert.equal(signals.listenerCount('SIGTERM'), 1, item.name);
      } else {
        assert.deepEqual(
          [...signals.removalAttempts].sort(),
          ['SIGINT', 'SIGTERM'],
          item.name
        );
        assert.equal(signals.listenerCount('SIGTERM'), 1, item.name);
      }

      const detail = assertStartupDetail(
        error,
        'SERVICE_COMPONENT_FAILED',
        configurationSubject('service-component:signal-listeners')
      );
      assert.equal(detail.actual, item.expectedActual, item.name);
      assert.doesNotMatch(
        JSON.stringify(detail),
        /signal-on-sigint-secret|signal-on-sigterm-secret|signal-remove-sigint-secret/,
        item.name
      );
      assert.equal('stack' in detail, false, item.name);
      assert.equal('cause' in detail, false, item.name);
    });
  }
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

test('a throwing operational log cannot hide a precise startup failure', async () => {
  const events: string[] = [];
  const fixture = fundingRunnableFixture(events, {
    monitorStartFailure: { enabled: true, value: undefined }
  });
  const throwingLog: OperationalLog = {
    info(): never { throw new Error('logging unavailable'); },
    warn(): never { throw new Error('logging unavailable'); },
    error(): never { throw new Error('logging unavailable'); },
    fatal(): never { throw new Error('logging unavailable'); }
  };

  const error = await rejectedValue(startService(fixture.composition, {
    signalTarget: new SignalTarget(),
    operationalLog: throwingLog,
    listen: async () => { events.push('listen'); }
  }));

  assertStartupDetail(error, 'SERVICE_COMPONENT_FAILED');
  assert.deepEqual(events, [
    'monitor.start:5000',
    'funding.stop',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
});

test('converts heterogeneous failures at each startup step before cleanup', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly point: 'monitor' | 'listen' | 'funding';
    readonly value: unknown;
    readonly code: 'SERVICE_COMPONENT_FAILED' | 'SERVICE_LISTEN_FAILED';
  }> = [
    { name: 'monitor undefined', point: 'monitor', value: undefined, code: 'SERVICE_COMPONENT_FAILED' },
    { name: 'listen undefined', point: 'listen', value: undefined, code: 'SERVICE_LISTEN_FAILED' },
    { name: 'funding undefined', point: 'funding', value: undefined, code: 'SERVICE_COMPONENT_FAILED' },
    { name: 'monitor Error', point: 'monitor', value: new Error('monitor-start-secret'), code: 'SERVICE_COMPONENT_FAILED' },
    { name: 'listen string', point: 'listen', value: 'listen-start-secret', code: 'SERVICE_LISTEN_FAILED' },
    { name: 'funding object', point: 'funding', value: { message: 'funding-start-secret' }, code: 'SERVICE_COMPONENT_FAILED' }
  ];

  for (const item of cases) {
    const events: string[] = [];
    const operations: CapturedOperation[] = [];
    const signals = new SignalTarget();
    const fixture = fundingRunnableFixture(events, {
      ...(item.point === 'monitor'
        ? { monitorStartFailure: { enabled: true as const, value: item.value } }
        : {}),
      ...(item.point === 'funding'
        ? { fundingStartFailure: { enabled: true as const, value: item.value } }
        : {})
    });
    const error = await rejectedValue(startService(fixture.composition, {
      signalTarget: signals,
      operationalLog: captureOperationalLog(operations),
      listen: async () => {
        events.push('listen');
        if (item.point === 'listen') throw item.value;
      }
    }));
    const detail = assertStartupDetail(error, item.code);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /monitor-start-secret|listen-start-secret|funding-start-secret/
    );
    assert.deepEqual(
      assertStartupDetail(operations[1]?.error, item.code),
      detail,
      item.name
    );
    assert.deepEqual(events, [
      'monitor.start:5000',
      ...(item.point === 'monitor' ? [] : ['listen']),
      ...(item.point === 'funding' ? ['funding.start'] : []),
      'funding.stop',
      'monitor.stop',
      'server.close',
      'database.close'
    ], item.name);
    assert.equal(
      fixture.counts().fundingStarts,
      item.point === 'funding' ? 1 : 0,
      item.name
    );
    assert.equal(fixture.counts().strategyTransitions, 0, item.name);
    assert.equal(fixture.counts().coordinatorActions, 0, item.name);
    assert.equal(fixture.counts().monitorTradingActions, 0, item.name);
    assert.equal(signals.listenerCount('SIGINT'), 0, item.name);
    assert.equal(signals.listenerCount('SIGTERM'), 0, item.name);
  }
});

test('all cleanup steps run when startup and every cleanup step fail', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const signals = new SignalTarget();
  const fixture = fundingRunnableFixture(events, {
    fundingStopFailure: {
      enabled: true,
      value: new Error('funding sync cleanup failed')
    },
    monitorStopFailure: {
      enabled: true,
      value: new Error('order monitor cleanup failed')
    },
    serverCloseFailure: {
      enabled: true,
      value: new Error('HTTP server cleanup failed')
    },
    databaseCloseFailure: {
      enabled: true,
      value: new Error('database cleanup failed')
    }
  });

  const error = await rejectedValue(startService(fixture.composition, {
    signalTarget: signals,
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      events.push('listen');
      throw new Error('listener startup failed');
    }
  }));
  const detail = assertStartupDetail(error, 'SERVICE_LISTEN_FAILED');
  const serialized = JSON.stringify(projectTradeOpsError(
    error as TradeOpsError,
    [],
    false
  ));
  const reasons = [
    'listener startup failed',
    'funding sync cleanup failed',
    'order monitor cleanup failed',
    'HTTP server cleanup failed',
    'database cleanup failed'
  ];
  let previousIndex = -1;
  for (const reason of reasons) {
    const index = serialized.indexOf(reason);
    assert.ok(index > previousIndex, `${reason} must remain in failure order`);
    previousIndex = index;
  }
  const startupLogs = operations.filter(
    ({ event }) => event === 'service_start_failed'
  );
  assert.equal(startupLogs.length, 1);
  const startupSerialized = JSON.stringify(projectTradeOpsError(
    startupLogs[0]?.error as TradeOpsError,
    [],
    false
  ));
  assert.match(startupSerialized, /listener startup failed/);
  for (const cleanupReason of reasons.slice(1)) {
    assert.doesNotMatch(startupSerialized, new RegExp(cleanupReason));
  }
  const stopLogs = operations.filter(
    ({ event }) => event === 'service_stop_failed'
  );
  assert.equal(stopLogs.length, 1);
  const stopSerialized = JSON.stringify(projectTradeOpsError(
    stopLogs[0]?.error as TradeOpsError,
    [],
    false
  ));
  previousIndex = -1;
  for (const cleanupReason of reasons.slice(1)) {
    const index = stopSerialized.indexOf(cleanupReason);
    assert.ok(
      index > previousIndex,
      `${cleanupReason} must remain in cleanup failure order`
    );
    previousIndex = index;
  }
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
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
    fundingStarts: 0,
    fundingStops: 1,
    strategyTransitions: 0,
    coordinatorActions: 0,
    monitorTradingActions: 0
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('retains both signal listener removal failures in attempt order', async () => {
  const events: string[] = [];
  const operations: CapturedOperation[] = [];
  const fixture = runnableFixture(events);
  const signals = new SignalTarget(undefined, [
    { signal: 'SIGINT', value: new Error('SIGINT removal failed') },
    { signal: 'SIGTERM', value: new Error('SIGTERM removal failed') }
  ]);
  const started = await startService(fixture.composition, {
    signalTarget: signals,
    operationalLog: captureOperationalLog(operations),
    listen: async () => {
      events.push('listen');
    }
  });

  const error = await rejectedValue(started.shutdown());
  const serialized = JSON.stringify(projectTradeOpsError(
    error as TradeOpsError,
    [],
    false
  ));
  const sigintIndex = serialized.indexOf('SIGINT removal failed');
  const sigtermIndex = serialized.indexOf('SIGTERM removal failed');
  assert.ok(sigintIndex >= 0);
  assert.ok(sigtermIndex > sigintIndex);
  assert.deepEqual(signals.removalAttempts, ['SIGINT', 'SIGTERM']);
  assert.deepEqual(events, [
    'monitor.start:5000',
    'listen',
    'monitor.stop',
    'server.close',
    'database.close'
  ]);
  assert.deepEqual(
    operations.map(({ event }) => event),
    [
      'service_starting',
      'service_started',
      'service_stopping',
      'service_stop_failed'
    ]
  );
});

test('cleanup throw undefined rejects shutdown and still closes later resources', async () => {
  const cases = [
    ['funding', 'fundingStopFailure'],
    ['monitor', 'monitorStopFailure'],
    ['server', 'serverCloseFailure'],
    ['database', 'databaseCloseFailure']
  ] as const;

  for (const [name, option] of cases) {
    const events: string[] = [];
    const operations: CapturedOperation[] = [];
    const fixture = fundingRunnableFixture(events, {
      [option]: { enabled: true, value: undefined }
    });
    const started = await startService(fixture.composition, {
      signalTarget: new SignalTarget(),
      operationalLog: captureOperationalLog(operations),
      listen: async () => { events.push('listen'); }
    });
    const error = await rejectedValue(started.shutdown());
    assertStartupDetail(error, 'SERVICE_COMPONENT_FAILED');
    assert.deepEqual(events, [
      'monitor.start:5000',
      'listen',
      'funding.start',
      'funding.stop',
      'monitor.stop',
      'server.close',
      'database.close'
    ], name);
    assert.equal(
      operations.some(({ event }) => event === 'service_stop_failed'),
      true,
      name
    );
    assert.equal(
      operations.some(({ event }) => event === 'service_stopped'),
      false,
      name
    );
  }
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

  const error = await rejectedValue(startService(fixture.composition, {
    signalTarget: signals,
    listen: async () => {
      events.push('listen');
      throw new Error('address unavailable');
    }
  }));
  assertStartupDetail(error, 'SERVICE_LISTEN_FAILED');

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

  const error = await rejectedValue(started.shutdown());
  const detail = assertStartupDetail(error, 'SERVICE_COMPONENT_FAILED');
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
  assert.deepEqual(
    assertStartupDetail(
      operations[3]?.error,
      'SERVICE_COMPONENT_FAILED'
    ),
    detail
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
  assertStartupDetail(
    await rejectedValue(started.shutdown()),
    'SERVICE_COMPONENT_FAILED'
  );
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
    fundingStopFailure: { enabled: true, value: cleanupError }
  });
  const signals = new SignalTarget();

  const error = await rejectedValue(startService(fixture.composition, {
    signalTarget: signals,
    listen: async () => {
      events.push('listen');
      throw startupError;
    }
  }));
  assertStartupDetail(error, 'SERVICE_LISTEN_FAILED');

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
  assert.equal(outcome.status, 'rejected');
  assertStartupDetail(
    outcome.status === 'rejected' ? outcome.error : undefined,
    'SERVICE_COMPONENT_FAILED'
  );
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
