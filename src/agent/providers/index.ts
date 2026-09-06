import type { LlmProvider } from '../types.js';
import type { LlmConfig } from '../../config.js';
import { AnthropicProvider } from './anthropic.js';
import { HeuristicProvider } from './mock.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiProvider } from './openai.js';

export { AnthropicProvider } from './anthropic.js';
export { HeuristicProvider, ScriptedProvider } from './mock.js';
export { OllamaProvider } from './ollama.js';
export { OpenAiProvider } from './openai.js';
export { DEFAULT_TIMEOUT_MS, LlmApiError, LlmTimeoutError, postJson } from './http.js';

/**
 * Build the configured backend. `mock` needs no key and no network, so
 * MOCK_MODE runs and CI use the same code path as production.
 */
export function createProvider(cfg: LlmConfig): LlmProvider {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAiProvider({
        baseUrl: cfg.baseUrl,
        apiKey: requireKey(cfg),
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      });
    case 'anthropic':
      return new AnthropicProvider({
        baseUrl: cfg.baseUrl,
        apiKey: requireKey(cfg),
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        ...(cfg.effort ? { effort: cfg.effort } : {}),
      });
    case 'ollama':
      return new OllamaProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      });
    case 'mock':
      return new HeuristicProvider();
  }
}

function requireKey(cfg: LlmConfig): string {
  if (!cfg.apiKey) {
    throw new Error(`LLM_API_KEY is required when LLM_PROVIDER=${cfg.provider}`);
  }
  return cfg.apiKey;
}
