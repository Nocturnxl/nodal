import { randomUUID } from 'node:crypto';
import type {
  ChatEvent,
  ChatEventBatch,
  ChatStartRequest,
  ChatStartResult,
  ContentPart,
  Conversation,
  Message,
  NormalizedError,
  Usage,
} from '@shared/types';
import type { AttachmentStore } from '../attachments';
import { Store, textOf } from '../db/store';
import type { Logger } from '../log';
import { nodalError, toNormalized } from '../net/errors';
import type { Http, Timeouts } from '../net/http';
import { checkBaseUrl } from '../net/http';
import type { ProviderAdapter, ProviderRuntime } from '../providers/adapter';
import { adapterFor as defaultAdapterFor } from '../providers/registry';
import type { KeyStore } from '../secrets/keystore';
import { buildContext } from './context';

export const MAX_STREAMS = 4;
/** Auto-retry budgets, before the first token only (spec section 8). */
const RETRY_BUDGET: Partial<Record<NormalizedError['code'], number>> = { rate_limit: 3, server: 2, network: 1 };
/** Do not sit silently on a rate limit that resets further out than this. */
const MAX_AUTO_WAIT_MS = 60_000;

const CONTINUE_PROMPT =
  'Continue your previous reply from exactly where it stopped. Do not repeat anything already written and do not add any preamble.';

export interface StreamDeps {
  store: Store;
  keys: Pick<KeyStore, 'get'>;
  http: Http;
  attachments: AttachmentStore;
  log: Logger;
  emit(batch: ChatEventBatch): void;
  timeouts(): Timeouts;
  adapterFor?: (config: { kind: 'openai-compatible'; preset?: string }) => ProviderAdapter;
  flushMs?: number;
  saveMs?: number;
  /** Base for exponential backoff; tests shrink it. */
  backoffBaseMs?: number;
}

interface Active {
  streamId: string;
  conversationId: string;
  messageId: string;
  ctl: AbortController;
  shutdown: boolean;
  text: string;
  reasoning: string;
  finished: Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!line) return 'New chat';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

/**
 * Owns every in-flight reply: creates the message rows, calls the adapter,
 * batches events to the renderer about once a frame, saves partial text about
 * once a second, and applies the retry / cancel / recovery rules.
 */
export class StreamManager {
  private readonly active = new Map<string, Active>();
  private readonly flushMs: number;
  private readonly saveMs: number;
  private readonly backoffBaseMs: number;
  private readonly adapterFor: NonNullable<StreamDeps['adapterFor']>;

  constructor(private readonly d: StreamDeps) {
    this.flushMs = d.flushMs ?? 16;
    this.saveMs = d.saveMs ?? 1000;
    this.backoffBaseMs = d.backoffBaseMs ?? 1000;
    this.adapterFor = d.adapterFor ?? (defaultAdapterFor as NonNullable<StreamDeps['adapterFor']>);
  }

  get activeCount(): number {
    return this.active.size;
  }

  isStreaming(conversationId: string): boolean {
    return [...this.active.values()].some((a) => a.conversationId === conversationId);
  }

  /** Resolves when the given stream (or all streams) has fully finished. Used by tests and shutdown. */
  async settled(streamId?: string): Promise<void> {
    if (streamId) return this.active.get(streamId)?.finished;
    await Promise.all([...this.active.values()].map((a) => a.finished));
  }

  start(req: ChatStartRequest): ChatStartResult {
    const { store } = this.d;
    const conv = store.requireConversation(req.conversationId);
    if (this.isStreaming(conv.id)) throw nodalError('busy', 'This conversation is already generating a reply.');
    if (this.active.size >= MAX_STREAMS) throw nodalError('busy', `NODAL runs at most ${MAX_STREAMS} replies at once. Wait for one to finish or stop it.`);
    const provider = store.getProvider(conv.providerId);
    if (!provider) throw nodalError('invalid_request', 'The provider for this conversation no longer exists.');

    let userMessage: Message | undefined;
    let assistant: Message;
    let path: Message[];
    let title = conv.title;
    const blank = (parentId: string | null): Omit<Message, 'createdAt'> => ({
      id: randomUUID(),
      conversationId: conv.id,
      parentId,
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      providerId: conv.providerId,
      modelId: conv.modelId,
      reasoningText: null,
      finishReason: null,
      usage: null,
      requestId: null,
      error: null,
    });
    const user = (parentId: string | null, content: ContentPart[]): Omit<Message, 'createdAt'> => ({
      ...blank(parentId),
      role: 'user',
      content,
      providerId: null,
      modelId: null,
      finishReason: 'stop',
    });
    const owned = (id: string, role: Message['role']): Message => {
      const m = store.getMessage(id);
      if (!m || m.conversationId !== conv.id || m.role !== role) throw nodalError('invalid_request', 'That message cannot be used for this action.');
      return m;
    };

    const tx = store.db.transaction(() => {
      if (req.mode === 'send') {
        const content: ContentPart[] = [{ type: 'text', text: req.text }];
        for (const a of req.attachments ?? []) {
          if (!this.d.attachments.read(a.sha256)) throw nodalError('invalid_request', 'An attached image is no longer available.');
          content.push({ type: 'image', sha256: a.sha256, mime: a.mime });
        }
        if (!req.text.trim() && content.length === 1) throw nodalError('invalid_request', 'Type a message first.');
        if (!conv.activeLeafId && conv.title === 'New chat') title = titleFrom(req.text);
        userMessage = store.insertMessage(user(conv.activeLeafId, content));
        assistant = store.insertMessage(blank(userMessage.id));
        path = store.pathTo(userMessage.id);
      } else if (req.mode === 'edit') {
        const orig = owned(req.messageId, 'user');
        const content: ContentPart[] = [{ type: 'text', text: req.text }, ...orig.content.filter((p) => p.type === 'image')];
        userMessage = store.insertMessage(user(orig.parentId, content));
        assistant = store.insertMessage(blank(userMessage.id));
        path = store.pathTo(userMessage.id);
      } else if (req.mode === 'regenerate') {
        const orig = owned(req.messageId, 'assistant');
        assistant = store.insertMessage(blank(orig.parentId));
        path = store.pathTo(orig.parentId);
      } else {
        const orig = owned(req.messageId, 'assistant');
        store.updateMessage(orig.id, { finishReason: null, error: null, providerId: conv.providerId, modelId: conv.modelId }, false);
        assistant = store.getMessage(orig.id)!;
        path = store.pathTo(orig.id);
        if (textOf(orig.content).trim()) {
          path.push({ ...user(orig.id, [{ type: 'text', text: CONTINUE_PROMPT }]), createdAt: Date.now() });
        } else {
          path.pop(); // nothing was written: this is a plain retry of the same turn
        }
      }
      return store.updateConversation(conv.id, { activeLeafId: assistant.id, title }, true);
    });
    const conversation = tx();

    const streamId = randomUUID();
    const a: Active = {
      streamId,
      conversationId: conv.id,
      messageId: assistant!.id,
      ctl: new AbortController(),
      shutdown: false,
      text: req.mode === 'continue' ? textOf(assistant!.content) : '',
      reasoning: req.mode === 'continue' ? (assistant!.reasoningText ?? '') : '',
      finished: Promise.resolve(),
    };
    this.active.set(streamId, a);
    // Start on the next tick so the renderer has the streamId before events arrive.
    a.finished = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.run(a, conversation, path!)
          .catch((e) => this.d.log.error('stream crashed', { error: String(e) }))
          .finally(() => {
            this.active.delete(streamId);
            resolve();
          });
      });
    });
    return { streamId, conversation, userMessage, assistantMessage: assistant! };
  }

  /** Stop: abort the upstream request, keep the text so far, finish as `cancelled`. */
  cancel(streamId: string): void {
    this.active.get(streamId)?.ctl.abort();
  }

  /** App is closing: abort everything and leave the rows `interrupted`. */
  abortAll(): void {
    for (const a of this.active.values()) {
      a.shutdown = true;
      a.ctl.abort();
      try {
        this.d.store.updateMessage(a.messageId, {
          content: [{ type: 'text', text: a.text }],
          reasoningText: a.reasoning || null,
          finishReason: 'interrupted',
        });
      } catch {
        /* database may already be closing */
      }
    }
  }

  private async run(a: Active, conv: Conversation, path: Message[]): Promise<void> {
    const { store, log } = this.d;
    const signal = a.ctl.signal;
    let usage: Usage | null = null;
    let requestId: string | null = null;
    let gotContent = false;
    let dirty = false;

    // ---- batching to the renderer (about one frame) ----
    let pending: ChatEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!pending.length) return;
      const events = pending;
      pending = [];
      this.d.emit({ streamId: a.streamId, conversationId: a.conversationId, messageId: a.messageId, events });
    };
    const push = (ev: ChatEvent) => {
      const last = pending[pending.length - 1];
      if (last && (ev.t === 'delta' || ev.t === 'reasoning') && last.t === ev.t) last.text += ev.text;
      else pending.push(ev.t === 'delta' || ev.t === 'reasoning' ? { ...ev } : ev);
      flushTimer ??= setTimeout(flush, this.flushMs);
    };

    // ---- partial text saved about once a second, so a reply is never lost ----
    const save = () => {
      if (!dirty || a.shutdown) return;
      dirty = false;
      store.updateMessage(a.messageId, { content: [{ type: 'text', text: a.text }], reasoningText: a.reasoning || null }, false);
    };
    const saveTimer = setInterval(save, this.saveMs);

    const finish = (finishReason: string, error: NormalizedError | null) => {
      clearInterval(saveTimer);
      if (a.shutdown) return;
      store.updateMessage(a.messageId, {
        content: [{ type: 'text', text: a.text }],
        reasoningText: a.reasoning || null,
        finishReason,
        usage,
        requestId,
        error,
      });
      store.updateConversation(a.conversationId, {}, true);
      if (error) push({ t: 'error', error });
      push({ t: 'done', finishReason });
      flush();
    };

    try {
      const provider = store.getProvider(conv.providerId);
      if (!provider) throw nodalError('invalid_request', 'The provider for this conversation no longer exists.');
      const verdict = checkBaseUrl(provider.baseUrl, provider.allowInsecureHttp);
      if (!verdict.ok) throw nodalError('blocked', verdict.reason ?? 'The provider URL is not allowed.');
      const model = store.getModel(conv.providerId, conv.modelId);
      const adapter = this.adapterFor(provider);
      const built = buildContext(path, {
        systemPrompt: conv.systemPrompt,
        contextTokens: model?.contextTokens,
        maxOutputTokens: model?.maxOutputTokens,
        params: conv.params,
        imageDataUrl: (sha, mime) => {
          const buf = this.d.attachments.read(sha);
          return buf ? `data:${mime};base64,${buf.toString('base64')}` : undefined;
        },
      });
      const request = {
        modelId: conv.modelId,
        model,
        messages: built.messages,
        params: conv.params,
        extensions: conv.extensions,
        conversationId: conv.id,
      };

      const used: Record<string, number> = {};
      for (;;) {
        const started = Date.now();
        try {
          // The key is decrypted per attempt and lives only in this scope.
          const apiKey = provider.auth.scheme === 'none' ? undefined : this.d.keys.get(provider.id);
          if (provider.auth.scheme !== 'none' && !apiKey) throw nodalError('auth', 'No API key is saved for this provider.');
          const runtime: ProviderRuntime = { config: provider, apiKey, http: this.d.http, timeouts: this.d.timeouts() };
          let finishReason = 'stop';
          for await (const ev of adapter.streamChat(runtime, request, signal)) {
            if (ev.t === 'delta') {
              a.text += ev.text;
              gotContent = dirty = true;
              push(ev);
            } else if (ev.t === 'reasoning') {
              a.reasoning += ev.text;
              gotContent = dirty = true;
              push(ev);
            } else if (ev.t === 'usage') {
              usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
              push(ev);
            } else if (ev.t === 'meta') {
              requestId = ev.requestId ?? requestId;
              push(ev);
            } else if (ev.t === 'done') {
              finishReason = ev.finishReason;
            } else if (ev.t === 'tool_call') {
              push(ev); // v1 gives the model no tools; surfaced for completeness only
            }
          }
          const u = usage as Usage | null;
          store.logRequest({
            providerId: provider.id,
            modelId: conv.modelId,
            status: 200,
            requestId: requestId ?? undefined,
            promptTokens: u?.promptTokens,
            completionTokens: u?.completionTokens,
            latencyMs: Date.now() - started,
          });
          finish(finishReason, null);
          return;
        } catch (e) {
          const err = toNormalized(e);
          if (a.shutdown) return;
          if (signal.aborted || err.code === 'cancelled') {
            finish('cancelled', null);
            return;
          }
          requestId = err.requestId ?? requestId;
          store.logRequest({
            providerId: provider.id,
            modelId: conv.modelId,
            status: err.status,
            requestId: requestId ?? undefined,
            latencyMs: Date.now() - started,
            errorCode: err.code,
          });
          log.warn('chat request failed', { code: err.code, status: err.status, requestId: requestId ?? undefined, provider: provider.displayName, model: conv.modelId });

          // Rule 1: once any content has arrived, never retry automatically.
          const budget = RETRY_BUDGET[err.code] ?? 0;
          const n = used[err.code] ?? 0;
          if (!gotContent && n < budget) {
            const backoff = this.backoffBaseMs * 2 ** n * (0.75 + Math.random() * 0.5);
            const delay = err.code === 'rate_limit' && err.retryAfterMs !== undefined ? err.retryAfterMs + 250 : backoff;
            if (delay <= MAX_AUTO_WAIT_MS) {
              used[err.code] = n + 1;
              push({ t: 'retry', attempt: n + 1, delayMs: Math.round(delay), error: err });
              await sleep(delay, signal);
              if (signal.aborted) {
                if (!a.shutdown) finish('cancelled', null);
                return;
              }
              continue;
            }
          }
          finish(a.text ? 'incomplete' : 'error', err);
          return;
        }
      }
    } catch (e) {
      // Failures before any request was made (missing provider, blocked URL...).
      if (!a.shutdown) finish(a.text ? 'incomplete' : 'error', toNormalized(e));
    } finally {
      clearInterval(saveTimer);
      if (flushTimer) clearTimeout(flushTimer);
    }
  }
}
