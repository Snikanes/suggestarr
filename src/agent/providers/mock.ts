import type { LlmCompletion, LlmProvider } from '../types.js';

/**
 * Deterministic provider that replays a queue of raw responses — used by
 * the unit tests, where it stands in for any real LLM so CI needs zero
 * API credentials.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'mock-1';

  /** raw completions returned in order; the last one repeats if exhausted */
  private readonly queue: string[];
  readonly calls: { system: string; user: string }[] = [];

  constructor(responses: string[]) {
    this.queue = [...responses];
  }

  async complete(system: string, user: string): Promise<LlmCompletion> {
    this.calls.push({ system, user });
    const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return { text: next ?? '', inputTokens: 10, outputTokens: 5 };
  }
}

/**
 * Offline stand-in for a real judge: reads the candidate lines back out
 * of the rendered prompt and keeps anything rated 7.0+. Drives MOCK_MODE
 * runs and the fully-mocked e2e pipeline without a network.
 *
 * Unreleased films are kept regardless of score, mirroring the
 * instruction the real judge gets — they have no rating yet, and
 * dropping them for that would defeat the upcoming source.
 */
export class HeuristicProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'heuristic-1';

  constructor(readonly keepAtRating = 7) {}

  async complete(_system: string, user: string): Promise<LlmCompletion> {
    const decisions: unknown[] = [];
    const lines = user.split('\n');

    for (const [i, line] of lines.entries()) {
      const head = line.match(/remote_id=(\d+) title="([^"]*)"/);
      if (!head) continue;
      const unreleased = line.includes('status=unreleased');
      const ratingMatch = lines[i + 1]?.match(/rating=([\d.]+)/);
      const rating = ratingMatch ? Number(ratingMatch[1]) : 0;
      const keep = unreleased || rating >= this.keepAtRating;
      decisions.push({
        remote_id: Number(head[1]),
        keep,
        reason: unreleased
          ? `mock judge: "${head[2]}" is not out yet — queued on premise, not on score`
          : keep
            ? `mock judge: "${head[2]}" rates ${rating.toFixed(1)}, at or above the ${this.keepAtRating} bar`
            : `mock judge: "${head[2]}" rates ${rating.toFixed(1)}, below the ${this.keepAtRating} bar`,
      });
    }

    const text = JSON.stringify({ decisions });
    return { text, inputTokens: user.length, outputTokens: text.length };
  }
}
