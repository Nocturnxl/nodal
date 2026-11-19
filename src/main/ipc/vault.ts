import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { VaultStatus } from '@shared/types';
import { rekeyDatabase, removeBackups } from '../db';
import { nodalError } from '../net/errors';
import { checkPassphrase, type Vault, type VaultKeys } from '../secrets/vault';
import { handle, type AppContext } from './register';

export interface VaultHost {
  vault: Vault;
  userData: string;
  log: AppContext['log'];
  trustedOrigins: string[];
  /** The running app, or null while the profile is still locked. */
  ctx(): AppContext | null;
  /** Opens the database with these keys and starts everything that depends on it. */
  boot(keys: VaultKeys): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The vault channels are registered before the database is open, because
 * `status` and `unlock` are what open it. Passphrases arrive here from the
 * renderer and go no further: they are never logged, stored or echoed back.
 */
export function registerVaultIpc(host: VaultHost): void {
  const { vault, log } = host;
  let busy = false;
  let failures = 0;

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
  });

  handle(host, CH.vaultStatus, schemas.none, status);

  handle(host, CH.vaultUnlock, schemas.passphrase, ({ passphrase }) =>
    exclusive(async () => {
      if (host.ctx()) return true;
      const keys = await vault.unlock(passphrase);
      if (!keys) {
        failures++;
        log.warn('unlock failed: wrong passphrase', { failures });
        // Guessing through the app gets slower; the real protection against guessing is the key stretching.
        await sleep(Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
        return false;
      }
      failures = 0;
      host.boot(keys);
      log.info('unlocked');
      return true;
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
}
