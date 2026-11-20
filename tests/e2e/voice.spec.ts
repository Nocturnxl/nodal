import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { NodalApi } from '@shared/api';
import { DEFAULT_VOICE_INSTRUCTIONS } from '../../src/shared/types';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appArgs } from './launch';
import { MOCK_KEY, startMockServer, wav, type MockServer } from '../mock/server';

declare global {
  interface Window {
    nodal: NodalApi;
  }
}

// Voice chat, driven through the real app with Chromium's stand-in microphone
// playing a recording on a loop: a moment of silence, a burst of sound, then
// a long silence so that only one turn is spoken while a test looks.
// The mock provider "hears" a fixed sentence in whatever it is sent.

let mock: MockServer;
let dir: string;
let app: ElectronApplication;
let page: Page;

const audioRequests = () => mock.requests.filter((r) => r.path.includes('/audio/'));
const composer = () => page.getByRole('textbox', { name: 'Message', exact: true });

test.beforeAll(async () => {
  mock = await startMockServer({ chunkDelayMs: 2, publicModels: true });
  dir = mkdtempSync(join(tmpdir(), 'nodal-e2e-voice-'));
  const recording = join(dir, 'speech.wav');
  writeFileSync(recording, wav([[1.5, false], [1.5, true], [40, false]], 48_000, 2));
  app = await electron.launch({
    args: [...appArgs(), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${recording}`],
    env: { ...process.env, NODAL_USER_DATA: join(dir, 'profile') } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(
    async ({ url, key }) => {
      const venice = (await window.nodal.providers.save({ kind: 'openai-compatible', preset: 'venice', displayName: 'Venice.ai', baseUrl: url, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: false })).saved;
      await window.nodal.keys.set(venice.id, key);
      const other = (await window.nodal.providers.save({ kind: 'openai-compatible', displayName: 'Plain', baseUrl: url, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: false })).saved;
      await window.nodal.keys.set(other.id, key);
      await window.nodal.conversations.create({ providerId: other.id, modelId: 'mock-echo', title: 'Plain chat' });
      await window.nodal.conversations.create({ providerId: venice.id, modelId: 'mock-echo', title: 'Venice chat' });
    },
    { url: mock.url, key: MOCK_KEY },
  );
  await page.reload();
});
test.afterAll(async () => {
  await app.close().catch(() => {});
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('the voice switch is offered only where the provider has speech services', async () => {
  await page.locator('[data-conversation-id]', { hasText: 'Plain chat' }).click();
  await expect(composer()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Voice chat/ })).toHaveCount(0);
  await page.locator('[data-conversation-id]', { hasText: 'Venice chat' }).click();
  await expect(page.getByRole('button', { name: /^Voice chat: talk/ })).toBeVisible();
});

test('diagnostic: what the simulated microphone delivers on this machine', async () => {
  // Loudest level heard over nine seconds (longer than the silence the recording starts with), with and without the browser's voice processing.
  const heard = await page.evaluate(async () => {
    const measure = async (processing: boolean) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing } });
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let peak = 0;
        const until = performance.now() + 9000;
        while (performance.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          peak = Math.max(peak, Math.sqrt(sum / buf.length));
        }
        const track = stream.getAudioTracks()[0];
        const info = { peak: Number(peak.toFixed(4)), label: track.label, muted: track.muted, state: ctx.state, settings: track.getSettings() };
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
        return info;
      } catch (e) {
        return { error: String(e) };
      }
    };
    return { processed: await measure(true), raw: await measure(false) };
  });
  console.log('microphone levels:', JSON.stringify(heard));
});

test('speaking sends a message, the reply is read aloud, and it listens again', async () => {
  await page.getByRole('button', { name: /^Voice chat: talk/ }).click();
  const status = page.getByRole('status');
  await expect(status).toHaveText(/Listening|Hearing you/);
  await expect(page.getByRole('button', { name: 'Voice chat is on. Turn off' })).toHaveAttribute('aria-pressed', 'true');
  const axe = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Recorded in the run's output: what audio hardware this machine gives the app.
  console.log(
    'audio devices:',
    await page.evaluate(async () => {
      const probe = new AudioContext();
      const state = probe.state;
      await probe.close();
      return JSON.stringify({ context: state, devices: (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind) });
    }),
  );

  // The pause after the sound ends the turn: the words arrive as an ordinary message and the model answers.
  await expect(page.locator('[data-role="user"]').last()).toContainText('What is the capital of France?', { timeout: 30_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('You said: What is the capital of France?');
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');

  // The recording went up as a file, and the reply came back as speech.
  await expect.poll(() => audioRequests().map((r) => r.path)).toEqual(['/v1/audio/transcriptions', '/v1/audio/speech']);
  expect(audioRequests()[0].headers['content-type']).toMatch(/^multipart\/form-data/);
  expect(String(audioRequests()[0].body)).toContain('filename="speech.webm"');
  expect(audioRequests()[1].body.input).toBe('You said: What is the capital of France?');

  // The voice instructions were sent as the system prompt for this spoken turn.
  const chat = mock.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!.body;
  expect(chat.messages[0]).toEqual({ role: 'system', content: DEFAULT_VOICE_INSTRUCTIONS });
  expect(chat.messages.at(-1)).toEqual({ role: 'user', content: 'What is the capital of France?' });

  // Once the reply has been read out, the microphone is open again.
  await expect(status).toHaveText('Listening. Speak when you are ready.', { timeout: 15_000 });

  // The turn is saved as text, like any other. No audio is kept.
  const saved = await page.evaluate(async () => {
    const [c] = await window.nodal.conversations.list();
    return (await window.nodal.conversations.get(c.id)).messages.map((m) => m.content);
  });
  expect(saved).toEqual([[{ type: 'text', text: 'What is the capital of France?' }], [{ type: 'text', text: 'You said: What is the capital of France?' }]]);
});

test('turning voice off releases the microphone, and typing still works', async () => {
  await page.getByRole('button', { name: 'Turn off voice' }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Voice chat: talk/ })).toHaveAttribute('aria-pressed', 'false');
  const before = audioRequests().length;
  await composer().fill('typed, not spoken');
  await composer().press('Enter');
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('You said: typed, not spoken');
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute('data-finish', 'stop');
  // A typed message is not read aloud and carries no voice instructions.
  expect(audioRequests()).toHaveLength(before);
  expect(mock.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!.body.messages[0].role).toBe('user');
});

test('a voice service failure turns voice off and says why', async () => {
  const providerId = await page.evaluate(async () => (await window.nodal.providers.list()).find((p) => p.preset === 'venice')!.id);
  await page.evaluate((id) => window.nodal.keys.clear(id), providerId);
  await page.getByRole('button', { name: /^Voice chat: talk/ }).click();
  await expect(page.getByRole('status')).toHaveText(/Listening|Hearing you/);
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Voice chat stopped')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Venice needs a valid API key for voice.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
});
