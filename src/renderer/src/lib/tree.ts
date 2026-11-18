import type { ContentPart, Message } from '@shared/types';

/** Root-to-leaf path through the message tree: the visible thread. */
export function pathTo(messages: Message[], leafId: string | null): Message[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let id = leafId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const m = byId.get(id);
    if (!m) break;
    path.push(m);
    id = m.parentId;
  }
  return path.reverse();
}

/** parent id -> child ids, oldest first. Built once per message list, so lookups stay O(1) in long chats. */
export function childIndex(messages: Message[]): Map<string | null, Message[]> {
  const map = new Map<string | null, Message[]>();
  for (const m of messages) {
    const list = map.get(m.parentId);
    if (list) list.push(m);
    else map.set(m.parentId, [m]);
  }
  for (const list of map.values()) if (list.length > 1) list.sort((a, b) => a.createdAt - b.createdAt);
  return map;
}

/** Messages sharing a parent, oldest first: the branches at one point in the thread. */
export function siblingsOf(messages: Message[], m: Message): Message[] {
  return childIndex(messages).get(m.parentId) ?? [m];
}

/** Follow the newest child at each level down to a leaf. */
export function deepestLeaf(messages: Message[], id: string): string {
  const index = childIndex(messages);
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    const kids = index.get(cur);
    if (!kids?.length || seen.has(cur)) return cur;
    seen.add(cur);
    cur = kids[kids.length - 1].id;
  }
}

export function textOf(content: ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Splits Markdown into top-level blocks at blank lines, never inside a fenced
 * code block. A streaming reply re-renders only its last block, so a long
 * answer does not re-parse from the top on every frame.
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
    }
    if (!fence && line.trim() === '' && !m) {
      if (cur.length) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
