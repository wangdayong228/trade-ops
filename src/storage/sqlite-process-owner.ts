import { isProxy } from 'node:util/types';
import type Database from 'better-sqlite3';
import {
  createTradeOpsError,
  safeFailureCategory,
  withErrorPhase,
  type DatabaseErrorSubject,
  type TradeOpsError
} from '../errors/trade-ops-error.js';

export type SqliteOwnershipFailureCode =
  | 'DATABASE_OWNERSHIP_BUSY'
  | 'DATABASE_OWNERSHIP_UNAVAILABLE';

export class SqliteOwnershipError extends Error {
  readonly name = 'SqliteOwnershipError';

  constructor(
    readonly code: SqliteOwnershipFailureCode,
    readonly databasePath: string
  ) {
    super(code === 'DATABASE_OWNERSHIP_BUSY'
      ? `SQLite database ownership is busy: ${databasePath}`
      : [
          'SQLite database exclusive ownership is unavailable:',
          databasePath
        ].join(' '));
  }
}

function sqliteErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object'
    || error === null
    || isProxy(error)
  ) {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return undefined;
  }
  return descriptor !== undefined
      && 'value' in descriptor
      && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function isSqliteContentionCode(code: string | undefined): boolean {
  return code === 'SQLITE_BUSY'
    || code?.startsWith('SQLITE_BUSY_') === true
    || code === 'SQLITE_LOCKED'
    || code?.startsWith('SQLITE_LOCKED_') === true;
}

function ownershipSubject(
  databasePath: string
): DatabaseErrorSubject {
  return {
    type: 'database',
    ...(databasePath.length <= 512
      ? { path: databasePath }
      : { field: `path-length:${databasePath.length}` }),
    operation: 'claim-exclusive-ownership'
  };
}

function ownershipError(
  code: SqliteOwnershipFailureCode,
  databasePath: string,
  actual: string
): TradeOpsError {
  return createTradeOpsError({
    code,
    phase: 'startup',
    subject: ownershipSubject(databasePath),
    expected: 'exclusive SQLite process ownership',
    actual
  });
}

function trustedOwnershipError(error: unknown): TradeOpsError | undefined {
  try {
    const trusted = withErrorPhase(error as TradeOpsError, 'startup');
    return trusted.detail.code === 'DATABASE_OWNERSHIP_BUSY'
      || trusted.detail.code === 'DATABASE_OWNERSHIP_UNAVAILABLE'
      ? trusted
      : undefined;
  } catch {
    return undefined;
  }
}

export function claimSqliteProcessOwnership(
  database: Database.Database,
  databasePath: string
): void {
  try {
    const mode = database.pragma(
      'main.locking_mode = EXCLUSIVE',
      { simple: true }
    );
    if (mode !== 'exclusive') {
      throw ownershipError(
        'DATABASE_OWNERSHIP_UNAVAILABLE',
        databasePath,
        'locking-mode-not-exclusive'
      );
    }
    database.exec('BEGIN EXCLUSIVE; COMMIT');
  } catch (error) {
    const trusted = trustedOwnershipError(error);
    if (trusted !== undefined) throw trusted;
    const code = sqliteErrorCode(error);
    if (isSqliteContentionCode(code)) {
      throw ownershipError(
        'DATABASE_OWNERSHIP_BUSY',
        databasePath,
        'sqlite-contention'
      );
    }
    throw ownershipError(
      'DATABASE_OWNERSHIP_UNAVAILABLE',
      databasePath,
      safeFailureCategory(error)
    );
  }
}
