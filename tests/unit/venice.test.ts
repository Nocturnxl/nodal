import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fixture from '../fixtures/venice-models.json';
import type { ChatRequest } from '../../src/main/providers/adapter';
import { adapterFor } from '../../src/main/providers/registry';
import { mapVeniceModel, veniceExtension, veniceExtensions } from '../../src/main/providers/venice';
import { MOCK_KEY, startMockServer, type MockServer } from '../mock/server';
import { FAST, http, mockProvider } from './helpers';

// Replays a recorded GET /models?type=text response (public endpoint, nothing
// to scrub) through the mapping code.
const models = (fixture.data as Record<string, unknown>[]).map((m) => mapVeniceModel(m, 'p1')!);
const byId = (id: string) => models.find((m) => m.id === id)!;

describe('Venice model mapping', () => {
  it('maps every documented field', () => {
    const m = byId('gemini-4-carbon');
    expect(m).toMatchObject({
      providerId: 'p1',
      displayName: 'Gemini 4 Carbon',
      contextTokens: 1_000_000,
      maxOutputTokens: 65536,
      capabilities: { vision: true, reasoning: true, tools: true, structuredOutput: true, webSearch: true },
      pricing: { inputPerM: 2.5, outputPerM: 12.5, currency: 'USD' },
      details: { privacy: 'anonymized', offline: false },
    });
    expect(m.details?.description).toMatch(/Gemini 4 Carbon/);
    expect(m.raw).toBeDefined();
  });

  it('reads sampling defaults from constraints and reports false capabilities as false, not unknown', () => {
    expect(byId('qwen-3-7-plus').defaults).toEqual({ temperature: 0.7, topP: 0.8 });
    const plain = byId('qwen3-235b-a22b-instruct-2507');
    expect(plain.capabilities.vision).toBe(false);
    expect(plain.capabilities.reasoning).toBe(false);
  });

  it('skips non-text models and entries without an id', () => {
    expect(mapVeniceModel({ id: 'img', type: 'image', model_spec: {} }, 'p')).toBeNull();
    expect(mapVeniceModel({ model_spec: {} }, 'p')).toBeNull();
    expect(mapVeniceModel({ id: 'bare' }, 'p')).toMatchObject({ id: 'bare', displayName: 'bare', capabilities: {} });
  });
});

describe('venice_parameters', () => {
  const keys = (id: string) => veniceExtensions(byId(id)).map((f) => f.key);

  it('shows controls only where the model supports them', () => {
    expect(keys('gemini-4-carbon')).toEqual(
      expect.arrayContaining(['enable_web_search', 'enable_web_citations', 'enable_web_scraping', 'include_venice_system_prompt', 'strip_thinking_response', 'disable_thinking', 'character_slug']),
    );
    expect(keys('gemini-4-carbon')).not.toContain('enable_x_search');
    expect(keys('grok-4-3')).toContain('enable_x_search');
    const plain = keys('qwen3-235b-a22b-instruct-2507');
    expect(plain).not.toContain('strip_thinking_response');
    expect(plain).not.toContain('disable_thinking');
  });

  it('marks search controls with a cost note and unknown capabilities as unverified', () => {
    const f = veniceExtensions(byId('gemini-4-carbon'));
    expect(f.find((x) => x.key === 'enable_web_search')?.costNote).toBeTruthy();
    expect(f.find((x) => x.key === 'enable_web_scraping')?.costNote).toBeTruthy();
    const unknown = veniceExtensions({ id: 'x', providerId: 'p', displayName: 'x', capabilities: {} });
    expect(unknown.find((x) => x.key === 'enable_web_search')?.unverified).toBe(true);
  });

  const request = (extensions: ChatRequest['extensions']): ChatRequest => ({
    modelId: 'gemini-4-carbon',
    model: byId('gemini-4-carbon'),
    messages: [],
    params: {},
    extensions,
    conversationId: 'conv-1',
  });

  it('sends a venice_parameters object with documented fields and a top-level prompt_cache_key', () => {
    const body: Record<string, unknown> = { model: 'gemini-4-carbon' };
    veniceExtension.applyToRequest!(body, request({ enable_web_search: 'auto', enable_web_citations: true, character_slug: ' alan-watts ' }));
    expect(body.model).toBe('gemini-4-carbon'); // no model-name suffixes
    expect(body.prompt_cache_key).toBe('conv-1');
    expect(body.venice_parameters).toEqual({
      enable_web_search: 'auto',
      enable_web_citations: true,
      enable_web_scraping: false,
      include_venice_system_prompt: false,
      strip_thinking_response: false,
      disable_thinking: false,
      character_slug: 'alan-watts',
    });
  });

  it('leaves the Venice system prompt off unless the user turns it on', () => {
    const off: Record<string, unknown> = {};
    veniceExtension.applyToRequest!(off, request({}));
    expect((off.venice_parameters as Record<string, unknown>).include_venice_system_prompt).toBe(false);
    const on: Record<string, unknown> = {};
    veniceExtension.applyToRequest!(on, request({ include_venice_system_prompt: true }));
    expect((on.venice_parameters as Record<string, unknown>).include_venice_system_prompt).toBe(true);
  });

  it('omits citations while web search is off, and an empty character slug', () => {
    const body: Record<string, unknown> = {};
    veniceExtension.applyToRequest!(body, request({ enable_web_citations: true }));
    const p = body.venice_parameters as Record<string, unknown>;
    expect(p.enable_web_search).toBe('off');
    expect(p).not.toHaveProperty('enable_web_citations');
    expect(p).not.toHaveProperty('character_slug');
  });
});

describe('Venice response metadata', () => {
  it('turns headers into balance and deprecation notices', () => {
    const meta = veniceExtension.metaFromHeaders!(
      new Headers({
        'x-venice-balance-usd': '12.50',
        'x-venice-balance-diem': '3',
        'x-venice-model-deprecation-warning': 'Going away',
        'x-venice-model-deprecation-date': '2027-01-31',
      }),
      0,
    );
    expect(meta.balance).toEqual({ USD: '12.50', DIEM: '3' });
    expect(meta.notice).toEqual({ kind: 'deprecation', message: 'Going away', date: '2027-01-31' });
    expect(veniceExtension.metaFromHeaders!(new Headers(), 0)).toEqual({ balance: undefined, notice: undefined });
  });
});

describe('Venice key validation', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMockServer({ publicModels: true });
  });
  afterAll(() => mock.close());

  const check = (apiKey: string | undefined) => {
    const config = { id: 'v', ...mockProvider(mock.url, { preset: 'venice' }) };
    return adapterFor(config).validateKey({ config, apiKey, http, timeouts: FAST });
  };

  it('accepts a good key using the authenticated endpoint, not the public model list', async () => {
    mock.reset();
    expect((await check(MOCK_KEY)).ok).toBe(true);
    expect(mock.requests[0].path).toBe('/v1/api_keys/rate_limits');
  });

  it('rejects a bad key with 401 even though /models is public', async () => {
    const res = await check('wrong-key');
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: 'auth', status: 401, message: 'Authentication failed' });
    expect(res.error?.requestId).toMatch(/MOCK$/); // CF-RAY
  });

  it('treats the 402 payment challenge for unrecognised credentials as an auth failure', async () => {
    const res = await check(undefined);
    expect(res.error).toMatchObject({ code: 'auth', status: 402 });
  });
});
