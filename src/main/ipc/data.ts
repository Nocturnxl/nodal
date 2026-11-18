import { app, dialog, shell } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { AppInfo, Settings } from '@shared/types';
import { exportAllZip, exportConversationJson, exportConversationMarkdown, importBytes } from '../data/exporter';
import { nodalError } from '../net/errors';
import { handle, type AppContext } from './register';

function safeName(title: string): string {
  return title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'conversation';
}

export function registerDataIpc(ctx: AppContext): void {
  const { store, attachments } = ctx;

  handle(ctx, CH.settingsGet, schemas.none, () => store.getSettings());
  handle(ctx, CH.settingsSet, schemas.settingsSet, (patch) => {
    const next = store.setSettings(patch as Partial<Settings>);
    if ('proxy' in patch || 'updateCheck' in patch) ctx.applyNetworkSettings();
    return next;
  });

  handle(ctx, CH.exportConversation, schemas.exportConversation, async ({ id, format }) => {
    const conv = store.requireConversation(id);
    const ext = format === 'markdown' ? 'md' : 'json';
    const win = ctx.window();
    const options = {
      title: 'Export conversation',
      defaultPath: `${safeName(conv.title)}.${ext}`,
      filters: [{ name: format === 'markdown' ? 'Markdown' : 'JSON', extensions: [ext] }],
    };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, format === 'markdown' ? exportConversationMarkdown(store, id) : exportConversationJson(store, id), 'utf8');
    return res.filePath;
  });

  handle(ctx, CH.exportAll, schemas.none, async () => {
    const win = ctx.window();
    const options = {
      title: 'Export everything',
      defaultPath: `nodal-export-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, exportAllZip(store, attachments));
    return res.filePath;
  });

  handle(ctx, CH.importFile, schemas.none, async () => {
    const win = ctx.window();
    const options = {
      title: 'Import',
      properties: ['openFile' as const],
      filters: [{ name: 'NODAL export', extensions: ['zip', 'json'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    if (statSync(file).size > 1024 * 1024 * 1024) throw nodalError('invalid_request', 'That file is too large to import.');
    return importBytes(store, attachments, new Uint8Array(readFileSync(file)));
  });

  handle(ctx, CH.attachmentAdd, schemas.attachmentAdd, ({ mime, data }) => attachments.add(mime, data));
  handle(ctx, CH.attachmentGet, schemas.attachmentGet, ({ sha256 }) => {
    const buf = attachments.read(sha256);
    if (!buf) return null;
    const row = store.db.prepare('SELECT mime FROM attachments WHERE sha256 = ? LIMIT 1').get(sha256) as { mime: string } | undefined;
    return { mime: row?.mime ?? 'image/png', data: new Uint8Array(buf) };
  });

  handle(ctx, CH.appInfo, schemas.none, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userDataPath: ctx.paths.userData,
    logPath: ctx.paths.logs,
    packaged: app.isPackaged,
  }));

  handle(ctx, CH.appOpenDataFolder, schemas.none, async () => {
    await shell.openPath(ctx.paths.userData);
  });
  handle(ctx, CH.appOpenLogFolder, schemas.none, async () => {
    await shell.openPath(ctx.paths.logs);
  });

  // Links from model output: http(s) only, and only after the user has seen the full URL.
  handle(ctx, CH.appOpenExternal, schemas.openExternal, async ({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw nodalError('invalid_request', 'That link is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw nodalError('blocked', `NODAL only opens http and https links, not "${parsed.protocol}".`);
    }
    const win = ctx.window();
    const options = {
      type: 'question' as const,
      buttons: ['Open in browser', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Open link',
      message: `Open this link in your browser?`,
      detail: `${parsed.toString()}\n\nSite: ${parsed.hostname}`,
      noLink: true,
    };
    const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (res.response !== 0) return false;
    await shell.openExternal(parsed.toString());
    return true;
  });
}
