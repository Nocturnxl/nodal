import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { NodalApi } from '@shared/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appArgs } from './launch';
import { MOCK_KEY, startMockServer, type MockServer } from '../mock/server';

declare global {
  interface Window {
    nodal: NodalApi;
  }
}

// The Venice character option: chosen from a searchable list the provider
// serves, so nobody has to know or type a slug.

let mock: MockServer;
let dir: string;
let app: ElectronApplication;
let page: Page;
let providerId: string;

const lastChat = () => mock.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!.body;
const send = async (text: string) => {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(`You said: ${text}`);
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');
};

test.beforeAll(async () => {
  mock = await startMockServer({ chunkDelayMs: 2, publicModels: true });
  dir = mkdtempSync(join(tmpdir(), 'nodal-e2e-characters-'));
  app = await electron.launch({ args: appArgs(), env: { ...process.env, NODAL_USER_DATA: dir } as Record<string, string> });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  providerId = await page.evaluate(
    async ({ url, key }) => {
      const { saved } = await window.nodal.providers.save({ kind: 'openai-compatible', preset: 'venice', displayName: 'Venice.ai', baseUrl: url, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: false });
      await window.nodal.keys.set(saved.id, key);
      await window.nodal.settings.set({ lastModel: { providerId: saved.id, modelId: 'mock-echo' } });
      return saved.id;
    },
    { url: mock.url, key: MOCK_KEY },
  );
  await page.reload();
  await page.getByRole('button', { name: 'New chat' }).click();
});
test.afterAll(async () => {
  await app.close().catch(() => {});
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('a character is picked from a searchable list and sent by its slug', async () => {
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: 'Advanced' }).click();
  // No free-text slug box any more.
  await expect(inspector.getByLabel('Character slug')).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Character: None' }).click();

  await expect(inspector.getByText('3 found.')).toBeVisible();
  for (const name of ['Alan Watts', 'Ada Lovelace', 'Night Owl']) await expect(inspector.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(inspector.getByRole('button', { name: /^Night Owl/ })).toContainText('18+');
  const axe = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Searching asks the provider, and a search with no match says so.
  await inspector.getByLabel('Search characters').fill('mathematics');
  await expect(inspector.getByText('1 found.')).toBeVisible();
  await expect(inspector.getByRole('button', { name: /^Alan Watts/ })).toHaveCount(0);
  expect(mock.requests.some((r) => r.path === '/v1/characters?limit=50&search=mathematics')).toBe(true);
  await inspector.getByLabel('Search characters').fill('nobody by this name');
  await expect(inspector.getByText('No characters match.')).toBeVisible();
  await inspector.getByLabel('Search characters').fill('mathematics');

  // Picking one closes the list, shows the name, and the request carries the slug.
  await inspector.getByRole('button', { name: /^Ada Lovelace/ }).click();
  await expect(inspector.getByRole('button', { name: 'Character: Ada Lovelace' })).toBeVisible();
  await expect(inspector.getByLabel('Search characters')).toHaveCount(0);
  await send('hello Ada');
  expect(lastChat().venice_parameters.character_slug).toBe('ada-lovelace');

  // The choice is saved with the conversation, and the current one is marked in the list.
  expect((await page.evaluate(() => window.nodal.conversations.list()))[0]).toBeTruthy();
  await inspector.getByRole('button', { name: 'Character: Ada Lovelace' }).click();
  await expect(inspector.getByRole('button', { name: /^Ada Lovelace/ })).toHaveAttribute('aria-pressed', 'true');
  await inspector.getByRole('button', { name: 'Character: Ada Lovelace' }).click();

  // Clear goes back to no character.
  await inspector.getByRole('button', { name: 'Clear' }).click();
  await expect(inspector.getByRole('button', { name: 'Character: None' })).toBeVisible();
  await send('hello nobody');
  expect(lastChat().venice_parameters).not.toHaveProperty('character_slug');
});

test('when the list cannot be loaded the reason is shown, with a way to try again', async () => {
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await page.evaluate((id) => window.nodal.keys.clear(id), providerId);
  await inspector.getByRole('button', { name: 'Character: None' }).click();
  await expect(inspector.getByText('Venice needs a valid API key to list characters.')).toBeVisible();
  await expect(inspector.getByRole('button', { name: /^Alan Watts/ })).toHaveCount(0);

  await page.evaluate(({ id, key }) => window.nodal.keys.set(id, key), { id: providerId, key: MOCK_KEY });
  await inspector.getByRole('button', { name: 'Try again' }).click();
  await expect(inspector.getByText('3 found.')).toBeVisible();
  await inspector.getByRole('button', { name: /^Alan Watts/ }).click();
  await expect(inspector.getByRole('button', { name: 'Character: Alan Watts' })).toBeVisible();
});
