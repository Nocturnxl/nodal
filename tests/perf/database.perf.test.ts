// Database timings, run on demand with `npm run perf:db`. Not part of `npm test`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/main/db';
import { Store } from '../../src/main/db/store';
import { cleanupTmp, mockProvider, tmpDir } from '../unit/helpers';

it('database operations over 10,000 messages', () => {
  const store = new Store(openDatabase(tmpDir()));
  const p = store.saveProvider(mockProvider('http://127.0.0.1:1/v1'));
  const words = ['quince', 'harbor', 'lattice', 'ember', 'copper', 'meadow', 'signal', 'orbit', 'thimble', 'granite', 'willow', 'cipher'];
  const blank = { providerId: null, modelId: null, reasoningText: null, finishReason: 'stop', usage: null, requestId: null, error: null };
  const ids: string[] = [];
  const t0 = performance.now();
  store.db.transaction(() => {
    for (let c = 0; c < 100; c++) {
      const conv = store.createConversation({ providerId: p.id, modelId: 'm', title: `Chat ${c}` });
      ids.push(conv.id);
      let parent: string | null = null;
      for (let i = 0; i < 100; i++) {
        const text = Array.from({ length: 80 }, (_, k) => words[(c * 7 + i * 3 + k) % words.length]).join(' ') + ` uniq${c}x${i}` + (c % 10 === 0 ? ' tenth' : '');
        const m = store.insertMessage({ ...blank, id: `${c}-${i}`, conversationId: conv.id, parentId: parent, role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }] });
        parent = m.id;
      }
      store.updateConversation(conv.id, { activeLeafId: parent });
    }
  })();
  const insertMs = performance.now() - t0;

  // One long thread, to time the walk from leaf to root.
  const long = store.createConversation({ providerId: p.id, modelId: 'm', title: 'Long' });
  store.db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      store.insertMessage({ ...blank, id: `long-${i}`, conversationId: long.id, parentId: i ? `long-${i - 1}` : null, role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${i}` }] });
    }
  })();

  const time = (fn: () => unknown, n = 25) => {
    const a: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      fn();
      a.push(performance.now() - s);
    }
    a.sort((x, y) => x - y);
    return { medianMs: +a[n >> 1].toFixed(2), maxMs: +a[n - 1].toFixed(2) };
  };
  const found = (q: string) => store.listConversations({ search: q }).length;
  const out = {
    messages: 10000,
    conversations: 100,
    insertAllMs: +insertMs.toFixed(0),
    searchEveryMessageMatches: { ...time(() => store.listConversations({ search: 'quince harbor' })), conversationsFound: found('quince harbor') },
    searchTenthOfMessagesMatch: { ...time(() => store.listConversations({ search: 'tenth' })), conversationsFound: found('tenth') },
    searchSingleMessageMatches: { ...time(() => store.listConversations({ search: 'uniq42x17' })), conversationsFound: found('uniq42x17') },
    listConversations: time(() => store.listConversations()),
    loadConversation100Messages: time(() => store.listMessages(ids[42])),
    pathTo100Deep: time(() => store.pathTo('5-99')),
    pathTo5000Deep: time(() => store.pathTo('long-4999')),
    loadConversation5000Messages: time(() => store.listMessages(long.id)),
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(process.env.PERF_OUT ?? 'test-results/db-perf.json', JSON.stringify(out, null, 2));
  expect(out.searchEveryMessageMatches.conversationsFound).toBe(100);
  expect(store.pathTo('long-4999')).toHaveLength(5000);
  store.db.close();
  cleanupTmp();
});
