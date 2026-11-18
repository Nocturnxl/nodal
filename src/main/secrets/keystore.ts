import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyStatus, KeyStoreStatus } from '@shared/types';
import { nodalError } from '../net/errors';

/** The slice of Electron's safeStorage this module needs (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface KeyFile {
  version: 1;
  keys: Record<string, string>; // providerId -> base64 ciphertext
}

/**
 * API keys encrypted by the OS (DPAPI / Keychain / libsecret) and stored as
 * ciphertext in keys.json. Nothing else in the app persists a key, and no
 * method here is reachable from the renderer except `status`.
 */
export class KeyStore {
  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  storeStatus(): KeyStoreStatus {
    const backend = this.platform === 'linux' ? (this.safe.getSelectedStorageBackend?.() ?? 'unknown') : this.platform === 'win32' ? 'dpapi' : 'keychain';
    if (this.platform === 'linux' && backend === 'basic_text') {
      return {
        available: false,
        backend,
        reason:
          'No system keyring (libsecret or kwallet) is available, so keys could only be stored unencrypted. NODAL refuses to do that. Install and unlock a keyring, then restart.',
      };
    }
    if (!this.safe.isEncryptionAvailable()) {
      return { available: false, backend, reason: 'OS-level encryption is not available on this system, so keys cannot be stored safely.' };
    }
    return { available: true, backend };
  }

  private read(): KeyFile {
    if (!existsSync(this.file)) return { version: 1, keys: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as KeyFile;
      if (parsed && typeof parsed.keys === 'object' && parsed.keys) return { version: 1, keys: parsed.keys };
    } catch {
      /* fall through: treat a corrupt file as empty */
    }
    return { version: 1, keys: {} };
  }

  private write(data: KeyFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  set(providerId: string, key: string): void {
    const status = this.storeStatus();
    if (!status.available) throw nodalError('blocked', status.reason ?? 'Key storage is unavailable.');
    const data = this.read();
    data.keys[providerId] = this.safe.encryptString(key).toString('base64');
    this.write(data);
  }

  /** Decrypts for one request. Callers keep the result in a local variable only. */
  get(providerId: string): string | undefined {
    const ct = this.read().keys[providerId];
    if (!ct) return undefined;
    try {
      return this.safe.decryptString(Buffer.from(ct, 'base64'));
    } catch {
      return undefined;
    }
  }

  clear(providerId: string): void {
    const data = this.read();
    if (providerId in data.keys) {
      delete data.keys[providerId];
      this.write(data);
    }
  }

  status(providerId: string): KeyStatus {
    const key = this.get(providerId);
    if (!key) return { present: false };
    // Never reveal more than a third of a short key.
    return { present: true, last4: key.length >= 12 ? key.slice(-4) : undefined };
  }
}
