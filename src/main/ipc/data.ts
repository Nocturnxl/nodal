import { app, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { AppInfo, Settings } from '@shared/types';
import { exportAllZip, exportConversationJson, exportConversationMarkdown, importBytes } from '../data/exporter';
import { nodalError } from '../net/errors';
import { isSealedExport, openSealedExport, sealExport } from '../secrets/vault';
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

  // With a passphrase the same ZIP is written encrypted, as a .nodalx file.
  // Without one it is a plain ZIP, readable by anyone who has the file.
  handle(ctx, CH.exportAll, schemas.exportAll, async ({ passphrase }) => {
    const win = ctx.window();
    const ext = passphrase ? 'nodalx' : 'zip';
    const options = {
      title: passphrase ? 'Export everything (encrypted)' : 'Export everything',
      defaultPath: `nodal-export-${new Date().toISOString().slice(0, 10)}.${ext}`,
      filters: [{ name: passphrase ? 'Encrypted NODAL export' : 'ZIP archive', extensions: [ext] }],
    };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    const zip = exportAllZip(store, attachments);
    writeFileSync(res.filePath, passphrase ? await sealExport(zip, passphrase) : zip);
    return res.filePath;
  });

  // A protected export chosen in the file picker waits here, in memory, until its passphrase arrives.
  let pending: { token: string; bytes: Uint8Array } | null = null;

  handle(ctx, CH.importFile, schemas.importFile, async ({ unlock }) => {
    if (unlock) {
      if (!pending || pending.token !== unlock.token) throw nodalError('invalid_request', 'Choose the file again.');
      const zip = await openSealedExport(pending.bytes, unlock.passphrase);
      if (!zip) throw nodalError('invalid_request', 'That passphrase does not open this export.');
      pending = null;
      return importBytes(store, attachments, new Uint8Array(zip));
    }
    const win = ctx.window();
    const options = {
      title: 'Import',
      properties: ['openFile' as const],
      filters: [{ name: 'NODAL export', extensions: ['zip', 'json', 'nodalx'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    if (statSync(file).size > 1024 * 1024 * 1024) throw nodalError('invalid_request', 'That file is too large to import.');
    const bytes = new Uint8Array(readFileSync(file));
    if (isSealedExport(bytes)) {
      pending = { token: randomUUID(), bytes };
      return { locked: true as const, token: pending.token };
    }
    pending = null;
    return importBytes(store, attachments, bytes);
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
