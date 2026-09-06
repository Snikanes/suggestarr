import { describe, expect, it } from 'vitest';
import { AgentClient } from '../../src/agent/agent.js';
import { PROMPT_VERSION, tasteHash } from '../../src/agent/prompt.js';
import { AgentError } from '../../src/agent/types.js';
import { HeuristicProvider, ScriptedProvider } from '../../src/agent/providers/index.js';
import {
  candidatesFixture,
  dudCandidate,
  fullDecisionsJson,
  inceptionCandidate,
  libraryFixture,
  matrixCandidate,
} from '../fixtures/agent.js';

const req = { candidates: candidatesFixture, library: libraryFixture };

describe('AgentClient.judge', () => {
  it('returns one verdict per candidate, in candidate order', async () => {
    const provider = new ScriptedProvider([fullDecisionsJson()]);
    const result = await new AgentClient(provider).judge(req);

    expect(result.verdicts).toEqual([
      { remoteId: 603, keep: true, reason: 'Anchor sci-fi, missing from the shelf.' },
      { remoteId: 999, keep: false, reason: 'Weak ratings, thin premise.' },
      { remoteId: 27205, keep: true, reason: 'Nolan, and it matches the sci-fi they own.' },
    ]);
    expect(result.provider).toBe('scripted');
    expect(result.model).toBe('mock-1');
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('sums token usage across attempts', async () => {
    const single = await new AgentClient(new ScriptedProvider([fullDecisionsJson()])).judge(req);
    expect(single.inputTokens).toBe(10);
    expect(single.outputTokens).toBe(5);

    const retried = await new AgentClient(
      new ScriptedProvider(['not json at all', fullDecisionsJson()]),
    ).judge(req);
    expect(retried.attempts).toBe(2);
    expect(retried.inputTokens).toBe(20);
    expect(retried.outputTokens).toBe(10);
  });

  it('strips ```json fences', async () => {
    const provider = new ScriptedProvider(['```json\n' + fullDecisionsJson() + '\n```']);
    const result = await new AgentClient(provider).judge(req);
    expect(result.verdicts[0]?.keep).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it('extracts the JSON object out of surrounding prose', async () => {
    const provider = new ScriptedProvider([
      `Sure! Here are my picks:\n${fullDecisionsJson()}\nHope that helps.`,
    ]);
    const result = await new AgentClient(provider).judge(req);
    expect(result.verdicts).toHaveLength(3);
    expect(provider.calls).toHaveLength(1);
  });

  it('retries once on a schema failure and reports the reason to the model', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ decisions: [{ remote_id: 603, keep: 'yes' }] }),
      fullDecisionsJson(),
    ]);
    const result = await new AgentClient(provider).judge(req);

    expect(result.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.user).toMatch(/does not match the required schema/);
    expect(provider.calls[1]?.user).toMatch(/ONLY the JSON object/);
    expect(result.verdicts).toHaveLength(3);
  });

  it('retries once on malformed JSON', async () => {
    const provider = new ScriptedProvider(['{"decisions": [', fullDecisionsJson()]);
    const result = await new AgentClient(provider).judge(req);
    expect(result.attempts).toBe(2);
    expect(result.verdicts).toHaveLength(3);
  });

  it('reports an empty reply as such on the retry', async () => {
    const provider = new ScriptedProvider(['   ', fullDecisionsJson()]);
    await new AgentClient(provider).judge(req);
    expect(provider.calls[1]?.user).toMatch(/the reply was empty/);
  });

  it('throws AgentError with the raw output after two bad attempts', async () => {
    const provider = new ScriptedProvider(['garbage one', 'garbage two']);
    const err = await new AgentClient(provider)
      .judge(req)
      .catch((e: unknown) => e as AgentError);

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toMatch(/after 2 attempts/);
    expect((err as AgentError).rawOutput).toBe('garbage two');
    expect(provider.calls).toHaveLength(2);
  });

  it('drops candidates the model forgot rather than silently approving them', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [{ remote_id: 603, keep: true, reason: 'Great.' }],
      }),
    ]);
    const result = await new AgentClient(provider).judge(req);

    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts[1]).toEqual({
      remoteId: 999,
      keep: false,
      reason: 'agent returned no verdict for this title',
    });
    expect(result.verdicts[2]?.keep).toBe(false);
  });

  it('ignores verdicts for titles that were never candidates', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [
          { remote_id: 603, keep: true, reason: 'Great.' },
          { remote_id: 111111, keep: true, reason: 'Hallucinated title.' },
        ],
      }),
    ]);
    const result = await new AgentClient(provider).judge(req);
    expect(result.verdicts.map((v) => v.remoteId)).toEqual([603, 999, 27205]);
  });

  it('lets the last duplicate verdict win', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [
          { remote_id: 603, keep: true, reason: 'First thought.' },
          { remote_id: 603, keep: false, reason: 'On reflection, no.' },
        ],
      }),
    ]);
    const result = await new AgentClient(provider).judge({
      candidates: [matrixCandidate],
      library: [],
    });
    expect(result.verdicts).toEqual([{ remoteId: 603, keep: false, reason: 'On reflection, no.' }]);
  });

  it('never calls the provider for an empty candidate list', async () => {
    const provider = new ScriptedProvider([fullDecisionsJson()]);
    const result = await new AgentClient(provider).judge({ candidates: [], library: [] });

    expect(provider.calls).toHaveLength(0);
    expect(result.verdicts).toEqual([]);
    expect(result.attempts).toBe(0);
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  it('records a taste hash that tracks the notes it was rendered with', async () => {
    const plain = await new AgentClient(new ScriptedProvider([fullDecisionsJson()])).judge(req);
    const noted = await new AgentClient(new ScriptedProvider([fullDecisionsJson()])).judge({
      ...req,
      userNotes: 'more 90s sci-fi please',
    });

    expect(plain.tasteHash).toBe(tasteHash({}));
    expect(noted.tasteHash).not.toBe(plain.tasteHash);
    expect(noted.tasteHash).toBe(tasteHash({ userNotes: '  more 90s sci-fi please ' }));
    expect(plain.tasteHash).toHaveLength(12);
  });
});

describe('HeuristicProvider (offline judge)', () => {
  it('keeps candidates rated at or above the bar and drops the rest', async () => {
    const result = await new AgentClient(new HeuristicProvider()).judge(req);

    expect(result.verdicts.map((v) => [v.remoteId, v.keep])).toEqual([
      [603, true],
      [999, false],
      [27205, true],
    ]);
    expect(result.verdicts[1]?.reason).toContain('below the 7 bar');
    expect(result.provider).toBe('mock');
    expect(result.attempts).toBe(1);
  });

  it('honours a custom keep threshold', async () => {
    // Matrix 8.2, dud 4.1, Inception 8.4 — all below an 8.5 bar
    const strict = await new AgentClient(new HeuristicProvider(8.5)).judge(req);
    expect(strict.verdicts.map((v) => v.keep)).toEqual([false, false, false]);

    const lenient = await new AgentClient(new HeuristicProvider(8.3)).judge(req);
    expect(lenient.verdicts.map((v) => v.keep)).toEqual([false, false, true]);
  });

  it('keeps an unreleased candidate no matter how it scores', async () => {
    const unreleased = { ...dudCandidate, origin: 'upcoming', rating: null, votes: null };
    const result = await new AgentClient(new HeuristicProvider()).judge({
      candidates: [unreleased],
      library: [],
    });

    expect(result.verdicts[0]?.keep).toBe(true);
    expect(result.verdicts[0]?.reason).toContain('not out yet');
  });

  it('treats an unrated candidate as a drop', async () => {
    const unrated = { ...dudCandidate, rating: null, votes: null };
    const result = await new AgentClient(new HeuristicProvider()).judge({
      candidates: [unrated],
      library: [],
    });
    expect(result.verdicts[0]?.keep).toBe(false);
  });
});
