import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/**
 * Arguments for launching the built app in tests.
 *
 * Playwright starts Electron with --password-store=basic. On Linux that
 * selects plain-text key storage, which NODAL refuses, so a Linux run must set
 * NODAL_PASSWORD_STORE=gnome-libsecret (with an unlocked keyring) to name the
 * real backend. The CI workflow does this.
 */
export function appArgs(): string[] {
  return [ROOT];
}
