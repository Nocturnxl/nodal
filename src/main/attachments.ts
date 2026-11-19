import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentRef } from '@shared/types';
import { nodalError } from './net/errors';

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

const HASH = /^[a-f0-9]{64}$/;
// Encrypted files start with this; no image format does.
const MAGIC = Buffer.from('NODALA1\n');
const HEADER = MAGIC.length + 12 + 16;

export interface AttachmentKeys {
  files: Buffer;
  names: Buffer;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const isEncrypted = (buf: Buffer) => buf.length >= HEADER && MAGIC.equals(buf.subarray(0, MAGIC.length));

function encrypt(key: Buffer, data: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, buf: Buffer): Buffer | undefined {
  if (!isEncrypted(buf)) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAuthTag(buf.subarray(MAGIC.length + 12, HEADER));
    return Buffer.concat([decipher.update(buf.subarray(HEADER)), decipher.final()]);
  } catch {
    return undefined;
  }
}

/**
 * Image files under attachments/, deduplicated by content hash.
 *
 * Without keys a file is the image itself, named by its SHA-256. With keys
 * (encryption on) each file is AES-256-GCM ciphertext and its name is an HMAC
 * of the hash, so neither the contents nor which images you hold can be read
 * from the folder.
 */
export class AttachmentStore {
  constructor(
    private readonly dir: string,
    private keys: AttachmentKeys | null = null,
  ) {}

  private nameFor(hash: string, keys = this.keys): string {
    return keys ? createHmac('sha256', keys.names).update(hash).digest('hex') : hash;
  }

  private write(hash: string, data: Uint8Array): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, this.nameFor(hash));
    if (!existsSync(file)) writeFileSync(file, this.keys ? encrypt(this.keys.files, data) : data);
  }

  add(mime: string, data: Uint8Array): AttachmentRef {
    const check = SIGNATURES[mime];
    if (!check || !check(data)) throw nodalError('invalid_request', 'That file is not a valid PNG, JPEG, GIF or WebP image.');
    const hash = sha256(data);
    this.write(hash, data);
    return { sha256: hash, mime, bytes: data.byteLength };
  }

  read(hash: string): Buffer | undefined {
    if (!HASH.test(hash)) return undefined;
    const file = join(this.dir, this.nameFor(hash));
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file);
    if (!this.keys) return isEncrypted(raw) ? undefined : raw;
    const plain = decrypt(this.keys.files, raw);
    // The content must be the image this name stands for, not another valid file moved into its place.
    return plain && sha256(plain) === hash ? plain : undefined;
  }

  remove(hash: string): void {
    if (HASH.test(hash)) rmSync(join(this.dir, this.nameFor(hash)), { force: true });
  }

  /**
   * Deletes files no message refers to. `minAgeMs` spares files that were just
   * attached in the composer and not sent yet. Returns how many were removed.
   */
  gc(inUse: Set<string>, minAgeMs = 0, now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    const keep = new Set([...inUse].map((h) => this.nameFor(h)));
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!HASH.test(name) || keep.has(name)) continue;
      try {
        // Only when an age is asked for: a file written this instant can carry a time a fraction ahead of `now`.
        if (minAgeMs > 0 && now - statSync(join(this.dir, name)).mtimeMs < minAgeMs) continue;
        rmSync(join(this.dir, name), { force: true });
        removed++;
      } catch {
        /* a file in use or already gone: try again next time */
      }
    }
    return removed;
  }

  /** Writes a file from an import, verifying the name matches the content hash. */
  restore(hash: string, data: Uint8Array): boolean {
    if (sha256(data) !== hash) return false;
    this.write(hash, data);
    return true;
  }

  /**
   * Switches the folder to `next` keys (null for no encryption) and rewrites
   * every file that is not already in that form. Each new file is written
   * before its old one is deleted, and a file already converted is skipped, so
   * this can be interrupted and run again. Files that cannot be read with the
   * keys at hand are left alone. Returns how many files were rewritten.
   */
  convert(next: AttachmentKeys | null): number {
    const from = this.keys;
    this.keys = next;
    if (!existsSync(this.dir)) return 0;
    let converted = 0;
    for (const name of readdirSync(this.dir)) {
      if (!HASH.test(name)) continue;
      const file = join(this.dir, name);
      let raw: Buffer;
      try {
        raw = readFileSync(file);
      } catch {
        continue;
      }
      let plain: Buffer | undefined;
      if (!isEncrypted(raw)) {
        if (!next) continue; // already plain
        plain = sha256(raw) === name ? raw : undefined;
      } else {
        // Try the keys we are moving to first: a file already in the target form stays.
        if (next) {
          const already = decrypt(next.files, raw);
          if (already && this.nameFor(sha256(already), next) === name) continue;
        }
        plain = from ? decrypt(from.files, raw) : undefined;
        if (plain && this.nameFor(sha256(plain), from) !== name) plain = undefined;
      }
      if (!plain) continue;
      const target = join(this.dir, this.nameFor(sha256(plain), next));
      if (!existsSync(target)) writeFileSync(target, next ? encrypt(next.files, plain) : plain);
      rmSync(file, { force: true });
      converted++;
    }
    return converted;
  }
}
