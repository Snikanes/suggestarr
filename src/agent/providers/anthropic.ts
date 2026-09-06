import { JUDGE_JSON_SCHEMA, type LlmCompletion, type LlmProvider } from '../types.js';
import { DEFAULT_TIMEOUT_MS, postJson } from './http.js';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** default: https://api.anthropic.com */
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * How hard the model thinks: low | medium | high | xhigh | max.
   * Unset leaves the API default (high). Thinking is on by default on
   * current models and its tokens count toward max_tokens, so this is
   * the cost dial for a judging batch.
   */
  effort?: string;
}

interface AnthropicMessageResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(readonly cfg: AnthropicConfig) {
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com';
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Generous, because thinking tokens are billed as output and count
    // against this ceiling — 4096 truncates a batch of verdicts.
    this.maxTokens = cfg.maxTokens ?? 16_000;
  }

  async complete(system: string, user: string): Promise<LlmCompletion> {
    const body = await postJson<AnthropicMessageResponse>({
      provider: this.name,
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeoutMs: this.timeoutMs,
      body: {
        model: this.model,
        max_tokens: this.maxTokens,
        // No temperature/top_p: sampling parameters were removed on the
        // current models and sending them is a 400, not a warning.
        // Structured output: the API enforces the verdict schema, so a
        // prose reply cannot happen in the first place.
        output_config: {
          ...(this.cfg.effort ? { effort: this.cfg.effort } : {}),
          format: { type: 'json_schema', schema: JUDGE_JSON_SCHEMA },
        },
        system,
        messages: [{ role: 'user', content: user }],
      },
    });

    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text) throw new Error('anthropic returned no text content');
    return {
      text,
      inputTokens: body.usage?.input_tokens ?? null,
      outputTokens: body.usage?.output_tokens ?? null,
    };
  }
}
