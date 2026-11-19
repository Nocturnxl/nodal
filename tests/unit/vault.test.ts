import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../../src/main/attachments';
import { exportAllZip, importBytes } from '../../src/main/data/exporter';
import { isPlainDatabase, openDatabase, rekeyDatabase, removeBackups } from '../../src/main/db';
import { Store } from '../../src/main/db/store';
import { isSealedExport, openSealedExport, sealExport, Vault } from '../../src/main/secrets/vault';
import { cleanupTmp, mockProvider, tmpDir } from './helpers';

// Small scrypt cost so the suite stays fast; the default is exercised once below.
const FAST = { N: 1 << 10, r: 8, p: 1 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const SECRET = 'the launch codes are under the doormat';

const opened: Store[] = [];
afterAll(() => {
  for (const s of opened) {
    try {
      s.db.close();
    } catch {
      /* already closed */
    }
  }
  cleanupTmp();
});

function seeded(dir: string): Store {
  const store = new Store(openDatabase(dir));
  opened.push(store);
  const p = store.saveProvider(mockProvider('http://127.0.0.1:1/v1'));
  const c = store.createConversation({ providerId: p.id, modelId: 'm', title: 'Private plans' });
  store.insertMessage({
    id: 'm1',
    conversationId: c.id,
    parentId: null,
    role: 'user',
    content: [{ type: 'text', text: SECRET }],
    providerId: null,
    modelId: null,
    reasoningText: null,
    finishReason: null,
    usage: null,
    requestId: null,
    error: null,
    createdAt: 1,
  });
  return store;
}

/** Every byte under the data folder, to search for text that should not be there. */
function allBytes(dir: string): Buffer {
  const parts: Buffer[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else parts.push(readFileSync(join(d, e.name)));
    }
  };
  walk(dir);
  return Buffer.concat(parts);
}

describe('vault', () => {
  it('unlocks with the right passphrase only, and gives the same keys each time', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    expect(vault.enabled).toBe(false);
    const keys = await vault.create('correct horse battery');
    expect(vault.enabled).toBe(true);
    expect(keys.db).toMatch(/^[a-f0-9]{64}$/);

    const again = new Vault(dir, FAST);
    expect(again.unlocked).toBe(false);
    expect(await again.unlock('correct horse batterx')).toBeNull();
    expect(again.unlocked).toBe(false);
    const reopened = await again.unlock('correct horse battery');
    expect(reopened?.db).toBe(keys.db);
    expect(reopened?.files.equals(keys.files)).toBe(true);
    expect(reopened?.names.equals(keys.names)).toBe(true);
  });

  it('never writes the passphrase or the keys to vault.json', async () => {
    const dir = tmpDir();
    const keys = await new Vault(dir, FAST).create('correct horse battery');
    const text = readFileSync(join(dir, 'vault.json'), 'utf8');
    expect(text).not.toContain('correct horse');
    expect(text).not.toContain(keys.db);
    expect(text).not.toContain(keys.files.toString('base64'));
    expect(JSON.parse(text).kdf).toMatchObject({ name: 'scrypt', N: FAST.N });
  });

  it('rejects a short passphrase and a second create', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    await expect(vault.create('short')).rejects.toThrow(/at least 8/);
    expect(vault.enabled).toBe(false);
    await vault.create('long enough now');
    await expect(vault.create('another passphrase')).rejects.toThrow(/already on/);
  });

  it('changes the passphrase without changing the keys', async () => {
    const dir = tmpDir();
    const vault = new Vault(dir, FAST);
    const keys = await vault.create('first passphrase');
    expect(await vault.changePassphrase('wrong passphrase', 'second passphrase')).toBe(false);
    expect(await vault.changePassphrase('first passphrase', 'second passphrase')).toBe(true);
    const again = new Vault(dir, FAST);
    expect(await again.unlock('first passphrase')).toBeNull();
    expect((await again.unlock('second passphrase'))?.db).toBe(keys.db);
  });

  it('detects a tampered vault file as a wrong passphrase, and a damaged one as damaged', async () => {
    const dir = tmpDir();
    await new Vault(dir, FAST).create('first passphrase');
    const file = join(dir, 'vault.json');
    const v = JSON.parse(readFileSync(file, 'utf8'));
    const sealed = Buffer.from(v.sealed, 'base64');
    sealed[0] ^= 1;
    writeFileSync(file, JSON.stringify({ ...v, sealed: sealed.toString('base64') }));
    expect(await new Vault(dir, FAST).unlock('first passphrase')).toBeNull();
    writeFileSync(file, '{ not json');
    await expect(new Vault(dir, FAST).unlock('first passphrase')).rejects.toThrow(/damaged/);
    // A crafted file cannot ask for an absurd amount of work.
    writeFileSync(file, JSON.stringify({ ...v, kdf: { ...v.kdf, N: 2 ** 30 } }));
    await expect(new Vault(dir, FAST).unlock('first passphrase')).rejects.toThrow(/damaged/);
  });

  it('works at the real key-stretching cost', async () => {
    const dir = tmpDir();
    const keys = await new Vault(dir).create('correct horse battery');
    expect((await new Vault(dir).unlock('correct horse battery'))?.db).toBe(keys.db);
    expect(JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')).kdf.N).toBe(1 << 17);
  });
});

describe('encrypted database', () => {
  it('encrypts an existing database in place and keeps working on the same connection', async () => {
    const dir = tmpDir();
    const store = seeded(dir);
    expect(isPlainDatabase(dir)).toBe(true);
    expect(allBytes(dir).includes(SECRET)).toBe(true);

    const keys = await new Vault(dir, FAST).create('correct horse battery');
    rekeyDatabase(store.db, keys.db);
    expect(isPlainDatabase(dir)).toBe(false);
    // The open connection carries on: reads, writes and full-text search.
    expect(store.listConversations({ search: 'doormat' })).toHaveLength(1);
    store.setSettings({ theme: 'dark' });
    expect(allBytes(dir).includes(SECRET)).toBe(false);
    expect(allBytes(dir).includes('Private plans')).toBe(false);
    store.db.close();

    // Reopening needs the key.
    expect(() => openDatabase(dir)).toThrow();
    expect(() => openDatabase(dir, undefined, undefined, 'ab'.repeat(32))).toThrow();
    const again = new Store(openDatabase(dir, undefined, undefined, keys.db));
    opened.push(again);
    expect(again.listConversations({ search: 'doormat' })).toHaveLength(1);
    expect(again.getSettings().theme).toBe('dark');
    // Text written after encryption, including what sits in the write-ahead log, is not readable either.
    again.setSettings({ defaultSystemPrompt: 'zebra crossing' });
    expect(allBytes(dir).includes('zebra crossing')).toBe(false);
  });

  it('removes the encryption again', async () => {
    const dir = tmpDir();
    const store = seeded(dir);
    const keys = await new Vault(dir, FAST).create('correct horse battery');
    rekeyDatabase(store.db, keys.db);
    rekeyDatabase(store.db, null);
    store.db.close();
    expect(isPlainDatabase(dir)).toBe(true);
    const again = new Store(openDatabase(dir));
    opened.push(again);
    expect(again.listConversations({ search: 'doormat' })).toHaveLength(1);
  });

  it('runs migrations on an encrypted database and keeps an encrypted backup', async () => {
    const dir = tmpDir();
    const store = seeded(dir);
    const keys = await new Vault(dir, FAST).create('correct horse battery');
    rekeyDatabase(store.db, keys.db);
    const version = store.db.pragma('user_version', { simple: true }) as number;
    store.db.close();
    const extra = [{ version: version + 1, name: 'extra.sql', sql: 'CREATE TABLE extra (a TEXT);' }];
    const db = openDatabase(dir, extra, undefined, keys.db);
    expect(db.pragma('user_version', { simple: true })).toBe(version + 1);
    db.close();
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, 'backups', backups[0])).includes(SECRET)).toBe(false);
  });

  it('deletes old unencrypted backups', () => {
    const dir = tmpDir();
    seeded(dir).db.close();
    mkdirSync(join(dir, 'backups'));
    copyFileSync(join(dir, 'nodal.db'), join(dir, 'backups', 'nodal-v1-old.db'));
    writeFileSync(join(dir, 'backups', 'notes.txt'), 'kept');
    expect(removeBackups(dir)).toBe(1);
    expect(readdirSync(join(dir, 'backups'))).toEqual(['notes.txt']);
  });
});

describe('encrypted attachments', () => {
  const keysFor = async () => {
    const k = await new Vault(tmpDir(), FAST).create('correct horse battery');
    return { files: k.files, names: k.names };
  };

  it('stores ciphertext under a name that is not the content hash', async () => {
    const dir = join(tmpDir(), 'attachments');
    const store = new AttachmentStore(dir, await keysFor());
    const ref = store.add('image/png', PNG);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(ref.sha256);
    const raw = readFileSync(join(dir, names[0]));
    expect(raw.includes(Buffer.from(PNG))).toBe(false);
    expect(Buffer.from(store.read(ref.sha256)!).equals(Buffer.from(PNG))).toBe(true);
    // Another profile's keys cannot read it.
    expect(new AttachmentStore(dir, await keysFor()).read(ref.sha256)).toBeUndefined();
    // Nor can a store with no keys.
    expect(new AttachmentStore(dir).read(ref.sha256)).toBeUndefined();
  });

  it('refuses a file that was altered or swapped for another', async () => {
    const dir = join(tmpDir(), 'attachments');
    const store = new AttachmentStore(dir, await keysFor());
    const a = store.add('image/png', PNG);
    const [nameA] = readdirSync(dir);
    const other = Uint8Array.from([...PNG, 1]);
    const b = store.add('image/png', other);
    const nameB = readdirSync(dir).find((n) => n !== nameA)!;
    // Put B's valid ciphertext where A should be.
    copyFileSync(join(dir, nameB), join(dir, nameA));
    expect(store.read(a.sha256)).toBeUndefined();
    expect(store.read(b.sha256)).toBeDefined();
    // Flip one bit of B.
    const raw = readFileSync(join(dir, nameB));
    raw[raw.length - 1] ^= 1;
    writeFileSync(join(dir, nameB), raw);
    expect(store.read(b.sha256)).toBeUndefined();
  });

  it('converts a folder to encrypted and back, and can be run again after an interruption', async () => {
    const dir = join(tmpDir(), 'attachments');
    const keys = await keysFor();
    const store = new AttachmentStore(dir);
    const a = store.add('image/png', PNG);
    const b = store.add('image/png', Uint8Array.from([...PNG, 1]));

    expect(store.convert(keys)).toBe(2);
    expect(readdirSync(dir).sort()).not.toEqual([a.sha256, b.sha256].sort());
    expect(store.read(a.sha256)).toBeDefined();
    expect(store.convert(keys)).toBe(0); // nothing left to do

    // An interrupted switch leaves a plain file beside the encrypted ones; the next start finishes it.
    writeFileSync(join(dir, a.sha256), PNG);
    const c = new AttachmentStore(dir).add('image/png', Uint8Array.from([...PNG, 2]));
    const restarted = new AttachmentStore(dir, keys);
    expect(restarted.convert(keys)).toBe(2);
    expect(readdirSync(dir)).toHaveLength(3);
    expect(readdirSync(dir)).not.toContain(a.sha256);
    expect(restarted.read(c.sha256)).toBeDefined();

    expect(restarted.convert(null)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([a.sha256, b.sha256, c.sha256].sort());
    expect(Buffer.from(restarted.read(a.sha256)!).equals(Buffer.from(PNG))).toBe(true);
  });

  it('cleans up unreferenced files and deletes by content hash', async () => {
    const dir = join(tmpDir(), 'attachments');
    const store = new AttachmentStore(dir, await keysFor());
    const a = store.add('image/png', PNG);
    const b = store.add('image/png', Uint8Array.from([...PNG, 1]));
    expect(store.gc(new Set([a.sha256]))).toBe(1);
    expect(store.read(a.sha256)).toBeDefined();
    expect(store.read(b.sha256)).toBeUndefined();
    store.remove(a.sha256);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('encrypted export', () => {
  it('round-trips through a passphrase and restores conversations and images', async () => {
    const src = tmpDir();
    const store = seeded(src);
    const attachments = new AttachmentStore(join(src, 'attachments'));
    const zip = exportAllZip(store, attachments);
    const sealed = await sealExport(zip, 'file passphrase', FAST);
    expect(isSealedExport(sealed)).toBe(true);
    expect(isSealedExport(zip)).toBe(false);
    expect(sealed.includes(SECRET)).toBe(false);
    expect(sealed.includes('Private plans')).toBe(false);

    expect(await openSealedExport(sealed, 'wrong passphrase')).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    expect(await openSealedExport(tampered, 'file passphrase')).toBeNull();

    const dstDir = tmpDir();
    const dst = new Store(openDatabase(dstDir));
    opened.push(dst);
    const inner = await openSealedExport(sealed, 'file passphrase');
    const result = importBytes(dst, new AttachmentStore(join(dstDir, 'attachments')), new Uint8Array(inner!));
    expect(result.conversations).toBe(1);
    expect(dst.listConversations({ search: 'doormat' })).toHaveLength(1);
  });

  it('refuses a short passphrase and a file that asks for absurd work', async () => {
    await expect(sealExport(new Uint8Array([1, 2, 3]), 'short', FAST)).rejects.toThrow(/at least 8/);
    const sealed = await sealExport(new Uint8Array([1, 2, 3]), 'file passphrase', FAST);
    const crafted = Buffer.from(sealed);
    crafted.writeUInt32BE(2 ** 31, 8);
    expect(await openSealedExport(crafted, 'file passphrase')).toBeNull();
    expect(await openSealedExport(sealed.subarray(0, 20), 'file passphrase')).toBeNull();
    expect(existsSync(join(tmpDir(), 'nothing'))).toBe(false);
  });
});
