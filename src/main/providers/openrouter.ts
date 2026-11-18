import { normalizeHttpError, RelayError, relayError } from '../net/errors';
import { buildAuthHeaders, joinUrl, readBody } from '../net/http';
import type { ProviderExtension } from './adapter';

// OpenRouter is plain OpenAI-compatible. The one quirk: GET /models is public,
// so it cannot prove a key is valid. GET /key needs auth (200 for a good key,
// 401 otherwise). Checked against the live API and docs on 2026-11-17.
export const openRouterExtension: ProviderExtension = {
  async validateKey(p) {
    try {
      const res = await p.http.request(joinUrl(p.config.baseUrl, '/key'), {
        headers: { Accept: 'application/json', ...buildAuthHeaders(p.config, p.apiKey) },
        timeoutMs: p.timeouts.connectMs,
      });
      const text = await readBody(res, 15_000);
      if (res.ok) return { ok: true };
      const error = normalizeHttpError(res.status, text, res.headers);
      if (res.status === 404) return { ok: false, unverifiable: true, error };
      return { ok: false, error };
    } catch (e) {
      return { ok: false, error: e instanceof RelayError ? e.normalized : relayError('internal', String(e)).normalized };
    }
  },
};
