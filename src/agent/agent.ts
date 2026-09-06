import {
  AgentError,
  RawJudgeResponseSchema,
  type JudgeRequest,
  type JudgeResult,
  type LlmProvider,
  type RawJudgeResponse,
  type Verdict,
} from './types.js';
import { buildPrompt, PROMPT_VERSION, tasteHash } from './prompt.js';

/**
 * The judgment orchestrator: prompt -> LLM call -> strict parse -> one
 * self-healing retry -> verdicts. Candidates the model forgets are
 * treated as dropped ("no verdict") so a bad answer never silently
 * over-approves; a completely unparseable answer is an AgentError.
 */
export class AgentClient {
  constructor(readonly provider: LlmProvider) {}

  async judge(req: JudgeRequest): Promise<JudgeResult> {
    if (req.candidates.length === 0) {
      return {
        verdicts: [],
        provider: this.provider.name,
        model: this.provider.model,
        promptVersion: PROMPT_VERSION,
        tasteHash: tasteHash(req),
        attempts: 0,
        inputTokens: null,
        outputTokens: null,
      };
    }

    const { system, user } = buildPrompt(req);

    let completion = await this.provider.complete(system, user);
    let inputTokens = completion.inputTokens;
    let outputTokens = completion.outputTokens;
    let attempts = 1;
    let parsed = tryParse(completion.text);

    if (!parsed) {
      const retryUser = [
        user,
        '',
        `Your previous reply was not usable: ${parseFailureMessage(completion.text)}`,
        'Reply again with ONLY the JSON object described above.',
      ].join('\n');
      completion = await this.provider.complete(system, retryUser);
      attempts = 2;
      inputTokens = addTokens(inputTokens, completion.inputTokens);
      outputTokens = addTokens(outputTokens, completion.outputTokens);
      parsed = tryParse(completion.text);
    }

    if (!parsed) {
      throw new AgentError(
        `LLM produced no parseable verdicts after ${attempts} attempts: ${parseFailureMessage(completion.text)}`,
        completion.text,
      );
    }

    return {
      verdicts: completeVerdicts(parsed.decisions, req),
      provider: this.provider.name,
      model: this.provider.model,
      promptVersion: PROMPT_VERSION,
      tasteHash: tasteHash(req),
      attempts,
      inputTokens,
      outputTokens,
    };
  }
}

/** null + null stays null; otherwise unknown halves count as zero. */
function addTokens(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Extract and validate the JSON object from raw LLM text. */
function tryParse(raw: string): RawJudgeResponse | undefined {
  const text = stripFences(raw);
  try {
    return RawJudgeResponseSchema.parse(JSON.parse(text));
  } catch {
    // fall through to brace-matching extraction
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return RawJudgeResponseSchema.parse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

/** Some models wrap JSON in ```json fences despite instructions. */
function stripFences(raw: string): string {
  const t = raw.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fence?.[1] ?? t).trim();
}

function parseFailureMessage(raw: string): string {
  if (!raw.trim()) return 'the reply was empty';
  try {
    JSON.parse(stripFences(raw));
    return 'JSON is well-formed but does not match the required schema';
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Ensure exactly one verdict per candidate: dedupe by remote_id (last
 * wins), drop verdicts for candidates we never asked about, and turn any
 * forgotten candidate into a conservative drop.
 */
function completeVerdicts(decisions: RawJudgeResponse['decisions'], req: JudgeRequest): Verdict[] {
  const byRemoteId = new Map<number, Verdict>();
  for (const d of decisions) {
    byRemoteId.set(d.remote_id, { remoteId: d.remote_id, keep: d.keep, reason: d.reason });
  }
  return req.candidates.map(
    (c) =>
      byRemoteId.get(c.remoteId) ?? {
        remoteId: c.remoteId,
        keep: false,
        reason: 'agent returned no verdict for this title',
      },
  );
}
