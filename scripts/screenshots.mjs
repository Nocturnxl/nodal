// Takes the screenshots used in the README and docs from the real, built app.
//
// The app talks to a small demo server started here, standing in for a
// provider, so no account or key is needed and nothing leaves the machine.
// The model names and replies are placeholders written for the pictures; the
// interface around them is the application exactly as it ships.
//
//   npm run bundle
//   node scripts/screenshots.mjs
//
// Writes assets/screenshots/<name>-light.png and <name>-dark.png.
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'assets/screenshots');
const KEY = 'demo-key-for-screenshots';

const model = (id, name, caps) => ({
  id,
  type: 'text',
  object: 'model',
  model_spec: {
    name,
    availableContextTokens: 128000,
    maxCompletionTokens: 16384,
    capabilities: { supportsVision: false, supportsReasoning: false, supportsFunctionCalling: true, supportsResponseSchema: true, supportsWebSearch: true, ...caps },
  },
});
const MODELS = [
  model('demo-model', 'Demo Model', {}),
  model('demo-reasoning-model', 'Demo Reasoning Model', { supportsReasoning: true }),
  model('demo-vision-model', 'Demo Vision Model', { supportsVision: true }),
];

const REPLY = `Binary search finds a value in a **sorted** list by halving the range it has to look at on every step.

## How it works

1. Look at the middle element.
2. If it is the target, stop.
3. If the target is smaller, keep the left half; otherwise keep the right half.
4. Repeat until the range is empty.

\`\`\`python
def binary_search(items, target):
    low, high = 0, len(items) - 1
    while low <= high:
        mid = (low + high) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1
\`\`\`

Each step discards half of what is left, so a list of a million items needs at most about 20 comparisons.

| List size | Worst-case steps |
| --- | --- |
| 1,000 | 10 |
| 1,000,000 | 20 |
`;
const THINKING = 'The trains start 300 km apart and close the gap at 60 + 90 = 150 km/h. Time to meet is 300 / 150 = 2 hours. The first train covers 60 × 2 = 120 km in that time, so they meet 120 km from the first station. Check: the second covers 180 km, and 120 + 180 = 300.';
const ANSWER = 'They meet after **2 hours**, 120 km from the first station.\n\nTogether they close the 300 km gap at 150 km/h, and 300 ÷ 150 = 2.';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${KEY}` && !url.pathname.endsWith('/models')) return json(401, { error: 'Authentication failed' });
  if (url.pathname.endsWith('/models')) return json(200, { object: 'list', data: MODELS });
  if (url.pathname.endsWith('/api_keys/rate_limits')) return json(200, { data: {} });
  if (url.pathname.endsWith('/chat/completions')) {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    const pieces = (text) => text.match(/[\s\S]{1,24}/g) ?? [];
    if (body.model === 'demo-reasoning-model') for (const p of pieces(THINKING)) send({ reasoning_content: p });
    for (const p of pieces(body.model === 'demo-reasoning-model' ? ANSWER : REPLY)) send({ content: p });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 212, total_tokens: 236 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  json(404, { error: 'Not found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

mkdirSync(outDir, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'nodal-shots-'));
const app = await electron.launch({
  args: [root, '--force-device-scale-factor=2', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  env: { ...process.env, NODAL_USER_DATA: userData },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

const theme = async (name) => {
  await page.evaluate((t) => window.nodal.settings.set({ theme: t }), name);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
};
const settle = () =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
const shot = async (name, mode) => {
  await settle();
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(outDir, `${name}-${mode}.png`) });
  console.log(`${name}-${mode}.png`);
};
const composer = () => page.getByRole('textbox', { name: 'Message', exact: true });
const say = async (text) => {
  await composer().fill(text);
  await composer().press('Enter');
  await page.locator('[data-role="assistant"][data-finish="stop"]').last().waitFor();
  await page.locator('[data-role="assistant"]').last().locator('[data-finish="stop"], :scope').first().waitFor();
};

try {
  // First run: the welcome screen, before any provider exists.
  for (const mode of ['light', 'dark']) {
    await theme(mode);
    await page.getByRole('heading', { name: 'Welcome to NODAL' }).waitFor();
    await shot('welcome', mode);
  }

  // A provider, added the way the app's own form would, and two conversations.
  await page.evaluate(
    async ({ base, key }) => {
      const { saved } = await window.nodal.providers.save({ kind: 'openai-compatible', preset: 'venice', displayName: 'Demo server', baseUrl: base, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: false });
      await window.nodal.keys.set(saved.id, key);
      await window.nodal.models.list(saved.id, { refresh: true });
      await window.nodal.conversations.create({ providerId: saved.id, modelId: 'demo-reasoning-model', title: 'Two trains' });
      await window.nodal.conversations.create({ providerId: saved.id, modelId: 'demo-model', title: 'Binary search' });
      await window.nodal.settings.set({ lastModel: { providerId: saved.id, modelId: 'demo-model' }, theme: 'light' });
    },
    { base, key: KEY },
  );
  await page.reload();
  await page.locator('[data-conversation-id]', { hasText: 'Binary search' }).click();
  await say('Explain how binary search works, with a short Python example.');
  await page.locator('[data-conversation-id]', { hasText: 'Two trains' }).click();
  await say('Two trains leave stations 300 km apart and travel toward each other at 60 km/h and 90 km/h. When and where do they meet?');

  for (const mode of ['light', 'dark']) {
    await theme(mode);

    await page.locator('[data-conversation-id]', { hasText: 'Binary search' }).click();
    await page.locator('[data-role="assistant"]').last().waitFor();
    await page.locator('[data-role="user"]').first().scrollIntoViewIfNeeded();
    await shot('chat', mode);

    await page.keyboard.press('Control+k');
    await page.getByLabel('Search models').waitFor();
    await shot('models', mode);
    await page.keyboard.press('Escape');

    await page.locator('[data-conversation-id]', { hasText: 'Two trains' }).click();
    await page.locator('summary', { hasText: 'Reasoning' }).click();
    await shot('reasoning', mode);

    await page.getByRole('button', { name: /^Voice chat: talk/ }).click();
    await page.getByRole('status').waitFor();
    await shot('voice', mode);
    await page.getByRole('button', { name: 'Turn off voice' }).click();

    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    await shot('providers', mode);
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await page.getByRole('heading', { name: /Encrypt chats/ }).waitFor();
    await shot('security', mode);
    await page.keyboard.press('Escape');
  }
} finally {
  await app.close().catch(() => {});
  server.close();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
}
