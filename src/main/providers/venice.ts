import type { ExtensionChoice, ExtensionField, ModelInfo } from '@shared/types';
import { normalizeHttpError, NodalError, nodalError } from '../net/errors';
import { buildAuthHeaders, joinUrl, readBody } from '../net/http';
import type { ProviderExtension, ProviderRuntime } from './adapter';

// Venice = the OpenAI-compatible adapter plus this module. Facts are from the
// Venice API reference (read 2026-11-16) and a live GET /models response.
// GET /characters is from the reference as read on 2026-11-20, where it is
// marked a preview API that may change; it has not been run against the live
// service with a key.

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function mapVeniceModel(raw: Record<string, unknown>, providerId: string): ModelInfo | null {
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.type === 'string' && raw.type !== 'text') return null; // chat picker shows text models only
  const spec = rec(raw.model_spec) ?? {};
  const caps = rec(spec.capabilities);
  const constraints = rec(spec.constraints);
  const pricing = rec(spec.pricing);
  const inUsd = num(rec(pricing?.input)?.usd);
  const outUsd = num(rec(pricing?.output)?.usd);
  const temperature = num(rec(constraints?.temperature)?.default);
  const topP = num(rec(constraints?.top_p)?.default);

  return {
    id: raw.id,
    providerId,
    displayName: typeof spec.name === 'string' && spec.name ? spec.name : raw.id,
    contextTokens: num(spec.availableContextTokens) ?? num(raw.context_length),
    maxOutputTokens: num(spec.maxCompletionTokens),
    capabilities: caps
      ? {
          vision: bool(caps.supportsVision),
          reasoning: bool(caps.supportsReasoning),
          tools: bool(caps.supportsFunctionCalling),
          structuredOutput: bool(caps.supportsResponseSchema),
          webSearch: bool(caps.supportsWebSearch),
        }
      : {},
    // Venice documents pricing as USD per million tokens.
    pricing: inUsd !== undefined || outUsd !== undefined ? { inputPerM: inUsd, outputPerM: outUsd, currency: 'USD' } : undefined,
    defaults: temperature !== undefined || topP !== undefined ? { temperature, topP } : undefined,
    details: {
      description: typeof spec.description === 'string' ? spec.description : undefined,
      traits: Array.isArray(spec.traits) ? spec.traits.filter((t): t is string => typeof t === 'string') : undefined,
      privacy: typeof spec.privacy === 'string' ? spec.privacy : undefined,
      offline: bool(spec.offline),
      beta: bool(spec.betaModel),
    },
    raw, // other flags (supportsReasoningEffort, supportsE2EE, ...) stay here for later use
  };
}

const SEARCH_COST = 'Adds usage-based charges per the Venice docs.';

function supportsXSearch(model: ModelInfo): boolean {
  const caps = rec(rec(rec(model.raw)?.model_spec)?.capabilities);
  if (typeof caps?.supportsXSearch === 'boolean') return caps.supportsXSearch;
  return /grok/i.test(model.id);
}

export function veniceExtensions(model: ModelInfo): ExtensionField[] {
  const fields: ExtensionField[] = [];
  const { webSearch, reasoning } = model.capabilities;

  if (webSearch !== false) {
    fields.push({
      key: 'enable_web_search',
      label: 'Web search',
      type: 'enum',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'auto', label: 'Auto' },
        { value: 'on', label: 'On' },
      ],
      default: 'off',
      costNote: SEARCH_COST,
      unverified: webSearch === undefined,
    });
    fields.push({
      key: 'enable_web_citations',
      label: 'Web citations',
      type: 'toggle',
      default: false,
      description: 'Ask the model to cite its web sources.',
      showWhen: { key: 'enable_web_search', notEquals: 'off' },
    });
  }
  fields.push({
    key: 'enable_web_scraping',
    label: 'Scrape URLs in message',
    type: 'toggle',
    default: false,
    description: 'Fetches up to 5 URLs found in your message.',
    costNote: SEARCH_COST,
  });
  fields.push({
    key: 'include_venice_system_prompt',
    label: 'Venice system prompt',
    type: 'toggle',
    // Off by default: measured live, it adds about 1,700 prompt tokens to every request.
    default: false,
    description: "Include Venice's default system prompt alongside yours. Adds about 1,700 prompt tokens to every request.",
  });
  if (reasoning !== false) {
    fields.push({
      key: 'strip_thinking_response',
      label: 'Strip thinking from reply',
      type: 'toggle',
      default: false,
      unverified: reasoning === undefined,
    });
    fields.push({
      key: 'disable_thinking',
      label: 'Disable thinking',
      type: 'toggle',
      default: false,
      unverified: reasoning === undefined,
    });
  }
  if (supportsXSearch(model)) {
    fields.push({ key: 'enable_x_search', label: 'X search', type: 'toggle', default: false, costNote: SEARCH_COST });
  }
  fields.push({
    key: 'character_slug',
    label: 'Character',
    type: 'lookup',
    default: '',
    description: 'Chat with a public Venice character.',
    advanced: true,
  });
  return fields;
}

const CHARACTER_LIMIT = 50;

/** One entry of GET /characters as a choice. The slug is what chat requests send. */
export function mapVeniceCharacter(raw: unknown): ExtensionChoice | null {
  const c = rec(raw);
  if (!c || typeof c.slug !== 'string' || !c.slug.trim()) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : undefined);
  const badges: string[] = [];
  if (c.adult === true) badges.push('18+');
  const model = text(c.modelId, 80);
  if (model) badges.push(model);
  return {
    value: c.slug.trim(),
    label: text(c.name, 120) ?? c.slug.trim(),
    description: text(c.description, 240),
    badges: badges.length ? badges : undefined,
  };
}

async function listCharacters(p: ProviderRuntime, search: string): Promise<ExtensionChoice[]> {
  const query = new URLSearchParams({ limit: String(CHARACTER_LIMIT) });
  if (search) query.set('search', search.slice(0, 200));
  const res = await p.http.request(`${joinUrl(p.config.baseUrl, '/characters')}?${query}`, {
    headers: { Accept: 'application/json', ...buildAuthHeaders(p.config, p.apiKey) },
    timeoutMs: p.timeouts.connectMs,
  });
  const body = await readBody(res, 30_000);
  if (!res.ok) {
    const error = normalizeHttpError(res.status, body, res.headers, { requestIdHeaders: ['cf-ray'] });
    // Without credentials Venice answers 402 with a payment challenge.
    if (res.status === 402) throw new NodalError({ ...error, code: 'auth', message: 'Venice needs a valid API key to list characters.' });
    throw new NodalError(error);
  }
  let data: unknown;
  try {
    data = rec(JSON.parse(body))?.data;
  } catch {
    data = undefined;
  }
  if (!Array.isArray(data)) throw nodalError('invalid_request', 'The character list had an unexpected shape.', { status: res.status });
  const seen = new Set<string>();
  const out: ExtensionChoice[] = [];
  for (const entry of data) {
    const choice = mapVeniceCharacter(entry);
    if (choice && !seen.has(choice.value)) {
      seen.add(choice.value);
      out.push(choice);
    }
  }
  return out;
}

export const veniceExtension: ProviderExtension = {
  mapModel: mapVeniceModel,
  extensions: veniceExtensions,

  async lookup(p, key, search) {
    if (key !== 'character_slug') throw nodalError('invalid_request', 'Venice has no list for that option.');
    return listCharacters(p, search);
  },
  requestIdHeaders: ['cf-ray'],

  applyToRequest(body, req) {
    // Only documented fields are sent, as an object (never model-name suffixes).
    const fields = req.model ? veniceExtensions(req.model) : veniceExtensions({ id: req.modelId, providerId: '', displayName: req.modelId, capabilities: {} });
    const value = (key: string) => req.extensions[key] ?? fields.find((f) => f.key === key)?.default;
    const params: Record<string, unknown> = {};
    for (const f of fields) {
      const v = value(f.key);
      if (f.showWhen && value(f.showWhen.key) === f.showWhen.notEquals) continue;
      if (f.type === 'string' || f.type === 'lookup') {
        if (typeof v === 'string' && v.trim()) params[f.key] = v.trim();
      } else if (v !== undefined) {
        params[f.key] = v;
      }
    }
    body.venice_parameters = params;
    // Top-level field: routes a multi-turn chat to the same backend for cache hits.
    body.prompt_cache_key = req.conversationId;
  },

  metaFromHeaders(headers) {
    const balance: Record<string, string> = {};
    const usd = headers.get('x-venice-balance-usd');
    const diem = headers.get('x-venice-balance-diem');
    if (usd) balance.USD = usd;
    if (diem) balance.DIEM = diem;
    const warning = headers.get('x-venice-model-deprecation-warning');
    const date = headers.get('x-venice-model-deprecation-date') ?? undefined;
    return {
      balance: Object.keys(balance).length ? balance : undefined,
      notice: warning || date ? { kind: 'deprecation', message: warning || 'This model is being retired.', date } : undefined,
    };
  },

  // GET /models is readable without a key, so it cannot prove a key is valid.
  // GET /api_keys/rate_limits needs auth: 200 for a good key, 401 for a bad
  // one, 402 (payment challenge) when no credentials are recognised.
  async validateKey(p) {
    try {
      const res = await p.http.request(joinUrl(p.config.baseUrl, '/api_keys/rate_limits'), {
        headers: { Accept: 'application/json', ...buildAuthHeaders(p.config, p.apiKey) },
        timeoutMs: p.timeouts.connectMs,
      });
      const text = await readBody(res, 15_000);
      if (res.ok) return { ok: true };
      const error = normalizeHttpError(res.status, text, res.headers, { requestIdHeaders: ['cf-ray'] });
      if (res.status === 402 && /authentication required/i.test(text)) {
        return { ok: false, error: { ...error, code: 'auth', message: 'Authentication required: Venice did not recognise this API key.' } };
      }
      if (res.status === 404) return { ok: false, unverifiable: true, error };
      return { ok: false, error };
    } catch (e) {
      return { ok: false, error: e instanceof NodalError ? e.normalized : nodalError('internal', String(e)).normalized };
    }
  },
};
