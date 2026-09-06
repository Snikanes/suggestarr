import { JUDGE_JSON_SCHEMA, type LlmCompletion, type LlmProvider } from '../types.js';
import { DEFAULT_TIMEOUT_MS, postJson } from './http.js';

export interface OpenAiConfig {
  /** API root including version, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI-compatible chat completions (also covers OpenAI-compatible gateways). */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(readonly cfg: OpenAiConfig) {
    this.model = cfg.model;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(system: string, user: string): Promise<LlmCompletion> {
    const body = await postJson<OpenAiChatResponse>({
      provider: this.name,
      url: `${this.cfg.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      timeoutMs: this.timeoutMs,
      body: {
        model: this.model,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'judge_verdicts', strict: true, schema: JUDGE_JSON_SCHEMA },
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });

    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('openai returned an empty completion');
    return {
      text,
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    };
  }
}
