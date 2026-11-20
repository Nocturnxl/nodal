import { z } from 'zod';
import type { ChatEvent, ModelInfo } from '@shared/types';
import { extractErrorMessage, normalizeHttpError, parseRateLimit, nodalError, NodalError, requestIdFrom } from '../net/errors';
import { buildAuthHeaders, joinUrl, readBody, readSse } from '../net/http';
import type { ChatRequest, KeyCheckResult, ProviderAdapter, ProviderExtension, ProviderRuntime } from './adapter';
import { ThinkTagParser } from './thinkParser';

// Providers return odd shapes; accept the common ones and fail with a clear message.
const modelEntry = z.looseObject({ id: z.string().min(1) });
const modelListSchema = z.union([
  z.looseObject({ data: z.array(z.unknown()) }).transform((o) => o.data),
  z.looseObject({ models: z.array(z.unknown()) }).transform((o) => o.models),
  z.array(z.unknown()),
]);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Plain OpenAI-style entries carry only an id, so capabilities stay undefined
 * (= unknown). Fields that some aggregators add (OpenRouter-style name,
 * context_length, per-token pricing, modalities, supported_parameters) are
 * picked up when present.
 */
export function mapGenericModel(raw: Record<string, unknown>, providerId: string): ModelInfo | null {
  const parsed = modelEntry.safeParse(raw);
  if (!parsed.success) return null;
  const id = parsed.data.id;
  const info: ModelInfo = {
    id,
    providerId,
    displayName: typeof raw.name === 'string' && raw.name ? raw.name : id,
    capabilities: {},
    raw,
  };
  const ctx = asNumber(raw.context_length) ?? asNumber(raw.context_window) ?? asNumber(raw.max_context_length);
  if (ctx && ctx > 0) info.contextTokens = ctx;

  const pricing = asRecord(raw.pricing);
  const inTok = asNumber(pricing?.prompt);
  const outTok = asNumber(pricing?.completion);
  if (inTok !== undefined || outTok !== undefined) {
    info.pricing = {
      inputPerM: inTok !== undefined ? inTok * 1_000_000 : undefined,
      outputPerM: outTok !== undefined ? outTok * 1_000_000 : undefined,
      currency: 'USD',
    };
  }
  const arch = asRecord(raw.architecture);
  if (Array.isArray(arch?.input_modalities)) info.capabilities.vision = arch.input_modalities.includes('image');
  if (Array.isArray(raw.supported_parameters)) {
    const sp = raw.supported_parameters as unknown[];
    info.capabilities.tools = sp.includes('tools');
    info.capabilities.reasoning = sp.includes('reasoning') || sp.includes('include_reasoning');
    info.capabilities.structuredOutput = sp.includes('structured_outputs') || sp.includes('response_format');
  }
  if (typeof raw.description === 'string' && raw.description) info.details = { description: raw.description };
  return info;
}

const chunkSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z.looseObject({}).nullish(),
        message: z.looseObject({}).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z.looseObject({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() }).nullish(),
  error: z.unknown().optional(),
});

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Adjusts a request body after a server rejected one of its optional fields.
 * Returns true if something changed and the request is worth sending again.
 */
export function adaptBody(body: Record<string, unknown>, message: string): boolean {
  const m = message.toLowerCase();
  const rejects = /unsupported|not supported|unrecognized|unknown|not allowed|not permitted|invalid|extra inputs|does not support|unexpected/.test(m);
  if (!rejects) return false;
  if (m.includes('stream_options') && 'stream_options' in body) {
    delete body.stream_options;
    return true;
  }
  // Newer OpenAI models take max_completion_tokens and refuse max_tokens.
  if (m.includes('max_tokens') && 'max_tokens' in body) {
    if (m.includes('max_completion_tokens')) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    return true;
  }
  for (const field of ['temperature', 'top_p', 'prompt_cache_key', 'venice_parameters']) {
    if (m.includes(field) && field in body) {
      delete body[field];
      return true;
    }
  }
  return false;
}

export function createOpenAiCompatibleAdapter(ext: ProviderExtension = {}): ProviderAdapter {
  const mapModel = ext.mapModel ?? mapGenericModel;

  async function fetchModels(p: ProviderRuntime): Promise<{ models: ModelInfo[]; status: number }> {
    const url = joinUrl(p.config.baseUrl, p.config.modelListPath || '/models', p.config.modelListQuery);
    const res = await p.http.request(url, {
      headers: { Accept: 'application/json', ...buildAuthHeaders(p.config, p.apiKey) },
      timeoutMs: p.timeouts.connectMs,
    });
    const text = await readBody(res, 30_000);
    if (!res.ok) throw new NodalError(normalizeHttpError(res.status, text, res.headers, { requestIdHeaders: ext.requestIdHeaders }));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      const html = extractErrorMessage(text).html;
      throw nodalError('invalid_request', 'The model list was not valid JSON.', {
        status: res.status,
        hint: html ? 'The base URL is probably wrong: it points at a website, not an API endpoint.' : undefined,
        requestId: requestIdFrom(res.headers, ext.requestIdHeaders),
      });
    }
    const list = modelListSchema.safeParse(json);
    if (!list.success) {
      throw nodalError('invalid_request', 'The model list had an unexpected shape (expected { "data": [ { "id": ... } ] }).', { status: res.status });
    }
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const entry of list.data) {
      const rec = asRecord(entry);
      const info = rec ? mapModel(rec, p.config.id) : null;
      if (info && !seen.has(info.id)) {
        seen.add(info.id);
        models.push(info);
      }
    }
    return { models, status: res.status };
  }

  return {
    async listModels(p) {
      return (await fetchModels(p)).models;
    },

    async validateKey(p): Promise<KeyCheckResult> {
      if (ext.validateKey) return ext.validateKey(p);
      // Generic check: an authenticated model-list call. Servers that serve
      // the list without auth cannot prove a key, hence `unverifiable`.
      try {
        const { models } = await fetchModels(p);
        return { ok: true, modelCount: models.length };
      } catch (e) {
        const error = e instanceof NodalError ? e.normalized : nodalError('internal', String(e)).normalized;
        const unverifiable = error.code === 'model_not_found' || (error.code === 'invalid_request' && error.status === 200);
        return { ok: false, error, unverifiable: unverifiable || undefined };
      }
    },

    extensions(model) {
      return ext.extensions?.(model) ?? [];
    },

    async lookup(p, key, search) {
      if (!ext.lookup) throw nodalError('invalid_request', 'This provider has no list for that option.');
      return ext.lookup(p, key, search);
    },

    async *streamChat(p, req: ChatRequest, signal): AsyncIterable<ChatEvent> {
      const body: Record<string, unknown> = {
        model: req.modelId,
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.params.temperature !== undefined) body.temperature = req.params.temperature;
      if (req.params.topP !== undefined) body.top_p = req.params.topP;
      if (req.params.maxTokens !== undefined) body.max_tokens = req.params.maxTokens;
      ext.applyToRequest?.(body, req);

      // Servers differ on a few optional fields. When one rejects a field by
      // name with a 400, drop or rename that field and try again. This happens
      // before any output, so it cannot duplicate text.
      let res!: Awaited<ReturnType<typeof p.http.request>>;
      let meta!: Extract<ChatEvent, { t: 'meta' }>;
      let requestId: string | undefined;
      for (let adjustments = 0; ; adjustments++) {
        res = await p.http.request(joinUrl(p.config.baseUrl, '/chat/completions'), {
          method: 'POST',
          headers: { Accept: 'text/event-stream', ...buildAuthHeaders(p.config, p.apiKey) },
          json: body,
          signal,
          // Some servers hold the headers back until the first token is ready.
          timeoutMs: Math.max(p.timeouts.connectMs, p.timeouts.firstByteMs),
        });
        const now = Date.now();
        requestId = requestIdFrom(res.headers, ext.requestIdHeaders);
        meta = {
          t: 'meta',
          requestId,
          rateLimit: parseRateLimit(res.headers, now),
          ...ext.metaFromHeaders?.(res.headers, now),
        };
        if (res.ok) break;
        const text = await readBody(res, 15_000).catch(() => '');
        if ((res.status === 400 || res.status === 422) && adjustments < 4 && adaptBody(body, extractErrorMessage(text).message ?? text)) continue;
        const err = normalizeHttpError(res.status, text, res.headers, { requestIdHeaders: ext.requestIdHeaders, now });
        if (meta.balance) err.balance = meta.balance;
        throw new NodalError(err);
      }
      yield meta;

      const think = new ThinkTagParser();
      let finishReason: string | undefined;
      let sawDone = false;
      let sawAnything = false;

      const handle = function* (json: unknown): Generator<ChatEvent> {
        const parsed = chunkSchema.safeParse(json);
        if (!parsed.success) return;
        const chunk = parsed.data;
        if (chunk.error) {
          // Some providers report failures inside a 200 stream.
          const { message, code } = extractErrorMessage(JSON.stringify({ error: chunk.error }));
          const status = asNumber(asRecord(chunk.error)?.code);
          throw new NodalError(
            status && status >= 400
              ? { ...normalizeHttpError(status, JSON.stringify({ error: chunk.error }), res.headers), requestId }
              : { code: /context/i.test(code ?? '') ? 'context_length' : 'server', message: message ?? 'The provider reported an error mid-stream.', requestId },
          );
        }
        const choice = chunk.choices?.[0];
        const d = (choice?.delta ?? choice?.message) as Record<string, unknown> | null | undefined;
        if (d) {
          const reasoning = str(d.reasoning_content) || str(d.reasoning);
          if (reasoning) yield { t: 'reasoning', text: reasoning };
          const content = str(d.content);
          if (content) {
            for (const piece of think.feed(content)) {
              yield piece.kind === 'text' ? { t: 'delta', text: piece.text } : { t: 'reasoning', text: piece.text };
            }
          }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const t = asRecord(tc);
              const fn = asRecord(t?.function);
              yield { t: 'tool_call', id: str(t?.id), name: str(fn?.name), argsDelta: str(fn?.arguments) };
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage && (chunk.usage.prompt_tokens != null || chunk.usage.completion_tokens != null)) {
          yield { t: 'usage', promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 };
        }
      };

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // The server ignored `stream: true` and sent one complete response.
        const text = await readBody(res, p.timeouts.firstByteMs + p.timeouts.idleMs);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw nodalError('server', 'The provider sent a response that was not valid JSON.', { requestId });
        }
        yield* handle(json);
        sawAnything = true;
        sawDone = true;
      } else {
        for await (const data of readSse(res, p.timeouts, signal)) {
          if (data.trim() === '[DONE]') {
            sawDone = true;
            break;
          }
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            continue; // tolerate a malformed keep-alive payload
          }
          sawAnything = true;
          yield* handle(json);
        }
      }

      for (const piece of think.flush()) {
        yield piece.kind === 'text' ? { t: 'delta', text: piece.text } : { t: 'reasoning', text: piece.text };
      }
      if (signal.aborted) throw nodalError('cancelled', 'Cancelled');
      if (!sawDone && !finishReason) {
        throw nodalError(
          'network',
          sawAnything ? 'The connection closed before the reply finished.' : 'The server closed the connection without sending a reply.',
          { requestId },
        );
      }
      yield { t: 'done', finishReason: finishReason ?? 'stop' };
    },
  };
}
