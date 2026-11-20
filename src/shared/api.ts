import type {
  AppInfo,
  AttachmentRef,
  Capabilities,
  ChatEventBatch,
  ChatStartRequest,
  ChatStartResult,
  Conversation,
  ConversationDetail,
  ConversationListItem,
  ExtensionChoice,
  ExtensionField,
  SpokenAudio,
  ExtensionValue,
  ImportLocked,
  ImportResult,
  KeyCheck,
  KeyStatus,
  KeyStoreStatus,
  ModelListResult,
  ProviderConfig,
  ProviderUsage,
  SamplingParams,
  Settings,
  UnlockResult,
  VaultStatus,
} from './types';
import type { ProviderConfigInput } from './schemas';

/** IPC channel names. `chat:event` is the only main-to-renderer push. */
export const CH = {
  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersDelete: 'providers:delete',
  providersTest: 'providers:test',
  providersUsage: 'providers:usage',
  providersReassign: 'providers:reassign',
  keysSet: 'keys:set',
  keysClear: 'keys:clear',
  keysStatus: 'keys:status',
  keysStore: 'keys:store-status',
  modelsList: 'models:list',
  modelsAddManual: 'models:add-manual',
  modelsRemoveManual: 'models:remove-manual',
  modelsOverride: 'models:override',
  modelsExtensions: 'models:extensions',
  modelsLookup: 'models:lookup',
  chatStart: 'chat:start',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
  convList: 'conversations:list',
  convGet: 'conversations:get',
  convCreate: 'conversations:create',
  convUpdate: 'conversations:update',
  convDelete: 'conversations:delete',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  exportConversation: 'export:conversation',
  exportAll: 'export:all',
  importFile: 'export:import',
  attachmentAdd: 'attachments:add',
  attachmentGet: 'attachments:get',
  appInfo: 'app:info',
  appOpenDataFolder: 'app:open-data-folder',
  appOpenLogFolder: 'app:open-log-folder',
  appOpenExternal: 'app:open-external',
  voiceAvailable: 'voice:available',
  voiceTranscribe: 'voice:transcribe',
  voiceSpeak: 'voice:speak',
  vaultStatus: 'vault:status',
  vaultUnlock: 'vault:unlock',
  vaultEnable: 'vault:enable',
  vaultChange: 'vault:change-passphrase',
  vaultDisable: 'vault:disable',
  vaultLock: 'vault:lock',
  vaultSetWipe: 'vault:set-wipe',
} as const;

export interface ConversationPatch {
  title?: string;
  providerId?: string;
  modelId?: string;
  systemPrompt?: string | null;
  params?: SamplingParams;
  extensions?: Record<string, ExtensionValue>;
  pinned?: boolean;
  archived?: boolean;
  activeLeafId?: string | null;
}

/** The whole surface exposed to the renderer as `window.nodal`. No `keys.get` exists. */
export interface NodalApi {
  providers: {
    list(): Promise<ProviderConfig[]>;
    save(config: ProviderConfigInput): Promise<{ providers: ProviderConfig[]; saved: ProviderConfig }>;
    delete(id: string): Promise<ProviderConfig[]>;
    test(providerId: string): Promise<KeyCheck>;
    usage(providerId: string): Promise<ProviderUsage>;
    reassign(fromProviderId: string, toProviderId: string, modelId: string): Promise<number>;
  };
  keys: {
    set(providerId: string, key: string, saveAnyway?: boolean): Promise<KeyCheck>;
    clear(providerId: string): Promise<void>;
    status(providerId: string): Promise<KeyStatus>;
    storeStatus(): Promise<KeyStoreStatus>;
  };
  models: {
    list(providerId: string, opts?: { refresh?: boolean }): Promise<ModelListResult>;
    addManual(providerId: string, modelId: string): Promise<ModelListResult>;
    removeManual(providerId: string, modelId: string): Promise<ModelListResult>;
    setOverride(providerId: string, modelId: string, capabilities: Capabilities | null): Promise<ModelListResult>;
    extensions(providerId: string, modelId: string): Promise<ExtensionField[]>;
    /** Choices for a `lookup` control, fetched from the provider and narrowed by `search`. */
    lookup(providerId: string, key: string, search: string): Promise<ExtensionChoice[]>;
  };
  chat: {
    start(req: ChatStartRequest): Promise<ChatStartResult>;
    cancel(streamId: string): Promise<void>;
    onEvent(cb: (batch: ChatEventBatch) => void): () => void;
  };
  conversations: {
    list(opts?: { search?: string; includeArchived?: boolean }): Promise<ConversationListItem[]>;
    get(id: string): Promise<ConversationDetail>;
    create(input: { providerId: string; modelId: string; title?: string }): Promise<Conversation>;
    update(id: string, patch: ConversationPatch): Promise<Conversation>;
    delete(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  data: {
    exportConversation(id: string, format: 'markdown' | 'json'): Promise<string | null>;
    /** With a passphrase the export is written encrypted (.nodalx) instead of as a plain ZIP. */
    exportAll(passphrase?: string): Promise<string | null>;
    /** Opens a file picker. A protected export comes back as `locked`; call again with its token and passphrase. */
    importFile(unlock?: { token: string; passphrase: string }): Promise<ImportResult | ImportLocked | null>;
  };
  attachments: {
    add(mime: string, data: Uint8Array): Promise<AttachmentRef>;
    get(sha256: string): Promise<{ mime: string; data: Uint8Array } | null>;
  };
  /**
   * Voice chat for providers that offer speech services. The window records
   * and plays; these calls turn a recording into text and text into audio.
   */
  voice: {
    available(providerId: string): Promise<boolean>;
    transcribe(providerId: string, mime: string, data: Uint8Array): Promise<string>;
    speak(providerId: string, text: string): Promise<SpokenAudio>;
  };
  /**
   * Optional passphrase encryption of chats on disk. While a profile is locked
   * only `status` and `unlock` work; every other call fails until it is unlocked.
   */
  vault: {
    status(): Promise<VaultStatus>;
    unlock(passphrase: string): Promise<UnlockResult>;
    enable(passphrase: string): Promise<VaultStatus>;
    changePassphrase(current: string, next: string): Promise<boolean>;
    disable(passphrase: string): Promise<boolean>;
    /** Closes the chats and returns to the unlock screen. Replies still arriving are stopped. The window reloads. */
    lock(): Promise<void>;
    /** Turns on or off deleting all chats after five wrong passphrases in a row. */
    setWipe(enabled: boolean): Promise<VaultStatus>;
  };
  app: {
    info(): Promise<AppInfo>;
    openDataFolder(): Promise<void>;
    openLogFolder(): Promise<void>;
    /** Shows a native confirm dialog with the full URL before opening. */
    openExternal(url: string): Promise<boolean>;
  };
}

/** Errors thrown by handlers cross IPC as a JSON string prefixed with this tag. */
export const IPC_ERROR_TAG = 'NODAL_ERR:';
