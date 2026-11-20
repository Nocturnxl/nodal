import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { KeyCheck, ProviderConfig } from '@shared/types';
import { nodalError } from '../net/errors';
import { checkBaseUrl } from '../net/http';
import { handle, type AppContext } from './register';

export function registerProviderIpc(ctx: AppContext): void {
  const { store, keys, models } = ctx;

  handle(ctx, CH.providersList, schemas.none, () => store.listProviders());

  handle(ctx, CH.providersSave, schemas.providerSave, (input) => {
    const baseUrl = input.baseUrl.replace(/\/+$/, '');
    const verdict = checkBaseUrl(baseUrl, input.allowInsecureHttp);
    if (!verdict.ok) {
      throw nodalError('blocked', verdict.reason ?? 'That base URL is not allowed.', {
        hint: verdict.needsInsecureConfirm ? 'insecure-lan' : undefined,
      });
    }
    if (input.auth.scheme === 'header' && !input.auth.headerName) throw nodalError('invalid_request', 'Enter the header name that carries the key.');
    const existing = input.id ? store.getProvider(input.id) : undefined;
    if (input.id && !existing) throw nodalError('invalid_request', 'That provider no longer exists.');
    // A stored key was entered for one host. Pointing the provider at a
    // different host must not silently send that key there.
    if (existing && new URL(existing.baseUrl).host !== verdict.url!.host) keys.clear(existing.id);
    const path = input.modelListPath ? (input.modelListPath.startsWith('/') ? input.modelListPath : `/${input.modelListPath}`) : '/models';
    const saved = store.saveProvider({ ...(input as Omit<ProviderConfig, 'id'> & { id?: string }), baseUrl, modelListPath: path });
    return { providers: store.listProviders(), saved };
  });

  handle(ctx, CH.providersDelete, schemas.providerDelete, ({ id }) => {
    store.deleteProvider(id); // throws while conversations still use it
    keys.clear(id); // deleting a provider deletes its ciphertext
    return store.listProviders();
  });

  handle(ctx, CH.providersUsage, schemas.providerId, ({ providerId }) => ({ conversations: store.providerUsage(providerId) }));

  handle(ctx, CH.providersReassign, schemas.providerReassign, ({ fromProviderId, toProviderId, modelId }) =>
    store.reassignConversations(fromProviderId, toProviderId, modelId),
  );

  handle(ctx, CH.providersTest, schemas.providerId, async ({ providerId }): Promise<KeyCheck> => {
    const check = await models.validate(providerId);
    return { ...check, saved: keys.status(providerId).present };
  });

  // ----- keys: a key goes in once and never comes back out -----

  handle(ctx, CH.keysSet, schemas.keysSet, async ({ providerId, key, saveAnyway }): Promise<KeyCheck> => {
    const provider = store.getProvider(providerId);
    if (!provider) throw nodalError('invalid_request', 'That provider no longer exists.');
    const trimmed = key.trim();
    if (!trimmed) throw nodalError('invalid_request', 'Enter an API key.');
    const status = keys.storeStatus();
    if (!status.available) return { ok: false, saved: false, error: { code: 'blocked', message: status.reason ?? 'Key storage is unavailable.' } };

    const check = await models.validate(providerId, trimmed);
    // The key is kept only once it validates, unless the user chose "Save anyway".
    if (check.ok || saveAnyway) {
      keys.set(providerId, trimmed);
      return { ...check, saved: true };
    }
    return { ...check, saved: false };
  });

  handle(ctx, CH.keysClear, schemas.providerId, ({ providerId }) => keys.clear(providerId));
  handle(ctx, CH.keysStatus, schemas.providerId, ({ providerId }) => keys.status(providerId));
  handle(ctx, CH.keysStore, schemas.none, () => keys.storeStatus());

  // ----- models -----

  handle(ctx, CH.modelsList, schemas.modelsList, ({ providerId, refresh }) => models.list(providerId, refresh));

  handle(ctx, CH.modelsAddManual, schemas.modelsAddManual, ({ providerId, modelId }) => {
    if (!store.getProvider(providerId)) throw nodalError('invalid_request', 'That provider no longer exists.');
    store.addManualModel(providerId, modelId);
    return models.cached(providerId);
  });

  handle(ctx, CH.modelsRemoveManual, schemas.modelsRemoveManual, ({ providerId, modelId }) => {
    store.removeManualModel(providerId, modelId);
    return models.cached(providerId);
  });

  handle(ctx, CH.modelsOverride, schemas.modelsOverride, ({ providerId, modelId, capabilities }) => {
    store.setModelOverride(providerId, modelId, capabilities);
    return models.cached(providerId);
  });

  handle(ctx, CH.modelsExtensions, schemas.modelRef, ({ providerId, modelId }) => models.extensions(providerId, modelId));

  handle(ctx, CH.modelsLookup, schemas.modelsLookup, ({ providerId, key, search }) => models.lookup(providerId, key, search));
}
