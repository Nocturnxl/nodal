import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { RelayApi } from '@shared/api';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appArgs } from './launch';
import { MOCK_KEY, startMockServer, type MockServer } from '../mock/server';

declare global {
  interface Window {
    relay: RelayApi;
  }
}

// Image attachments through the composer, deleting a chat removes its images,
// and a full ZIP export restores into an empty profile from the welcome screen.

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let mock: MockServer;
const dirs: string[] = [];
const apps: ElectronApplication[] = [];

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: appArgs(), env: { ...process.env, RELAY_USER_DATA: userData } as Record<string, string> });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

function profile(): string {
  const d = mkdtempSync(join(tmpdir(), 'relay-e2e-data-'));
  dirs.push(d);
  return d;
}

async function connectMock(page: Page, model = 'mock-echo'): Promise<void> {
  await page.getByRole('button', { name: /^Custom/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mock provider');
  await page.getByLabel('Base URL', { exact: true }).fill(mock.url);
  await page.getByLabel('API key', { exact: true }).fill(MOCK_KEY);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('option', { name: model, exact: true }).click();
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const attachmentFiles = (dir: string) => (existsSync(join(dir, 'attachments')) ? readdirSync(join(dir, 'attachments')) : []);

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  mock = await startMockServer({ chunkDelayMs: 2 });
});
test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => {});
  await mock.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

test('a failed first attempt leaves no provider behind', async () => {
  const dir = profile();
  const { app, page } = await launch(dir);
  await page.getByRole('button', { name: /^Custom/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Typo provider');
  await page.getByLabel('Base URL', { exact: true }).fill(mock.url);
  await page.getByLabel('API key', { exact: true }).fill('wrong-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Key rejected');
  expect(await page.evaluate(async () => (await window.relay.providers.list()).length)).toBe(1);
  await page.getByRole('button', { name: 'All providers' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Relay' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.relay.providers.list()).length)).toBe(0);
  await app.close();
});

test('attach an image, send it, and deleting the chat deletes the image file', async () => {
  const dir = profile();
  const { app, page } = await launch(dir);
  await connectMock(page);

  await page.locator('input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByAltText('Attachment preview')).toBeVisible();
  expect(attachmentFiles(dir)).toHaveLength(1);

  await composer(page).fill('What is in this picture?');
  await composer(page).press('Enter');
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply).toHaveAttribute('data-finish', 'stop');
  await expect(reply).toContainText('You said: What is in this picture? [image]');
  await expect(page.locator('[data-role="user"]').getByAltText('Attached image')).toBeVisible();

  const sent = mock.requests.at(-1)!.body.messages.at(-1);
  expect(sent.content[0]).toEqual({ type: 'text', text: 'What is in this picture?' });
  expect(sent.content[1].type).toBe('image_url');
  expect(sent.content[1].image_url.url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);

  // Pasting an image works too, and removing it before sending drops the preview.
  await composer(page).focus();
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1; // different content, so a different file
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await expect(page.getByAltText('Attachment preview')).toBeVisible();
  await page.getByRole('button', { name: 'Remove attachment' }).click();
  await expect(page.getByAltText('Attachment preview')).toHaveCount(0);

  // Delete the conversation: its image goes with it.
  const item = page.locator('[data-conversation-id]').first();
  await item.hover();
  await item.getByRole('button', { name: 'Delete' }).click();
  await item.getByRole('button', { name: 'Click again to delete' }).click();
  await expect(page.locator('[data-conversation-id]')).toHaveCount(0);
  const sentHash = attachmentFiles(dir);
  expect(sentHash).toHaveLength(1); // only the pasted-but-unsent one remains; startup cleanup removes it after a day
  await app.close();
});

test('math renders with KaTeX when switched on, and stays as text when off', async () => {
  const dir = profile();
  const { app, page } = await launch(dir);
  await connectMock(page);
  await composer(page).fill('Euler: $e^{i\\pi} + 1 = 0$');
  await composer(page).press('Enter');
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply).toHaveAttribute('data-finish', 'stop');
  await expect(reply.locator('.katex')).toHaveCount(0);
  await expect(reply).toContainText('$e^{i\\pi} + 1 = 0$');
  await page.evaluate(() => window.relay.settings.set({ mathEnabled: true }));
  await page.reload();
  await expect(page.locator('[data-role="assistant"]').last().locator('.katex')).toHaveCount(1);
  await app.close();
});

test('export everything to a ZIP and restore it into an empty profile from the welcome screen', async () => {
  const src = profile();
  const a = await launch(src);
  await connectMock(a.page);
  await a.page.locator('input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await composer(a.page).fill('First chat with a picture');
  await composer(a.page).press('Enter');
  await expect(a.page.locator('[data-role="assistant"][data-finish="stop"]')).toHaveCount(1);
  // A branch, so the export has more than the visible thread.
  const user = a.page.locator('[data-role="user"]').first();
  await user.hover();
  await user.getByRole('button', { name: 'Edit and resend' }).click();
  await a.page.getByLabel('Edit message').fill('First chat, edited');
  await a.page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await expect(a.page.locator('[data-role="assistant"]').last()).toContainText('You said: First chat, edited');
  await a.page.keyboard.press('Control+n');
  await composer(a.page).fill('Second chat');
  await composer(a.page).press('Enter');
  await expect(a.page.locator('[data-role="assistant"]').last()).toContainText('You said: Second chat');
  await expect(a.page.locator('[data-conversation-id]')).toHaveCount(2);

  const zip = join(src, 'export.zip');
  await a.app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog;
  }, zip);
  await a.page.keyboard.press('Control+,');
  await a.page.getByRole('button', { name: 'Data', exact: true }).click();
  await a.page.getByRole('button', { name: 'Export ZIP' }).click();
  await expect(a.page.getByText(/Exported to/)).toBeVisible();
  expect(existsSync(zip)).toBe(true);
  await a.app.close();

  const dst = profile();
  const b = await launch(dst);
  await expect(b.page.getByRole('heading', { name: 'Welcome to Relay' })).toBeVisible();
  await b.app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as unknown as typeof dialog.showOpenDialog;
  }, zip);
  await b.page.getByRole('button', { name: 'Restore from an export' }).click();
  await expect(b.page.getByText(/Imported 2 conversations/)).toBeVisible();
  await expect(b.page.locator('[data-conversation-id]')).toHaveCount(2);

  // The branch and the image came across; the key did not.
  await b.page.locator('[data-conversation-id]', { hasText: 'First chat with a picture' }).click();
  await expect(b.page.locator('[data-role="user"]').first()).toContainText('First chat, edited');
  await expect(b.page.locator('[data-role="user"]').first()).toContainText('2/2');
  await expect(b.page.locator('[data-role="user"]').getByAltText('Attached image')).toBeVisible();
  expect(attachmentFiles(dst)).toHaveLength(1);
  const status = await b.page.evaluate(async () => window.relay.keys.status((await window.relay.providers.list())[0].id));
  expect(status).toEqual({ present: false });

  // Sending without a key fails visibly and offers to re-enter it.
  await composer(b.page).fill('hello again');
  await composer(b.page).press('Enter');
  const alert = b.page.locator('[data-role="assistant"]').last().getByRole('alert');
  await expect(alert).toContainText('No API key is saved for this provider.');
  await expect(alert.getByRole('button', { name: 'Re-enter key' })).toBeVisible();
  await b.app.close();
});
