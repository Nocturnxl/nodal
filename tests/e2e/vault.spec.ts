import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { NodalApi } from '@shared/api';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appArgs } from './launch';
import { MOCK_KEY, startMockServer, type MockServer } from '../mock/server';

declare global {
  interface Window {
    nodal: NodalApi;
  }
}

// Optional passphrase encryption, driven through the real app: turn it on with
// chats and an image already present, restart into the lock screen, unlock,
// export and restore an encrypted file, change the passphrase, turn it off.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PASS = 'correct horse battery staple';
const NEXT = 'another four random words';
const FILE_PASS = 'passphrase for the export file';
const SECRET = 'the launch codes are under the doormat';

let mock: MockServer;
let dir: string;
let exported: string;
const dirs: string[] = [];
const apps: ElectronApplication[] = [];

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: appArgs(), env: { ...process.env, NODAL_USER_DATA: userData } as Record<string, string> });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

function profile(): string {
  const d = mkdtempSync(join(tmpdir(), 'nodal-e2e-vault-'));
  dirs.push(d);
  return d;
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const header = (d: string) => readFileSync(join(d, 'nodal.db')).subarray(0, 15).toString('latin1');
const images = (d: string) => readdirSync(join(d, 'attachments')).map((n) => readFileSync(join(d, 'attachments', n)));
const isPng = (b: Buffer) => b[0] === 0x89 && b[1] === 0x50;

/**
 * Searches everything NODAL itself writes (the database and its journal files,
 * the vault and key files, attachments and backups) for a piece of text, to
 * prove it is not readable on disk. Chromium's own profile files sit in the
 * same folder; they hold no chat content and some are locked while the app runs.
 */
function diskContains(d: string, text: string): boolean {
  const files = readdirSync(d)
    .filter((n) => /^(nodal\.db.*|vault\.json.*|keys\.json)$/.test(n))
    .map((n) => join(d, n));
  for (const sub of ['attachments', 'backups']) {
    if (existsSync(join(d, sub))) files.push(...readdirSync(join(d, sub)).map((n) => join(d, sub, n)));
  }
  expect(files.length).toBeGreaterThan(0);
  return files.some((f) => readFileSync(f).includes(text));
}

async function openSecurity(page: Page): Promise<void> {
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Security', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  mock = await startMockServer({ chunkDelayMs: 2 });
  dir = profile();
  exported = join(profile(), 'everything.nodalx');
});
test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => {});
  await mock.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

test('turning encryption on encrypts the existing chats and image, and the app keeps working', async () => {
  const { app, page } = await launch(dir);
  expect(await page.evaluate(() => window.nodal.vault.status())).toMatchObject({ enabled: false, unlocked: true });
  await page.getByRole('button', { name: /^Custom/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mock provider');
  await page.getByLabel('Base URL', { exact: true }).fill(mock.url);
  await page.getByLabel('API key', { exact: true }).fill(MOCK_KEY);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('option', { name: 'mock-echo', exact: true }).click();

  await page.locator('input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByAltText('Attachment preview')).toBeVisible();
  await composer(page).fill(SECRET);
  await composer(page).press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');

  // Before: an ordinary SQLite file, the text readable in it, the image a PNG.
  expect(header(dir)).toBe('SQLite format 3');
  expect(diskContains(dir, SECRET)).toBe(true);
  expect(images(dir).every(isPng)).toBe(true);

  await expect(page.getByRole('button', { name: /^Lock now/ })).toHaveCount(0); // nothing to lock yet
  await openSecurity(page);
  const turnOn = page.getByRole('button', { name: 'Turn on encryption' });
  await expect(turnOn).toBeDisabled();
  const axe = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByLabel('Passphrase', { exact: true }).fill('short');
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByLabel('Type it again').fill(`${PASS}!`);
  await expect(page.getByText('The two entries do not match.')).toBeVisible();
  await page.getByLabel('Type it again').fill(PASS);
  await expect(turnOn).toBeDisabled(); // the warning has to be acknowledged
  await page.getByRole('checkbox').check();
  await turnOn.click();
  await expect(page.getByText('Encryption is on.', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Change passphrase' })).toBeVisible();

  // After: nothing readable on disk.
  expect(existsSync(join(dir, 'vault.json'))).toBe(true);
  expect(header(dir)).not.toBe('SQLite format 3');
  expect(diskContains(dir, SECRET)).toBe(false);
  expect(diskContains(dir, PASS)).toBe(false);
  expect(images(dir)).toHaveLength(1);
  expect(images(dir).some(isPng)).toBe(false);

  // The running app carries on without a restart: old chat, image, search and a new message.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-role="user"]').getByAltText('Attached image')).toBeVisible();
  await composer(page).fill('written after encryption: zebra crossing');
  await composer(page).press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('zebra crossing');
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');
  await page.getByLabel('Search conversations').fill('doormat');
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  expect(diskContains(dir, 'zebra crossing')).toBe(false);
  await app.close();
});

test('a restart opens on the lock screen; nothing is reachable until the right passphrase', async () => {
  const { app, page } = await launch(dir);
  await expect(page.getByRole('heading', { name: 'NODAL is locked' })).toBeVisible();
  expect(await page.evaluate(() => window.nodal.vault.status())).toMatchObject({ enabled: true, unlocked: false });

  const results = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Main has not opened the database, so no other call can answer.
  for (const call of ['conversations.list', 'providers.list', 'settings.get', 'data.exportAll'] as const) {
    const failed = await page.evaluate(async (path) => {
      const [group, fn] = path.split('.') as [keyof NodalApi, string];
      try {
        await (window.nodal[group] as unknown as Record<string, () => Promise<unknown>>)[fn]();
        return false;
      } catch {
        return true;
      }
    }, call);
    expect(failed, call).toBe(true);
  }
  // Nor can encryption be switched off or re-keyed from the lock screen.
  const disable = await page.evaluate(async () => window.nodal.vault.disable('guess guess guess').then(() => 'done', (e) => String(e)));
  expect(disable).toContain('locked');

  await page.getByLabel('Passphrase', { exact: true }).fill('not the passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await expect(page.getByRole('heading', { name: 'NODAL is locked' })).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByLabel('Passphrase', { exact: true }).press('Enter');
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  await expect(page.locator('[data-role="user"]').first()).toContainText(SECRET);
  await expect(page.locator('[data-role="user"]').getByAltText('Attached image')).toBeVisible();
  // The stored API key was never part of the vault and still works.
  await composer(page).fill('after unlocking');
  await composer(page).press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('You said: after unlocking');
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');

  // An encrypted export, with a passphrase of its own.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog;
  }, exported);
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('button', { name: 'Encrypted export' }).click();
  await page.getByLabel('Passphrase for this file').fill(FILE_PASS);
  await page.getByLabel('Type it again').fill(FILE_PASS);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText(/Exported to/)).toBeVisible();
  const bytes = readFileSync(exported);
  expect(bytes.subarray(0, 7).toString()).toBe('NODALX1');
  expect(bytes.includes(SECRET)).toBe(false);
  await app.close();
});

test('an encrypted export restores into an empty profile with its passphrase', async () => {
  const dst = profile();
  const { app, page } = await launch(dst);
  await expect(page.getByRole('heading', { name: 'Welcome to NODAL' })).toBeVisible();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as unknown as typeof dialog.showOpenDialog;
  }, exported);
  await page.getByRole('button', { name: 'Restore from an export' }).click();
  await expect(page.getByRole('heading', { name: 'This export is encrypted' })).toBeVisible();
  await page.getByLabel('Passphrase for this file').fill('wrong passphrase');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('does not open this export');
  await page.getByLabel('Passphrase for this file').fill(FILE_PASS);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Imported 1 conversation/)).toBeVisible();
  await expect(page.locator('[data-role="user"]').first()).toContainText(SECRET);
  await expect(page.locator('[data-role="user"]').getByAltText('Attached image')).toBeVisible();
  // The new profile is not encrypted unless its owner turns that on.
  expect(header(dst)).toBe('SQLite format 3');
  await app.close();
});

test('Lock now and the idle timer close the chats without quitting', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch(dir);
  const locked = page.getByRole('heading', { name: 'NODAL is locked' });
  const unlock = async () => {
    await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  };
  await unlock();

  // Lock now, from the sidebar.
  await page.getByRole('button', { name: /^Lock now/ }).click();
  await expect(locked).toBeVisible();
  expect(await page.evaluate(() => window.nodal.vault.status())).toMatchObject({ enabled: true, unlocked: false });
  await expect(page.getByText(SECRET)).toHaveCount(0);
  const failed = await page.evaluate(() => window.nodal.conversations.list().then(() => false, () => true));
  expect(failed).toBe(true);
  await page.getByLabel('Passphrase', { exact: true }).fill('not the passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');

  // Unlocking again brings everything back, and new messages work.
  await unlock();
  await expect(page.locator('[data-role="user"]').first()).toContainText(SECRET);
  await expect(page.locator('[data-role="user"]').getByAltText('Attached image').first()).toBeVisible();
  await composer(page).fill('after locking and unlocking');
  await composer(page).press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('You said: after locking and unlocking');
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');
  expect(diskContains(dir, 'after locking and unlocking')).toBe(false);

  // The keyboard shortcut, and Lock now in Settings.
  await page.keyboard.press('Control+Shift+L');
  await expect(locked).toBeVisible();
  await unlock();
  await openSecurity(page);
  const axe = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expect(page.getByLabel('Lock automatically')).toHaveValue('15');
  await page.getByRole('region', { name: 'Lock' }).getByRole('button', { name: 'Lock now' }).click();
  await expect(locked).toBeVisible();
  await unlock();

  // On the shortest setting, using the window keeps it open well past a minute...
  await openSecurity(page);
  await page.getByLabel('Lock automatically').selectOption('1');
  await page.keyboard.press('Escape');
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(5000);
    if (i % 2) await page.mouse.move(300 + i, 300);
    else await page.keyboard.press('Shift');
  }
  await expect(locked).toHaveCount(0);
  // ...and left alone, it locks itself.
  await expect(locked).toBeVisible({ timeout: 100_000 });
  expect(await page.evaluate(() => window.nodal.vault.status())).toMatchObject({ enabled: true, unlocked: false });

  // Back to never, so the tests that follow are not timed.
  await unlock();
  expect((await page.evaluate(() => window.nodal.settings.set({ autoLockMinutes: 0 }))).autoLockMinutes).toBe(0);
  await app.close();
});

test('the passphrase can be changed, and encryption turned off again', async () => {
  let { app, page } = await launch(dir);
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);

  await openSecurity(page);
  await page.getByLabel('Current passphrase').fill('not the passphrase');
  await page.getByLabel('New passphrase').fill(NEXT);
  await page.getByLabel('Type it again').fill(NEXT);
  await page.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(page.getByRole('alert')).toContainText('current passphrase is not right');
  await page.getByLabel('Current passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(page.getByText('Passphrase changed')).toBeVisible();
  await app.close();

  ({ app, page } = await launch(dir));
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByLabel('Passphrase', { exact: true }).fill(NEXT);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);

  await openSecurity(page);
  const off = page.getByRole('region', { name: 'Turn off encryption' });
  await off.getByLabel('Passphrase', { exact: true }).fill('not the passphrase');
  await off.getByRole('button', { name: 'Turn off encryption' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
  expect(header(dir)).not.toBe('SQLite format 3');
  await off.getByLabel('Passphrase', { exact: true }).fill(NEXT);
  await off.getByRole('button', { name: 'Turn off encryption' }).click();
  await expect(page.getByText('Encryption is off')).toBeVisible();
  expect(existsSync(join(dir, 'vault.json'))).toBe(false);
  expect(header(dir)).toBe('SQLite format 3');
  expect(images(dir).every(isPng)).toBe(true);
  await app.close();

  // And it starts straight into the chats again.
  ({ app, page } = await launch(dir));
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  await expect(page.locator('[data-role="user"]').first()).toContainText(SECRET);
  await app.close();
});

test('with the option on, five wrong passphrases in a row delete everything', async () => {
  let { app, page } = await launch(dir);
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  await openSecurity(page);
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByLabel('Type it again').fill(PASS);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Turn on encryption' }).click();
  await expect(page.getByRole('heading', { name: 'Change passphrase' })).toBeVisible();

  // Off until asked for.
  const option = page.getByLabel('Delete all chats after 5 wrong passphrases in a row');
  await expect(option).not.toBeChecked();
  expect(await page.evaluate(() => window.nodal.vault.status())).toEqual({ enabled: true, unlocked: true, wipeAfter: 0, failures: 0 });
  await option.click(); // the box follows the saved setting, so it ticks once main has answered
  await expect(option).toBeChecked();
  expect(await page.evaluate(() => window.nodal.vault.status())).toEqual({ enabled: true, unlocked: true, wipeAfter: 5, failures: 0 });
  const axe = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await app.close();

  const guess = async (text: string) => {
    await page.getByLabel('Passphrase', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Unlock' }).click();
  };

  // The lock screen says what is at stake, and counts down.
  ({ app, page } = await launch(dir));
  await expect(page.getByText('5 more wrong passphrases delete all chats on this computer.')).toBeVisible();
  await guess('first wrong guess');
  await expect(page.getByText('4 more wrong passphrases delete all chats on this computer.')).toBeVisible();
  await guess('second wrong guess');
  await expect(page.getByText('3 more wrong passphrases delete all chats on this computer.')).toBeVisible();
  await app.close();

  // Restarting does not start the count again; the right passphrase does.
  ({ app, page } = await launch(dir));
  await expect(page.getByText('3 more wrong passphrases delete all chats on this computer.')).toBeVisible();
  await guess(PASS);
  await expect(page.locator('[data-conversation-id]')).toHaveCount(1);
  expect(await page.evaluate(() => window.nodal.vault.status())).toEqual({ enabled: true, unlocked: true, wipeAfter: 5, failures: 0 });
  expect(existsSync(join(dir, 'keys.json'))).toBe(true);

  // Lock, then five wrong ones.
  await page.getByRole('button', { name: /^Lock now/ }).click();
  await expect(page.getByText('5 more wrong passphrases delete all chats on this computer.')).toBeVisible();
  for (let i = 1; i <= 4; i++) {
    await guess(`wrong guess number ${i}`);
    await expect(page.getByText(i === 4 ? 'One more wrong passphrase deletes all chats on this computer.' : `${5 - i} more wrong passphrases delete all chats on this computer.`)).toBeVisible({
      timeout: 15_000,
    });
  }
  expect(existsSync(join(dir, 'vault.json'))).toBe(true);
  await guess('wrong guess number 5');
  await expect(page.getByRole('heading', { name: 'The chats on this computer were deleted' })).toBeVisible({ timeout: 15_000 });
  const gone = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(gone.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Nothing is left: no sealed key, no images, no stored API key, and a new empty database.
  expect(existsSync(join(dir, 'vault.json'))).toBe(false);
  expect(existsSync(join(dir, 'attachments'))).toBe(false);
  expect(existsSync(join(dir, 'keys.json'))).toBe(false);
  expect(header(dir)).toBe('SQLite format 3');
  expect(diskContains(dir, SECRET)).toBe(false);
  expect(await page.evaluate(() => window.nodal.vault.status())).toEqual({ enabled: false, unlocked: true, wipeAfter: 0, failures: 0 });

  // Even the right passphrase opens nothing now. NODAL starts as new.
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to NODAL' })).toBeVisible();
  expect(await page.evaluate(() => window.nodal.conversations.list())).toEqual([]);
  expect(await page.evaluate(() => window.nodal.providers.list())).toEqual([]);
  await app.close();

  ({ app, page } = await launch(dir));
  await expect(page.getByRole('heading', { name: 'Welcome to NODAL' })).toBeVisible();
  await app.close();
});
