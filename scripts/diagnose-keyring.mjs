// Prints what Electron's safeStorage reports on this machine, with and without
// an explicit --password-store switch. Useful on Linux, where the key-storage
// backend depends on the desktop session. Needs the app bundled (`npm run bundle`).
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Note: Playwright itself adds --password-store=basic, so the switch value seen
// here is the driver's unless RELAY_PASSWORD_STORE names a real backend.
const variants = [[]];

for (const extra of variants) {
  const userData = mkdtempSync(join(tmpdir(), 'relay-keyring-'));
  let app;
  try {
    app = await electron.launch({ args: [root, ...extra], env: { ...process.env, RELAY_USER_DATA: userData } });
    await app.firstWindow();
    const report = await app.evaluate(async ({ safeStorage, app: a }) => {
      const backend = () => (typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'n/a');
      const out = {
        switchSeen: a.commandLine.hasSwitch('password-store'),
        switchValue: a.commandLine.getSwitchValue('password-store'),
        desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
        dbus: !!process.env.DBUS_SESSION_BUS_ADDRESS,
        backendBefore: backend(),
        available: safeStorage.isEncryptionAvailable(),
      };
      try {
        const enc = safeStorage.encryptString('probe');
        out.roundTrip = safeStorage.decryptString(enc) === 'probe';
        out.cipherPrefix = enc.subarray(0, 3).toString('latin1');
      } catch (e) {
        out.encryptError = String(e);
      }
      out.backendAfter = backend();
      if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') out.asyncAvailable = await safeStorage.isAsyncEncryptionAvailable().catch((e) => String(e));
      return out;
    });
    console.log(`args ${JSON.stringify(extra)}: ${JSON.stringify(report)}`);
  } catch (e) {
    console.log(`args ${JSON.stringify(extra)}: launch failed: ${e}`);
  } finally {
    await app?.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
  }
}
