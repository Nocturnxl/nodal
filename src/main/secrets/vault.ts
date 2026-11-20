import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodalError } from '../net/errors';

// Optional encryption of chats at rest.
//
// A random 32-byte master key encrypts everything. The passphrase never
// encrypts data directly: scrypt turns it into a wrapping key, which seals the
// master key in vault.json. Changing the passphrase therefore re-seals 32
// bytes instead of rewriting the database, and a wrong passphrase is detected
// by the seal's authentication tag before the database is touched.
//
// There is no recovery path. Without the passphrase the master key cannot be
// unsealed, by anyone.

export const MIN_PASSPHRASE = 8;
/** With the option on, this many wrong passphrases in a row delete the chats. */
export const WIPE_AFTER = 5;

const AAD = Buffer.from('nodal-vault-v1');

interface Kdf {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
}

interface VaultFile {
  version: 1;
  kdf: Kdf;
  nonce: string;
  tag: string;
  sealed: string;
  /** Delete everything after this many wrong passphrases in a row. Absent or 0 = never. */
  wipeAfter?: number;
  /** Wrong passphrases since the last right one. Kept here because it must be readable while locked. */
  failures?: number;
}

export interface VaultGuard {
  wipeAfter: number;
  failures: number;
}

/** The keys in use while the app is unlocked. Never written to disk, never sent to the renderer. */
export interface VaultKeys {
  /** SQLCipher raw key for the database, as 64 hex characters. */
  db: string;
  /** AES-256-GCM key for attachment files. */
  files: Buffer;
  /** HMAC key that turns a content hash into a file name, so names reveal nothing. */
  names: Buffer;
}

// About 128 MB and a few hundred milliseconds per guess on current hardware.
const DEFAULT_KDF = { N: 1 << 17, r: 8, p: 1 };

function stretch(passphrase: string, kdf: Kdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function derive(master: Buffer): VaultKeys {
  const sub = (label: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `nodal ${label}`, 32));
  return {
    db: sub('database').toString('hex'),
    files: sub('attachments'),
    names: sub('attachment names'),
  };
}

export function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE) throw nodalError('invalid_request', `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
}

export class Vault {
  private readonly file: string;
  private master: Buffer | null = null;

  constructor(
    dir: string,
    private readonly cost: { N: number; r: number; p: number } = DEFAULT_KDF,
  ) {
    this.file = join(dir, 'vault.json');
  }

  /** True when this profile is encrypted (whether or not it is unlocked yet). */
  get enabled(): boolean {
    return existsSync(this.file);
  }

  get unlocked(): boolean {
    return this.master !== null;
  }

  get keys(): VaultKeys | null {
    return this.master ? derive(this.master) : null;
  }

  private read(): VaultFile {
    let parsed: VaultFile;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as VaultFile;
    } catch {
      throw nodalError('internal', 'vault.json is damaged and cannot be read. Restore it from a backup of the data folder.');
    }
    const k = parsed?.kdf;
    const sane =
      parsed?.version === 1 &&
      k?.name === 'scrypt' &&
      Number.isInteger(k.N) &&
      k.N >= 1 << 10 &&
      k.N <= 1 << 22 &&
      Number.isInteger(k.r) &&
      k.r >= 1 &&
      k.r <= 32 &&
      Number.isInteger(k.p) &&
      k.p >= 1 &&
      k.p <= 16 &&
      [k.salt, parsed.nonce, parsed.tag, parsed.sealed].every((s) => typeof s === 'string' && s.length > 0 && s.length < 200);
    if (!sane) throw nodalError('internal', 'vault.json is damaged and cannot be read. Restore it from a backup of the data folder.');
    return parsed;
  }

  private async seal(passphrase: string, master: Buffer): Promise<void> {
    const kdf: Kdf = {
      name: 'scrypt',
      ...this.cost,
      salt: randomBytes(16).toString('base64'),
    };
    const wrapping = await stretch(passphrase, kdf);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrapping, nonce);
    cipher.setAAD(AAD);
    const sealed = Buffer.concat([cipher.update(master), cipher.final()]);
    // A new passphrase keeps the wrong-passphrase setting; the count starts again.
    const wipeAfter = this.enabled ? this.guard.wipeAfter : 0;
    this.write({
      version: 1,
      kdf,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      sealed: sealed.toString('base64'),
      ...(wipeAfter ? { wipeAfter } : {}),
    });
  }

  private write(out: VaultFile): void {
    // Write beside the old file and swap, so a crash never leaves a half-written vault.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The wrong-passphrase setting and the current count. */
  get guard(): VaultGuard {
    if (!this.enabled) return { wipeAfter: 0, failures: 0 };
    const v = this.read();
    const int = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0);
    return { wipeAfter: int(v.wipeAfter), failures: int(v.failures) };
  }

  /** Turns deleting after wrong passphrases on (a count) or off (0). */
  setWipeAfter(count: number): void {
    const { wipeAfter: _old, failures: _count, ...rest } = this.read();
    this.write(count > 0 ? { ...rest, wipeAfter: count } : rest);
  }

  /** Counts a wrong passphrase on disk, so restarting the app does not start the count again. */
  recordFailure(): VaultGuard {
    const v = this.read();
    const failures = this.guard.failures + 1;
    this.write({ ...v, failures });
    return { wipeAfter: this.guard.wipeAfter, failures };
  }

  private clearFailures(): void {
    const { failures, ...rest } = this.read();
    if (failures) this.write(rest);
  }

  /**
   * Destroys the sealed key. Everything it encrypted becomes unreadable for
   * good, whether or not the encrypted files themselves are then deleted.
   */
  destroy(): void {
    try {
      writeFileSync(this.file, randomBytes(Math.max(512, statSync(this.file).size)));
    } catch {
      /* removed below either way */
    }
    this.remove();
  }

  private async open(passphrase: string): Promise<Buffer | null> {
    const v = this.read();
    const wrapping = await stretch(passphrase, v.kdf);
    try {
      const decipher = createDecipheriv('aes-256-gcm', wrapping, Buffer.from(v.nonce, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
      const master = Buffer.concat([decipher.update(Buffer.from(v.sealed, 'base64')), decipher.final()]);
      return master.length === 32 ? master : null;
    } catch {
      return null; // wrong passphrase
    }
  }

  /** Turns encryption on: makes a new master key and seals it. Returns the keys to encrypt with. */
  async create(passphrase: string): Promise<VaultKeys> {
    if (this.enabled) throw nodalError('invalid_request', 'Encryption is already on.');
    checkPassphrase(passphrase);
    const master = randomBytes(32);
    await this.seal(passphrase, master);
    this.master = master;
    return derive(master);
  }

  /** Returns the keys, or null when the passphrase is wrong. */
  async unlock(passphrase: string): Promise<VaultKeys | null> {
    const master = await this.open(passphrase);
    if (!master) return null;
    this.clearFailures();
    this.master = master;
    return derive(master);
  }

  /** Forgets the master key. The passphrase is needed again to get it back. */
  lock(): void {
    this.master?.fill(0);
    this.master = null;
  }

  /** True when the passphrase is the current one. */
  async verify(passphrase: string): Promise<boolean> {
    const master = await this.open(passphrase);
    return !!master && !!this.master && timingSafeEqual(master, this.master);
  }

  async changePassphrase(current: string, next: string): Promise<boolean> {
    checkPassphrase(next);
    if (!this.master || !(await this.verify(current))) return false;
    await this.seal(next, this.master);
    return true;
  }

  /** Turns encryption off. The caller must already have decrypted the data. */
  remove(): void {
    rmSync(this.file, { force: true });
    rmSync(`${this.file}.tmp`, { force: true });
    this.master = null;
  }
}

// ---- passphrase-protected export files ----

const SEALED_MAGIC = Buffer.from('NODALX1\n');
const EXPORT_AAD = Buffer.from('nodal-export-v1');

export function isSealedExport(bytes: Uint8Array): boolean {
  return bytes.length > SEALED_MAGIC.length && SEALED_MAGIC.equals(Buffer.from(bytes.subarray(0, SEALED_MAGIC.length)));
}

/** Wraps an export in a passphrase: magic, scrypt cost, salt, nonce, tag, ciphertext. */
export async function sealExport(data: Uint8Array, passphrase: string, cost = DEFAULT_KDF): Promise<Buffer> {
  checkPassphrase(passphrase);
  const salt = randomBytes(16);
  const key = await stretch(passphrase, {
    name: 'scrypt',
    ...cost,
    salt: salt.toString('base64'),
  });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(EXPORT_AAD);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const params = Buffer.alloc(6);
  params.writeUInt32BE(cost.N, 0);
  params.writeUInt8(cost.r, 4);
  params.writeUInt8(cost.p, 5);
  return Buffer.concat([SEALED_MAGIC, params, salt, nonce, cipher.getAuthTag(), body]);
}

/** Returns the export inside, or null when the passphrase is wrong or the file was altered. */
export async function openSealedExport(bytes: Uint8Array, passphrase: string): Promise<Buffer | null> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SEALED_MAGIC.length;
  if (!isSealedExport(bytes) || buf.length < at + 6 + 16 + 12 + 16) return null;
  const N = buf.readUInt32BE(at);
  const r = buf.readUInt8(at + 4);
  const p = buf.readUInt8(at + 5);
  at += 6;
  // Refuse absurd costs from a crafted file before spending memory on them.
  if (N < 1 << 10 || N > 1 << 22 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = buf.subarray(at, (at += 16));
  const nonce = buf.subarray(at, (at += 12));
  const tag = buf.subarray(at, (at += 16));
  const key = await stretch(passphrase, {
    name: 'scrypt',
    N,
    r,
    p,
    salt: salt.toString('base64'),
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(EXPORT_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(at)), decipher.final()]);
  } catch {
    return null;
  }
}
