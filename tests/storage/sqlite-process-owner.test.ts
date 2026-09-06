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
  claimSqliteProcessOwnership,
  SqliteOwnershipError
} from '../../src/storage/sqlite-process-owner.js';

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
  test(`classifies ${sqliteCode} as busy without retaining SQLite messages`, () => {
    const lockedDatabase = {
      pragma: () => 'exclusive',
      exec: () => {
        throw Object.assign(new Error('secret sqlite detail'), {
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
        assert.ok(error instanceof SqliteOwnershipError);
        const ownershipError = error as {
          readonly code: string;
          readonly databasePath: string;
          readonly message: string;
        };
        assert.equal(ownershipError.code, 'DATABASE_OWNERSHIP_BUSY');
        assert.equal(ownershipError.databasePath, '/safe/service.sqlite');
        assert.doesNotMatch(ownershipError.message, /secret sqlite detail/);
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
    (error: unknown) => error instanceof SqliteOwnershipError
      && (error as { readonly code: string }).code
        === 'DATABASE_OWNERSHIP_UNAVAILABLE'
  );

  const unavailable = {
    pragma: () => 'exclusive',
    exec: () => { throw new Error('private filesystem detail'); }
  } as unknown as Database.Database;
  assert.throws(
    () => claimSqliteProcessOwnership(
      unavailable,
      '/safe/service.sqlite'
    ),
    (error: unknown) => error instanceof SqliteOwnershipError
      && (error as { readonly code: string }).code
        === 'DATABASE_OWNERSHIP_UNAVAILABLE'
      && !(error as { readonly message: string }).message
        .includes('private filesystem detail')
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
