import type { ContentPart, Message, SamplingParams } from '@shared/types';
import type { WireMessage, WirePart } from '../providers/adapter';

// There is no universal tokenizer across providers: estimate characters / 4
// and stay 10% below the model's context size (spec section 8).
const CHARS_PER_TOKEN = 4;
const SAFETY = 0.9;
const IMAGE_TOKENS = 1000;
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(content: ContentPart[]): number {
  let n = PER_MESSAGE_OVERHEAD;
  for (const p of content) n += p.type === 'text' ? Math.ceil(p.text.length / CHARS_PER_TOKEN) : IMAGE_TOKENS;
  return n;
}

export function estimatePath(path: Message[], systemPrompt: string | null): number {
  return path.reduce((sum, m) => sum + estimateTokens(m.content), systemPrompt ? Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD : 0);
}

export interface BuildOptions {
  systemPrompt: string | null;
  contextTokens?: number;
  maxOutputTokens?: number;
  params: SamplingParams;
  /** Resolves an attachment hash to a data URL, or undefined if the file is gone. */
  imageDataUrl(sha256: string, mime: string): string | undefined;
}

export interface BuiltContext {
  messages: WireMessage[];
  dropped: number;
  estimatedTokens: number;
}

function toWire(m: Message, opts: BuildOptions): WireMessage | null {
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return null;
  const hasImage = m.content.some((p) => p.type === 'image');
  if (!hasImage || m.role !== 'user') {
    const text = m.content
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    if (!text && m.role === 'assistant') return null; // empty failed replies are not sent back
    return { role: m.role, content: text };
  }
  const parts: WirePart[] = [];
  for (const p of m.content) {
    if (p.type === 'text') {
      if (p.text) parts.push({ type: 'text', text: p.text });
    } else {
      const url = opts.imageDataUrl(p.sha256, p.mime);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
      else parts.push({ type: 'text', text: '[image attachment unavailable]' });
    }
  }
  return { role: m.role, content: parts };
}

/**
 * Builds the provider request from the active path only: system prompt first,
 * then the thread, trimmed from the oldest messages when it would exceed the
 * context size minus the reply budget. The newest message is always kept.
 */
export function buildContext(path: Message[], opts: BuildOptions): BuiltContext {
  const limit = Math.min(opts.contextTokens ?? Infinity, opts.params.contextLimit ?? Infinity);
  let kept = path.filter((m) => m.role !== 'system');
  let dropped = 0;

  if (Number.isFinite(limit)) {
    const replyBudget = opts.params.maxTokens ?? Math.min(opts.maxOutputTokens ?? 4096, 4096, Math.floor(limit / 4));
    const budget = Math.max(0, Math.floor(limit * SAFETY) - replyBudget);
    let total = estimatePath(kept, opts.systemPrompt);
    while (kept.length > 1 && total > budget) {
      total -= estimateTokens(kept[0].content);
      kept = kept.slice(1);
      dropped++;
    }
    // Never start the thread on an assistant turn after trimming.
    while (dropped > 0 && kept.length > 1 && kept[0].role === 'assistant') {
      kept = kept.slice(1);
      dropped++;
    }
  }

  const messages: WireMessage[] = [];
  if (opts.systemPrompt?.trim()) messages.push({ role: 'system', content: opts.systemPrompt });
  for (const m of kept) {
    const w = toWire(m, opts);
    if (w) messages.push(w);
  }
  return { messages, dropped, estimatedTokens: estimatePath(kept, opts.systemPrompt) };
}
