import { z } from 'zod';
import type { Candidate } from '../tmdb/types.js';
import type { Title } from '../arr/types.js';

/** One verdict for one candidate, as returned by (and verified from) the agent. */
export interface Verdict {
  remoteId: number;
  keep: boolean;
  reason: string;
}

/** What the LLM is asked to output — snake_case, one object per call. */
export const RawVerdictSchema = z.object({
  remote_id: z.number().int().nonnegative(),
  keep: z.boolean(),
  reason: z.string().min(1),
});

export const RawJudgeResponseSchema = z.object({
  decisions: z.array(RawVerdictSchema).min(1),
});

export type RawJudgeResponse = z.infer<typeof RawJudgeResponseSchema>;

/** Everything the agent needs to make its call. */
export interface JudgeRequest {
  candidates: Candidate[];
  library: Title[];
  /** optional human taste notes (M5 feeds this from the learned profile) */
  userNotes?: string;
  /** TMDB genre id -> display name, for readable prompts */
  genreNames?: Record<number, string>;
}

export interface JudgeResult {
  verdicts: Verdict[];
  provider: string;
  model: string;
  promptVersion: string;
  /** sha256 prefix of the taste snapshot the prompt was rendered with */
  tasteHash: string;
  /** how many provider calls it took (2 = one schema-failure retry) */
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** One assistant reply plus whatever usage accounting the provider reported. */
export interface LlmCompletion {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * The verdict shape, as JSON Schema, for providers that can *enforce* an
 * output format rather than being asked nicely in the prompt.
 *
 * The parser and the self-healing retry stay in place regardless — this
 * removes a class of failure, it does not remove the need to check.
 */
export const JUDGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['remote_id', 'keep', 'reason'],
        properties: {
          remote_id: { type: 'integer' },
          keep: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Provider-agnostic LLM backend. M3 ships OpenAI / Anthropic / Ollama. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** One chat completion; returns the assistant text and token usage. */
  complete(system: string, user: string): Promise<LlmCompletion>;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
