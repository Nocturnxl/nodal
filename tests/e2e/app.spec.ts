import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RelayApi } from '@shared/api';
import { MOCK_KEY, startMockServer, type MockServer } from '../mock/server';

declare global {
  interface Window {
    relay: RelayApi;
  }
}

const ROOT = resolve(__dirname, '../..');
let mock: MockServer;
let userData: string;
let app: ElectronApplication;
let page: Page;
const foreignRequests: string[] = [];

async function launch(): Promise<void> {
  app = await electron.launch({ args: [ROOT], env: { ...process.env, RELAY_USER_DATA: userData } as Record<string, string> });
  page = await app.firstWindow();
  page.on('request', (r) => {
    if (!r.url().startsWith('app://relay/') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreignRequests.push(r.url());
  });
  await page.waitForLoadState('domcontentloaded');
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const composer = () => page.getByRole('textbox', { name: 'Message', exact: true });
const replies = () => page.locator('[data-role="assistant"]');

async function switchModel(id: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search models').fill(id);
  await expect(page.getByRole('option', { name: id, exact: false }).first()).toBeVisible();
  await page.getByLabel('Search models').press('Enter');
  await expect(page.getByLabel('Search models')).toBeHidden();
}

async function send(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press('Enter');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mock = await startMockServer({ chunkDelayMs: 15 });
  userData = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await mock.close();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
});

test('first run: a rejected key is not kept, a valid key connects and lists models', async () => {
  await expect(page.getByRole('heading', { name: 'Welcome to Relay' })).toBeVisible();
  await page.getByRole('button', { name: /^Custom/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mock provider');
  await page.getByLabel('Base URL', { exact: true }).fill(mock.url);
  await page.getByLabel('API key', { exact: true }).fill('definitely-wrong');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Key rejected');
  await expect(alert).toContainText('Incorrect API key provided.');
  await expect(alert).toContainText('HTTP 401');
  await expect(alert).toContainText(/request mock-req-\d+/);
  await expect(page.getByRole('button', { name: 'Save anyway' })).toBeVisible();
  expect(await page.evaluate(async () => (await window.relay.keys.status((await window.relay.providers.list())[0].id)).present)).toBe(false);

  await page.getByLabel('API key', { exact: true }).fill(MOCK_KEY);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mock provider is connected' })).toBeVisible();
  await expect(page.getByText(/\d+ models available/)).toBeVisible();
  await page.getByRole('option', { name: 'mock-echo' }).click();
  await expect(composer()).toBeFocused();
});

test('a reply streams and is saved', async () => {
  await send('Hello from the test');
  await expect(replies().last()).toContainText('You said: Hello from the test');
  await expect(replies().last()).toHaveAttribute('data-finish', 'stop');
  await expect(page.locator('[data-conversation-id]').first()).toContainText('Hello from the test');
});

test('Stop cancels mid-stream within a second and keeps the partial text', async () => {
  await switchModel('mock-long');
  await send('keep going');
  await expect(replies().last()).toContainText('word5 ');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(replies().last()).toHaveAttribute('data-finish', 'cancelled');
  expect(Date.now() - t0).toBeLessThan(1500);
  await expect(replies().last()).toContainText('Stopped');
  const text = await replies().last().innerText();
  expect(text).toContain('word0');
  expect(text).not.toContain('word399');
});

test('the renderer is sealed: no Node, no ipcRenderer, no key read-back, no network', async () => {
  const probe = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    let fetchBlocked = false;
    try {
      await fetch('https://example.com/');
    } catch {
      fetchBlocked = true;
    }
    return {
      require: typeof w.require,
      process: typeof w.process,
      ipcRenderer: typeof w.ipcRenderer,
      keysApi: Object.keys(window.relay.keys).sort(),
      topLevel: Object.keys(window.relay).sort(),
      fetchBlocked,
    };
  });
  expect(probe.require).toBe('undefined');
  expect(probe.process).toBe('undefined');
  expect(probe.ipcRenderer).toBe('undefined');
  expect(probe.keysApi).toEqual(['clear', 'set', 'status', 'storeStatus']); // no keys.get
  expect(probe.topLevel).toEqual(['app', 'attachments', 'chat', 'conversations', 'data', 'keys', 'models', 'providers', 'settings']);
  expect(probe.fetchBlocked).toBe(true);

  const status = await page.evaluate(async () => window.relay.keys.status((await window.relay.providers.list())[0].id));
  expect(status).toEqual({ present: true, last4: MOCK_KEY.slice(-4) });

  // Main rejects malformed payloads before any handler runs.
  const bad = await page.evaluate(() => window.relay.chat.start({ mode: 'send', conversationId: 42 } as never).then(() => 'accepted', (e: Error) => e.message));
  expect(bad).toContain('invalid_request');

  // New windows are refused.
  await page.evaluate(() => void window.open('https://example.com/'));
  await page.waitForTimeout(200);
  expect(app.windows()).toHaveLength(1);
});

test('edit-and-resend creates a branch that can be switched back', async () => {
  await switchModel('mock-echo');
  const firstUser = page.locator('[data-role="user"]').first();
  await firstUser.hover();
  await firstUser.getByRole('button', { name: 'Edit and resend' }).click();
  await page.getByLabel('Edit message').fill('An edited question');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await expect(replies().last()).toContainText('You said: An edited question');
  await expect(replies().last()).toHaveAttribute('data-finish', 'stop');
  await expect(page.locator('[data-role="user"]')).toHaveCount(1); // the old branch is hidden, not deleted
  await expect(page.locator('[data-role="user"]').first()).toContainText('2/2');
  await page.locator('[data-role="user"]').first().getByRole('button', { name: 'Previous version' }).click();
  await expect(page.locator('[data-role="user"]').first()).toContainText('Hello from the test');
  await expect(page.locator('[data-role="user"]')).toHaveCount(2);
});

for (const [model, title, extra] of [
  ['mock-401', 'Key rejected', 'Re-enter key'],
  ['mock-402', 'Out of balance', 'Insufficient USD'],
  ['mock-403', 'Not allowed', 'API access is disabled'],
  ['mock-404-html', 'Model or endpoint not found', 'base URL is probably wrong'],
  ['mock-400-context', 'Conversation too long', 'Drop oldest turns and retry'],
  ['mock-429-always', 'Rate limited', 'Limit resets at'],
  ['mock-500-always', 'The provider had an error', 'Inference backend crashed.'],
] as const) {
  test(`error table: ${model} shows "${title}" with status and request id`, async () => {
    await page.keyboard.press('Control+n');
    await switchModel(model);
    await send(`trigger ${model}`);
    const alert = replies().last().getByRole('alert');
    await expect(alert).toContainText(title, { timeout: 20_000 });
    await expect(alert).toContainText(extra);
    await expect(alert).toContainText(/HTTP \d{3}/);
    await expect(alert).toContainText(/request mock-req-\d+/);
    await expect(alert.getByRole('button', { name: 'Copy details' })).toBeVisible();
    await expect(replies().last()).toHaveAttribute('data-finish', 'error');
  });
}

test('a mid-stream failure keeps the partial reply with Continue and Regenerate', async () => {
  await page.keyboard.press('Control+n');
  await switchModel('mock-disconnect');
  await send('this one will break halfway through');
  const reply = replies().last();
  await expect(reply).toHaveAttribute('data-finish', 'incomplete');
  await expect(reply).toContainText('You said:');
  await expect(reply.getByRole('alert')).toContainText('Network problem');
  await expect(reply.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(reply.getByRole('button', { name: 'Regenerate' })).toBeVisible();
});

test('reasoning is shown in its own collapsible block', async () => {
  await page.keyboard.press('Control+n');
  await switchModel('mock-think');
  await send('think about it');
  const reply = replies().last();
  await expect(reply).toHaveAttribute('data-finish', 'stop');
  await expect(reply.locator('.md')).toHaveText('The answer is 42.');
  await expect(reply.locator('details summary')).toHaveText('Reasoning');
  await reply.locator('details summary').click();
  await expect(reply.locator('details')).toContainText('Let me think.');
});

test('export writes Markdown through the native save dialog', async () => {
  const target = join(userData, 'exported.md');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
  }, target);
  await page.getByRole('button', { name: 'Export as Markdown' }).click();
  await expect(page.getByText(/Exported to/)).toBeVisible();
  const md = readFileSync(target, 'utf8');
  expect(md).toContain('## User');
  expect(md).toContain('The answer is 42.');
  expect(md).not.toContain(MOCK_KEY);
  rmSync(target);
});

test('killing the app mid-stream leaves the reply interrupted after relaunch', async () => {
  await page.keyboard.press('Control+n');
  await switchModel('mock-long');
  await send('this will be interrupted');
  await expect(replies().last()).toContainText('word20 ');
  await page.waitForTimeout(1200); // let the once-a-second save land
  // Hard-kill the whole process tree, as a crash or power loss would.
  const pid = app.process().pid!;
  if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 1000));

  await launch();
  const reply = replies().last();
  await expect(reply).toHaveAttribute('data-finish', 'interrupted');
  await expect(reply).toContainText('Interrupted');
  await expect(reply).toContainText('word20 ');
  await expect(reply.getByRole('button', { name: 'Continue' })).toBeVisible();
  await reply.hover();
  await expect(reply.getByRole('button', { name: 'Regenerate' })).toBeVisible();
  // Everything else persisted across the restart.
  await expect(page.locator('[data-conversation-id]')).toHaveCount(await page.locator('[data-conversation-id]').count());
  expect(await page.locator('[data-conversation-id]').count()).toBeGreaterThanOrEqual(10);
});

test('search finds conversations by message content', async () => {
  await page.getByLabel('Search conversations').fill('edited question');
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  await page.getByLabel('Search conversations').fill('');
});

test('the renderer made no network requests and no key string is anywhere in the user-data folder', async () => {
  expect(foreignRequests).toEqual([]);
  // Navigating away is refused (checked last: a cancelled navigation confuses the test driver).
  await page.evaluate(() => void setTimeout(() => (location.href = 'https://example.com/'), 0));
  await new Promise((r) => setTimeout(r, 500));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe('app://relay/index.html');
  expect(foreignRequests).toEqual([]);
  await app.close();
  const files = filesUnder(userData);
  expect(files.some((f) => f.endsWith('keys.json'))).toBe(true);
  expect(files.some((f) => f.endsWith('relay.db'))).toBe(true);
  for (const f of files) {
    if (statSync(f).size > 50 * 1024 * 1024) continue; // Chromium caches
    expect(readFileSync(f).includes(MOCK_KEY), `key found in ${f}`).toBe(false);
  }
  const log = readFileSync(join(userData, 'logs', 'relay.log'), 'utf8');
  expect(log).toContain('started');
  expect(log).not.toContain('Hello from the test');
});
