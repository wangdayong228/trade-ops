/// <reference types="node" />

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  composeService,
  loadRuntimeConfig,
  startService
} from '../src/main.js';
import { FakeExchangeGateway } from './support/fake-exchange-gateway.js';

const VALID_ENV = {
  TRADING_EXCHANGES: 'bitget,okx',
  TRADING_BITGET_API_KEY: 'bitget-api-key-value',
  TRADING_BITGET_SECRET: 'bitget-secret-value',
  TRADING_BITGET_PASSWORD: 'bitget-password-value',
  TRADING_OKX_API_KEY: 'okx-api-key-value',
  TRADING_OKX_SECRET: 'okx-secret-value',
  TRADING_OKX_PASSWORD: 'okx-password-value'
} as const;

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

test('gateway construction failure happens before opening SQLite', () => {
  let databaseConstructions = 0;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      gatewayFactory: () => {
        throw new Error('gateway construction failed');
      },
      databaseFactory: () => {
        databaseConstructions += 1;
        return new Database(':memory:');
      },
      logger: false
    }),
    /^Error: gateway construction failed$/
  );
  assert.equal(databaseConstructions, 0);
});

test('schema construction failure closes an opened database', () => {
  let closed = 0;
  const database = {
    exec(): never {
      throw new Error('schema unavailable');
    },
    close(): void {
      closed += 1;
    }
  } as unknown as Database.Database;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
      databaseFactory: () => database,
      logger: false
    }),
    /^Error: schema unavailable$/
  );
  assert.equal(closed, 1);
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

function runnableFixture(events: string[]) {
  let monitorStarts = 0;
  let monitorStops = 0;
  let serverCloses = 0;
  let databaseCloses = 0;
  return {
    composition: {
      config: {
        host: '127.0.0.1' as const,
        port: 3000
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
  const fixture = runnableFixture(events);
  fixture.composition.server.close = async () => {
    events.push('server.close');
    throw new Error('server close failed');
  };
  const started = await startService(fixture.composition, {
    signalTarget: new SignalTarget(),
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
});
