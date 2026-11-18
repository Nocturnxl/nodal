import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../../src/main/attachments';
import { buildContext } from '../../src/main/chat/context';
import { MIGRATIONS, MigrationError, openDatabase } from '../../src/main/db';
import { ftsQuery, Store } from '../../src/main/db/store';
import { KeyStore } from '../../src/main/secrets/keystore';
import type { Message } from '@shared/types';
import { cleanupTmp, fakeSafeStorage, mockProvider, tmpDir } from './helpers';

afterAll(cleanupTmp);

const textOfFirstAndLast = (path: Message[]) => [path[0], path[path.length - 1]].map((m) => (m.content[0] as { text: string }).text);

function fresh() {
  const dir = tmpDir();
  const store = new Store(openDatabase(dir));
  const provider = store.saveProvider(mockProvider('http://127.0.0.1:1/v1'));
  return { dir, store, provider };
}

function msg(store: Store, conversationId: string, parentId: string | null, role: Message['role'], text: string, finishReason: string | null = 'stop'): Message {
  return store.insertMessage({
    id: `${role}-${Math.random().toString(36).slice(2)}`,
    conversationId,
    parentId,
    role,
    content: [{ type: 'text', text }],
    providerId: null,
    modelId: null,
    reasoningText: null,
    finishReason,
    usage: null,
    requestId: null,
    error: null,
  });
}

describe('migrations', () => {
  it('creates the schema in WAL mode with FTS5', () => {
    const { store } = fresh();
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['providers', 'models_cache', 'model_overrides', 'conversations', 'messages', 'attachments', 'settings', 'request_log', 'messages_fts']));
    store.db.close();
  });

  it('backs up before migrating, and restores the backup when a migration fails', () => {
    const { dir, store, provider } = fresh();
    store.createConversation({ providerId: provider.id, modelId: 'm', title: 'Keep me' });
    store.db.close();

    const broken = [...MIGRATIONS, { version: 99, name: '099_bad.sql', sql: 'CREATE TABLE ok_table (x); THIS IS NOT SQL;' }];
    expect(() => openDatabase(dir, broken)).toThrow(MigrationError);
    expect(readdirSync(join(dir, 'backups')).length).toBe(1);

    const db = openDatabase(dir); // reopens the restored, un-migrated database
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get()).toBeUndefined();
    expect(new Store(db).listConversations()[0].title).toBe('Keep me');
    db.close();
  });

  it('applies a later migration and keeps a backup', () => {
    const { dir, store } = fresh();
    store.db.close();
    const db = openDatabase(dir, [...MIGRATIONS, { version: 2, name: '002_x.sql', sql: 'ALTER TABLE settings ADD COLUMN note TEXT;' }]);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(readdirSync(join(dir, 'backups')).length).toBe(1);
    db.close();
  });
});

describe('providers and model cache', () => {
  it('round-trips a provider config and stores no key material', () => {
    const { store } = fresh();
    const p = store.saveProvider(
      mockProvider('https://api.venice.ai/api/v1', { preset: 'venice', displayName: 'Venice', modelListQuery: { type: 'text' }, extraHeaders: { 'X-A': 'b' } }),
    );
    expect(store.getProvider(p.id)).toEqual(p);
    expect(p).not.toHaveProperty('key');
    const cols = (store.db.prepare('PRAGMA table_info(providers)').all() as { name: string }[]).map((c) => c.name);
    expect(cols.some((c) => /key|secret|token/i.test(c))).toBe(false);
    store.db.close();
  });

  it('blocks deleting a provider that conversations still use, until they are reassigned', () => {
    const { store, provider } = fresh();
    const other = store.saveProvider(mockProvider('http://127.0.0.1:2/v1', { displayName: 'Other' }));
    store.createConversation({ providerId: provider.id, modelId: 'a' });
    expect(() => store.deleteProvider(provider.id)).toThrow(/still use this provider/);
    expect(store.reassignConversations(provider.id, other.id, 'b')).toBe(1);
    store.deleteProvider(provider.id);
    expect(store.listProviders().map((p) => p.id)).toEqual([other.id]);
    expect(store.listConversations()[0]).toMatchObject({ providerId: other.id, modelId: 'b' });
    store.db.close();
  });

  it('keeps hand-entered models across a refresh and applies capability overrides', () => {
    const { store, provider } = fresh();
    store.addManualModel(provider.id, 'my-custom');
    store.replaceModelCache(provider.id, [{ id: 'listed', providerId: provider.id, displayName: 'Listed', capabilities: { vision: false } }]);
    expect(store.listModels(provider.id).map((m) => m.id)).toEqual(['listed', 'my-custom']);
    expect(store.modelsFetchedAt(provider.id)).toBeGreaterThan(0);

    store.setModelOverride(provider.id, 'listed', { vision: true });
    const m = store.getModel(provider.id, 'listed')!;
    expect(m.capabilities.vision).toBe(true);
    expect(m.reportedCapabilities?.vision).toBe(false);
    store.setModelOverride(provider.id, 'listed', null);
    expect(store.getModel(provider.id, 'listed')!.capabilities.vision).toBe(false);
    store.db.close();
  });
});

describe('conversations and messages', () => {
  it('new conversations pick up the global defaults', () => {
    const { store, provider } = fresh();
    store.setSettings({ defaultSystemPrompt: 'Be brief.', defaultParams: { temperature: 0.2 }, defaultExtensions: { [provider.id]: { enable_web_search: 'auto' } } });
    const c = store.createConversation({ providerId: provider.id, modelId: 'm' });
    expect(c).toMatchObject({ title: 'New chat', systemPrompt: 'Be brief.', params: { temperature: 0.2 }, extensions: { enable_web_search: 'auto' } });
    store.db.close();
  });

  it('follows parent links from the active leaf, so branches do not overwrite history', () => {
    const { store, provider } = fresh();
    const c = store.createConversation({ providerId: provider.id, modelId: 'm' });
    const u1 = msg(store, c.id, null, 'user', 'first question');
    const a1 = msg(store, c.id, u1.id, 'assistant', 'first answer');
    const u2 = msg(store, c.id, a1.id, 'user', 'follow up');
    const u2b = msg(store, c.id, a1.id, 'user', 'edited follow up');
    expect(store.pathTo(u2.id).map((m) => m.id)).toEqual([u1.id, a1.id, u2.id]);
    expect(store.pathTo(u2b.id).map((m) => m.id)).toEqual([u1.id, a1.id, u2b.id]);
    expect(store.listMessages(c.id)).toHaveLength(4);
    expect(() => store.updateConversation(c.id, { activeLeafId: 'not-a-message' })).toThrow();
    store.db.close();
  });

  it('searches titles and message content, and survives odd query syntax', () => {
    const { store, provider } = fresh();
    const a = store.createConversation({ providerId: provider.id, modelId: 'm', title: 'Gardening plans' });
    const b = store.createConversation({ providerId: provider.id, modelId: 'm', title: 'Untitled' });
    msg(store, b.id, null, 'user', 'How do I prune a quince tree in winter?');
    expect(store.listConversations({ search: 'garden' }).map((c) => c.id)).toEqual([a.id]);
    const hit = store.listConversations({ search: 'quince prun' });
    expect(hit.map((c) => c.id)).toEqual([b.id]);
    expect(hit[0].snippet).toMatch(/quince/);
    expect(store.listConversations({ search: '"unbalanced AND (NEAR' })).toEqual([]);
    expect(ftsQuery('a "b" c')).toBe('"a"* """b"""* "c"*');

    store.deleteConversation(b.id);
    expect(store.listConversations({ search: 'quince' })).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
    store.db.close();
  });

  it('finds every matching conversation even when one chat has hundreds of hits', () => {
    const { store, provider } = fresh();
    const big = store.createConversation({ providerId: provider.id, modelId: 'm', title: 'Big' });
    store.db.transaction(() => {
      for (let i = 0; i < 700; i++) msg(store, big.id, null, 'user', `kumquat note ${i}`);
    })();
    const small = store.createConversation({ providerId: provider.id, modelId: 'm', title: 'Small' });
    msg(store, small.id, null, 'user', 'one kumquat here');
    expect(store.listConversations({ search: 'kumquat' }).map((c) => c.title).sort()).toEqual(['Big', 'Small']);
    store.db.close();
  });

  it('deleting a conversation reports the images nothing else uses, and startup cleanup removes strays', () => {
    const { dir, store, provider } = fresh();
    const files = new AttachmentStore(join(dir, 'attachments'));
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
    const shared = files.add('image/png', png(1));
    const own = files.add('image/png', png(2));
    const stray = files.add('image/png', png(3)); // attached in the composer, never sent
    const withImages = (convId: string, refs: { sha256: string }[]) =>
      store.insertMessage({
        id: `img-${Math.random().toString(36).slice(2)}`,
        conversationId: convId,
        parentId: null,
        role: 'user',
        content: [{ type: 'text', text: 'pic' }, ...refs.map((r) => ({ type: 'image' as const, sha256: r.sha256, mime: 'image/png' }))],
        providerId: null,
        modelId: null,
        reasoningText: null,
        finishReason: 'stop',
        usage: null,
        requestId: null,
        error: null,
      });
    const a = store.createConversation({ providerId: provider.id, modelId: 'm' });
    const b = store.createConversation({ providerId: provider.id, modelId: 'm' });
    withImages(a.id, [shared, own]);
    withImages(b.id, [shared]);

    const orphaned = store.deleteConversation(a.id);
    expect(orphaned).toEqual([own.sha256]); // the shared image is still used by the other chat
    for (const sha of orphaned) files.remove(sha);
    expect(files.read(own.sha256)).toBeUndefined();
    expect(files.read(shared.sha256)).toBeDefined();

    // Cleanup spares a fresh unsent attachment, and removes it once it is old.
    expect(files.gc(store.attachmentHashesInUse(), 24 * 3600 * 1000)).toBe(0);
    expect(files.read(stray.sha256)).toBeDefined();
    expect(files.gc(store.attachmentHashesInUse(), 24 * 3600 * 1000, Date.now() + 25 * 3600 * 1000)).toBe(1);
    expect(files.read(stray.sha256)).toBeUndefined();
    expect(files.read(shared.sha256)).toBeDefined();
    store.db.close();
  });

  it('walks a long thread in one query and survives a parent cycle', () => {
    const { store, provider } = fresh();
    const c = store.createConversation({ providerId: provider.id, modelId: 'm' });
    let parent: string | null = null;
    store.db.transaction(() => {
      for (let i = 0; i < 1500; i++) parent = msg(store, c.id, parent, i % 2 ? 'assistant' : 'user', `t${i}`).id;
    })();
    const path = store.pathTo(parent);
    expect(path).toHaveLength(1500);
    expect(textOfFirstAndLast(path)).toEqual(['t0', 't1499']);
    expect(store.pathTo(null)).toEqual([]);
    expect(store.pathTo('missing')).toEqual([]);
    // A corrupt import could make a message its own ancestor.
    store.db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run(parent, path[0].id);
    expect(store.pathTo(parent).length).toBeLessThanOrEqual(1500);
    store.db.close();
  });

  it('hides archived conversations unless asked, and sorts pinned first', () => {
    const { store, provider } = fresh();
    const a = store.createConversation({ providerId: provider.id, modelId: 'm', title: 'A' });
    const b = store.createConversation({ providerId: provider.id, modelId: 'm', title: 'B' });
    store.updateConversation(a.id, { archived: true });
    expect(store.listConversations().map((c) => c.title)).toEqual(['B']);
    store.updateConversation(a.id, { archived: false, pinned: true });
    expect(store.listConversations().map((c) => c.title)).toEqual(['A', 'B']);
    expect(b.pinned).toBe(false);
    store.db.close();
  });

  it('marks unfinished assistant rows interrupted on startup', () => {
    const { store, provider } = fresh();
    const c = store.createConversation({ providerId: provider.id, modelId: 'm' });
    const u = msg(store, c.id, null, 'user', 'hi');
    const a = msg(store, c.id, u.id, 'assistant', 'partial te', null);
    expect(store.markInterrupted()).toBe(1);
    expect(store.getMessage(a.id)).toMatchObject({ finishReason: 'interrupted', content: [{ type: 'text', text: 'partial te' }] });
    expect(store.markInterrupted()).toBe(0);
    store.db.close();
  });

  it('logs request metadata without any message content', () => {
    const { store, provider } = fresh();
    store.logRequest({ providerId: provider.id, modelId: 'm', status: 200, requestId: 'r1', promptTokens: 3, completionTokens: 4, latencyMs: 12 });
    const cols = (store.db.prepare('PRAGMA table_info(request_log)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'ts', 'provider_id', 'model_id', 'status', 'request_id', 'prompt_tokens', 'completion_tokens', 'latency_ms', 'error_code']);
    store.db.close();
  });
});

describe('context building', () => {
  const m = (role: Message['role'], text: string): Message => ({
    id: Math.random().toString(36),
    conversationId: 'c',
    parentId: null,
    role,
    content: [{ type: 'text', text }],
    providerId: null,
    modelId: null,
    reasoningText: null,
    finishReason: 'stop',
    usage: null,
    requestId: null,
    error: null,
    createdAt: 0,
  });
  const opts = { systemPrompt: 'sys', params: {}, imageDataUrl: () => 'data:image/png;base64,AAAA' };

  it('prepends the system prompt and sends the whole path when it fits', () => {
    const built = buildContext([m('user', 'a'), m('assistant', 'b'), m('user', 'c')], { ...opts, contextTokens: 100_000 });
    expect(built.messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(built.dropped).toBe(0);
  });

  it('trims from the oldest messages and never drops the newest', () => {
    const long = 'x'.repeat(4000); // ~1000 tokens each
    const path = [m('user', long), m('assistant', long), m('user', long), m('assistant', long), m('user', 'latest question')];
    const built = buildContext(path, { ...opts, contextTokens: 3000, params: { maxTokens: 500 } });
    expect(built.dropped).toBeGreaterThan(0);
    expect(built.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(built.messages.at(-1)).toEqual({ role: 'user', content: 'latest question' });
    expect(built.messages[1].role).toBe('user');
    const one = buildContext([m('user', long.repeat(10))], { ...opts, contextTokens: 100 });
    expect(one.messages).toHaveLength(2);
  });

  it('honours the user context limit and sends images as data URLs', () => {
    const long = 'x'.repeat(4000);
    const capped = buildContext([m('user', long), m('assistant', long), m('user', 'q')], { ...opts, contextTokens: 1_000_000, params: { contextLimit: 600 } });
    expect(capped.messages.map((x) => x.content)).toEqual(['sys', 'q']);
    const withImage: Message = { ...m('user', 'look'), content: [{ type: 'text', text: 'look' }, { type: 'image', sha256: 'a'.repeat(64), mime: 'image/png' }] };
    expect(buildContext([withImage], opts).messages[1].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});

describe('key store', () => {
  it('stores only ciphertext and reveals only presence and the last four characters', () => {
    const dir = tmpDir();
    const file = join(dir, 'keys.json');
    const keys = new KeyStore(file, fakeSafeStorage, 'win32');
    const secret = 'vn-inference-SECRETSECRET1234';
    keys.set('p1', secret);
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET');
    expect(keys.status('p1')).toEqual({ present: true, last4: '1234' });
    expect(keys.get('p1')).toBe(secret);
    expect(keys.status('nope')).toEqual({ present: false });
    keys.set('short', 'abc12345');
    expect(keys.status('short')).toEqual({ present: true, last4: undefined });
    keys.clear('p1');
    expect(keys.get('p1')).toBeUndefined();
    expect(existsSync(file + '.tmp')).toBe(false);
  });

  it('refuses to store keys on Linux when only the basic_text backend exists', () => {
    const keys = new KeyStore(join(tmpDir(), 'keys.json'), { ...fakeSafeStorage, getSelectedStorageBackend: () => 'basic_text' }, 'linux');
    expect(keys.storeStatus()).toMatchObject({ available: false, backend: 'basic_text' });
    expect(() => keys.set('p', 'k')).toThrow(/keyring/);
    const ok = new KeyStore(join(tmpDir(), 'keys.json'), fakeSafeStorage, 'linux');
    expect(ok.storeStatus().available).toBe(true);
  });
});
