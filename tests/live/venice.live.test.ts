// Live smoke test against the real Venice API. It is skipped unless
// VENICE_API_KEY is set, and it is not part of `npm test` or CI.
//
//   PowerShell:  $env:VENICE_API_KEY = "<key>"; npm run smoke:venice
//
// It runs the same adapter code the app uses and writes what it observed to
// test-results/venice-live-report.md. The key is never written anywhere; the
// run fails if the key string appears in the report. Each chat request is
// capped at a few hundred output tokens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatEvent, ModelInfo, NormalizedError, ProviderConfig } from '@shared/types';
import { PRESETS } from '@shared/presets';
import { NodalError } from '../../src/main/net/errors';
import { buildAuthHeaders, DEFAULT_TIMEOUTS, Http, joinUrl } from '../../src/main/net/http';
import { SseParser } from '../../src/main/net/sse';
import type { ChatRequest, ProviderRuntime } from '../../src/main/providers/adapter';
import { adapterFor } from '../../src/main/providers/registry';

const KEY = process.env.VENICE_API_KEY?.trim();
const MODEL = process.env.VENICE_MODEL?.trim() || 'deepseek-v4-1-flash-1017';

const config: ProviderConfig = { id: 'venice-live', ...PRESETS.find((p) => p.id === 'venice')!.config };
const adapter = adapterFor(config);

// Record response headers of interest (never cookies, never request headers).
const seenHeaders: Record<string, string> = {};
const http = new Http(async (url, init) => {
  const res = await fetch(url, init);
  res.headers.forEach((value, name) => {
    if (/^(x-ratelimit-|x-venice-|cf-ray$|retry-after$|x-request-id$|content-type$)/i.test(name)) seenHeaders[name] = /balance/i.test(name) ? '(present, value not recorded)' : value;
  });
  return res;
}, 'NODAL/live-smoke');

const rt = (apiKey: string | undefined): ProviderRuntime => ({ config, apiKey, http, timeouts: { ...DEFAULT_TIMEOUTS, firstByteMs: 120_000 } });

const report: string[] = ['# Venice live smoke report', '', `Run ${new Date().toISOString()}, model \`${MODEL}\`.`, ''];
const section = (title: string, lines: string[]) => report.push(`## ${title}`, '', ...lines, '');
const j = (v: unknown) => '`' + JSON.stringify(v) + '`';

async function chat(modelId: string, model: ModelInfo | undefined, prompt: string, over: Partial<ChatRequest> = {}, signal = new AbortController().signal) {
  const events: ChatEvent[] = [];
  let error: NormalizedError | undefined;
  const started = Date.now();
  let firstTokenMs: number | undefined;
  try {
    for await (const ev of adapter.streamChat(
      rt(KEY),
      { modelId, model, messages: [{ role: 'user', content: prompt }], params: { maxTokens: 300 }, extensions: {}, conversationId: 'nodal-live-smoke', ...over },
      signal,
    )) {
      if ((ev.t === 'delta' || ev.t === 'reasoning') && firstTokenMs === undefined) firstTokenMs = Date.now() - started;
      events.push(ev);
    }
  } catch (e) {
    if (!(e instanceof NodalError)) throw e;
    error = e.normalized;
  }
  const text = events.filter((e) => e.t === 'delta').map((e) => (e as { text: string }).text).join('');
  const reasoning = events.filter((e) => e.t === 'reasoning').map((e) => (e as { text: string }).text).join('');
  return { events, text, reasoning, error, firstTokenMs, totalMs: Date.now() - started };
}

describe.skipIf(!KEY)('Venice live', () => {
  let models: ModelInfo[] = [];
  let authOk = false;
  // After a rejected key, stop: repeated 401s only burn the failed-auth rate limit.
  const needAuth = (ctx: { skip(note?: string): void }) => {
    if (!authOk) ctx.skip('key was rejected');
  };

  afterAll(() => {
    section('Response headers seen (last value of each)', Object.keys(seenHeaders).sort().map((k) => `- \`${k}\`: \`${seenHeaders[k]}\``));
    const out = report.join('\n');
    expect(out.includes(KEY!), 'the key must never reach the report').toBe(false);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/venice-live-report.md', out, 'utf8');
  });

  it('validates the real key and rejects a wrong one', async () => {
    const good = await adapter.validateKey(rt(KEY));
    const bad = await adapter.validateKey(rt('VENICE_INFERENCE_KEY_this-key-is-deliberately-wrong-000000'));
    const none = await adapter.validateKey(rt(undefined));

    // Shape only: field names of the rate_limits body, no balances.
    const res = await fetch(joinUrl(config.baseUrl, '/api_keys/rate_limits'), { headers: buildAuthHeaders(config, KEY) });
    const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const firstLimit = Array.isArray(body?.data?.rateLimits) ? (body!.data!.rateLimits as unknown[])[0] : undefined;

    authOk = good.ok;
    // Shape of the key as received, without revealing it: catches stray quotes, brackets or spaces.
    section('Key as read from VENICE_API_KEY', [
      `- Length ${KEY!.length}; starts with VENICE_INFERENCE_KEY_: ${KEY!.startsWith('VENICE_INFERENCE_KEY_')}; starts with VENICE_ADMIN_KEY_: ${KEY!.startsWith('VENICE_ADMIN_KEY_')}`,
      `- Contains characters other than letters, digits, _ and -: ${/[^A-Za-z0-9_-]/.test(KEY!)}`,
    ]);
    section('Key validation (GET /api_keys/rate_limits)', [
      `- Real key: ok=${good.ok}${good.error ? `, error ${j({ code: good.error.code, status: good.error.status, message: good.error.message })}` : ''}`,
      `- Wrong key: ok=${bad.ok}, ${j({ code: bad.error?.code, status: bad.error?.status, message: bad.error?.message, hasRequestId: !!bad.error?.requestId })}`,
      `- No key: ok=${none.ok}, ${j({ code: none.error?.code, status: none.error?.status, message: none.error?.message })}`,
      `- Body field names: ${j(Object.keys(body?.data ?? {}))}`,
      `- One rateLimits entry (shape): ${j(firstLimit)}`,
    ]);
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('auth');
    expect(none.ok).toBe(false);
  });

  it('lists and maps the text models', async () => {
    models = await adapter.listModels(rt(KEY));
    const m = models.find((x) => x.id === MODEL);
    const count = (f: (x: ModelInfo) => unknown) => models.filter(f).length;
    section('Model list', [
      `- ${models.length} text models; ${count((x) => x.capabilities.reasoning)} reasoning, ${count((x) => x.capabilities.vision)} vision, ${count((x) => x.capabilities.webSearch)} web search, ${count((x) => x.details?.offline)} offline`,
      `- ${count((x) => x.contextTokens)} report a context size, ${count((x) => x.pricing)} report pricing, ${count((x) => x.defaults)} report sampling defaults`,
      `- \`${MODEL}\` ${m ? 'is in the list' : 'is NOT in the list'}${m ? `: ${j({ name: m.displayName, context: m.contextTokens, maxOut: m.maxOutputTokens, capabilities: m.capabilities, pricing: m.pricing, defaults: m.defaults })}` : ''}`,
      `- Controls offered for it: ${j(adapter.extensions(m ?? { id: MODEL, providerId: config.id, displayName: MODEL, capabilities: {} }).map((f) => f.key))}`,
    ]);
    expect(models.length).toBeGreaterThan(0);
  });

  it('streams a reply with venice_parameters, usage and a request id', async (ctx) => {
    needAuth(ctx);
    const model = models.find((x) => x.id === MODEL);
    const r = await chat(MODEL, model, 'Reply with exactly one word: pong');
    const meta = r.events.find((e) => e.t === 'meta') as Extract<ChatEvent, { t: 'meta' }> | undefined;
    const usage = r.events.find((e) => e.t === 'usage');
    section('Streaming chat', [
      `- Error: ${r.error ? j(r.error) : 'none'}`,
      `- Text: ${j(r.text.slice(0, 200))}`,
      `- Reasoning received: ${r.reasoning.length} characters`,
      `- Event types in order (collapsed): ${j([...new Set(r.events.map((e) => e.t))])}`,
      `- Finish: ${j(r.events.find((e) => e.t === 'done'))}`,
      `- Usage event (stream_options.include_usage): ${usage ? j(usage) : 'NOT RECEIVED'}`,
      `- Request id: ${meta?.requestId ? 'present' : 'MISSING'}; parsed rate limit: ${j(meta?.rateLimit)}; balance keys: ${j(Object.keys(meta?.balance ?? {}))}; notice: ${j(meta?.notice)}`,
      `- First token after ${r.firstTokenMs} ms, finished after ${r.totalMs} ms`,
    ]);
    expect(r.error).toBeUndefined();
    expect(r.text.length + r.reasoning.length).toBeGreaterThan(0);
  });

  it('shows which fields carry streamed content and reasoning (raw stream)', async (ctx) => {
    needAuth(ctx);
    // Prefer the chosen model if it reasons; otherwise the cheapest reasoning model.
    const chosen = models.find((x) => x.id === MODEL);
    const reasoner = chosen?.capabilities.reasoning
      ? chosen
      : models.filter((x) => x.capabilities.reasoning && !x.details?.offline).sort((a, b) => (a.pricing?.outputPerM ?? 1e9) - (b.pricing?.outputPerM ?? 1e9))[0];
    const id = reasoner?.id ?? MODEL;
    const res = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...buildAuthHeaders(config, KEY) },
      body: JSON.stringify({
        model: id,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 400,
        messages: [{ role: 'user', content: 'What is 17 * 23? Think briefly, then give only the number.' }],
      }),
    });
    const text = await res.text();
    const parser = new SseParser();
    const payloads = [...parser.feed(text), ...parser.end()];
    const deltaKeys = new Set<string>();
    const chunkKeys = new Set<string>();
    let inlineThink = false;
    let usageChunk: unknown;
    let sawDone = false;
    for (const p of payloads) {
      if (p.trim() === '[DONE]') {
        sawDone = true;
        continue;
      }
      try {
        const c = JSON.parse(p) as Record<string, any>;
        Object.keys(c).forEach((k) => chunkKeys.add(k));
        const d = c.choices?.[0]?.delta;
        if (d) for (const [k, v] of Object.entries(d)) if (v !== null && v !== '') deltaKeys.add(k);
        if (typeof d?.content === 'string' && d.content.includes('<think>')) inlineThink = true;
        if (c.usage) usageChunk = { keys: Object.keys(c.usage), choicesLength: c.choices?.length };
      } catch {
        /* ignore */
      }
    }
    section('Raw stream shape', [
      `- Model used: \`${id}\`, HTTP ${res.status}, ${payloads.length} SSE events, [DONE] sentinel: ${sawDone}`,
      `- Top-level chunk fields: ${j([...chunkKeys])}`,
      `- Non-empty delta fields: ${j([...deltaKeys])}`,
      `- Inline <think> tags in content: ${inlineThink}`,
      `- Usage chunk: ${j(usageChunk)}`,
      ...(res.ok ? [] : [`- Error body: ${j(text.slice(0, 400))}`]),
    ]);
    expect(res.ok).toBe(true);
  });

  it('cancels a stream promptly', async (ctx) => {
    needAuth(ctx);
    // Abort shortly after the first token, so a fast model cannot finish first.
    const ctl = new AbortController();
    let t0 = 0;
    const events: ChatEvent[] = [];
    let outcome = 'finished before cancel';
    try {
      for await (const ev of adapter.streamChat(
        rt(KEY),
        { modelId: MODEL, model: models.find((x) => x.id === MODEL), messages: [{ role: 'user', content: 'Write the numbers from 1 to 3000, one per line, no commentary.' }], params: { maxTokens: 4000 }, extensions: { disable_thinking: true }, conversationId: 'nodal-live-smoke' },
        ctl.signal,
      )) {
        events.push(ev);
        if (ev.t === 'delta' && !t0 && events.filter((e) => e.t === 'delta').length >= 5) {
          t0 = Date.now();
          ctl.abort();
        }
      }
    } catch (e) {
      if (!(e instanceof NodalError)) throw e;
      outcome = e.normalized.code;
    }
    const r = { error: outcome === 'finished before cancel' ? undefined : { code: outcome }, text: events.filter((e) => e.t === 'delta').map((e) => (e as { text: string }).text).join('') };
    t0 ||= Date.now();
    section('Cancel', [`- Outcome: ${j(r.error?.code ?? 'finished before cancel')}; returned ${Date.now() - t0} ms after abort; ${r.text.length} characters kept`]);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(outcome).toBe('cancelled');
  });

  it('reports a wrong model id clearly', async (ctx) => {
    needAuth(ctx);
    const r = await chat('nodal-smoke-no-such-model', undefined, 'hi');
    section('Unknown model', [`- ${j(r.error)}`]);
    expect(r.error).toBeDefined();
  });
});
