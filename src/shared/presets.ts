import type { PresetId, ProviderConfig } from './types';

export interface Preset {
  id: PresetId | 'custom';
  label: string;
  blurb: string;
  needsKey: boolean;
  keyHelp?: string;
  config: Omit<ProviderConfig, 'id'>;
}

// A preset only prefills the form. Everything goes through the same
// openai-compatible adapter.
export const PRESETS: Preset[] = [
  {
    id: 'venice',
    label: 'Venice.ai',
    blurb: 'Private inference with web search and reasoning controls',
    needsKey: true,
    keyHelp:
      'Create an INFERENCE key in Venice settings. NODAL never needs an ADMIN key, which can manage other keys and billing.',
    config: {
      kind: 'openai-compatible',
      preset: 'venice',
      displayName: 'Venice.ai',
      baseUrl: 'https://api.venice.ai/api/v1',
      auth: { scheme: 'bearer' },
      modelListPath: '/models',
      modelListQuery: { type: 'text' },
      allowInsecureHttp: false,
    },
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    blurb: 'Local server on this machine',
    needsKey: false,
    config: {
      kind: 'openai-compatible',
      preset: 'lmstudio',
      displayName: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      auth: { scheme: 'none' },
      modelListPath: '/models',
      allowInsecureHttp: true,
    },
  },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb: 'Local server on this machine',
    needsKey: false,
    config: {
      kind: 'openai-compatible',
      preset: 'ollama',
      displayName: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      auth: { scheme: 'none' },
      modelListPath: '/models',
      allowInsecureHttp: true,
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb: 'Many models behind one key',
    needsKey: true,
    config: {
      kind: 'openai-compatible',
      preset: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      auth: { scheme: 'bearer' },
      modelListPath: '/models',
      allowInsecureHttp: false,
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'The reference OpenAI API',
    needsKey: true,
    config: {
      kind: 'openai-compatible',
      preset: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      auth: { scheme: 'bearer' },
      modelListPath: '/models',
      allowInsecureHttp: false,
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    blurb: 'Any OpenAI-compatible endpoint',
    needsKey: true,
    config: {
      kind: 'openai-compatible',
      displayName: 'Custom provider',
      baseUrl: '',
      auth: { scheme: 'bearer' },
      modelListPath: '/models',
      allowInsecureHttp: false,
    },
  },
];
