import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { UnlockResult, VaultStatus } from '@shared/types';
import { rekeyDatabase, removeBackups } from '../db';
import { nodalError } from '../net/errors';
import type { LockReason } from '../secrets/autolock';
import { checkPassphrase, WIPE_AFTER, type Vault, type VaultKeys } from '../secrets/vault';
import { wipeProfile } from '../secrets/wipe';
import { handle, type AppContext } from './register';

export interface VaultHost {
  vault: Vault;
  userData: string;
  log: AppContext['log'];
  trustedOrigins: string[];
  /** The running app, or null while the profile is still locked. */
  ctx(): AppContext | null;
  /** Opens the database with these keys and starts everything that depends on it. */
  boot(keys: VaultKeys | null): void;
  /** Stops replies, closes the database, forgets the keys and shows the unlock screen. */
  lock(reason: LockReason): Promise<void>;
}

export interface VaultControl {
  /** Locks unless there is nothing to lock or an encryption change is running. True when it locked. */
  lock(reason: LockReason): Promise<boolean>;
  busy(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The vault channels are registered before the database is open, because
 * `status` and `unlock` are what open it. Passphrases arrive here from the
 * renderer and go no further: they are never logged, stored or echoed back.
 */
export function registerVaultIpc(host: VaultHost): VaultControl {
  const { vault, log } = host;
  let busy = false;

  const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy) throw nodalError('busy', 'Another encryption change is still running.');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
  const running = (): AppContext => {
    const ctx = host.ctx();
    if (!ctx) throw nodalError('forbidden', 'NODAL is locked. Enter your passphrase first.');
    if (ctx.streams.activeCount > 0) throw nodalError('busy', 'Wait for replies to finish, or stop them, then try again.');
    return ctx;
  };
  const status = (): VaultStatus => ({
    enabled: vault.enabled,
    unlocked: host.ctx() !== null,
    ...vault.guard,
  });

  handle(host, CH.vaultStatus, schemas.none, status);

  handle(host, CH.vaultUnlock, schemas.passphrase, ({ passphrase }) =>
    exclusive(async () => {
      const opened: UnlockResult = { ok: true, wiped: false, remaining: null };
      if (host.ctx()) return opened;
      const keys = await vault.unlock(passphrase);
      if (!keys) {
        // Counted on disk before anything else, so quitting mid-guess does not win a free try.
        const { failures, wipeAfter } = vault.recordFailure();
        log.warn('unlock failed: wrong passphrase', { failures });
        if (wipeAfter > 0 && failures >= wipeAfter) {
          // The sealed key goes first: once it is gone nothing here can be decrypted, whatever happens next.
          vault.destroy();
          const left = wipeProfile(host.userData);
          log.warn('too many wrong passphrases: chats, images and stored API keys deleted', { failures, notRemoved: left });
          host.boot(null);
          return { ok: false, wiped: true, remaining: 0 } satisfies UnlockResult;
        }
        // Guessing through the app gets slower; the real protection against guessing is the key stretching.
        await sleep(Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
        return { ok: false, wiped: false, remaining: wipeAfter > 0 ? wipeAfter - failures : null } satisfies UnlockResult;
      }
      host.boot(keys);
      log.info('unlocked');
      return opened;
    }),
  );

  handle(host, CH.vaultEnable, schemas.passphrase, ({ passphrase }) =>
    exclusive(async () => {
      const ctx = running();
      if (vault.enabled) throw nodalError('invalid_request', 'Encryption is already on.');
      checkPassphrase(passphrase);
      // The sealed key is written first. If the app dies after this point, the
      // next unlock finds a plain database beside a vault and finishes the job.
      const keys = await vault.create(passphrase);
      try {
        const images = ctx.attachments.convert(keys);
        rekeyDatabase(ctx.store.db, keys.db);
        const backups = removeBackups(host.userData);
        log.info('encryption turned on', { images, backupsRemoved: backups });
      } catch (e) {
        // Nothing was lost: put the images back as they were and forget the new key.
        log.error('turning encryption on failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        try {
          ctx.attachments.convert(null);
        } finally {
          vault.remove();
        }
        throw e;
      }
      return status();
    }),
  );

  handle(host, CH.vaultChange, schemas.passphraseChange, ({ current, next }) =>
    exclusive(async () => {
      running();
      if (!vault.enabled) throw nodalError('invalid_request', 'Encryption is off.');
      const ok = await vault.changePassphrase(current, next);
      if (ok) log.info('passphrase changed');
      else await sleep(500);
      return ok;
    }),
  );

  handle(host, CH.vaultDisable, schemas.passphrase, ({ passphrase }) =>
    exclusive(async () => {
      const ctx = running();
      if (!vault.enabled) throw nodalError('invalid_request', 'Encryption is already off.');
      if (!(await vault.verify(passphrase))) {
        await sleep(500);
        return false;
      }
      const keys = vault.keys;
      const images = ctx.attachments.convert(null);
      try {
        rekeyDatabase(ctx.store.db, null);
      } catch (e) {
        ctx.attachments.convert(keys);
        throw e;
      }
      vault.remove();
      log.info('encryption turned off', { images });
      return true;
    }),
  );

  handle(host, CH.vaultSetWipe, schemas.vaultSetWipe, ({ enabled }) =>
    exclusive(async () => {
      running();
      if (!vault.enabled) throw nodalError('invalid_request', 'Turn on encryption first.');
      vault.setWipeAfter(enabled ? WIPE_AFTER : 0);
      log.info(enabled ? 'deleting after wrong passphrases turned on' : 'deleting after wrong passphrases turned off');
      return status();
    }),
  );

  // Locking takes the same turn as the changes above, so it can never close the database under one of them.
  const lock = async (reason: LockReason): Promise<boolean> => {
    if (busy || !vault.enabled || !host.ctx()) return false;
    return exclusive(async () => {
      await host.lock(reason);
      return true;
    });
  };

  handle(host, CH.vaultLock, schemas.none, async () => {
    if (!vault.enabled) throw nodalError('invalid_request', 'Encryption is off, so there is nothing to lock.');
    if (busy) throw nodalError('busy', 'Another encryption change is still running.');
    await lock('manual');
  });

  return { lock, busy: () => busy };
}
