import { randomUUID } from 'node:crypto';
import type {
  Capabilities,
  ContentPart,
  Conversation,
  ConversationListItem,
  Message,
  ModelInfo,
  NormalizedError,
  ProviderConfig,
  Settings,
  Usage,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { ConversationPatch } from '@shared/api';
import { relayError } from '../net/errors';
import type { Db } from './index';

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toProvider(r: Row): ProviderConfig {
  const query = json<Record<string, string>>(r.model_list_query_json, {});
  const headers = json<Record<string, string>>(r.extra_headers_json, {});
  return {
    id: r.id as string,
    kind: 'openai-compatible',
    preset: (r.preset as ProviderConfig['preset']) ?? undefined,
    displayName: r.display_name as string,
    baseUrl: r.base_url as string,
    auth: { scheme: r.auth_scheme as ProviderConfig['auth']['scheme'], headerName: (r.auth_header as string) ?? undefined },
    extraHeaders: Object.keys(headers).length ? headers : undefined,
    modelListPath: r.model_list_path as string,
    modelListQuery: Object.keys(query).length ? query : undefined,
    allowInsecureHttp: !!r.allow_insecure_http,
  };
}

function toConversation(r: Row): Conversation {
  return {
    id: r.id as string,
    title: r.title as string,
    providerId: r.provider_id as string,
    modelId: r.model_id as string,
    systemPrompt: (r.system_prompt as string) ?? null,
    params: json(r.params_json, {}),
    extensions: json(r.extensions_json, {}),
    activeLeafId: (r.active_leaf_id as string) ?? null,
    pinned: !!r.pinned,
    archived: !!r.archived,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toMessage(r: Row): Message {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    parentId: (r.parent_id as string) ?? null,
    role: r.role as Message['role'],
    content: json<ContentPart[]>(r.content_json, []),
    providerId: (r.provider_id as string) ?? null,
    modelId: (r.model_id as string) ?? null,
    reasoningText: (r.reasoning_text as string) ?? null,
    finishReason: (r.finish_reason as string) ?? null,
    usage: json<Usage | null>(r.usage_json, null),
    requestId: (r.request_id as string) ?? null,
    error: json<NormalizedError | null>(r.error_json, null),
    createdAt: r.created_at as number,
  };
}

export function textOf(content: ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Turn free text into a safe FTS5 query: every term quoted, prefix-matched, ANDed. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' ');
}

export interface MessageUpdate {
  content?: ContentPart[];
  reasoningText?: string | null;
  finishReason?: string | null;
  usage?: Usage | null;
  requestId?: string | null;
  error?: NormalizedError | null;
  providerId?: string | null;
  modelId?: string | null;
}

export interface RequestLogEntry {
  providerId: string;
  modelId: string;
  status?: number;
  requestId?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  errorCode?: string;
}

/** All SQL lives here. Repositories are grouped by table. */
export class Store {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- providers ----------

  listProviders(): ProviderConfig[] {
    return (this.db.prepare('SELECT * FROM providers ORDER BY created_at, rowid').all() as Row[]).map(toProvider);
  }

  getProvider(id: string): ProviderConfig | undefined {
    const r = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
    return r ? toProvider(r) : undefined;
  }

  saveProvider(input: Omit<ProviderConfig, 'id'> & { id?: string }): ProviderConfig {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO providers (id, kind, preset, display_name, base_url, auth_scheme, auth_header, extra_headers_json,
           model_list_path, model_list_query_json, allow_insecure_http, created_at)
         VALUES (@id, @kind, @preset, @displayName, @baseUrl, @scheme, @header, @extra, @path, @query, @insecure, @now)
         ON CONFLICT(id) DO UPDATE SET kind=@kind, preset=@preset, display_name=@displayName, base_url=@baseUrl,
           auth_scheme=@scheme, auth_header=@header, extra_headers_json=@extra, model_list_path=@path,
           model_list_query_json=@query, allow_insecure_http=@insecure`,
      )
      .run({
        id,
        kind: input.kind,
        preset: input.preset ?? null,
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        scheme: input.auth.scheme,
        header: input.auth.headerName ?? null,
        extra: JSON.stringify(input.extraHeaders ?? {}),
        path: input.modelListPath || '/models',
        query: JSON.stringify(input.modelListQuery ?? {}),
        insecure: input.allowInsecureHttp ? 1 : 0,
        now: this.now(),
      });
    return this.getProvider(id)!;
  }

  providerUsage(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE provider_id = ?').get(id) as { n: number }).n;
  }

  /** Blocked while conversations still use the provider (spec section 7). */
  deleteProvider(id: string): void {
    const n = this.providerUsage(id);
    if (n > 0) {
      throw relayError('blocked', `${n} conversation${n === 1 ? '' : 's'} still use this provider. Reassign or delete them first.`);
    }
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  reassignConversations(fromProviderId: string, toProviderId: string, modelId: string): number {
    if (!this.getProvider(toProviderId)) throw relayError('invalid_request', 'The target provider does not exist.');
    return this.db
      .prepare('UPDATE conversations SET provider_id = ?, model_id = ?, extensions_json = ? WHERE provider_id = ?')
      .run(toProviderId, modelId, '{}', fromProviderId).changes;
  }

  // ---------- model cache + overrides ----------

  /** Replaces the fetched list for a provider; hand-entered model IDs are kept. */
  replaceModelCache(providerId: string, models: ModelInfo[]): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM models_cache WHERE provider_id = ? AND manual = 0').run(providerId);
      const ins = this.db.prepare(
        `INSERT INTO models_cache (provider_id, model_id, info_json, manual, position, fetched_at) VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET info_json = excluded.info_json, manual = 0, position = excluded.position, fetched_at = excluded.fetched_at`,
      );
      models.forEach((m, i) => ins.run(providerId, m.id, JSON.stringify(m), i, now));
      this.setSettingRaw(`modelsFetchedAt:${providerId}`, now);
    })();
  }

  addManualModel(providerId: string, modelId: string): void {
    const info: ModelInfo = { id: modelId, providerId, displayName: modelId, capabilities: {}, manual: true };
    this.db
      .prepare(
        `INSERT INTO models_cache (provider_id, model_id, info_json, manual, position, fetched_at) VALUES (?, ?, ?, 1, 1000000, ?)
         ON CONFLICT(provider_id, model_id) DO NOTHING`,
      )
      .run(providerId, modelId, JSON.stringify(info), this.now());
  }

  removeManualModel(providerId: string, modelId: string): void {
    this.db.prepare('DELETE FROM models_cache WHERE provider_id = ? AND model_id = ? AND manual = 1').run(providerId, modelId);
  }

  modelsFetchedAt(providerId: string): number | null {
    return this.getSettingRaw<number | null>(`modelsFetchedAt:${providerId}`, null);
  }

  /** Cached models with user capability overrides applied. `raw` is included; strip before IPC. */
  listModels(providerId: string): ModelInfo[] {
    const rows = this.db.prepare('SELECT info_json, manual FROM models_cache WHERE provider_id = ? ORDER BY manual, position, model_id').all(providerId) as Row[];
    const overrides = new Map(
      (this.db.prepare('SELECT model_id, capabilities_json FROM model_overrides WHERE provider_id = ?').all(providerId) as Row[]).map((r) => [
        r.model_id as string,
        json<Capabilities>(r.capabilities_json, {}),
      ]),
    );
    return rows.map((r) => {
      const info = json<ModelInfo>(r.info_json, { id: '?', providerId, displayName: '?', capabilities: {} });
      const reported = info.capabilities ?? {};
      const ov = overrides.get(info.id);
      return { ...info, providerId, manual: !!r.manual || undefined, reportedCapabilities: reported, capabilities: ov ? { ...reported, ...ov } : reported };
    });
  }

  getModel(providerId: string, modelId: string): ModelInfo | undefined {
    return this.listModels(providerId).find((m) => m.id === modelId);
  }

  setModelOverride(providerId: string, modelId: string, capabilities: Capabilities | null): void {
    if (!capabilities || Object.keys(capabilities).length === 0) {
      this.db.prepare('DELETE FROM model_overrides WHERE provider_id = ? AND model_id = ?').run(providerId, modelId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO model_overrides (provider_id, model_id, capabilities_json) VALUES (?, ?, ?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET capabilities_json = excluded.capabilities_json`,
      )
      .run(providerId, modelId, JSON.stringify(capabilities));
  }

  // ---------- conversations ----------

  listConversations(opts: { search?: string; includeArchived?: boolean } = {}): ConversationListItem[] {
    const archived = opts.includeArchived ? '' : 'AND c.archived = 0';
    const q = opts.search?.trim();
    if (!q) {
      return (this.db.prepare(`SELECT c.* FROM conversations c WHERE 1=1 ${archived} ORDER BY c.pinned DESC, c.updated_at DESC`).all() as Row[]).map(toConversation);
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const fts = ftsQuery(q);
    const hits = new Map<string, string>();
    if (fts) {
      // One row per conversation (not per message), so many hits in a few
      // chats can never crowd other matching chats out of the result.
      const rows = this.db
        .prepare('SELECT conversation_id AS id, MIN(rowid) AS rid FROM messages_fts WHERE messages_fts MATCH ? GROUP BY conversation_id')
        .all(fts) as { id: string; rid: number }[];
      const snip = this.db.prepare("SELECT snippet(messages_fts, 0, '', '', ' … ', 12) AS snip FROM messages_fts WHERE messages_fts MATCH ? AND rowid = ?");
      rows.forEach((r, i) => hits.set(r.id, i < 200 ? ((snip.get(fts, r.rid) as { snip: string } | undefined)?.snip ?? '') : ''));
    }
    const all = (this.db
      .prepare(`SELECT c.*, (c.title LIKE ? ESCAPE '\\') AS title_hit FROM conversations c WHERE 1=1 ${archived} ORDER BY c.pinned DESC, c.updated_at DESC`)
      .all(like) as Row[]);
    return all
      .filter((r) => r.title_hit || hits.has(r.id as string))
      .map((r) => ({ ...toConversation(r), snippet: hits.get(r.id as string) || undefined }));
  }

  getConversation(id: string): Conversation | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return r ? toConversation(r) : undefined;
  }

  requireConversation(id: string): Conversation {
    const c = this.getConversation(id);
    if (!c) throw relayError('invalid_request', 'That conversation no longer exists.');
    return c;
  }

  createConversation(input: { providerId: string; modelId: string; title?: string; id?: string }): Conversation {
    if (!this.getProvider(input.providerId)) throw relayError('invalid_request', 'That provider no longer exists.');
    const settings = this.getSettings();
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, provider_id, model_id, system_prompt, params_json, extensions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title?.trim() || 'New chat',
        input.providerId,
        input.modelId,
        settings.defaultSystemPrompt || null,
        JSON.stringify(settings.defaultParams ?? {}),
        JSON.stringify(settings.defaultExtensions?.[input.providerId] ?? {}),
        now,
        now,
      );
    return this.getConversation(id)!;
  }

  updateConversation(id: string, patch: ConversationPatch, touch = false): Conversation {
    const cur = this.requireConversation(id);
    if (patch.providerId && !this.getProvider(patch.providerId)) throw relayError('invalid_request', 'That provider no longer exists.');
    if (patch.activeLeafId) {
      const m = this.getMessage(patch.activeLeafId);
      if (!m || m.conversationId !== id) throw relayError('invalid_request', 'That message is not part of this conversation.');
    }
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Conversation;
    this.db
      .prepare(
        `UPDATE conversations SET title=?, provider_id=?, model_id=?, system_prompt=?, params_json=?, extensions_json=?,
           active_leaf_id=?, pinned=?, archived=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.title,
        next.providerId,
        next.modelId,
        next.systemPrompt || null,
        JSON.stringify(next.params ?? {}),
        JSON.stringify(next.extensions ?? {}),
        next.activeLeafId,
        next.pinned ? 1 : 0,
        next.archived ? 1 : 0,
        touch ? this.now() : cur.updatedAt,
        id,
      );
    return this.getConversation(id)!;
  }

  /** Deletes a conversation. Returns the attachment hashes nothing refers to any more. */
  deleteConversation(id: string): string[] {
    return this.db.transaction(() => {
      const mine = (this.db
        .prepare('SELECT DISTINCT a.sha256 AS sha FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?')
        .all(id) as { sha: string }[]).map((r) => r.sha);
      this.db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      const still = this.attachmentHashesInUse();
      return mine.filter((sha) => !still.has(sha));
    })();
  }

  attachmentHashesInUse(): Set<string> {
    return new Set((this.db.prepare('SELECT DISTINCT sha256 AS sha FROM attachments').all() as { sha: string }[]).map((r) => r.sha));
  }

  // ---------- messages ----------

  listMessages(conversationId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId) as Row[]).map(toMessage);
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  insertMessage(m: Omit<Message, 'createdAt'> & { createdAt?: number }): Message {
    const createdAt = m.createdAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, parent_id, role, content_json, provider_id, model_id, reasoning_text,
           finish_reason, usage_json, request_id, error_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.conversationId,
        m.parentId,
        m.role,
        JSON.stringify(m.content),
        m.providerId,
        m.modelId,
        m.reasoningText,
        m.finishReason,
        m.usage ? JSON.stringify(m.usage) : null,
        m.requestId,
        m.error ? JSON.stringify(m.error) : null,
        createdAt,
      );
    for (const p of m.content) {
      if (p.type === 'image') {
        this.db.prepare('INSERT INTO attachments (id, message_id, mime, bytes, sha256) VALUES (?, ?, ?, 0, ?)').run(randomUUID(), m.id, p.mime, p.sha256);
      }
    }
    this.indexMessage(m.id, m.conversationId, m.content);
    return { ...m, createdAt };
  }

  updateMessage(id: string, u: MessageUpdate, reindex = true): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (u.content !== undefined) add('content_json', JSON.stringify(u.content));
    if (u.reasoningText !== undefined) add('reasoning_text', u.reasoningText);
    if (u.finishReason !== undefined) add('finish_reason', u.finishReason);
    if (u.usage !== undefined) add('usage_json', u.usage ? JSON.stringify(u.usage) : null);
    if (u.requestId !== undefined) add('request_id', u.requestId);
    if (u.error !== undefined) add('error_json', u.error ? JSON.stringify(u.error) : null);
    if (u.providerId !== undefined) add('provider_id', u.providerId);
    if (u.modelId !== undefined) add('model_id', u.modelId);
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (reindex && u.content !== undefined) {
      const row = this.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(id) as { conversation_id: string } | undefined;
      if (row) this.indexMessage(id, row.conversation_id, u.content);
    }
  }

  private indexMessage(id: string, conversationId: string, content: ContentPart[]): void {
    this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id);
    const body = textOf(content);
    if (body.trim()) this.db.prepare('INSERT INTO messages_fts (body, message_id, conversation_id) VALUES (?, ?, ?)').run(body, id, conversationId);
  }

  /** Root-to-leaf path: the conversation's visible thread. One query, however deep the thread. */
  pathTo(leafId: string | null): Message[] {
    if (!leafId) return [];
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT m.parent_id, c.depth + 1 FROM messages m JOIN chain c ON m.id = c.id
           WHERE m.parent_id IS NOT NULL AND c.depth < 1000000
         )
         SELECT m.* FROM chain c JOIN messages m ON m.id = c.id ORDER BY c.depth DESC`,
      )
      .all(leafId) as Row[];
    // A corrupt import could contain a parent cycle; keep each message once.
    const seen = new Set<string>();
    const path: Message[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const id = rows[i].id as string;
      if (seen.has(id)) break;
      seen.add(id);
      path.push(toMessage(rows[i]));
    }
    return path.reverse();
  }

  /** On startup: any assistant row with no finish_reason was cut off by the app closing. */
  markInterrupted(): number {
    return this.db.prepare(`UPDATE messages SET finish_reason = 'interrupted' WHERE role = 'assistant' AND finish_reason IS NULL`).run().changes;
  }

  // ---------- settings ----------

  private getSettingRaw<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    return r ? json(r.value_json, fallback) : fallback;
  }

  private setSettingRaw(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value));
  }

  getSettings(): Settings {
    const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = this.getSettingRaw(key, out[key]);
    return out as unknown as Settings;
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && k in DEFAULT_SETTINGS) this.setSettingRaw(k, v);
    })();
    return this.getSettings();
  }

  // ---------- import helpers (merge: skip IDs already present) ----------

  importConversation(c: Conversation): boolean {
    if (this.getConversation(c.id) || !this.getProvider(c.providerId)) return false;
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, provider_id, model_id, system_prompt, params_json, extensions_json, active_leaf_id,
           pinned, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.title,
        c.providerId,
        c.modelId,
        c.systemPrompt,
        JSON.stringify(c.params ?? {}),
        JSON.stringify(c.extensions ?? {}),
        c.activeLeafId,
        c.pinned ? 1 : 0,
        c.archived ? 1 : 0,
        c.createdAt,
        c.updatedAt,
      );
    return true;
  }

  importSettings(values: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
      this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(k, JSON.stringify(v));
    }
  }

  /** Settings the user has actually changed (what a full export carries). */
  storedSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
      if (r) out[key] = json(r.value_json, undefined);
    }
    return out;
  }

  listModelOverrides(): { providerId: string; modelId: string; capabilities: Capabilities }[] {
    return (this.db.prepare('SELECT * FROM model_overrides').all() as Row[]).map((r) => ({
      providerId: r.provider_id as string,
      modelId: r.model_id as string,
      capabilities: json<Capabilities>(r.capabilities_json, {}),
    }));
  }

  // ---------- request log (metadata only) ----------

  logRequest(e: RequestLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_log (ts, provider_id, model_id, status, request_id, prompt_tokens, completion_tokens, latency_ms, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.now(), e.providerId, e.modelId, e.status ?? null, e.requestId ?? null, e.promptTokens ?? null, e.completionTokens ?? null, e.latencyMs, e.errorCode ?? null);
    this.db.prepare('DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - 5000').run();
  }
}
