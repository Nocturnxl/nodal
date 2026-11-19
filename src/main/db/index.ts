import Database from 'better-sqlite3-multiple-ciphers';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync } from 'node:fs';
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

const KEY = /^[a-f0-9]{64}$/;

/** Selects the cipher and gives the key. Must run before anything else touches the file. */
function applyKey(db: Db, key: string): void {
  if (!KEY.test(key)) throw new Error('Invalid database key.');
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = "x'${key}'"`);
}

function connect(file: string, key?: string): Db {
  const db = new Database(file);
  try {
    if (key) applyKey(db, key);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    // Overwrite deleted rows with zeros, so a deleted conversation is not recoverable from the file.
    db.pragma('secure_delete = ON');
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** True when nodal.db exists and is an ordinary, unencrypted SQLite file. */
export function isPlainDatabase(dir: string): boolean {
  const file = join(dir, 'nodal.db');
  if (!existsSync(file)) return false;
  const head = Buffer.alloc(15);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, 15, 0);
  } finally {
    closeSync(fd);
  }
  return head.toString('latin1') === 'SQLite format 3';
}

/**
 * Encrypts an open, unencrypted database in place (every page is rewritten),
 * or with `key` null removes the encryption again. The connection stays usable.
 */
export function rekeyDatabase(db: Db, key: string | null): void {
  if (key !== null && !KEY.test(key)) throw new Error('Invalid database key.');
  db.pragma('wal_checkpoint(TRUNCATE)');
  if (key) db.pragma("cipher = 'sqlcipher'");
  db.pragma(key ? `rekey = "x'${key}'"` : "rekey = ''");
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** Removes the pre-migration copies in backups/. Used when encryption is switched on: they are unencrypted. */
export function removeBackups(dir: string): number {
  const backups = join(dir, 'backups');
  if (!existsSync(backups)) return 0;
  let n = 0;
  for (const name of readdirSync(backups)) {
    if (!name.endsWith('.db')) continue;
    rmSync(join(backups, name), { force: true });
    n++;
  }
  return n;
}

/**
 * Opens nodal.db and runs pending migrations in one transaction. An existing
 * database is copied to backups/ first; if a migration fails the copy is
 * restored and a MigrationError is thrown, so a half-migrated database is
 * never opened.
 *
 * `key` opens an encrypted database. Backups are byte copies, so they are
 * encrypted with the same key.
 */
export function openDatabase(dir: string, migrations: Migration[] = MIGRATIONS, now: () => number = Date.now, key?: string): Db {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'nodal.db');
  const existed = existsSync(file);
  let db = connect(file, key);

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
  db = connect(file, key);
  return db;
}
