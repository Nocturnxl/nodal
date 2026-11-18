import { create } from 'zustand';
import type { ConversationPatch } from '@shared/api';
import type {
  AttachmentRef,
  ChatEventBatch,
  ChatStartRequest,
  Conversation,
  ConversationDetail,
  ConversationListItem,
  KeyStatus,
  Message,
  ModelInfo,
  ModelListResult,
  ModelNotice,
  NormalizedError,
  ProviderConfig,
  RateLimitInfo,
  Settings,
  Usage,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { parseIpcError, nodal } from './lib/ipc';
import { deepestLeaf, pathTo, textOf } from './lib/tree';

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  title: string;
  error?: NormalizedError;
  action?: { label: string; run(): void };
}

/** Text of a reply while it streams. Kept apart from `detail` so only the streaming message re-renders. */
export interface Live {
  text: string;
  reasoning: string;
  usage?: Usage;
  retry?: { attempt: number; until: number; error: NormalizedError };
}

export interface StreamRef {
  streamId: string;
  messageId: string;
}

export interface ProviderStatus {
  rateLimit?: RateLimitInfo;
  balance?: Record<string, string>;
  notice?: ModelNotice & { modelId: string };
  lastUsage?: Usage;
}

export type SettingsSection = 'providers' | 'appearance' | 'data' | 'network' | 'about';

interface State {
  ready: boolean;
  settings: Settings;
  providers: ProviderConfig[];
  keyStatus: Record<string, KeyStatus>;
  models: Record<string, ModelListResult>;
  conversations: ConversationListItem[];
  search: string;
  currentId: string | null;
  detail: ConversationDetail | null;
  streams: Record<string, StreamRef>; // by conversation id
  live: Record<string, Live>; // by message id
  drafts: Record<string, string>;
  status: Record<string, ProviderStatus>; // by provider id
  toasts: Toast[];
  settingsOpen: SettingsSection | null;
  settingsProviderId: string | null;
  pickerOpen: boolean;
  welcome: boolean;
  focusTick: number;

  init(): Promise<void>;
  refreshProviders(): Promise<void>;
  loadModels(providerId: string, refresh?: boolean): Promise<ModelListResult | undefined>;
  refreshConversations(): Promise<void>;
  setSearch(q: string): void;
  select(id: string | null): Promise<void>;
  newChat(): Promise<void>;
  chooseModel(providerId: string, modelId: string): Promise<void>;
  patchConversation(patch: ConversationPatch, id?: string): Promise<void>;
  removeConversation(id: string): Promise<void>;
  send(text: string, attachments?: AttachmentRef[]): Promise<boolean>;
  editAndResend(messageId: string, text: string): Promise<void>;
  regenerate(messageId: string): Promise<void>;
  continueReply(messageId: string): Promise<void>;
  stop(conversationId?: string): void;
  switchBranch(messageId: string): Promise<void>;
  setDraft(id: string, text: string): void;
  setSettings(patch: Partial<Settings>): Promise<void>;
  toast(t: Omit<Toast, 'id'>): void;
  toastError(title: string, e: unknown): void;
  dismissToast(id: number): void;
  openSettings(section?: SettingsSection, providerId?: string | null): void;
  closeSettings(): void;
  setPicker(open: boolean): void;
  setWelcome(open: boolean): void;
  focusComposer(): void;
}

let toastSeq = 1;
let initStarted = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

export function findModel(models: Record<string, ModelListResult>, providerId: string, modelId: string): ModelInfo | undefined {
  return models[providerId]?.models.find((m) => m.id === modelId);
}

export const useStore = create<State>((set, get) => {
  async function startStream(req: ChatStartRequest): Promise<boolean> {
    try {
      const res = await nodal.chat.start(req);
      set((s) => {
        const detail = s.detail && s.detail.conversation.id === res.conversation.id ? { ...s.detail } : s.detail;
        if (detail && detail.conversation.id === res.conversation.id) {
          const others = detail.messages.filter((m) => m.id !== res.assistantMessage.id);
          detail.messages = [...others, ...(res.userMessage ? [res.userMessage] : []), res.assistantMessage];
          detail.conversation = res.conversation;
        }
        return {
          detail,
          streams: { ...s.streams, [res.conversation.id]: { streamId: res.streamId, messageId: res.assistantMessage.id } },
          live: {
            ...s.live,
            [res.assistantMessage.id]: { text: textOf(res.assistantMessage.content), reasoning: res.assistantMessage.reasoningText ?? '' },
          },
          conversations: [
            { ...res.conversation },
            ...s.conversations.filter((c) => c.id !== res.conversation.id),
          ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
        };
      });
      return true;
    } catch (e) {
      get().toastError('Could not start the reply', e);
      return false;
    }
  }

  function onBatch(batch: ChatEventBatch): void {
    const s = get();
    const prev = s.live[batch.messageId] ?? { text: '', reasoning: '' };
    const live: Live = { ...prev };
    let finished: string | null = null;
    let error: NormalizedError | undefined;
    const providerId = (s.detail?.conversation.id === batch.conversationId ? s.detail.conversation : s.conversations.find((c) => c.id === batch.conversationId))?.providerId;
    const modelId = (s.detail?.conversation.id === batch.conversationId ? s.detail.conversation : s.conversations.find((c) => c.id === batch.conversationId))?.modelId;
    let status: ProviderStatus | undefined;

    for (const ev of batch.events) {
      if (ev.t === 'delta') {
        live.text += ev.text;
        live.retry = undefined;
      } else if (ev.t === 'reasoning') {
        live.reasoning += ev.text;
        live.retry = undefined;
      } else if (ev.t === 'usage') {
        live.usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
        status = { ...(status ?? {}), lastUsage: live.usage };
      } else if (ev.t === 'meta') {
        live.retry = undefined;
        status = {
          ...(status ?? {}),
          ...(ev.rateLimit ? { rateLimit: ev.rateLimit } : {}),
          ...(ev.balance ? { balance: ev.balance } : {}),
          notice: ev.notice && modelId ? { ...ev.notice, modelId } : undefined,
        };
      } else if (ev.t === 'retry') {
        live.retry = { attempt: ev.attempt, until: Date.now() + ev.delayMs, error: ev.error };
      } else if (ev.t === 'error') {
        error = ev.error;
      } else if (ev.t === 'done') {
        finished = ev.finishReason;
      }
    }

    set((st) => {
      const next: Partial<State> = { live: { ...st.live, [batch.messageId]: live } };
      if (status && providerId) next.status = { ...st.status, [providerId]: { ...st.status[providerId], ...status } };
      if (error?.balance && providerId) next.status = { ...(next.status ?? st.status), [providerId]: { ...(next.status ?? st.status)[providerId], balance: error.balance } };
      if (finished !== null) {
        const streams = { ...st.streams };
        delete streams[batch.conversationId];
        next.streams = streams;
        const liveMap = { ...next.live! };
        delete liveMap[batch.messageId];
        next.live = liveMap;
        if (st.detail?.conversation.id === batch.conversationId) {
          next.detail = {
            ...st.detail,
            messages: st.detail.messages.map((m): Message =>
              m.id === batch.messageId
                ? {
                    ...m,
                    content: [{ type: 'text', text: live.text }],
                    reasoningText: live.reasoning || null,
                    finishReason: finished,
                    usage: live.usage ?? m.usage,
                    error: error ?? null,
                    requestId: error?.requestId ?? m.requestId,
                  }
                : m,
            ),
          };
        }
      }
      return next;
    });

    if (finished !== null) {
      // Pull the authoritative rows (request id, usage) once the reply is final.
      void get().refreshConversations();
      if (get().detail?.conversation.id === batch.conversationId) {
        void nodal.conversations.get(batch.conversationId).then((d) => {
          if (get().detail?.conversation.id === d.conversation.id && !get().streams[d.conversation.id]) set({ detail: d });
        });
      } else if (error) {
        get().toast({ kind: 'error', title: 'A reply in another chat failed', error });
      }
    }
  }

  return {
    ready: false,
    settings: DEFAULT_SETTINGS,
    providers: [],
    keyStatus: {},
    models: {},
    conversations: [],
    search: '',
    currentId: null,
    detail: null,
    streams: {},
    live: {},
    drafts: {},
    status: {},
    toasts: [],
    settingsOpen: null,
    settingsProviderId: null,
    pickerOpen: false,
    welcome: false,
    focusTick: 0,

    async init() {
      if (initStarted) return; // StrictMode runs effects twice in development
      initStarted = true;
      nodal.chat.onEvent(onBatch);
      const [settings, providers] = await Promise.all([nodal.settings.get(), nodal.providers.list()]);
      set({ settings, providers });
      await Promise.all([get().refreshProviders(), get().refreshConversations()]);
      const first = get().conversations[0];
      set({ ready: true, welcome: providers.length === 0 });
      if (first) await get().select(first.id);
    },

    async refreshProviders() {
      const providers = await nodal.providers.list();
      const entries = await Promise.all(providers.map(async (p) => [p.id, await nodal.keys.status(p.id)] as const));
      set({ providers, keyStatus: Object.fromEntries(entries) });
      await Promise.all(providers.map((p) => get().loadModels(p.id)));
    },

    async loadModels(providerId, refresh = false) {
      try {
        const res = await nodal.models.list(providerId, { refresh });
        set((s) => ({ models: { ...s.models, [providerId]: res } }));
        return res;
      } catch (e) {
        get().toastError('Could not load models', e);
        return undefined;
      }
    },

    async refreshConversations() {
      const { search, settings } = get();
      try {
        const conversations = await nodal.conversations.list({ search: search || undefined, includeArchived: settings.showArchived });
        set({ conversations });
      } catch (e) {
        get().toastError('Could not load conversations', e);
      }
    },

    setSearch(q) {
      set({ search: q });
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void get().refreshConversations(), 150);
    },

    async select(id) {
      if (!id) return set({ currentId: null, detail: null });
      try {
        const detail = await nodal.conversations.get(id);
        set({ currentId: id, detail });
        get().focusComposer();
      } catch (e) {
        get().toastError('Could not open the conversation', e);
        await get().refreshConversations();
      }
    },

    async newChat() {
      const s = get();
      // Reuse an empty chat instead of piling up blank ones.
      if (s.detail && s.detail.messages.length === 0) return get().focusComposer();
      const last = s.settings.lastModel;
      const pick =
        (last && s.providers.some((p) => p.id === last.providerId) ? last : null) ??
        (s.detail ? { providerId: s.detail.conversation.providerId, modelId: s.detail.conversation.modelId } : null);
      if (!pick) {
        if (!s.providers.length) return set({ welcome: true });
        return set({ currentId: null, detail: null, pickerOpen: true });
      }
      try {
        const conv = await nodal.conversations.create(pick);
        await get().refreshConversations();
        await get().select(conv.id);
      } catch (e) {
        get().toastError('Could not create a chat', e);
      }
    },

    async chooseModel(providerId, modelId) {
      const s = get();
      try {
        if (s.detail) {
          const same = s.detail.conversation.providerId === providerId;
          await get().patchConversation({ providerId, modelId, ...(same ? {} : { extensions: s.settings.defaultExtensions[providerId] ?? {} }) });
        } else {
          const conv = await nodal.conversations.create({ providerId, modelId });
          await get().refreshConversations();
          await get().select(conv.id);
        }
        await get().setSettings({ lastModel: { providerId, modelId } });
        set({ pickerOpen: false });
        get().focusComposer();
      } catch (e) {
        get().toastError('Could not switch model', e);
      }
    },

    async patchConversation(patch, id) {
      const target = id ?? get().currentId;
      if (!target) return;
      try {
        const conv: Conversation = await nodal.conversations.update(target, patch);
        set((s) => ({
          detail: s.detail?.conversation.id === conv.id ? { ...s.detail, conversation: conv } : s.detail,
          conversations: s.conversations.map((c) => (c.id === conv.id ? { ...c, ...conv } : c)),
        }));
        if (patch.pinned !== undefined || patch.archived !== undefined) await get().refreshConversations();
      } catch (e) {
        get().toastError('Could not save the change', e);
      }
    },

    async removeConversation(id) {
      try {
        await nodal.conversations.delete(id);
        if (get().currentId === id) set({ currentId: null, detail: null });
        await get().refreshConversations();
        if (!get().currentId) {
          const next = get().conversations[0];
          if (next) await get().select(next.id);
        }
      } catch (e) {
        get().toastError('Could not delete the conversation', e);
      }
    },

    async send(text, attachments) {
      const id = get().currentId;
      if (!id) return false;
      return startStream({ mode: 'send', conversationId: id, text, attachments: attachments?.map(({ sha256, mime }) => ({ sha256, mime })) });
    },

    async editAndResend(messageId, text) {
      const id = get().currentId;
      if (id) await startStream({ mode: 'edit', conversationId: id, messageId, text });
    },

    async regenerate(messageId) {
      const id = get().currentId;
      if (id) await startStream({ mode: 'regenerate', conversationId: id, messageId });
    },

    async continueReply(messageId) {
      const id = get().currentId;
      if (id) await startStream({ mode: 'continue', conversationId: id, messageId });
    },

    stop(conversationId) {
      const id = conversationId ?? get().currentId;
      const ref = id ? get().streams[id] : undefined;
      if (ref) void nodal.chat.cancel(ref.streamId);
    },

    async switchBranch(messageId) {
      const d = get().detail;
      if (!d) return;
      await get().patchConversation({ activeLeafId: deepestLeaf(d.messages, messageId) });
    },

    setDraft(id, text) {
      set((s) => ({ drafts: { ...s.drafts, [id]: text } }));
    },

    async setSettings(patch) {
      try {
        const settings = await nodal.settings.set(patch);
        set({ settings });
        if (patch.showArchived !== undefined) await get().refreshConversations();
      } catch (e) {
        get().toastError('Could not save the setting', e);
      }
    },

    toast(t) {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
      if (t.kind !== 'error') setTimeout(() => get().dismissToast(id), 4000);
    },
    toastError(title, e) {
      get().toast({ kind: 'error', title, error: parseIpcError(e) });
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    openSettings(section = 'providers', providerId = null) {
      set({ settingsOpen: section, settingsProviderId: providerId });
    },
    closeSettings() {
      set({ settingsOpen: null, settingsProviderId: null });
    },
    setPicker(open) {
      set({ pickerOpen: open });
    },
    setWelcome(open) {
      set({ welcome: open });
    },
    focusComposer() {
      set((s) => ({ focusTick: s.focusTick + 1 }));
    },
  };
});

/** The visible thread of the open conversation. */
export function currentPath(detail: ConversationDetail | null): Message[] {
  return detail ? pathTo(detail.messages, detail.conversation.activeLeafId) : [];
}
