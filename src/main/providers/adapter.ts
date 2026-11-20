import type { ChatEvent, ExtensionChoice, ExtensionField, SpokenAudio, ExtensionValue, KeyCheck, ModelInfo, ProviderConfig, SamplingParams } from '@shared/types';
import type { Http, Timeouts } from '../net/http';

/** Everything an adapter needs for one call. The key lives here only for the call's duration. */
export interface ProviderRuntime {
  config: ProviderConfig;
  apiKey?: string;
  http: Http;
  timeouts: Timeouts;
}

export type WirePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | WirePart[];
}

export interface ChatRequest {
  modelId: string;
  /** Cached metadata for the model, when the provider's list has it. */
  model?: ModelInfo;
  messages: WireMessage[];
  params: SamplingParams;
  extensions: Record<string, ExtensionValue>;
  conversationId: string;
}

/** Speech services a provider offers beside chat. Voice chat needs both. */
export interface SpeechServices {
  /** A recording to the words spoken in it. Empty when nothing was said. */
  transcribe(p: ProviderRuntime, audio: { mime: string; data: Uint8Array }): Promise<string>;
  speak(p: ProviderRuntime, text: string): Promise<SpokenAudio>;
}

export type KeyCheckResult = Omit<KeyCheck, 'saved'>;

export interface ProviderAdapter {
  validateKey(p: ProviderRuntime): Promise<KeyCheckResult>;
  listModels(p: ProviderRuntime): Promise<ModelInfo[]>;
  /** Yields normalized events and throws NodalError on failure. */
  streamChat(p: ProviderRuntime, req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** Provider-specific controls for the "Model options" panel. */
  extensions(model: ModelInfo): ExtensionField[];
  /** Choices for a `lookup` control. Throws for a key the provider has no list for. */
  lookup(p: ProviderRuntime, key: string, search: string): Promise<ExtensionChoice[]>;
  /** Present only for providers with speech-to-text and text-to-speech. */
  speech?: SpeechServices;
}

/**
 * A provider's quirks, plugged into the shared OpenAI-compatible adapter.
 * Adding one never touches the core chat code or shared UI.
 */
export interface ProviderExtension {
  mapModel?(raw: Record<string, unknown>, providerId: string): ModelInfo | null;
  extensions?(model: ModelInfo): ExtensionField[];
  lookup?(p: ProviderRuntime, key: string, search: string): Promise<ExtensionChoice[]>;
  speech?: SpeechServices;
  applyToRequest?(body: Record<string, unknown>, req: ChatRequest): void;
  metaFromHeaders?(headers: Headers, now: number): Partial<Extract<ChatEvent, { t: 'meta' }>>;
  requestIdHeaders?: string[];
  validateKey?(p: ProviderRuntime): Promise<KeyCheckResult>;
}
