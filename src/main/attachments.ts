import { createHash } from 'node:crypto';
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

/** Image files under attachments/<sha256>, deduplicated by content hash. */
export class AttachmentStore {
  constructor(private readonly dir: string) {}

  add(mime: string, data: Uint8Array): AttachmentRef {
    const check = SIGNATURES[mime];
    if (!check || !check(data)) throw nodalError('invalid_request', 'That file is not a valid PNG, JPEG, GIF or WebP image.');
    const sha256 = createHash('sha256').update(data).digest('hex');
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, sha256);
    if (!existsSync(file)) writeFileSync(file, data);
    return { sha256, mime, bytes: data.byteLength };
  }

  read(sha256: string): Buffer | undefined {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return undefined;
    const file = join(this.dir, sha256);
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  remove(sha256: string): void {
    if (/^[a-f0-9]{64}$/.test(sha256)) rmSync(join(this.dir, sha256), { force: true });
  }

  /**
   * Deletes files no message refers to. `minAgeMs` spares files that were just
   * attached in the composer and not sent yet. Returns how many were removed.
   */
  gc(inUse: Set<string>, minAgeMs = 0, now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!/^[a-f0-9]{64}$/.test(name) || inUse.has(name)) continue;
      try {
        if (now - statSync(join(this.dir, name)).mtimeMs < minAgeMs) continue;
        rmSync(join(this.dir, name), { force: true });
        removed++;
      } catch {
        /* a file in use or already gone: try again next time */
      }
    }
    return removed;
  }

  /** Writes a file from an import, verifying the name matches the content hash. */
  restore(sha256: string, data: Uint8Array): boolean {
    if (createHash('sha256').update(data).digest('hex') !== sha256) return false;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, sha256);
    if (!existsSync(file)) writeFileSync(file, data);
    return true;
  }
}
