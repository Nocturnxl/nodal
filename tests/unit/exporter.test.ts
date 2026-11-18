import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StreamManager } from '../../src/main/chat/streams';
import { exportAllZip, exportConversationJson, exportConversationMarkdown, importBytes } from '../../src/main/data/exporter';
import { nullLogger } from '../../src/main/log';
import { ModelService } from '../../src/main/models';
import { MOCK_KEY, MOCK_MODELS, startMockServer, type MockServer } from '../mock/server';
import { cleanupTmp, FAST, http, makeEnv } from './helpers';

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockServer();
});
afterAll(async () => {
  await mock.close();
  cleanupTmp();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function populated() {
  const env = makeEnv(mock.url);
  const streams = new StreamManager({ ...env, http, log: nullLogger, emit: () => {}, timeouts: () => FAST, flushMs: 1, saveMs: 20 });
  env.store.setSettings({ theme: 'dark', defaultSystemPrompt: 'Be kind.' });
  env.store.setModelOverride(env.provider.id, 'mock-echo', { vision: true });
  const conv = env.store.createConversation({ providerId: env.provider.id, modelId: 'mock-echo', title: 'Trip planning' });
  const img = env.attachments.add('image/png', PNG);
  const first = streams.start({ mode: 'send', conversationId: conv.id, text: 'Where to?', attachments: [img] });
  await streams.settled();
  const edit = streams.start({ mode: 'edit', conversationId: conv.id, messageId: first.userMessage!.id, text: 'Where to in spring?' });
  await streams.settled();
  env.store.updateConversation(conv.id, { pinned: true });
  return { ...env, conv, first, edit, img };
}

describe('export', () => {
  it('writes Markdown of the visible thread only', async () => {
    const t = await populated();
    const md = exportConversationMarkdown(t.store, t.conv.id);
    expect(md).toContain('# Trip planning');
    expect(md).toContain('## System\n\nBe kind.');
    expect(md).toContain('Where to in spring?');
    expect(md).toContain('## Assistant (mock-echo)');
    expect(md).not.toContain('Where to?\n'); // the abandoned branch is not in the visible thread
    expect(md).toContain('attached image');
  });

  it('never includes keys, in JSON or in the full ZIP', async () => {
    const t = await populated();
    const json = exportConversationJson(t.store, t.conv.id);
    expect(json).not.toContain(MOCK_KEY);
    expect(JSON.parse(json).messages).toHaveLength(4); // every branch
    const zip = exportAllZip(t.store, t.attachments);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([`attachments/${t.img.sha256}`, 'nodal-export.json']);
    expect(strFromU8(files['nodal-export.json'])).not.toContain(MOCK_KEY);
    expect(Buffer.from(zip).includes(MOCK_KEY)).toBe(false);
  });
});

describe('import', () => {
  it('reproduces every conversation, branch and setting in an empty profile, except keys', async () => {
    const src = await populated();
    const zip = exportAllZip(src.store, src.attachments);

    const dst = makeEnv('http://127.0.0.1:1/v1');
    dst.store.deleteProvider(dst.provider.id);
    dst.keys.clear(dst.provider.id);
    const result = importBytes(dst.store, dst.attachments, zip);
    expect(result).toMatchObject({ conversations: 1, messages: 4, providers: 1 });

    expect(dst.store.listProviders()).toEqual(src.store.listProviders());
    expect(dst.store.getConversation(src.conv.id)).toEqual(src.store.getConversation(src.conv.id));
    expect(dst.store.listMessages(src.conv.id)).toEqual(src.store.listMessages(src.conv.id));
    expect(dst.store.getSettings()).toEqual(src.store.getSettings());
    expect(dst.store.getModel(src.provider.id, 'mock-echo')).toBeUndefined(); // model cache is refetched, not exported
    expect(dst.store.listModelOverrides()).toEqual(src.store.listModelOverrides());
    expect(dst.attachments.read(src.img.sha256)?.equals(Buffer.from(PNG))).toBe(true);
    expect(dst.keys.status(src.provider.id)).toEqual({ present: false });
    expect(dst.store.listConversations({ search: 'spring' })).toHaveLength(1); // search index rebuilt

    // Importing again is a merge that skips what is already there.
    expect(importBytes(dst.store, dst.attachments, zip)).toMatchObject({ conversations: 0, messages: 0, providers: 0, skipped: 1 });
    expect(dst.store.listMessages(src.conv.id)).toHaveLength(4);
  });

  it('imports a single-conversation JSON export', async () => {
    const src = await populated();
    const dst = makeEnv('http://127.0.0.1:1/v1');
    const res = importBytes(dst.store, dst.attachments, new TextEncoder().encode(exportConversationJson(src.store, src.conv.id)));
    expect(res).toMatchObject({ conversations: 1, messages: 4, providers: 1 });
    expect(dst.store.pathTo(dst.store.getConversation(src.conv.id)!.activeLeafId).map((m) => m.id)).toEqual([src.edit.userMessage!.id, src.edit.assistantMessage.id]);
  });

  it('rejects files that are not NODAL exports and never lets a file allow LAN HTTP or a remote HTTP endpoint', () => {
    const dst = makeEnv('http://127.0.0.1:1/v1');
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(() => importBytes(dst.store, dst.attachments, enc({ hello: 'world' }))).toThrow(/not a NODAL export/);
    expect(() => importBytes(dst.store, dst.attachments, new TextEncoder().encode('not json'))).toThrow(/not a NODAL export/);
    const provider = (id: string, baseUrl: string) => ({ id, kind: 'openai-compatible', displayName: id, baseUrl, auth: { scheme: 'bearer' }, modelListPath: '/models', allowInsecureHttp: true });
    const res = importBytes(dst.store, dst.attachments, enc({ format: 'nodal.export', version: 1, providers: [provider('lan', 'http://192.168.1.9:1234/v1'), provider('evil', 'http://example.com/v1')] }));
    expect(res).toMatchObject({ providers: 1, skipped: 1 });
    expect(dst.store.getProvider('lan')?.allowInsecureHttp).toBe(false);
    expect(dst.store.getProvider('evil')).toBeUndefined();
  });
});

describe('model service', () => {
  it('caches the list for 24 hours, refreshes on demand, and falls back to the cache with the error', async () => {
    const env = makeEnv(mock.url);
    let now = Date.now();
    const svc = new ModelService(env.store, env.keys, http, () => FAST, () => now);
    const first = await svc.list(env.provider.id);
    expect(first).toMatchObject({ fromCache: false });
    expect(first.models.map((m) => m.id)).toEqual(MOCK_MODELS);
    expect(first.models.every((m) => !('raw' in m))).toBe(true); // raw never crosses IPC

    mock.reset();
    expect((await svc.list(env.provider.id)).fromCache).toBe(true);
    expect(mock.requests).toHaveLength(0);
    expect((await svc.list(env.provider.id, true)).fromCache).toBe(false);
    now += 25 * 60 * 60 * 1000;
    mock.reset();
    await svc.list(env.provider.id);
    expect(mock.requests).toHaveLength(1);

    env.keys.set(env.provider.id, 'wrong-key');
    const failed = await svc.list(env.provider.id, true);
    expect(failed.error).toMatchObject({ code: 'auth', status: 401 });
    expect(failed.models).toHaveLength(MOCK_MODELS.length);
  });

  it('validates a candidate key without storing it', async () => {
    const env = makeEnv(mock.url);
    env.keys.clear(env.provider.id);
    const svc = new ModelService(env.store, env.keys, http, () => FAST);
    expect(await svc.validate(env.provider.id, 'bad')).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(await svc.validate(env.provider.id, MOCK_KEY)).toMatchObject({ ok: true, modelCount: MOCK_MODELS.length });
    expect(env.keys.status(env.provider.id).present).toBe(false);
  });

  it('refuses a provider URL that breaks the transport policy', async () => {
    const env = makeEnv('http://203.0.113.5/v1');
    const svc = new ModelService(env.store, env.keys, http, () => FAST);
    expect((await svc.list(env.provider.id, true)).error).toMatchObject({ code: 'blocked' });
  });
});
