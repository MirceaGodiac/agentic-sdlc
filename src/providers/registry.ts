import { CursorAdapter } from './cursor.js';
import { getApiKey, requireApiKey } from './keys.js';
import { OpenAIAdapter } from './openai.js';
import type { ProviderRegistry } from './types.js';

export function defaultProviders(): ProviderRegistry {
  return {
    openai: new OpenAIAdapter({ apiKey: async () => requireApiKey('openai') }),
    cursor: new CursorAdapter({ apiKey: async () => getApiKey('cursor') }),
  };
}
