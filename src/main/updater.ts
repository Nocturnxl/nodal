import { app } from 'electron';
import type { Logger } from './log';

/**
 * Optional update check. Off by default and a no-op in development or when no
 * update feed was configured at packaging time, which keeps the
 * no-surprise-network rule: this is the only automatic outbound call besides
 * provider traffic, and the user can turn it off.
 */
export async function maybeCheckForUpdates(enabled: boolean, log: Logger): Promise<void> {
  if (!enabled || !app.isPackaged) return;
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo) log.info('update check', { latest: result.updateInfo.version, current: app.getVersion() });
  } catch (e) {
    log.info('update check skipped', { reason: e instanceof Error ? e.message.split('\n')[0] : String(e) });
  }
}
