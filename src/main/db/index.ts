import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type Db = Database.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Numbered SQL files, bundled as text at build time.
const files = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const MIGRATIONS: Migration[] = Object.entries(files)
  .map(([path, sql]) => {
    const name = path.split('/').pop()!;
    return { version: Number.parseInt(name, 10), name, sql };
  })
  .sort((a, b) => a.version - b.version);

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly restoredFrom?: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

function connect(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Overwrite deleted rows with zeros, so a deleted conversation is not recoverable from the file.
  db.pragma('secure_delete = ON');
  return db;
}

/**
 * Opens nodal.db and runs pending migrations in one transaction. An existing
 * database is copied to backups/ first; if a migration fails the copy is
 * restored and a MigrationError is thrown, so a half-migrated database is
 * never opened.
 */
export function openDatabase(dir: string, migrations: Migration[] = MIGRATIONS, now: () => number = Date.now): Db {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'nodal.db');
  const existed = existsSync(file);
  let db = connect(file);

  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return db;

  let backup: string | undefined;
  if (existed && current > 0) {
    const backups = join(dir, 'backups');
    mkdirSync(backups, { recursive: true });
    db.pragma('wal_checkpoint(TRUNCATE)');
    backup = join(backups, `nodal-v${current}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.db`);
    copyFileSync(file, backup);
  }

  try {
    db.transaction(() => {
      for (const m of pending) {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
      }
    })();
  } catch (e) {
    db.close();
    const reason = e instanceof Error ? e.message : String(e);
    if (backup) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
      copyFileSync(backup, file);
      throw new MigrationError(`Database migration failed (${reason}). Your data was restored from the backup taken just before.`, backup);
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    throw new MigrationError(`Database setup failed: ${reason}`);
  }
  // Reconnect so prepared statements see the final schema.
  db.close();
  db = connect(file);
  return db;
}
