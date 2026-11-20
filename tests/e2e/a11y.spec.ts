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

// Automated accessibility checks (axe-core, WCAG 2.1 A and AA rules) on each
// main screen in both themes. This catches missing labels, roles and contrast
// problems; it is not a substitute for testing with a screen reader.

let mock: MockServer;
let app: ElectronApplication;
let page: Page;
let userData: string;

async function scan(name: string): Promise<void> {
  // Dialogs fade in. Measured part-way through, text is blended with what is behind it and fails contrast by accident.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((anim) => Number.isFinite(anim.effect?.getComputedTiming().endTime))
        .map((anim) => anim.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n    ')}`);
  expect(summary, `${name}:\n${summary.join('\n')}`).toEqual([]);
}

// Run in file order, but keep going after a failure so one run lists every problem.

test.beforeAll(async () => {
  mock = await startMockServer({ chunkDelayMs: 1 });
  userData = mkdtempSync(join(tmpdir(), 'nodal-e2e-a11y-'));
  app = await electron.launch({ args: appArgs(), env: { ...process.env, NODAL_USER_DATA: userData } as Record<string, string> });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await mock.close();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
});

for (const theme of ['light', 'dark'] as const) {
  test(`welcome and provider form (${theme})`, async () => {
    await page.evaluate((t) => window.nodal.settings.set({ theme: t }), theme);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome to NODAL' })).toBeVisible();
    await scan('welcome');
    await page.getByRole('button', { name: /^Venice/ }).click();
    await page.getByRole('button', { name: 'Connection details' }).click();
    await scan('provider form');
  });
}

test('set up a provider and a conversation with rich content and an error', async () => {
  await page.evaluate(
    async ({ url, key }) => {
      const { saved } = await window.nodal.providers.save({ kind: 'openai-compatible', preset: 'venice', displayName: 'Venice.ai', baseUrl: url, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: false });
      await window.nodal.keys.set(saved.id, key);
      await window.nodal.settings.set({ lastModel: { providerId: saved.id, modelId: 'mock-markdown' }, theme: 'light' });
    },
    { url: mock.url, key: MOCK_KEY },
  );
  await page.reload();
  await page.getByRole('button', { name: 'New chat' }).click();
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('Show me everything');
  await box.press('Enter');
  await expect(page.locator('[data-role="assistant"][data-finish="stop"]')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search models').fill('mock-401');
  await page.getByLabel('Search models').press('Enter');
  await box.fill('This one fails');
  await box.press('Enter');
  await expect(page.locator('[data-finish="error"]')).toHaveCount(1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`chat, model picker and settings (${theme})`, async () => {
    await page.evaluate((t) => window.nodal.settings.set({ theme: t }), theme);
    await page.reload();
    await expect(page.locator('[data-finish="error"]')).toHaveCount(1);
    await scan('chat');

    await page.keyboard.press('Control+k');
    await expect(page.getByLabel('Search models')).toBeVisible();
    await scan('model picker');
    // Again with a row highlighted by the mouse: its background changes, so contrast must hold there too.
    await page.getByRole('option').first().hover();
    await scan('model picker, row highlighted');
    await page.getByRole('option', { name: /current/ }).hover();
    await scan('model picker, current row highlighted');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+,');
    for (const section of ['Providers', 'Appearance', 'Data', 'Network', 'About']) {
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
      await page.waitForTimeout(150);
      await scan(`settings: ${section}`);
    }
    await page.keyboard.press('Escape');
  });
}
