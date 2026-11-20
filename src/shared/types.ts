// Normalized types shared by main, preload and renderer. The renderer only ever
// sees these shapes, never raw provider JSON.

export type PresetId = 'venice' | 'lmstudio' | 'ollama' | 'openrouter' | 'openai';
export type AuthScheme = 'bearer' | 'header' | 'none';

export interface ProviderConfig {
  id: string;
  kind: 'openai-compatible';
  preset?: PresetId;
  displayName: string;
  baseUrl: string;
  auth: { scheme: AuthScheme; headerName?: string };
  extraHeaders?: Record<string, string>;
  modelListPath: string;
  modelListQuery?: Record<string, string>;
  allowInsecureHttp: boolean;
}

export interface Capabilities {
  vision?: boolean;
  reasoning?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  webSearch?: boolean;
}
export const CAPABILITY_KEYS = ['vision', 'reasoning', 'tools', 'structuredOutput', 'webSearch'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface ModelInfo {
  id: string;
  providerId: string;
  displayName: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  /** undefined = unknown: the UI enables the control and marks it "unverified". */
  capabilities: Capabilities;
  /** Capabilities exactly as the provider reported them, before user overrides. */
  reportedCapabilities?: Capabilities;
  pricing?: { inputPerM?: number; outputPerM?: number; currency: string };
  defaults?: { temperature?: number; topP?: number };
  details?: { description?: string; traits?: string[]; privacy?: string; offline?: boolean; beta?: boolean };
  /** Typed in by hand because the endpoint has no usable model list. */
  manual?: boolean;
  /** Kept for debugging, never rendered. Stripped before crossing IPC. */
  raw?: unknown;
}

export interface ModelListResult {
  models: ModelInfo[];
  fetchedAt: number | null;
  fromCache: boolean;
  error?: NormalizedError;
}

export interface RateLimitInfo {
  limitRequests?: number;
  remainingRequests?: number;
  resetRequestsAt?: number; // epoch ms
  limitTokens?: number;
  remainingTokens?: number;
  resetTokensAt?: number; // epoch ms
}

export type ErrorCode =
  | 'invalid_request'
  | 'context_length'
  | 'auth'
  | 'quota'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'blocked'
  | 'busy'
  | 'internal';

export interface NormalizedError {
  code: ErrorCode;
  status?: number;
  /** The provider's own message, verbatim where there is one. */
  message: string;
  requestId?: string;
  /** Milliseconds to wait before retrying, when the provider says. */
  retryAfterMs?: number;
  /** Epoch ms at which a rate limit resets. */
  resetAt?: number;
  /** Extra plain-language hint (e.g. "the base URL is probably wrong"). */
  hint?: string;
  balance?: Record<string, string>;
}

export interface ModelNotice {
  kind: 'deprecation';
  message: string;
  date?: string;
}

export type ChatEvent =
  | { t: 'delta'; text: string }
  | { t: 'reasoning'; text: string }
  | { t: 'tool_call'; id: string; name: string; argsDelta: string }
  | { t: 'usage'; promptTokens: number; completionTokens: number }
  | { t: 'meta'; requestId?: string; rateLimit?: RateLimitInfo; balance?: Record<string, string>; notice?: ModelNotice }
  | { t: 'retry'; attempt: number; delayMs: number; error: NormalizedError }
  | { t: 'done'; finishReason: string }
  | { t: 'error'; error: NormalizedError };

export interface ChatEventBatch {
  streamId: string;
  conversationId: string;
  messageId: string;
  events: ChatEvent[];
}

export interface KeyCheck {
  ok: boolean;
  /** True when the key (or keyless provider) is now stored / usable. */
  saved: boolean;
  /** The provider has no endpoint that can prove the key is valid. */
  unverifiable?: boolean;
  error?: NormalizedError;
  modelCount?: number;
}

export interface KeyStatus {
  present: boolean;
  last4?: string;
}

export interface KeyStoreStatus {
  available: boolean;
  backend: string;
  reason?: string;
}

// ----- provider-specific controls ("Model options") -----

export type ExtensionValue = string | number | boolean;

export interface ExtensionField {
  key: string;
  label: string;
  /** `lookup` is a string chosen from a list the provider serves; the choices come from `models.lookup`. */
  type: 'toggle' | 'enum' | 'number' | 'string' | 'lookup';
  options?: { value: string; label: string }[];
  default: ExtensionValue;
  description?: string;
  /** Shown next to controls that add usage-based charges. */
  costNote?: string;
  advanced?: boolean;
  /** Hide unless another field's value differs from `notEquals`. */
  showWhen?: { key: string; notEquals: ExtensionValue };
  /** The provider did not confirm the capability this control depends on. */
  unverified?: boolean;
}

/** One choice for a `lookup` control. */
export interface ExtensionChoice {
  /** What is stored and sent to the provider. */
  value: string;
  label: string;
  description?: string;
  /** Short facts shown beside the label, such as the model a character uses. */
  badges?: string[];
}

/** Audio made from text, ready to play. */
export interface SpokenAudio {
  mime: string;
  data: Uint8Array;
}

// ----- conversations -----

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; sha256: string; mime: string };

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** User cap on the context sent, in estimated tokens (set by "trim and retry"). */
  contextLimit?: number;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  modelId: string;
  systemPrompt: string | null;
  params: SamplingParams;
  extensions: Record<string, ExtensionValue>;
  activeLeafId: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * finishReason: null while streaming; provider values ('stop', 'length', ...);
 * or NODAL's own: 'cancelled', 'incomplete' (failed mid-stream), 'error'
 * (failed before any text), 'interrupted' (app closed mid-stream).
 */
export interface Message {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: Role;
  content: ContentPart[];
  providerId: string | null;
  modelId: string | null;
  reasoningText: string | null;
  finishReason: string | null;
  usage: Usage | null;
  requestId: string | null;
  error: NormalizedError | null;
  createdAt: number;
}

export interface ConversationDetail {
  conversation: Conversation;
  /** Every node of the message tree, oldest first. */
  messages: Message[];
}

export interface ConversationListItem extends Conversation {
  snippet?: string;
}

export type ChatStartRequest =
  | { mode: 'send'; conversationId: string; text: string; attachments?: { sha256: string; mime: string }[]; /** Said aloud in voice chat: the voice instructions are added to the system prompt for this reply. */ spoken?: boolean }
  | { mode: 'edit'; conversationId: string; messageId: string; text: string }
  | { mode: 'regenerate'; conversationId: string; messageId: string }
  | { mode: 'continue'; conversationId: string; messageId: string };

export interface ChatStartResult {
  streamId: string;
  conversation: Conversation;
  userMessage?: Message;
  assistantMessage: Message;
}

export interface AttachmentRef {
  sha256: string;
  mime: string;
  bytes: number;
}

// ----- settings -----

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  defaultSystemPrompt: string;
  defaultParams: SamplingParams;
  /** Per-provider defaults for extension controls, keyed by provider id. */
  defaultExtensions: Record<string, Record<string, ExtensionValue>>;
  updateCheck: boolean;
  /** Empty = use the system proxy. Otherwise Chromium proxy rules. */
  proxy: string;
  firstByteTimeoutSec: number;
  mathEnabled: boolean;
  lastModel: { providerId: string; modelId: string } | null;
  inspectorOpen: boolean;
  showArchived: boolean;
  /** With encryption on: lock after this many minutes without input, and when the computer locks or sleeps. 0 = never. */
  autoLockMinutes: number;
  /** Added to the system prompt for replies in voice chat: how the model should talk. Empty = nothing added. */
  voiceInstructions: string;
}

export const DEFAULT_VOICE_INSTRUCTIONS =
  'This is a spoken conversation: your reply will be read aloud. Answer the way a person talks, in a few short, natural sentences. Do not use Markdown, lists, tables, headings, emoji or code unless asked for them.';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultSystemPrompt: '',
  defaultParams: {},
  defaultExtensions: {},
  updateCheck: false,
  proxy: '',
  firstByteTimeoutSec: 60,
  mathEnabled: false,
  lastModel: null,
  inspectorOpen: true,
  showArchived: false,
  autoLockMinutes: 15,
  voiceInstructions: DEFAULT_VOICE_INSTRUCTIONS,
};

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataPath: string;
  logPath: string;
  packaged: boolean;
}

export interface ImportResult {
  conversations: number;
  messages: number;
  providers: number;
  skipped: number;
}

/** A passphrase-protected export was chosen: ask for its passphrase and call import again with the token. */
export interface ImportLocked {
  locked: true;
  token: string;
}

export interface VaultStatus {
  /** Chats on this computer are encrypted with a passphrase. */
  enabled: boolean;
  /** The passphrase has been given this session (always true when encryption is off). */
  unlocked: boolean;
  /** Delete all chats after this many wrong passphrases in a row. 0 = never. */
  wipeAfter: number;
  /** Wrong passphrases since the last right one. */
  failures: number;
}

export interface UnlockResult {
  ok: boolean;
  /** That was one wrong passphrase too many: the chats were deleted and NODAL has started empty. */
  wiped: boolean;
  /** Wrong passphrases left before the chats are deleted, or null when that option is off. */
  remaining: number | null;
}

export interface ProviderUsage {
  conversations: number;
}
