/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  composeService,
  loadRuntimeConfig,
  resolveRuntimeEnvironment,
  startService
} from '../src/main.js';
import type {
  OperationalFields,
  OperationalLog
} from '../src/logging/logger.js';
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

test('composition shares one injected trade sink with coordinator and monitor', async (t) => {
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

  assert.equal(Reflect.get(composition.coordinator, 'tradeEvents'), tradeEvents);
  assert.equal(Reflect.get(composition.monitor, 'tradeEvents'), tradeEvents);
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
  readonly level: 'info' | 'error' | 'fatal';
  readonly event: string;
  readonly error?: unknown;
  readonly fields: Readonly<OperationalFields> | undefined;
}

function captureOperationalLog(entries: CapturedOperation[]): OperationalLog {
  return {
    info(event, fields): void {
      entries.push({ level: 'info', event, fields });
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
  const fixture = runnableFixture(events);
  const signals = new SignalTarget();
  let finishListen: (() => void) | undefined;
  const listenGate = new Promise<void>((resolve) => {
    finishListen = resolve;
  });

  const starting = startService(fixture.composition, {
    signalTarget: signals,
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
