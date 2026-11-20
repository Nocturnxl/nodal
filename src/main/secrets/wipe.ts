import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deletes everything NODAL keeps about the user in its data folder: the
 * database with its journal files, attached images, database backups and the
 * stored API keys. Logs stay; they never hold chat content, keys or
 * passphrases. Returns the names that could not be removed.
 */
export function wipeProfile(dir: string): string[] {
  const failed: string[] = [];
  for (const name of ['nodal.db', 'nodal.db-wal', 'nodal.db-shm', 'attachments', 'backups', 'keys.json']) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      failed.push(name);
    }
  }
  return failed;
}
