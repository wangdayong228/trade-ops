/// <reference types="node" />

import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  claimSqliteProcessOwnership
} from '../../src/storage/sqlite-process-owner.js';
import {
  projectTradeOpsError,
  withErrorPhase,
  type ErrorDetail,
  type TradeOpsError
} from '../../src/errors/trade-ops-error.js';

function ownershipDetail(error: unknown): ErrorDetail {
  const detail = withErrorPhase(error as TradeOpsError, 'startup').detail;
  assert.equal(detail.phase, 'startup');
  assert.equal(detail.subject.type, 'database');
  assert.equal(
    'path' in detail.subject ? detail.subject.path : undefined,
    '/safe/service.sqlite'
  );
  assert.equal(
    typeof ('operation' in detail.subject
      ? detail.subject.operation
      : undefined),
    'string'
  );
  return detail;
}

interface ChildResult {
  readonly kind: 'owned' | 'read' | 'rejected';
  readonly code?: string;
}

interface ServiceContenderResult {
  readonly kind: 'startup_rejected' | 'unexpectedly_started';
  readonly code?: string;
  readonly gatewayConstructions: number;
  readonly recoveryStarts: number;
  readonly monitorStarts: number;
  readonly listenCalls: number;
}

function startChild(
  databasePath: string,
  action: 'claim' | 'hold' | 'read'
): ChildProcess {
  return fork(
    resolve('dist/tests/support/sqlite-owner-child.js'),
    [databasePath, action],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
}

function startServiceContender(databasePath: string): ChildProcess {
  return fork(
    resolve('dist/tests/support/sqlite-service-contender-child.js'),
    [databasePath],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
}

function nextIpcResult<T>(child: ChildProcess): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const cleanup = (): void => {
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    };
    const onMessage = (message: unknown): void => {
      cleanup();
      resolveResult(message as T);
    };
    const onError = (): void => {
      cleanup();
      rejectResult(new Error('SQLite test child failed before IPC result'));
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      cleanup();
      rejectResult(new Error(
        `SQLite test child closed before IPC result: ${code}/${signal}`
      ));
    };
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function nextResult(child: ChildProcess): Promise<ChildResult> {
  return nextIpcResult<ChildResult>(child);
}

function nextServiceResult(
  child: ChildProcess
): Promise<ServiceContenderResult> {
  return nextIpcResult<ServiceContenderResult>(child);
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close');
}

interface TemporaryDatabase {
  readonly databasePath: string;
  trackChild(child: ChildProcess): ChildProcess;
  trackDatabase(database: Database.Database): Database.Database;
}

async function temporaryDatabase(t: TestContext): Promise<TemporaryDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-owner-'));
  const children: ChildProcess[] = [];
  const databases: Database.Database[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(children.map(waitForClose));
    for (const database of databases) {
      try {
        if (database.open) database.close();
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
  const databasePath = join(directory, 'trade-ops.sqlite');
  const seed = new Database(databasePath, { timeout: 0 });
  seed.exec('CREATE TABLE ownership_probe (id INTEGER PRIMARY KEY)');
  seed.close();
  return {
    databasePath,
    trackChild(child): ChildProcess {
      children.push(child);
      return child;
    },
    trackDatabase(database): Database.Database {
      databases.push(database);
      return database;
    }
  };
}

test('does not treat the exclusive pragma as acquired ownership', {
  timeout: 10_000
}, async (t) => {
  const fixture = await temporaryDatabase(t);
  const { databasePath } = fixture;
  const owner = fixture.trackDatabase(
    new Database(databasePath, { timeout: 0 })
  );

  assert.equal(
    owner.pragma('main.locking_mode = EXCLUSIVE', { simple: true }),
    'exclusive'
  );
  const reader = fixture.trackChild(startChild(databasePath, 'read'));

  assert.deepEqual(await nextResult(reader), { kind: 'read' });
  await waitForClose(reader);
});

test('allows exactly one process to own a SQLite file', {
  timeout: 10_000
}, async (t) => {
  const fixture = await temporaryDatabase(t);
  const { databasePath } = fixture;
  const owner = fixture.trackChild(startChild(databasePath, 'hold'));
  assert.deepEqual(await nextResult(owner), { kind: 'owned' });

  const contender = fixture.trackChild(startChild(databasePath, 'claim'));
  assert.deepEqual(await nextResult(contender), {
    kind: 'rejected',
    code: 'DATABASE_OWNERSHIP_BUSY'
  });
  await waitForClose(contender);

  owner.send('release');
  await waitForClose(owner);
  const successor = fixture.trackChild(startChild(databasePath, 'claim'));
  assert.deepEqual(await nextResult(successor), { kind: 'owned' });
  await waitForClose(successor);
});

test('releases SQLite ownership after an owner process is killed', {
  timeout: 10_000
}, async (t) => {
  const fixture = await temporaryDatabase(t);
  const { databasePath } = fixture;
  const owner = fixture.trackChild(startChild(databasePath, 'hold'));
  const ownerClosed = once(owner, 'close');
  assert.deepEqual(await nextResult(owner), { kind: 'owned' });
  assert.equal(owner.kill('SIGKILL'), true);
  await ownerClosed;

  const successor = fixture.trackChild(startChild(databasePath, 'claim'));
  assert.deepEqual(await nextResult(successor), { kind: 'owned' });
  await waitForClose(successor);
});

for (const sqliteCode of [
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE'
] as const) {
  test(`classifies ${sqliteCode} as busy with safe SQLite evidence`, () => {
    const configuredSecret = 'SYNTHETIC-SQLITE-CONFIGURED-SECRET';
    const lockedDatabase = {
      pragma: () => 'exclusive',
      exec: () => {
        throw Object.assign(new Error(
          `database is locked during ownership probe ${configuredSecret}`
        ), {
          code: sqliteCode
        });
      }
    } as unknown as Database.Database;
    assert.throws(
      () => claimSqliteProcessOwnership(
        lockedDatabase,
        '/safe/service.sqlite'
      ),
      (error: unknown) => {
        const detail = ownershipDetail(error);
        assert.equal(detail.code, 'DATABASE_OWNERSHIP_BUSY');
        const projected = projectTradeOpsError(
          error as TradeOpsError,
          [configuredSecret],
          false
        );
        const serialized = JSON.stringify(projected);
        assert.match(serialized, /database is locked during ownership probe/);
        assert.match(serialized, new RegExp(sqliteCode));
        assert.doesNotMatch(serialized, new RegExp(configuredSecret));
        assert.doesNotMatch(serialized, /"stack"/);
        return true;
      }
    );
  });
}

test('reads SQLite contention codes only from own data properties', async (t) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly createFailure: () => {
      readonly value: unknown;
      readonly observationCount: () => number;
      readonly forbidden: RegExp;
    };
  }> = [
    {
      name: 'own accessor',
      createFailure: () => {
        let getterReads = 0;
        const value = new Error('sqlite-accessor-secret');
        Object.defineProperty(value, 'code', {
          configurable: true,
          enumerable: true,
          get(): string {
            getterReads += 1;
            return 'SQLITE_BUSY';
          }
        });
        return {
          value,
          observationCount: () => getterReads,
          forbidden: /sqlite-accessor-secret/
        };
      }
    },
    {
      name: 'inherited data property',
      createFailure: () => {
        const value = Object.create({ code: 'SQLITE_BUSY' }) as {
          marker?: string;
        };
        value.marker = 'sqlite-inherited-secret';
        return {
          value,
          observationCount: () => 0,
          forbidden: /sqlite-inherited-secret/
        };
      }
    },
    {
      name: 'Proxy traps',
      createFailure: () => {
        let trapCalls = 0;
        const value = new Proxy(
          { marker: 'sqlite-proxy-secret' },
          {
            get(target, property, receiver): unknown {
              trapCalls += 1;
              if (property === 'code') return 'SQLITE_BUSY';
              return Reflect.get(target, property, receiver);
            },
            getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
              trapCalls += 1;
              return Reflect.getOwnPropertyDescriptor(target, property);
            }
          }
        );
        return {
          value,
          observationCount: () => trapCalls,
          forbidden: /sqlite-proxy-secret/
        };
      }
    },
    {
      name: 'revoked Proxy',
      createFailure: () => {
        let trapCalls = 0;
        const revocable = Proxy.revocable(
          { marker: 'sqlite-revoked-secret' },
          {
            get(target, property, receiver): unknown {
              trapCalls += 1;
              return Reflect.get(target, property, receiver);
            }
          }
        );
        revocable.revoke();
        return {
          value: revocable.proxy,
          observationCount: () => trapCalls,
          forbidden: /sqlite-revoked-secret/
        };
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const failure = item.createFailure();
      const unavailableDatabase = {
        pragma: () => 'exclusive',
        exec: () => { throw failure.value; }
      } as unknown as Database.Database;
      let caught: unknown;
      let didThrow = false;

      try {
        claimSqliteProcessOwnership(
          unavailableDatabase,
          '/safe/service.sqlite'
        );
      } catch (error) {
        caught = error;
        didThrow = true;
      }

      assert.equal(didThrow, true, item.name);
      assert.equal(failure.observationCount(), 0, item.name);
      const detail = ownershipDetail(caught);
      assert.equal(
        detail.code,
        'DATABASE_OWNERSHIP_UNAVAILABLE',
        item.name
      );
      assert.equal(detail.actual, 'object-failure', item.name);
      assert.doesNotMatch(JSON.stringify(detail), failure.forbidden, item.name);
    });
  }
});

for (const sqliteCode of [
  'SQLITE_BUSYISH',
  'SQLITE_LOCKEDISH'
] as const) {
  test(`classifies lookalike ${sqliteCode} as unavailable without retaining details`, () => {
    const unavailableDatabase = {
      pragma: () => 'exclusive',
      exec: () => {
        throw Object.assign(new Error('secret sqlite detail', {
          cause: new Error('secret nested cause')
        }), { code: sqliteCode });
      }
    } as unknown as Database.Database;
    assert.throws(
      () => claimSqliteProcessOwnership(
        unavailableDatabase,
        '/safe/service.sqlite'
      ),
      (error: unknown) => {
        const detail = ownershipDetail(error);
        assert.equal(detail.code, 'DATABASE_OWNERSHIP_UNAVAILABLE');
        assert.doesNotMatch(
          JSON.stringify(detail),
          /secret sqlite detail|secret nested cause/
        );
        return true;
      }
    );
  });
}

test('classifies non-contention ownership failures as unavailable', () => {
  const unsupported = {
    pragma: () => 'normal',
    exec: () => { throw new Error('must not execute'); }
  } as unknown as Database.Database;
  assert.throws(
    () => claimSqliteProcessOwnership(unsupported, '/safe/service.sqlite'),
    (error: unknown) => {
      const detail = ownershipDetail(error);
      assert.equal(detail.code, 'DATABASE_OWNERSHIP_UNAVAILABLE');
      assert.match(JSON.stringify(detail.actual), /normal/);
      return true;
    }
  );

  const unavailable = {
    pragma: () => 'exclusive',
    exec: () => {
      throw Object.assign(
        new Error('readonly filesystem blocked ownership transaction'),
        { code: 'SQLITE_READONLY' }
      );
    }
  } as unknown as Database.Database;
  assert.throws(
    () => claimSqliteProcessOwnership(
      unavailable,
      '/safe/service.sqlite'
    ),
    (error: unknown) => {
      const detail = ownershipDetail(error);
      assert.equal(detail.code, 'DATABASE_OWNERSHIP_UNAVAILABLE');
      const serialized = JSON.stringify(projectTradeOpsError(
        error as TradeOpsError,
        [],
        false
      ));
      assert.match(serialized, /readonly filesystem blocked ownership transaction/);
      assert.match(serialized, /SQLITE_READONLY/);
      assert.doesNotMatch(serialized, /"stack"/);
      return true;
    }
  );
});

test('rejects a competing service before gateway or recovery startup', {
  timeout: 10_000
}, async (t) => {
  const fixture = await temporaryDatabase(t);
  const { databasePath } = fixture;
  const owner = fixture.trackChild(startChild(databasePath, 'hold'));
  assert.deepEqual(await nextResult(owner), { kind: 'owned' });

  const contender = fixture.trackChild(startServiceContender(databasePath));
  assert.deepEqual(await nextServiceResult(contender), {
    kind: 'startup_rejected',
    code: 'DATABASE_OWNERSHIP_BUSY',
    gatewayConstructions: 0,
    recoveryStarts: 0,
    monitorStarts: 0,
    listenCalls: 0
  });
  await waitForClose(contender);
  owner.send('release');
  await waitForClose(owner);
});
