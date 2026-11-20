import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatEventBatch, ProviderConfig } from '@shared/types';
import { MAX_STREAMS, StreamManager } from '../../src/main/chat/streams';
import { textOf } from '../../src/main/db/store';
import { createLogger } from '../../src/main/log';
import { MOCK_KEY, startMockServer, type MockServer } from '../mock/server';
import { cleanupTmp, FAST, http, makeEnv } from './helpers';

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockServer();
});
afterAll(async () => {
  await mock.close();
  cleanupTmp();
});
beforeEach(() => mock.reset());

function setup(modelId: string, over: Partial<ProviderConfig> = {}, timeouts = FAST) {
  const env = makeEnv(mock.url, over);
  const batches: ChatEventBatch[] = [];
  const log = createLogger(join(env.dir, 'logs'));
  const streams = new StreamManager({
    ...env,
    http,
    log,
    emit: (b) => batches.push(b),
    timeouts: () => timeouts,
    flushMs: 5,
    saveMs: 20,
    backoffBaseMs: 10,
  });
  const conv = env.store.createConversation({ providerId: env.provider.id, modelId });
  const events = (): ChatEvent[] => batches.flatMap((b) => b.events);
  const send = async (text = 'hello') => {
    const res = streams.start({ mode: 'send', conversationId: conv.id, text });
    await streams.settled(res.streamId);
    return res;
  };
  const row = (id: string) => env.store.getMessage(id)!;
  return { ...env, streams, conv, batches, events, send, row, log };
}

describe('a normal reply', () => {
  it('creates the rows, streams in batches, and finalizes with usage and request id', async () => {
    const t = setup('mock-echo');
    const res = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'What is up?' });
    // Rows exist the moment the request starts.
    expect(res.userMessage).toMatchObject({ role: 'user', parentId: null });
    expect(t.row(res.assistantMessage.id)).toMatchObject({ role: 'assistant', parentId: res.userMessage!.id, finishReason: null, modelId: 'mock-echo' });
    expect(res.conversation).toMatchObject({ activeLeafId: res.assistantMessage.id, title: 'What is up?' });
    await t.streams.settled(res.streamId);

    const a = t.row(res.assistantMessage.id);
    expect(textOf(a.content)).toBe('You said: What is up?');
    expect(a).toMatchObject({ finishReason: 'stop', usage: { promptTokens: 11 }, error: null });
    expect(a.requestId).toMatch(/^mock-req-/);
    expect(t.events().at(-1)).toEqual({ t: 'done', finishReason: 'stop' });
    expect(t.events().filter((e) => e.t === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('You said: What is up?');
    expect(t.batches.every((b) => b.streamId === res.streamId && b.messageId === a.id)).toBe(true);
    expect(t.streams.activeCount).toBe(0);
    expect(t.store.listConversations({ search: 'said' }).map((c) => c.id)).toEqual([t.conv.id]);
  });

  it('adds the voice instructions to the system prompt for a spoken message, and only for that one', async () => {
    const t = setup('mock-echo');
    t.store.setSettings({ voiceInstructions: 'Talk like a pirate.' });
    const said = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'ahoy', spoken: true });
    await t.streams.settled(said.streamId);
    expect(mock.requests.at(-1)!.body.messages[0]).toEqual({ role: 'system', content: 'Talk like a pirate.' });
    // The spoken words are stored as an ordinary message.
    expect(t.row(said.userMessage!.id).content).toEqual([{ type: 'text', text: 'ahoy' }]);

    t.store.updateConversation(t.conv.id, { systemPrompt: 'Answer in French.' });
    const again = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'encore', spoken: true });
    await t.streams.settled(again.streamId);
    expect(mock.requests.at(-1)!.body.messages[0]).toEqual({ role: 'system', content: 'Answer in French.\n\nTalk like a pirate.' });

    await t.send('typed');
    expect(mock.requests.at(-1)!.body.messages[0]).toEqual({ role: 'system', content: 'Answer in French.' });

    // Emptied, nothing is added.
    t.store.setSettings({ voiceInstructions: '  ' });
    const plain = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'quiet', spoken: true });
    await t.streams.settled(plain.streamId);
    expect(mock.requests.at(-1)!.body.messages[0]).toEqual({ role: 'system', content: 'Answer in French.' });
  });

  it('builds the request from the active path with the system prompt first', async () => {
    const t = setup('mock-echo');
    t.store.updateConversation(t.conv.id, { systemPrompt: 'Answer in French.', params: { temperature: 0.1 } });
    await t.send('one');
    await t.send('two');
    const body = mock.requests.at(-1)!.body;
    expect(body.messages).toEqual([
      { role: 'system', content: 'Answer in French.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'You said: one' },
      { role: 'user', content: 'two' },
    ]);
    expect(body.temperature).toBe(0.1);
  });

  it('sends Venice parameters for a Venice provider and nothing provider-specific otherwise', async () => {
    const v = setup('mock-echo', { preset: 'venice' });
    v.store.updateConversation(v.conv.id, { extensions: { enable_web_search: 'on' } });
    await v.send();
    const body = mock.requests.at(-1)!.body;
    expect(body.venice_parameters.enable_web_search).toBe('on');
    expect(body.prompt_cache_key).toBe(v.conv.id);
    expect(v.events().find((e) => e.t === 'meta')).toMatchObject({ balance: { USD: '12.50' } });
  });

  it('surfaces a model deprecation header as a notice', async () => {
    const t = setup('mock-deprecated', { preset: 'venice' });
    await t.send();
    expect(t.events().find((e) => e.t === 'meta')).toMatchObject({ notice: { kind: 'deprecation', date: '2027-01-31' } });
  });
});

describe('retry rules (before the first token only)', () => {
  it('retries a 429 after the reset time, then succeeds', async () => {
    const t = setup('mock-429-once');
    const res = await t.send();
    expect(mock.hits['mock-429-once']).toBe(2);
    expect(t.events().filter((e) => e.t === 'retry')).toHaveLength(1);
    expect(t.events().find((e) => e.t === 'retry')).toMatchObject({ attempt: 1, error: { code: 'rate_limit', status: 429 } });
    expect(t.row(res.assistantMessage.id)).toMatchObject({ finishReason: 'stop', error: null });
  });

  it('gives up on a 429 after 3 retries and reports the reset time', async () => {
    const t = setup('mock-429-always');
    const res = await t.send();
    expect(mock.hits['mock-429-always']).toBe(4);
    const a = t.row(res.assistantMessage.id);
    expect(a.finishReason).toBe('error');
    expect(a.error).toMatchObject({ code: 'rate_limit', status: 429 });
    expect(a.error?.resetAt).toBeGreaterThan(0);
    expect(t.events().slice(-2).map((e) => e.t)).toEqual(['error', 'done']);
  });

  it('retries a 5xx up to 2 times', async () => {
    const once = setup('mock-500-once');
    expect(once.row((await once.send()).assistantMessage.id).finishReason).toBe('stop');
    const t = setup('mock-500-always');
    const res = await t.send();
    expect(mock.hits['mock-500-always']).toBe(3);
    expect(t.row(res.assistantMessage.id).error).toMatchObject({ code: 'server', status: 500, message: 'Inference backend crashed.' });
  });

  it.each([
    ['mock-401', 'auth'],
    ['mock-402', 'quota'],
    ['mock-403', 'forbidden'],
    ['mock-404-html', 'model_not_found'],
    ['mock-400-context', 'context_length'],
  ])('never retries %s', async (model, code) => {
    const t = setup(model);
    const res = await t.send();
    expect(mock.hits[model]).toBe(1);
    const a = t.row(res.assistantMessage.id);
    expect(a.finishReason).toBe('error');
    expect(a.error?.code).toBe(code);
    expect(a.error?.requestId).toMatch(/^mock-req-/);
    expect(a.requestId).toMatch(/^mock-req-/);
  });

  it('retries a network failure once', async () => {
    const t = setup('mock-echo');
    t.store.saveProvider({ ...t.provider, baseUrl: 'http://127.0.0.1:9/v1' });
    const res = await t.send();
    expect(t.events().filter((e) => e.t === 'retry')).toHaveLength(1);
    expect(t.row(res.assistantMessage.id).error?.code).toBe('network');
  });

  it('never retries once content has arrived: the partial reply is kept and marked incomplete', async () => {
    const t = setup('mock-disconnect');
    const res = await t.send('please go on for a while');
    expect(mock.hits['mock-disconnect']).toBe(1);
    const a = t.row(res.assistantMessage.id);
    expect(a.finishReason).toBe('incomplete');
    expect(a.error?.code).toBe('network');
    expect(textOf(a.content).length).toBeGreaterThan(0);
    expect(t.events().some((e) => e.t === 'retry')).toBe(false);
  });

  it('a stalled stream times out, names the timer and keeps the partial text', async () => {
    const t = setup('mock-stall', {}, { ...FAST, idleMs: 120 });
    const res = await t.send();
    const a = t.row(res.assistantMessage.id);
    expect(a.finishReason).toBe('incomplete');
    expect(a.error).toMatchObject({ code: 'timeout' });
    expect(a.error?.message).toMatch(/idle timer/);
    expect(textOf(a.content)).not.toBe('');
  });

  it('reports a missing key as an auth error without calling the provider', async () => {
    const t = setup('mock-echo');
    t.keys.clear(t.provider.id);
    const res = await t.send();
    expect(t.row(res.assistantMessage.id).error).toMatchObject({ code: 'auth' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('stop, continue and recovery', () => {
  it('Stop ends the stream within a second, keeps the partial text and finishes as cancelled', async () => {
    const t = setup('mock-long');
    const res = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'go' });
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    t.streams.cancel(res.streamId);
    await t.streams.settled(res.streamId);
    expect(Date.now() - started).toBeLessThan(1000);
    const a = t.row(res.assistantMessage.id);
    expect(a.finishReason).toBe('cancelled');
    expect(a.error).toBeNull();
    expect(textOf(a.content)).toContain('word0');
    expect(textOf(a.content)).not.toContain('word399');
    expect(t.events().at(-1)).toEqual({ t: 'done', finishReason: 'cancelled' });
    expect(t.events().some((e) => e.t === 'error')).toBe(false);
  });

  it('saves partial text while streaming, so a crash loses at most about a second', async () => {
    const t = setup('mock-long');
    const res = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'go' });
    await new Promise((r) => setTimeout(r, 200));
    const mid = t.row(res.assistantMessage.id);
    expect(mid.finishReason).toBeNull();
    expect(textOf(mid.content)).toContain('word0');
    t.streams.cancel(res.streamId);
    await t.streams.settled();
  });

  it('closing the app mid-stream leaves the row interrupted with its text', async () => {
    const t = setup('mock-long');
    const res = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'go' });
    await new Promise((r) => setTimeout(r, 150));
    t.streams.abortAll();
    await t.streams.settled();
    const a = t.row(res.assistantMessage.id);
    expect(a.finishReason).toBe('interrupted');
    expect(textOf(a.content)).toContain('word0');
  });

  it('Continue appends to the same message instead of creating a new one', async () => {
    const t = setup('mock-disconnect');
    const res = await t.send('tell me a story');
    const partial = textOf(t.row(res.assistantMessage.id).content);
    t.store.updateConversation(t.conv.id, { modelId: 'mock-echo' });
    const cont = t.streams.start({ mode: 'continue', conversationId: t.conv.id, messageId: res.assistantMessage.id });
    expect(cont.assistantMessage.id).toBe(res.assistantMessage.id);
    expect(cont.userMessage).toBeUndefined();
    await t.streams.settled(cont.streamId);
    const a = t.row(res.assistantMessage.id);
    expect(a).toMatchObject({ finishReason: 'stop', error: null, modelId: 'mock-echo' });
    expect(textOf(a.content).startsWith(partial)).toBe(true);
    expect(textOf(a.content).length).toBeGreaterThan(partial.length);
    const sent = mock.requests.at(-1)!.body.messages;
    expect(sent.at(-2)).toEqual({ role: 'assistant', content: partial });
    expect(sent.at(-1).content).toMatch(/Continue your previous reply/);
    expect(t.store.listMessages(t.conv.id)).toHaveLength(2);
  });
});

describe('branches', () => {
  it('edit-and-resend creates a sibling and moves the leaf; the old branch stays', async () => {
    const t = setup('mock-echo');
    const first = await t.send('original');
    const edit = t.streams.start({ mode: 'edit', conversationId: t.conv.id, messageId: first.userMessage!.id, text: 'edited' });
    await t.streams.settled(edit.streamId);
    expect(edit.userMessage!.parentId).toBe(first.userMessage!.parentId);
    expect(edit.userMessage!.id).not.toBe(first.userMessage!.id);
    const conv = t.store.getConversation(t.conv.id)!;
    expect(t.store.pathTo(conv.activeLeafId).map((m) => textOf(m.content))).toEqual(['edited', 'You said: edited']);
    expect(t.store.pathTo(first.assistantMessage.id).map((m) => textOf(m.content))).toEqual(['original', 'You said: original']);
    expect(mock.requests.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'edited' }]);
  });

  it('regenerate adds a sibling reply under the same user message', async () => {
    const t = setup('mock-echo');
    const first = await t.send('q');
    const regen = t.streams.start({ mode: 'regenerate', conversationId: t.conv.id, messageId: first.assistantMessage.id });
    await t.streams.settled(regen.streamId);
    expect(regen.assistantMessage.parentId).toBe(first.userMessage!.id);
    expect(regen.assistantMessage.id).not.toBe(first.assistantMessage.id);
    expect(t.store.listMessages(t.conv.id).filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(mock.requests.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('records the model that produced each reply when the model changes mid-conversation', async () => {
    const t = setup('mock-echo');
    const a = await t.send('one');
    t.store.updateConversation(t.conv.id, { modelId: 'mock-think' });
    const b = await t.send('two');
    expect(t.row(a.assistantMessage.id).modelId).toBe('mock-echo');
    expect(t.row(b.assistantMessage.id)).toMatchObject({ modelId: 'mock-think', reasoningText: 'Let me think.' });
  });
});

describe('limits and secrets', () => {
  it('allows one stream per conversation and four across the app', async () => {
    const t = setup('mock-long');
    const first = t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'a' });
    expect(() => t.streams.start({ mode: 'send', conversationId: t.conv.id, text: 'b' })).toThrow(/already generating/);
    for (let i = 1; i < MAX_STREAMS; i++) {
      const c = t.store.createConversation({ providerId: t.provider.id, modelId: 'mock-long' });
      t.streams.start({ mode: 'send', conversationId: c.id, text: 'x' });
    }
    const extra = t.store.createConversation({ providerId: t.provider.id, modelId: 'mock-long' });
    expect(() => t.streams.start({ mode: 'send', conversationId: extra.id, text: 'x' })).toThrow(/at most 4/);
    expect(t.store.listMessages(extra.id)).toHaveLength(0); // the rejected start left nothing behind
    t.streams.cancel(first.streamId);
    t.streams.abortAll();
    await t.streams.settled();
  });

  it('never lets the key reach events, the database, or the log', async () => {
    const t = setup('mock-401');
    await t.send('hi');
    const ok = setup('mock-echo');
    await ok.send('hi');
    for (const env of [t, ok]) {
      expect(JSON.stringify(env.batches)).not.toContain(MOCK_KEY);
      for (const f of readdirSync(join(env.dir, 'logs'))) expect(readFileSync(join(env.dir, 'logs', f), 'utf8')).not.toContain(MOCK_KEY);
      env.store.db.pragma('wal_checkpoint(TRUNCATE)');
      expect(readFileSync(join(env.dir, 'nodal.db')).includes(MOCK_KEY)).toBe(false);
      expect(readFileSync(join(env.dir, 'keys.json'), 'utf8')).not.toContain(MOCK_KEY);
    }
    const log = readFileSync(join(t.dir, 'logs', 'nodal.log'), 'utf8');
    expect(log).toContain('chat request failed');
    expect(log).not.toContain('hi"'); // no message bodies
  });
});
