import type { ExtensionField, KeyCheck, ModelInfo, ModelListResult, ProviderConfig } from '@shared/types';
import { MODEL_CACHE_TTL_MS, Store } from './db/store';
import { nodalError, toNormalized } from './net/errors';
import type { Http, Timeouts } from './net/http';
import { checkBaseUrl } from './net/http';
import type { ProviderRuntime } from './providers/adapter';
import { adapterFor } from './providers/registry';
import type { KeyStore } from './secrets/keystore';

/** `raw` is for debugging in main only; it never crosses IPC. */
function strip(models: ModelInfo[]): ModelInfo[] {
  return models.map(({ raw: _raw, ...rest }) => rest);
}

export class ModelService {
  constructor(
    private readonly store: Store,
    private readonly keys: KeyStore,
    private readonly http: Http,
    private readonly timeouts: () => Timeouts,
    private readonly now: () => number = Date.now,
  ) {}

  runtime(config: ProviderConfig, apiKey?: string): ProviderRuntime {
    const verdict = checkBaseUrl(config.baseUrl, config.allowInsecureHttp);
    if (!verdict.ok) throw nodalError('blocked', verdict.reason ?? 'The provider URL is not allowed.');
    const key = apiKey ?? (config.auth.scheme === 'none' ? undefined : this.keys.get(config.id));
    return { config, apiKey: key, http: this.http, timeouts: this.timeouts() };
  }

  private provider(id: string): ProviderConfig {
    const p = this.store.getProvider(id);
    if (!p) throw nodalError('invalid_request', 'That provider no longer exists.');
    return p;
  }

  cached(providerId: string, error?: ModelListResult['error']): ModelListResult {
    return { models: strip(this.store.listModels(providerId)), fetchedAt: this.store.modelsFetchedAt(providerId), fromCache: true, error };
  }

  /** Cached for 24 h; refreshed on demand. A failed refresh falls back to the cache plus the error. */
  async list(providerId: string, refresh = false): Promise<ModelListResult> {
    const config = this.provider(providerId);
    const fetchedAt = this.store.modelsFetchedAt(providerId);
    const fresh = fetchedAt !== null && this.now() - fetchedAt < MODEL_CACHE_TTL_MS;
    if (fresh && !refresh) return this.cached(providerId);
    try {
      const models = await adapterFor(config).listModels(this.runtime(config));
      this.store.replaceModelCache(providerId, models);
      return { ...this.cached(providerId), fromCache: false };
    } catch (e) {
      return this.cached(providerId, toNormalized(e));
    }
  }

  extensions(providerId: string, modelId: string): ExtensionField[] {
    const config = this.provider(providerId);
    const model = this.store.getModel(providerId, modelId) ?? { id: modelId, providerId, displayName: modelId, capabilities: {} };
    return adapterFor(config).extensions(model);
  }

  /** Validates `candidateKey` (or the stored key) with an authenticated call. */
  async validate(providerId: string, candidateKey?: string): Promise<Omit<KeyCheck, 'saved'>> {
    const config = this.provider(providerId);
    try {
      const check = await adapterFor(config).validateKey(this.runtime(config, candidateKey));
      if (check.ok && check.modelCount === undefined) {
        // Count models with the same credentials for the success screen.
        try {
          const models = await adapterFor(config).listModels(this.runtime(config, candidateKey));
          this.store.replaceModelCache(providerId, models);
          return { ...check, modelCount: models.length };
        } catch {
          return check;
        }
      }
      return check;
    } catch (e) {
      return { ok: false, error: toNormalized(e) };
    }
  }
}
