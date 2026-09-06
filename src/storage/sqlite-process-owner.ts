import type Database from 'better-sqlite3';

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
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : undefined;
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
      throw new SqliteOwnershipError(
        'DATABASE_OWNERSHIP_UNAVAILABLE',
        databasePath
      );
    }
    database.exec('BEGIN EXCLUSIVE; COMMIT');
  } catch (error) {
    if (error instanceof SqliteOwnershipError) throw error;
    const code = sqliteErrorCode(error);
    throw new SqliteOwnershipError(
      code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
        ? 'DATABASE_OWNERSHIP_BUSY'
        : 'DATABASE_OWNERSHIP_UNAVAILABLE',
      databasePath
    );
  }
}
