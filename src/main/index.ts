import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, protocol, safeStorage, session } from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { CH } from '@shared/api';
import type { ChatEventBatch } from '@shared/types';
import { AttachmentStore } from './attachments';
import { StreamManager } from './chat/streams';
import { isPlainDatabase, MigrationError, openDatabase, rekeyDatabase, removeBackups } from './db';
import { Store } from './db/store';
import { registerChatIpc } from './ipc/chat';
import { registerDataIpc } from './ipc/data';
import { registerProviderIpc } from './ipc/providers';
import type { AppContext } from './ipc/register';
import { registerVaultIpc } from './ipc/vault';
import { registerVoiceIpc } from './ipc/voice';
import { createLogger } from './log';
import { ModelService } from './models';
import { DEFAULT_TIMEOUTS, Http, type Timeouts } from './net/http';
import { AutoLock, type LockReason } from './secrets/autolock';
import { KeyStore } from './secrets/keystore';
import { Vault, type VaultKeys } from './secrets/vault';
import { maybeCheckForUpdates } from './updater';

const APP_ORIGIN = 'app://nodal';
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

// The app's pages are served from app://nodal, a real origin that CSP 'self'
// and the IPC sender check can both reason about.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Test runs point the app at a throwaway profile.
if (process.env.NODAL_USER_DATA) app.setPath('userData', process.env.NODAL_USER_DATA);

// Linux only: name the key-storage backend explicitly. Test drivers launch
// Chromium with --password-store=basic, which would make NODAL refuse to store
// keys; a desktop session Chromium does not recognise has the same effect.
// Only real keyrings can be named here, so this can never weaken storage.
const store = process.env.NODAL_PASSWORD_STORE;
if (process.platform === 'linux' && store && ['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(store)) {
  app.commandLine.appendSwitch('password-store', store);
}

let mainWindow: BrowserWindow | null = null;
let streams: StreamManager | null = null;
/** Called on every keyboard or mouse event in the window; feeds the auto-lock idle clock. */
let onInput: () => void = () => {};

function serveApp(): void {
  const root = normalize(join(__dirname, '../renderer'));
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'nodal') return new Response('Not found', { status: 404 });
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
  // Every web permission is denied except writing text to the clipboard (Copy
  // buttons) and, for voice chat, the microphone: audio only, never the camera
  // or the screen, and only for the app's own page.
  const ours = (url: string | undefined) => !!url && (url.startsWith(APP_ORIGIN) || (DEV_ORIGIN !== undefined && url.startsWith(DEV_ORIGIN)));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (permission === 'media') {
      const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes ?? [];
      return callback(types.length === 1 && types[0] === 'audio' && ours(details.requestingUrl));
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission === 'clipboard-sanitized-write') return true;
    return permission === 'media' && details.mediaType === 'audio' && ours(requestingOrigin);
  });
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
    title: 'NODAL',
    // Window and taskbar icon on Windows and Linux; macOS takes it from the app bundle.
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11131b' : '#f8f9fc',
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
  mainWindow.webContents.on('input-event', () => onInput());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
}

function start(): void {
  const userData = app.getPath('userData');
  const logs = join(userData, 'logs');
  const log = createLogger(logs);
  const trustedOrigins = DEV_ORIGIN ? [APP_ORIGIN, DEV_ORIGIN] : [APP_ORIGIN];
  const vault = new Vault(userData);
  let ctx: AppContext | null = null;
  let liveKeys: VaultKeys | null = null;

  // An unexpected error in the main process: record it, tell the user where
  // the log is, and close cleanly so in-flight replies are saved as interrupted.
  let crashing = false;
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { message: e?.message, stack: e?.stack?.split(/\r?\n/).slice(0, 8).join(' | ') });
    if (crashing) return;
    crashing = true;
    dialog.showErrorBox('NODAL hit an unexpected error', `${e?.message ?? e}

NODAL will close. Your conversations are saved.
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
      title: 'NODAL',
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

  /**
   * Opens the database and starts everything that needs it. With encryption
   * off this runs at once; with it on, it runs when the passphrase is given.
   */
  const boot = (vaultKeys: VaultKeys | null): void => {
    let store: Store;
    try {
      if (!vaultKeys && existsSync(join(userData, 'nodal.db')) && !isPlainDatabase(userData)) {
        throw new Error('it is encrypted, but vault.json (which holds its sealed key) is missing from the data folder. Put vault.json back from a backup to open your chats');
      }
      if (vaultKeys && isPlainDatabase(userData)) {
        // Turning encryption on was interrupted after the key was sealed: finish it.
        const plain = openDatabase(userData);
        rekeyDatabase(plain, vaultKeys.db);
        plain.close();
        removeBackups(userData);
        log.info('finished an interrupted encryption');
      }
      store = new Store(openDatabase(userData, undefined, undefined, vaultKeys?.db));
    } catch (e) {
      const message = e instanceof MigrationError ? e.message : `The database could not be opened: ${e instanceof Error ? e.message : String(e)}.`;
      log.error('database open failed', { message });
      dialog.showErrorBox('NODAL cannot start', message);
      app.exit(1);
      throw e;
    }

    const interrupted = store.markInterrupted();
    if (interrupted) log.info('marked interrupted replies', { count: interrupted });

    const keys = new KeyStore(join(userData, 'keys.json'), safeStorage);
    liveKeys = vaultKeys;
    const attachments = new AttachmentStore(join(userData, 'attachments'), vaultKeys);
    // Picks up any image a previous, interrupted switch left in the other form.
    if (vaultKeys) attachments.convert(vaultKeys);
    // Images attached but never sent, or left behind by an older version, are removed after a day.
    const orphans = attachments.gc(store.attachmentHashesInUse(), 24 * 60 * 60 * 1000);
    if (orphans) log.info('removed unreferenced attachments', { count: orphans });

    // Provider traffic uses its own in-memory session: no cookies or cache on
    // disk, the system proxy and certificate store, and an egress allowlist of
    // configured provider hosts.
    const netSession = session.fromPartition('nodal-net', { cache: false });
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

    const http = new Http((url, init) => netSession.fetch(url, init as Parameters<typeof netSession.fetch>[1]), `NODAL/${app.getVersion()}`);
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

    ctx = {
      store,
      keys,
      attachments,
      streams,
      models: new ModelService(store, keys, http, timeouts),
      log,
      paths: { userData, logs },
      trustedOrigins,
      window: () => mainWindow,
      applyNetworkSettings,
    };
    registerProviderIpc(ctx);
    registerChatIpc(ctx);
    registerDataIpc(ctx);
    registerVoiceIpc(ctx);
    applyNetworkSettings();
    autoLock.reset();
  };

  /**
   * Returns an unlocked profile to the state it starts in: nothing left in
   * this process can read a chat until the passphrase is given again.
   */
  const lock = async (reason: LockReason): Promise<void> => {
    const current = ctx;
    if (!current) return;
    // Replies in flight are saved as interrupted, exactly as when the app closes.
    current.streams.abortAll();
    await Promise.race([current.streams.settled(), new Promise((r) => setTimeout(r, 3000))]);
    for (const channel of Object.values(CH)) if (!channel.startsWith('vault:')) ipcMain.removeHandler(channel);
    ctx = null;
    streams = null;
    try {
      current.store.db.close();
    } catch {
      /* already closed */
    }
    liveKeys?.files.fill(0);
    liveKeys?.names.fill(0);
    liveKeys = null;
    vault.lock();
    log.info('locked', { reason });
    // A reload drops everything the window had on screen and in memory, and it comes back on the unlock screen.
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    });
  };

  const vaultControl = registerVaultIpc({ vault, userData, log, trustedOrigins, ctx: () => ctx, boot, lock });

  const autoLock = new AutoLock({
    minutes: () => {
      if (!ctx || !vault.enabled) return 0;
      try {
        return ctx.store.getSettings().autoLockMinutes;
      } catch {
        return 0;
      }
    },
    busy: () => (streams?.activeCount ?? 0) > 0 || vaultControl.busy(),
    lock: (reason) => void vaultControl.lock(reason).catch((e) => log.error('locking failed', { error: e instanceof Error ? e.message : String(e) })),
  });
  onInput = () => autoLock.touch();
  setInterval(() => autoLock.check(), 5000).unref();
  // Not sent on Linux, where only the idle timer applies.
  powerMonitor.on('lock-screen', () => autoLock.request('screen'));
  powerMonitor.on('suspend', () => autoLock.request('sleep'));
  // With encryption on, the window opens on the unlock screen and the database stays closed until then.
  if (!vault.enabled) {
    try {
      boot(null);
    } catch {
      return; // already reported
    }
  }

  serveApp();
  lockDownRendererSession();
  buildMenu();
  createWindow();
  log.info('started', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, encrypted: vault.enabled });

  app.on('before-quit', () => {
    // Closing mid-stream aborts all requests and leaves rows `interrupted`.
    streams?.abortAll();
    try {
      ctx?.store.db.close();
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
