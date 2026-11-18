import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import type { Conversation, ImportResult, Message, ProviderConfig } from '@shared/types';
import { providerConfigSchema, settingsPatchSchema } from '@shared/schemas';
import type { AttachmentStore } from '../attachments';
import type { Store } from '../db/store';
import { textOf } from '../db/store';
import { relayError } from '../net/errors';
import { checkBaseUrl } from '../net/http';

// Exports never contain keys: provider configs carry no key material by design.

const partSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string().max(100) }),
]);

const conversationSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(1000),
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(500),
  systemPrompt: z.string().nullable(),
  params: z.record(z.string(), z.unknown()).default({}),
  extensions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  activeLeafId: z.string().nullable(),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const messageSchema = z.object({
  id: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  parentId: z.string().nullable(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.array(partSchema),
  providerId: z.string().nullable().default(null),
  modelId: z.string().nullable().default(null),
  reasoningText: z.string().nullable().default(null),
  finishReason: z.string().nullable().default(null),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).nullable().default(null),
  requestId: z.string().nullable().default(null),
  error: z.looseObject({ code: z.string(), message: z.string() }).nullable().default(null),
  createdAt: z.number(),
});

const providerSchema = providerConfigSchema.extend({ id: z.string().min(1).max(200) });

const exportSchema = z.object({
  format: z.enum(['relay.export', 'relay.conversation']),
  version: z.literal(1),
  providers: z.array(providerSchema).default([]),
  conversations: z.array(conversationSchema).default([]),
  messages: z.array(messageSchema).default([]),
  settings: settingsPatchSchema.optional(),
  modelOverrides: z
    .array(z.object({ providerId: z.string(), modelId: z.string(), capabilities: z.record(z.string(), z.boolean()) }))
    .default([]),
});
type ExportFile = z.infer<typeof exportSchema>;

export function exportConversationJson(store: Store, id: string): string {
  const conversation = store.requireConversation(id);
  const provider = store.getProvider(conversation.providerId);
  const data = {
    format: 'relay.conversation',
    version: 1,
    exportedAt: new Date().toISOString(),
    providers: provider ? [provider] : [],
    conversations: [conversation],
    messages: store.listMessages(id), // the whole tree, every branch
  };
  return JSON.stringify(data, null, 2);
}

/** Markdown of the visible thread (root to active leaf). */
export function exportConversationMarkdown(store: Store, id: string): string {
  const c = store.requireConversation(id);
  const provider = store.getProvider(c.providerId);
  const lines: string[] = [`# ${c.title}`, ''];
  lines.push(`- Provider: ${provider?.displayName ?? c.providerId}`);
  lines.push(`- Model: ${c.modelId}`);
  lines.push(`- Created: ${new Date(c.createdAt).toISOString()}`);
  lines.push('');
  if (c.systemPrompt?.trim()) lines.push('## System', '', c.systemPrompt.trim(), '');
  for (const m of store.pathTo(c.activeLeafId)) {
    const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? `Assistant${m.modelId ? ` (${m.modelId})` : ''}` : m.role;
    lines.push(`## ${who}`, '');
    if (m.reasoningText?.trim()) {
      lines.push('<details><summary>Reasoning</summary>', '', m.reasoningText.trim(), '', '</details>', '');
    }
    const text = textOf(m.content).trim();
    if (text) lines.push(text, '');
    for (const p of m.content) if (p.type === 'image') lines.push(`*[attached image ${p.sha256.slice(0, 12)}, ${p.mime}]*`, '');
    if (m.finishReason && !['stop', 'length', 'end_turn'].includes(m.finishReason) && m.role === 'assistant') {
      lines.push(`*[reply ${m.finishReason}]*`, '');
    }
  }
  return lines.join('\n');
}

/** Full export: a ZIP holding relay-export.json and the attachment files. */
export function exportAllZip(store: Store, attachments: AttachmentStore): Uint8Array {
  const conversations = store.listConversations({ includeArchived: true });
  const messages = conversations.flatMap((c) => store.listMessages(c.id));
  const data = {
    format: 'relay.export',
    version: 1,
    exportedAt: new Date().toISOString(),
    providers: store.listProviders(),
    conversations,
    messages,
    settings: store.storedSettings(),
    modelOverrides: store.listModelOverrides(),
  };
  const files: Record<string, Uint8Array> = { 'relay-export.json': strToU8(JSON.stringify(data, null, 2)) };
  const seen = new Set<string>();
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type !== 'image' || seen.has(p.sha256)) continue;
      seen.add(p.sha256);
      const buf = attachments.read(p.sha256);
      if (buf) files[`attachments/${p.sha256}`] = new Uint8Array(buf);
    }
  }
  return zipSync(files, { level: 6 });
}

/** Reads a .zip (full export) or .json (full or single conversation) and merges it in. */
export function importBytes(store: Store, attachments: AttachmentStore, bytes: Uint8Array): ImportResult {
  let jsonText: string;
  const blobs = new Map<string, Uint8Array>();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw relayError('invalid_request', 'That ZIP file could not be read.');
    }
    const main = entries['relay-export.json'];
    if (!main) throw relayError('invalid_request', 'That ZIP is not a Relay export (relay-export.json is missing).');
    jsonText = strFromU8(main);
    for (const [name, data] of Object.entries(entries)) {
      const m = /^attachments\/([a-f0-9]{64})$/.exec(name);
      if (m) blobs.set(m[1], data);
    }
  } else {
    jsonText = new TextDecoder().decode(bytes);
  }

  let parsed: ExportFile;
  try {
    parsed = exportSchema.parse(JSON.parse(jsonText));
  } catch (e) {
    const detail = e instanceof z.ZodError ? e.issues[0]?.path.join('.') + ': ' + e.issues[0]?.message : 'not valid JSON';
    throw relayError('invalid_request', `That file is not a Relay export (${detail}).`);
  }

  const result: ImportResult = { conversations: 0, messages: 0, providers: 0, skipped: 0 };
  store.db.transaction(() => {
    store.db.pragma('defer_foreign_keys = ON');
    for (const p of parsed.providers) {
      if (store.getProvider(p.id)) continue;
      // Imported configs obey the same URL policy as hand-entered ones; LAN
      // HTTP is never silently allowed by a file.
      const loopbackOnly = checkBaseUrl(p.baseUrl, false);
      if (!loopbackOnly.ok && !loopbackOnly.needsInsecureConfirm) {
        result.skipped++;
        continue;
      }
      store.saveProvider({ ...(p as ProviderConfig), allowInsecureHttp: loopbackOnly.ok ? p.allowInsecureHttp : false });
      result.providers++;
    }
    const imported = new Set<string>();
    for (const c of parsed.conversations) {
      if (store.importConversation(c as unknown as Conversation)) {
        imported.add(c.id);
        result.conversations++;
      } else {
        result.skipped++;
      }
    }
    for (const m of parsed.messages) {
      if (!imported.has(m.conversationId) || store.getMessage(m.id)) continue;
      store.insertMessage(m as unknown as Message);
      result.messages++;
      for (const part of m.content) {
        if (part.type === 'image') {
          const blob = blobs.get(part.sha256);
          if (blob) attachments.restore(part.sha256, blob);
        }
      }
    }
    for (const o of parsed.modelOverrides) {
      if (store.getProvider(o.providerId) && !store.listModelOverrides().some((x) => x.providerId === o.providerId && x.modelId === o.modelId)) {
        store.setModelOverride(o.providerId, o.modelId, o.capabilities);
      }
    }
    if (parsed.settings) store.importSettings(parsed.settings);
  })();
  return result;
}
