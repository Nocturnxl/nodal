import { z } from 'zod';

// Payload schemas for every IPC channel. Main validates with these before a
// handler runs; nothing from the renderer is trusted.

const id = z.string().min(1).max(200);
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'Invalid header name').max(100);

export const providerConfigSchema = z.object({
  id: id.optional(),
  kind: z.literal('openai-compatible'),
  preset: z.enum(['venice', 'lmstudio', 'ollama', 'openrouter', 'openai']).optional(),
  displayName: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1).max(2000),
  auth: z.object({
    scheme: z.enum(['bearer', 'header', 'none']),
    headerName: headerName.optional(),
  }),
  extraHeaders: z.record(headerName, z.string().max(4000)).optional(),
  modelListPath: z.string().trim().max(500).default('/models'),
  modelListQuery: z.record(z.string().max(100), z.string().max(500)).optional(),
  allowInsecureHttp: z.boolean().default(false),
});
export type ProviderConfigInput = z.infer<typeof providerConfigSchema>;

export const samplingSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).max(10_000_000).optional(),
  contextLimit: z.number().int().min(256).max(100_000_000).optional(),
});

export const extensionValuesSchema = z.record(
  z.string().max(100),
  z.union([z.string().max(2000), z.number(), z.boolean()]),
);

const capabilitiesSchema = z.object({
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  webSearch: z.boolean().optional(),
});

const attachmentRef = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
});

export const settingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    defaultSystemPrompt: z.string().max(100_000),
    defaultParams: samplingSchema,
    defaultExtensions: z.record(id, extensionValuesSchema),
    updateCheck: z.boolean(),
    proxy: z.string().max(500),
    firstByteTimeoutSec: z.number().int().min(5).max(300),
    mathEnabled: z.boolean(),
    lastModel: z.object({ providerId: id, modelId: z.string().min(1).max(500) }).nullable(),
    inspectorOpen: z.boolean(),
    showArchived: z.boolean(),
  })
  .partial();

export const schemas = {
  none: z.undefined().or(z.null()),
  providerSave: providerConfigSchema,
  providerDelete: z.object({ id }),
  providerId: z.object({ providerId: id }),
  providerReassign: z.object({ fromProviderId: id, toProviderId: id, modelId: z.string().min(1).max(500) }),
  keysSet: z.object({ providerId: id, key: z.string().max(10_000), saveAnyway: z.boolean().optional() }),
  modelsList: z.object({ providerId: id, refresh: z.boolean().optional() }),
  modelsAddManual: z.object({ providerId: id, modelId: z.string().trim().min(1).max(500) }),
  modelsRemoveManual: z.object({ providerId: id, modelId: z.string().min(1).max(500) }),
  modelsOverride: z.object({ providerId: id, modelId: z.string().min(1).max(500), capabilities: capabilitiesSchema.nullable() }),
  modelRef: z.object({ providerId: id, modelId: z.string().min(1).max(500) }),
  chatStart: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('send'),
      conversationId: id,
      text: z.string().max(5_000_000),
      attachments: z.array(attachmentRef).max(16).optional(),
    }),
    z.object({ mode: z.literal('edit'), conversationId: id, messageId: id, text: z.string().max(5_000_000) }),
    z.object({ mode: z.literal('regenerate'), conversationId: id, messageId: id }),
    z.object({ mode: z.literal('continue'), conversationId: id, messageId: id }),
  ]),
  chatCancel: z.object({ streamId: id }),
  convList: z.object({ search: z.string().max(500).optional(), includeArchived: z.boolean().optional() }),
  convId: z.object({ id }),
  convCreate: z.object({
    providerId: id,
    modelId: z.string().min(1).max(500),
    title: z.string().max(300).optional(),
  }),
  convUpdate: z.object({
    id,
    patch: z
      .object({
        title: z.string().trim().min(1).max(300),
        providerId: id,
        modelId: z.string().min(1).max(500),
        systemPrompt: z.string().max(100_000).nullable(),
        params: samplingSchema,
        extensions: extensionValuesSchema,
        pinned: z.boolean(),
        archived: z.boolean(),
        activeLeafId: id.nullable(),
      })
      .partial(),
  }),
  settingsSet: settingsPatchSchema,
  exportConversation: z.object({ id, format: z.enum(['markdown', 'json']) }),
  attachmentAdd: z.object({
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 20 * 1024 * 1024, 'Image must be under 20 MB'),
  }),
  attachmentGet: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  openExternal: z.object({ url: z.string().max(4000) }),
};
