import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Vault, WIPE_AFTER } from '../../src/main/secrets/vault';
import { wipeProfile } from '../../src/main/secrets/wipe';
import { cleanupTmp, tmpDir } from './helpers';

const FAST = { N: 1 << 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';

afterAll(cleanupTmp);

describe('counting wrong passphrases', () => {
  it('is off by default and counts nothing that matters', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    expect(vault.guard).toEqual({ wipeAfter: 0, failures: 0 });
    await vault.create(PASS);
    expect(vault.guard).toEqual({ wipeAfter: 0, failures: 0 });
    expect(WIPE_AFTER).toBe(5);
  });

  it('keeps the count on disk across restarts and clears it on the right passphrase', async () => {
    const dir = tmpDir();
    const first = new Vault(dir, FAST);
    await first.create(PASS);
    first.setWipeAfter(5);
    expect(first.recordFailure()).toEqual({ wipeAfter: 5, failures: 1 });
    expect(first.recordFailure()).toEqual({ wipeAfter: 5, failures: 2 });

    const restarted = new Vault(dir, FAST);
    expect(restarted.guard).toEqual({ wipeAfter: 5, failures: 2 });
    expect(await restarted.unlock('not the passphrase')).toBeNull();
    expect(restarted.guard.failures).toBe(2); // counting is the caller's decision, not a side effect of trying
    expect(await restarted.unlock(PASS)).not.toBeNull();
    expect(restarted.guard).toEqual({ wipeAfter: 5, failures: 0 });
  });

  it('the setting survives a passphrase change and can be turned off; the passphrase still opens the vault', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    const keys = await vault.create(PASS);
    vault.setWipeAfter(5);
    vault.recordFailure();
    expect(await vault.changePassphrase(PASS, 'another four random words')).toBe(true);
    expect(vault.guard).toEqual({ wipeAfter: 5, failures: 0 });
    vault.setWipeAfter(0);
    expect(vault.guard).toEqual({ wipeAfter: 0, failures: 0 });
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).not.toContain('wipeAfter');
    expect((await new Vault(dir, FAST).unlock('another four random words'))?.db).toBe(keys.db);
  });

  it('a tampered count or setting is read as zero rather than trusted or crashing', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    await vault.create(PASS);
    const file = join(dir, 'vault.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), wipeAfter: 'soon', failures: -3 }));
    expect(vault.guard).toEqual({ wipeAfter: 0, failures: 0 });
    expect(await vault.unlock(PASS)).not.toBeNull();
  });

  it('destroying the vault removes the sealed key for good', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    await vault.create(PASS);
    vault.destroy();
    expect(existsSync(join(dir, 'vault.json'))).toBe(false);
    expect(vault.enabled).toBe(false);
    expect(vault.unlocked).toBe(false);
    expect(vault.keys).toBeNull();
  });
});

describe('wiping the data folder', () => {
  it('removes the database, images, backups and stored keys, and leaves the logs', () => {
    const dir = tmpDir();
    for (const name of ['nodal.db', 'nodal.db-wal', 'nodal.db-shm', 'keys.json']) writeFileSync(join(dir, name), 'x');
    for (const sub of ['attachments', 'backups', 'logs']) {
      mkdirSync(join(dir, sub));
      writeFileSync(join(dir, sub, 'file'), 'x');
    }
    expect(wipeProfile(dir)).toEqual([]);
    for (const name of ['nodal.db', 'nodal.db-wal', 'nodal.db-shm', 'keys.json', 'attachments', 'backups']) expect(existsSync(join(dir, name)), name).toBe(false);
    expect(existsSync(join(dir, 'logs', 'file'))).toBe(true);
    // Nothing to remove is not an error.
    expect(wipeProfile(dir)).toEqual([]);
  });
});
