/// <reference types="node" />

import Database from 'better-sqlite3';
import {
  claimSqliteProcessOwnership,
  SqliteOwnershipError
} from '../../src/storage/sqlite-process-owner.js';

type ChildAction = 'claim' | 'hold' | 'read';

interface ChildResult {
  readonly kind: 'owned' | 'read' | 'rejected';
  readonly code?: string;
}

function send(result: ChildResult): void {
  if (process.send === undefined) {
    throw new Error('sqlite owner child requires an IPC channel');
  }
  process.send(result);
}

const [databasePath, action] = process.argv.slice(2) as [
  string | undefined,
  ChildAction | undefined
];
if (databasePath === undefined || action === undefined) {
  throw new Error('sqlite owner child requires path and action');
}

const database = new Database(databasePath, { timeout: 0 });
try {
  if (action === 'read') {
    database.prepare('SELECT count(*) FROM sqlite_schema').get();
    send({ kind: 'read' });
    database.close();
    process.disconnect?.();
  } else {
    claimSqliteProcessOwnership(database, databasePath);
    database.pragma('journal_mode = WAL');
    send({ kind: 'owned' });
    if (action === 'claim') {
      database.close();
      process.disconnect?.();
    } else {
      process.once('message', (message: unknown) => {
        if (message !== 'release') {
          process.exitCode = 1;
        }
        database.close();
        process.disconnect?.();
      });
    }
  }
} catch (error) {
  send({
    kind: 'rejected',
    code: error instanceof SqliteOwnershipError
      ? (error as { readonly code: string }).code
      : 'UNEXPECTED_SAFE_TEST_FAILURE'
  });
  database.close();
  process.disconnect?.();
}
