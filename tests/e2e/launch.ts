import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/**
 * Arguments for launching the built app in tests. On Linux, Chromium picks its
 * key-storage backend from the desktop session; under a bare virtual display
 * it would fall back to plain text, which Relay refuses. Name the backend.
 */
export function appArgs(): string[] {
  return process.platform === 'linux' ? [ROOT, '--password-store=gnome-libsecret'] : [ROOT];
}
