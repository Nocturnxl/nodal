import { contextBridge, ipcRenderer } from 'electron';
import { CH, type NodalApi } from '@shared/api';
import type { ChatEventBatch } from '@shared/types';

// The only bridge between the sandboxed renderer and main. It exposes typed
// functions bound to fixed channels: never ipcRenderer itself, never a generic
// "send to any channel" helper, and no way to read a key back.
const invoke = <T>(channel: string, payload?: unknown): Promise<T> => ipcRenderer.invoke(channel, payload) as Promise<T>;

const api: NodalApi = {
  providers: {
    list: () => invoke(CH.providersList),
    save: (config) => invoke(CH.providersSave, config),
    delete: (id) => invoke(CH.providersDelete, { id }),
    test: (providerId) => invoke(CH.providersTest, { providerId }),
    usage: (providerId) => invoke(CH.providersUsage, { providerId }),
    reassign: (fromProviderId, toProviderId, modelId) => invoke(CH.providersReassign, { fromProviderId, toProviderId, modelId }),
  },
  keys: {
    set: (providerId, key, saveAnyway) => invoke(CH.keysSet, { providerId, key, saveAnyway }),
    clear: (providerId) => invoke(CH.keysClear, { providerId }),
    status: (providerId) => invoke(CH.keysStatus, { providerId }),
    storeStatus: () => invoke(CH.keysStore),
  },
  models: {
    list: (providerId, opts) => invoke(CH.modelsList, { providerId, refresh: opts?.refresh }),
    addManual: (providerId, modelId) => invoke(CH.modelsAddManual, { providerId, modelId }),
    removeManual: (providerId, modelId) => invoke(CH.modelsRemoveManual, { providerId, modelId }),
    setOverride: (providerId, modelId, capabilities) => invoke(CH.modelsOverride, { providerId, modelId, capabilities }),
    extensions: (providerId, modelId) => invoke(CH.modelsExtensions, { providerId, modelId }),
  },
  chat: {
    start: (req) => invoke(CH.chatStart, req),
    cancel: (streamId) => invoke(CH.chatCancel, { streamId }),
    onEvent: (cb) => {
      const listener = (_e: unknown, batch: ChatEventBatch) => cb(batch);
      ipcRenderer.on(CH.chatEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.chatEvent, listener);
      };
    },
  },
  conversations: {
    list: (opts) => invoke(CH.convList, opts ?? {}),
    get: (id) => invoke(CH.convGet, { id }),
    create: (input) => invoke(CH.convCreate, input),
    update: (id, patch) => invoke(CH.convUpdate, { id, patch }),
    delete: (id) => invoke(CH.convDelete, { id }),
  },
  settings: {
    get: () => invoke(CH.settingsGet),
    set: (patch) => invoke(CH.settingsSet, patch),
  },
  data: {
    exportConversation: (id, format) => invoke(CH.exportConversation, { id, format }),
    exportAll: () => invoke(CH.exportAll),
    importFile: () => invoke(CH.importFile),
  },
  attachments: {
    add: (mime, data) => invoke(CH.attachmentAdd, { mime, data }),
    get: (sha256) => invoke(CH.attachmentGet, { sha256 }),
  },
  app: {
    info: () => invoke(CH.appInfo),
    openDataFolder: () => invoke(CH.appOpenDataFolder),
    openLogFolder: () => invoke(CH.appOpenLogFolder),
    openExternal: (url) => invoke(CH.appOpenExternal, { url }),
  },
};

contextBridge.exposeInMainWorld('nodal', api);
