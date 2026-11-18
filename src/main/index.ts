import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, safeStorage, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { CH } from '@shared/api';
import type { ChatEventBatch } from '@shared/types';
import { AttachmentStore } from './attachments';
import { StreamManager } from './chat/streams';
import { MigrationError, openDatabase } from './db';
import { Store } from './db/store';
import { registerChatIpc } from './ipc/chat';
import { registerDataIpc } from './ipc/data';
import { registerProviderIpc } from './ipc/providers';
import type { AppContext } from './ipc/register';
import { createLogger } from './log';
import { ModelService } from './models';
import { DEFAULT_TIMEOUTS, Http, type Timeouts } from './net/http';
import { KeyStore } from './secrets/keystore';
import { maybeCheckForUpdates } from './updater';

const APP_ORIGIN = 'app://relay';
const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : undefined;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// The app's pages are served from app://relay, a real origin that CSP 'self'
// and the IPC sender check can both reason about.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Test runs point the app at a throwaway profile.
if (process.env.RELAY_USER_DATA) app.setPath('userData', process.env.RELAY_USER_DATA);

// Linux only: name the key-storage backend explicitly. Test drivers launch
// Chromium with --password-store=basic, which would make Relay refuse to store
// keys; a desktop session Chromium does not recognise has the same effect.
// Only real keyrings can be named here, so this can never weaken storage.
const store = process.env.RELAY_PASSWORD_STORE;
if (process.platform === 'linux' && store && ['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(store)) {
  app.commandLine.appendSwitch('password-store', store);
}

let mainWindow: BrowserWindow | null = null;
let streams: StreamManager | null = null;

function serveApp(): void {
  const root = normalize(join(__dirname, '../renderer'));
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'relay') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(file);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** The renderer may only ever load the app's own origin (plus the dev server in development). */
function lockDownRendererSession(): void {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url;
    const ok =
      u.startsWith(`${APP_ORIGIN}/`) ||
      u.startsWith(`blob:${APP_ORIGIN}/`) ||
      u.startsWith('data:') ||
      u.startsWith('devtools://') ||
      (DEV_ORIGIN !== undefined && (u.startsWith(`${DEV_ORIGIN}/`) || u.startsWith(`${DEV_ORIGIN.replace(/^http/, 'ws')}/`)));
    callback({ cancel: !ok });
  });
  // Every web permission is denied except writing text to the clipboard (Copy buttons).
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
}

function hardenWebContents(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      const allowed = DEV_URL ? url.startsWith(DEV_ORIGIN!) : url.startsWith(`${APP_ORIGIN}/`);
      if (!allowed) event.preventDefault();
    });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Relay',
    // Window and taskbar icon on Windows and Linux; macOS takes it from the app bundle.
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17171a' : '#fbfbfa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false, // the spellchecker would fetch dictionaries from the network
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
}

function start(): void {
  const userData = app.getPath('userData');
  const logs = join(userData, 'logs');
  const log = createLogger(logs);

  let store: Store;
  try {
    store = new Store(openDatabase(userData));
  } catch (e) {
    const message = e instanceof MigrationError ? e.message : `The database could not be opened: ${e instanceof Error ? e.message : String(e)}`;
    log.error('database open failed', { message });
    dialog.showErrorBox('Relay cannot start', message);
    app.exit(1);
    return;
  }
  // An unexpected error in the main process: record it, tell the user where
  // the log is, and close cleanly so in-flight replies are saved as interrupted.
  let crashing = false;
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { message: e?.message, stack: e?.stack?.split(/\r?\n/).slice(0, 8).join(' | ') });
    if (crashing) return;
    crashing = true;
    dialog.showErrorBox('Relay hit an unexpected error', `${e?.message ?? e}

Relay will close. Your conversations are saved.
Details are in the log folder:
${logs}`);
    app.quit();
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { message: reason instanceof Error ? reason.message : String(reason) });
  });
  app.on('render-process-gone', (_e, contents, details) => {
    log.error('window process ended', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed() || contents !== mainWindow.webContents) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: 'Relay',
      message: 'The window stopped responding and was closed.',
      detail: 'Your conversations are saved. Reload to carry on.',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) contents.reload();
    else app.quit();
  });
  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') log.warn('helper process ended', { type: details.type, reason: details.reason });
  });

  const interrupted = store.markInterrupted();
  if (interrupted) log.info('marked interrupted replies', { count: interrupted });

  const keys = new KeyStore(join(userData, 'keys.json'), safeStorage);
  const attachments = new AttachmentStore(join(userData, 'attachments'));
  // Images attached but never sent, or left behind by an older version, are removed after a day.
  const orphans = attachments.gc(store.attachmentHashesInUse(), 24 * 60 * 60 * 1000);
  if (orphans) log.info('removed unreferenced attachments', { count: orphans });

  // Provider traffic uses its own in-memory session: no cookies or cache on
  // disk, the system proxy and certificate store, and an egress allowlist of
  // configured provider hosts.
  const netSession = session.fromPartition('relay-net', { cache: false });
  netSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const host = new URL(details.url).host;
      allowed = store.listProviders().some((p) => {
        try {
          return new URL(p.baseUrl).host === host;
        } catch {
          return false;
        }
      });
    } catch {
      allowed = false;
    }
    if (!allowed) log.warn('blocked outbound request to a host that is not a configured provider');
    callback({ cancel: !allowed });
  });
  netSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  const http = new Http((url, init) => netSession.fetch(url, init as Parameters<typeof netSession.fetch>[1]), `Relay/${app.getVersion()}`);
  const timeouts = (): Timeouts => ({ ...DEFAULT_TIMEOUTS, firstByteMs: store.getSettings().firstByteTimeoutSec * 1000 });

  const applyNetworkSettings = () => {
    const { proxy, updateCheck } = store.getSettings();
    void netSession.setProxy(proxy.trim() ? { mode: 'fixed_servers', proxyRules: proxy.trim() } : { mode: 'system' }).catch((e) => {
      log.warn('proxy setting rejected', { error: String(e) });
    });
    void maybeCheckForUpdates(updateCheck, log);
  };

  streams = new StreamManager({
    store,
    keys,
    http,
    attachments,
    log,
    timeouts,
    emit: (batch: ChatEventBatch) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.chatEvent, batch);
    },
  });

  const ctx: AppContext = {
    store,
    keys,
    attachments,
    streams,
    models: new ModelService(store, keys, http, timeouts),
    log,
    paths: { userData, logs },
    trustedOrigins: DEV_ORIGIN ? [APP_ORIGIN, DEV_ORIGIN] : [APP_ORIGIN],
    window: () => mainWindow,
    applyNetworkSettings,
  };
  registerProviderIpc(ctx);
  registerChatIpc(ctx);
  registerDataIpc(ctx);

  serveApp();
  lockDownRendererSession();
  buildMenu();
  applyNetworkSettings();
  createWindow();
  log.info('started', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged });

  app.on('before-quit', () => {
    // Closing mid-stream aborts all requests and leaves rows `interrupted`.
    streams?.abortAll();
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  hardenWebContents();
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(start);
}
