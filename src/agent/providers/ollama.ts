import { JUDGE_JSON_SCHEMA, type LlmCompletion, type LlmProvider } from '../types.js';
import { DEFAULT_TIMEOUT_MS, postJson } from './http.js';

export interface OllamaConfig {
  /** default: http://localhost:11434 */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string | null };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Local models via Ollama's /api/chat endpoint. */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(readonly cfg: OllamaConfig) {
    this.model = cfg.model;
    // Local models are slow; give them a longer default budget.
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS * 3;
  }

  async complete(system: string, user: string): Promise<LlmCompletion> {
    const body = await postJson<OllamaChatResponse>({
      provider: this.name,
      url: `${this.cfg.baseUrl}/api/chat`,
      headers: {},
      timeoutMs: this.timeoutMs,
      body: {
        model: this.model,
        stream: false,
        format: JUDGE_JSON_SCHEMA,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });

    const text = body.message?.content ?? '';
    if (!text) throw new Error('ollama returned an empty message');
    return {
      text,
      inputTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
    };
  }
}
