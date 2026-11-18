import type { ProviderConfig } from '@shared/types';
import type { ProviderAdapter } from './adapter';
import { createOpenAiCompatibleAdapter } from './openaiCompatible';
import { openRouterExtension } from './openrouter';
import { veniceExtension } from './venice';

const generic = createOpenAiCompatibleAdapter();
const venice = createOpenAiCompatibleAdapter(veniceExtension);
const openRouter = createOpenAiCompatibleAdapter(openRouterExtension);

/** Adapter lookup. Later kinds ('anthropic', 'google') get their own adapter here. */
export function adapterFor(config: Pick<ProviderConfig, 'kind' | 'preset'>): ProviderAdapter {
  if (config.preset === 'venice') return venice;
  if (config.preset === 'openrouter') return openRouter;
  return generic;
}
