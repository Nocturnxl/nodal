import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, NormalizedError } from '@shared/types';
import { RelayError } from '../../src/main/net/errors';
import type { ChatRequest, ProviderRuntime } from '../../src/main/providers/adapter';
import { adaptBody, createOpenAiCompatibleAdapter, mapGenericModel } from '../../src/main/providers/openaiCompatible';
import { adapterFor } from '../../src/main/providers/registry';
import openRouterFixture from '../fixtures/openrouter-models.json';
import { MOCK_KEY, MOCK_MODELS, startMockServer, type MockServer } from '../mock/server';
import { FAST, http, mockProvider } from './helpers';

const adapter = createOpenAiCompatibleAdapter();
let mock: MockServer;
let rt: ProviderRuntime;

beforeAll(async () => {
  mock = await startMockServer();
  rt = { config: { id: 'p', ...mockProvider(mock.url) }, apiKey: MOCK_KEY, http, timeouts: FAST };
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

const req = (modelId: string, over: Partial<ChatRequest> = {}): ChatRequest => ({
  modelId,
  messages: [{ role: 'user', content: 'hello there' }],
  params: {},
  extensions: {},
  conversationId: 'c1',
  ...over,
});

async function collect(modelId: string, opts: { runtime?: ProviderRuntime; signal?: AbortSignal; request?: Partial<ChatRequest> } = {}) {
  const events: ChatEvent[] = [];
  let error: NormalizedError | undefined;
  try {
    for await (const ev of adapter.streamChat(opts.runtime ?? rt, req(modelId, opts.request), opts.signal ?? new AbortController().signal)) events.push(ev);
  } catch (e) {
    if (!(e instanceof RelayError)) throw e;
    error = e.normalized;
  }
  const text = events.filter((e) => e.t === 'delta').map((e) => (e as { text: string }).text).join('');
  const reasoning = events.filter((e) => e.t === 'reasoning').map((e) => (e as { text: string }).text).join('');
  return { events, text, reasoning, error };
}

describe('model list', () => {
  it('lists models; plain entries have unknown capabilities', async () => {
    const models = await adapter.listModels(rt);
    expect(models.map((m) => m.id)).toEqual(MOCK_MODELS);
    expect(models[0]).toMatchObject({ providerId: 'p', displayName: 'mock-echo', capabilities: {} });
    expect(mock.requests[0].headers.authorization).toBe(`Bearer ${MOCK_KEY}`);
    expect(mock.requests[0].headers['user-agent']).toBe('Relay/test');
  });

  it('picks up aggregator-style metadata when present', () => {
    const m = mapGenericModel(
      {
        id: 'vendor/model',
        name: 'Vendor Model',
        context_length: 128000,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['tools', 'reasoning'],
      },
      'p',
    )!;
    expect(m).toMatchObject({
      displayName: 'Vendor Model',
      contextTokens: 128000,
      pricing: { inputPerM: 1, outputPerM: 2 },
      capabilities: { vision: true, tools: true, reasoning: true, structuredOutput: false },
    });
  });

  it('maps a recorded OpenRouter model list', () => {
    const models = (openRouterFixture.data as Record<string, unknown>[]).map((m) => mapGenericModel(m, 'or')!);
    expect(models).toHaveLength(3);
    for (const m of models) {
      expect(m.displayName).not.toBe(m.id);
      expect(m.contextTokens).toBeGreaterThan(0);
      expect(m.pricing?.currency).toBe('USD');
    }
    const [first, textOnly, basic] = models;
    expect(first.capabilities).toMatchObject({ vision: true, tools: true, reasoning: true });
    expect(first.pricing!.inputPerM).toBeCloseTo(Number((openRouterFixture.data[0] as any).pricing.prompt) * 1e6, 6);
    expect(textOnly.capabilities).toMatchObject({ vision: false, tools: true });
    expect(basic.capabilities).toMatchObject({ tools: false, reasoning: false });
  });

  it('validates an OpenRouter key with the authenticated /key endpoint, since /models is public', async () => {
    const pub = await startMockServer({ publicModels: true });
    try {
      const config = { id: 'or', ...mockProvider(pub.url, { preset: 'openrouter' }) };
      const check = (apiKey: string) => adapterFor(config).validateKey({ ...rt, config, apiKey });
      expect((await check(MOCK_KEY)).ok).toBe(true);
      expect(pub.requests[0].path).toBe('/v1/key');
      expect(await check('sk-or-v1-wrong')).toMatchObject({ ok: false, error: { code: 'auth', status: 401, message: 'User not found.' } });
    } finally {
      await pub.close();
    }
  });

  it('fails clearly on a bad key', async () => {
    await expect(adapter.listModels({ ...rt, apiKey: 'nope' })).rejects.toMatchObject({ normalized: { code: 'auth', status: 401 } });
    const check = await adapter.validateKey({ ...rt, apiKey: 'nope' });
    expect(check).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect((await adapter.validateKey(rt)).ok).toBe(true);
  });

  it('supports a custom header auth scheme and extra headers', async () => {
    const open = await startMockServer({ auth: false });
    try {
      const config = { id: 'h', ...mockProvider(open.url, { auth: { scheme: 'header', headerName: 'x-api-key' }, extraHeaders: { 'X-Title': 'Relay' } }) };
      await adapter.listModels({ ...rt, config, apiKey: 'secret-value' });
      expect(open.requests[0].headers['x-api-key']).toBe('secret-value');
      expect(open.requests[0].headers['x-title']).toBe('Relay');
      expect(open.requests[0].headers.authorization).toBeUndefined();
    } finally {
      await open.close();
    }
  });
});

describe('streaming', () => {
  it('streams deltas, usage, meta and a done event', async () => {
    const r = await collect('mock-echo', { request: { params: { temperature: 0.3, topP: 0.9, maxTokens: 50 } } });
    expect(r.error).toBeUndefined();
    expect(r.text).toBe('You said: hello there');
    expect(r.events.at(-1)).toEqual({ t: 'done', finishReason: 'stop' });
    expect(r.events.find((e) => e.t === 'usage')).toMatchObject({ promptTokens: 11 });
    const meta = r.events[0] as Extract<ChatEvent, { t: 'meta' }>;
    expect(meta.t).toBe('meta');
    expect(meta.requestId).toMatch(/^mock-req-/);
    expect(meta.rateLimit).toMatchObject({ limitRequests: 20, remainingRequests: 19 });

    const sent = mock.requests[0];
    expect(sent.body).toMatchObject({ model: 'mock-echo', stream: true, temperature: 0.3, top_p: 0.9, max_tokens: 50 });
    expect(sent.headers.accept).toBe('text/event-stream');
    expect(sent.body).not.toHaveProperty('venice_parameters');
  });

  it('survives events and multi-byte characters split across network reads', async () => {
    const r = await collect('mock-split');
    expect(r.error).toBeUndefined();
    expect(r.text).toBe('Héllo wörld — 你好 🌍 done');
  });

  it('emits reasoning from inline <think> tags and from a separate delta field', async () => {
    const think = await collect('mock-think');
    expect(think.reasoning).toBe('Let me think.');
    expect(think.text).toBe('The answer is 42.');
    const sep = await collect('mock-reasoning');
    expect(sep.reasoning).toBe('Weighing the options.');
    expect(sep.text).toBe('You said: hello there');
  });

  it('handles a server that ignores stream:true and answers with plain JSON', async () => {
    const r = await collect('mock-json');
    expect(r.text).toBe('A complete non-streamed reply.');
    expect(r.events.find((e) => e.t === 'usage')).toEqual({ t: 'usage', promptTokens: 7, completionTokens: 5 });
    expect(r.events.at(-1)).toEqual({ t: 'done', finishReason: 'stop' });
  });

  it('adapts to a server that rejects optional fields by name, then succeeds', async () => {
    const r = await collect('mock-strict', { request: { params: { temperature: 0.3, maxTokens: 64 } } });
    expect(r.error).toBeUndefined();
    expect(r.text).toBe('You said: hello there');
    expect(mock.hits['mock-strict']).toBe(4);
    const final = mock.requests.at(-1)!.body;
    expect(final).not.toHaveProperty('stream_options');
    expect(final).not.toHaveProperty('max_tokens');
    expect(final).not.toHaveProperty('temperature');
    expect(final.max_completion_tokens).toBe(64);
  });

  it('does not rewrite a request for an unrelated 400', () => {
    const body: Record<string, unknown> = { max_tokens: 5, temperature: 1, stream_options: {} };
    expect(adaptBody(body, "This model's maximum context length is 8192 tokens.")).toBe(false);
    expect(adaptBody(body, 'max_tokens is too large: 999999')).toBe(false);
    expect(body).toEqual({ max_tokens: 5, temperature: 1, stream_options: {} });
  });

  it('waits out a slow start', async () => {
    const r = await collect('mock-slow-start');
    expect(r.text).toContain('You said');
  });
});

describe('failures', () => {
  it.each([
    ['mock-401', 'auth', 401],
    ['mock-402', 'quota', 402],
    ['mock-403', 'forbidden', 403],
    ['mock-404-html', 'model_not_found', 404],
    ['mock-400-context', 'context_length', 400],
    ['mock-429-always', 'rate_limit', 429],
    ['mock-500-always', 'server', 500],
  ])('%s becomes %s with status and request id', async (model, code, status) => {
    const r = await collect(model);
    expect(r.text).toBe('');
    expect(r.error).toMatchObject({ code, status });
    expect(r.error?.requestId).toMatch(/^mock-req-/);
  });

  it('keeps provider details: balance on 402, reset time on 429, HTML hint on 404', async () => {
    expect((await collect('mock-402')).error?.message).toMatch(/Insufficient USD/);
    const rl = (await collect('mock-429-always')).error!;
    expect(rl.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(rl.resetAt).toBeGreaterThan(Date.now() - 1000);
    expect((await collect('mock-404-html')).error?.hint).toMatch(/base URL/);
  });

  it('reports a mid-stream disconnect as a network error after yielding the partial text', async () => {
    const r = await collect('mock-disconnect');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.error?.code).toBe('network');
    expect(r.events.some((e) => e.t === 'done')).toBe(false);
  });

  it('aborts a stalled stream with a timeout that names the idle timer', async () => {
    const r = await collect('mock-stall', { runtime: { ...rt, timeouts: { ...FAST, idleMs: 150 } } });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.error).toMatchObject({ code: 'timeout' });
    expect(r.error?.message).toMatch(/idle timer/);
  });

  it('times out when the first byte never arrives', async () => {
    const r = await collect('mock-slow-start', { runtime: { ...rt, timeouts: { ...FAST, connectMs: 50, firstByteMs: 100 } } });
    expect(r.error?.code).toBe('timeout');
    expect(r.error?.message).toMatch(/first-byte/);
  });

  it('cancels promptly through the AbortSignal', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 80);
    const r = await collect('mock-long', { signal: ctl.signal });
    expect(r.error?.code).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.text).toContain('word0');
    expect(r.text).not.toContain('word399');
  });

  it('describes an unreachable server in plain language', async () => {
    const dead = { ...rt, config: { ...rt.config, baseUrl: 'http://127.0.0.1:9/v1' } };
    const r = await collect('mock-echo', { runtime: dead });
    expect(r.error?.code).toBe('network');
  });
});
