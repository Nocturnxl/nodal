import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from '@shared/types';
import { AttachmentStore } from '../../src/main/attachments';
import { openDatabase } from '../../src/main/db';
import { Store } from '../../src/main/db/store';
import { DEFAULT_TIMEOUTS, Http, type Timeouts } from '../../src/main/net/http';
import { KeyStore, type SafeStorageLike } from '../../src/main/secrets/keystore';
import { MOCK_KEY } from '../mock/server';

const dirs: string[] = [];

export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'relay-test-'));
  dirs.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a still-open database file on Windows; the OS temp cleaner will get it */
    }
  }
}

/** Reversible stand-in for OS encryption: XOR, so the plaintext never appears in the file. */
export const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
  getSelectedStorageBackend: () => 'gnome_libsecret',
};

export const http = new Http((url, init) => fetch(url, init), 'Relay/test');

export const FAST: Timeouts = { ...DEFAULT_TIMEOUTS, connectMs: 3000, firstByteMs: 3000, idleMs: 3000 };

export function mockProvider(baseUrl: string, over: Partial<ProviderConfig> = {}): Omit<ProviderConfig, 'id'> {
  return {
    kind: 'openai-compatible',
    displayName: 'Mock',
    baseUrl,
    auth: { scheme: 'bearer' },
    modelListPath: '/models',
    allowInsecureHttp: false,
    ...over,
  };
}

export function makeEnv(baseUrl: string, over: Partial<ProviderConfig> = {}) {
  const dir = tmpDir();
  const store = new Store(openDatabase(dir));
  const keys = new KeyStore(join(dir, 'keys.json'), fakeSafeStorage, 'win32');
  const attachments = new AttachmentStore(join(dir, 'attachments'));
  const provider = store.saveProvider(mockProvider(baseUrl, over));
  keys.set(provider.id, MOCK_KEY);
  return { dir, store, keys, attachments, provider };
}
