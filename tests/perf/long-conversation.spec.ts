import { _electron as electron, test } from '@playwright/test';
import type { RelayApi } from '@shared/api';
// Not part of the normal test run: `npm run perf:ui` (bundle first). Seeds a
// 5,000-message conversation and records scroll, typing and memory figures.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_KEY, startMockServer } from '../mock/server';

declare global {
  interface Window {
    relay: RelayApi;
  }
}

const N = 5000;

test('measure a 5,000-message conversation', async () => {
  test.setTimeout(300_000);
  const mock = await startMockServer({ chunkDelayMs: 10 });
  const userData = mkdtempSync(join(tmpdir(), 'relay-big-'));
  const words = 'the quick brown fox jumps over the lazy dog while a steady rain falls on the quiet harbor town'.split(' ');
  const body = (i: number) =>
    i % 7 === 3
      ? `Here is a list for item ${i}:\n\n- **first** point with \`code\`\n- second point\n\n\`\`\`ts\nconst n = ${i};\nconsole.log(n * 2);\n\`\`\`\n`
      : Array.from({ length: 40 + (i % 60) }, (_, k) => words[(i + k) % words.length]).join(' ') + ` (message ${i})`;
  const providerId = 'big-provider';
  const convId = 'big-conv';
  const messages = Array.from({ length: N }, (_, i) => ({
    id: `m${i}`,
    conversationId: convId,
    parentId: i ? `m${i - 1}` : null,
    role: i % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: body(i) }],
    providerId: i % 2 ? providerId : null,
    modelId: i % 2 ? 'mock-long' : null,
    reasoningText: null,
    finishReason: 'stop',
    usage: null,
    requestId: null,
    error: null,
    createdAt: 1_790_000_000_000 + i * 1000,
  }));
  const file = join(userData, 'big.json');
  writeFileSync(
    file,
    JSON.stringify({
      format: 'relay.conversation',
      version: 1,
      providers: [{ id: providerId, kind: 'openai-compatible', displayName: 'Mock', baseUrl: mock.url, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: false }],
      conversations: [{ id: convId, title: 'Five thousand messages', providerId, modelId: 'mock-long', systemPrompt: null, params: {}, extensions: {}, activeLeafId: `m${N - 1}`, pinned: false, archived: false, createdAt: 1_790_000_000_000, updatedAt: 1_795_000_000_000 }],
      messages,
    }),
  );

  const app = await electron.launch({ args: [resolve(__dirname, '../..')], env: { ...process.env, RELAY_USER_DATA: userData } as Record<string, string> });
  const page = await app.firstWindow();
  await page.locator('h1').first().waitFor();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as unknown as typeof dialog.showOpenDialog;
  }, file);

  const out: Record<string, unknown> = { messages: N };
  let t = Date.now();
  await page.evaluate(() => window.relay.data.importFile());
  out.importMs = Date.now() - t;
  await page.evaluate((key) => window.relay.keys.set('big-provider', key), MOCK_KEY);
  await page.reload();

  // Open the conversation: time until the newest message is on screen.
  t = Date.now();
  await page.locator('[data-conversation-id="big-conv"]').waitFor();
  await page.getByText(`(message ${N - 2})`).or(page.getByText(`const n = ${N - 1};`)).first().waitFor();
  out.reloadToLastMessageMs = Date.now() - t;
  out.mountedMessageNodes = await page.locator('[data-message-id]').count();

  // Scroll the whole thread bottom to top over about 6 seconds, recording frame gaps.
  out.scroll = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="message-scroll"]') as HTMLElement;
    const gaps: number[] = [];
    const start = performance.now();
    const from = el.scrollTop;
    let last = start;
    await new Promise<void>((done) => {
      const step = (now: number) => {
        gaps.push(now - last);
        last = now;
        const p = Math.min(1, (now - start) / 6000);
        el.scrollTop = from * (1 - p);
        if (p < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    gaps.shift();
    gaps.sort((a, b) => a - b);
    const q = (x: number) => +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * x))].toFixed(1);
    return { frames: gaps.length, scrollHeightPx: el.scrollHeight, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: q(1), over33ms: gaps.filter((g) => g > 33.4).length, over50ms: gaps.filter((g) => g > 50).length };
  });

  // Back to the bottom, then stream a reply and type while it streams.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-scroll"]') as HTMLElement;
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(500);
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('go');
  t = Date.now();
  await box.press('Enter');
  await page.locator('[data-role="assistant"]').last().getByText('word3 ').waitFor();
  out.sendToStreamingMs = Date.now() - t;

  await page.evaluate(() => {
    const w = window as unknown as { __lat: number[]; __gaps: number[]; __stop: boolean };
    w.__lat = [];
    w.__gaps = [];
    w.__stop = false;
    document.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now();
        // Two frames: the first runs before the paint that shows the character.
        requestAnimationFrame(() => requestAnimationFrame(() => w.__lat.push(performance.now() - t0)));
      },
      true,
    );
    let last = performance.now();
    const tick = (now: number) => {
      w.__gaps.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await box.pressSequentially('typing while the reply is still streaming in, sixty characters', { delay: 35 });
  out.typingWhileStreaming = await page.evaluate(() => {
    const w = window as unknown as { __lat: number[]; __gaps: number[]; __stop: boolean };
    w.__stop = true;
    const stats = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      const q = (x: number) => +s[Math.min(s.length - 1, Math.floor(s.length * x))].toFixed(1);
      return { samples: s.length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: q(1) };
    };
    return { keydownToSecondFrame: stats(w.__lat), frameGaps: { ...stats(w.__gaps.slice(1)), over33ms: w.__gaps.slice(1).filter((g) => g > 33.4).length } };
  });
  out.stillStreamingAfterTyping = await page.getByRole('button', { name: 'Stop' }).isVisible();
  t = Date.now();
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.locator('[data-finish="cancelled"]').last().waitFor();
  out.stopMs = Date.now() - t;

  out.memoryMB = await app.evaluate(({ app }) => {
    const by: Record<string, number> = {};
    for (const m of app.getAppMetrics()) by[m.type] = Math.round(((by[m.type] ?? 0) * 1024 + m.memory.workingSetSize) / 1024);
    return { ...by, total: Object.values(by).reduce((a, b) => a + b, 0) };
  });
  out.displayHz = await page.evaluate(
    () =>
      new Promise<number>((res) => {
        let n = 0;
        const s = performance.now();
        const f = () => (++n < 60 ? requestAnimationFrame(f) : res(Math.round(60000 / (performance.now() - s))));
        requestAnimationFrame(f);
      }),
  );

  mkdirSync('test-results', { recursive: true });
  writeFileSync(process.env.PERF_OUT ?? 'test-results/ui-perf.json', JSON.stringify(out, null, 2));
  await app.close();
  await mock.close();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
});
