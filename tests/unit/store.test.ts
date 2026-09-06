import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/state/db.js';
import type { JudgeResult } from '../../src/agent/types.js';
import { candidatesFixture, judgeResultFixture, matrixCandidate } from '../fixtures/agent.js';

let store: Store;

beforeEach(async () => {
  store = await Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const AT = new Date('2026-09-05T10:00:00.000Z');

function seed(result: JudgeResult = judgeResultFixture, at = AT): number {
  return store.recordJudgement(result, candidatesFixture, at);
}

describe('Store.recordJudgement', () => {
  it('persists one row per verdict, kept and dropped alike', () => {
    const runId = seed();
    const rows = store.listDecisions();

    expect(runId).toBe(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.verdict).sort()).toEqual(['drop', 'keep', 'keep']);
    expect(rows.every((r) => r.runId === runId)).toBe(true);
  });

  it('records the candidate payload, the reasoning and the prompt provenance', () => {
    seed();
    const row = store.latestDecision(603);

    expect(row).toMatchObject({
      remoteId: 603,
      title: 'The Matrix',
      year: 1999,
      origin: 'trending',
      rating: 8.2,
      votes: 16000,
      posterUrl: 'https://image.tmdb.org/t/p/w342/matrix.jpg',
      overview: 'A hacker learns reality is a simulation.',
      verdict: 'keep',
      reason: 'Anchor sci-fi, missing from the shelf.',
      provider: 'scripted',
      model: 'mock-1',
      promptVersion: 'v1',
      tasteHash: 'abc123def456',
      createdAt: AT.toISOString(),
      outcome: null,
      outcomeAt: null,
    });
  });

  it('ignores a verdict with no matching candidate', () => {
    store.recordJudgement(judgeResultFixture, [matrixCandidate]);
    expect(store.listDecisions()).toHaveLength(1);
  });

  it('handles a run with no verdicts at all', () => {
    const runId = store.recordJudgement({ ...judgeResultFixture, verdicts: [] }, []);
    expect(runId).toBe(1);
    expect(store.listDecisions()).toEqual([]);
  });

  it('keeps successive runs distinct', () => {
    const first = seed();
    const second = seed(judgeResultFixture, new Date('2026-09-06T10:00:00.000Z'));

    expect(second).toBe(first + 1);
    expect(store.listDecisions()).toHaveLength(6);
    expect(store.listDecisions({ limit: 1 })[0]?.runId).toBe(second);
  });
});

describe('Store.setOutcome', () => {
  it('joins the human reaction onto the pending verdict', () => {
    seed();
    const at = new Date('2026-09-05T18:30:00.000Z');

    expect(store.setOutcome(603, 'approved', at)).toBe(true);
    expect(store.latestDecision(603)).toMatchObject({
      outcome: 'approved',
      outcomeAt: at.toISOString(),
    });
  });

  it('records a force-add against the agent’s drop', () => {
    seed();
    expect(store.setOutcome(999, 'force-added')).toBe(true);
    expect(store.latestDecision(999)?.outcome).toBe('force-added');
  });

  it('refuses to overwrite a decided row and reports unknown titles', () => {
    seed();
    expect(store.setOutcome(603, 'approved')).toBe(true);
    expect(store.setOutcome(603, 'rejected')).toBe(false);
    expect(store.latestDecision(603)?.outcome).toBe('approved');
    expect(store.setOutcome(4242, 'approved')).toBe(false);
  });

  it('updates the newest pending row when a title was judged twice', () => {
    seed();
    const second = seed(judgeResultFixture, new Date('2026-09-06T10:00:00.000Z'));

    expect(store.setOutcome(603, 'rejected')).toBe(true);
    const rows = store.listDecisions({ remoteId: 603 });
    expect(rows[0]).toMatchObject({ runId: second, outcome: 'rejected' });
    expect(rows[1]?.outcome).toBeNull();
  });


});

describe('Store.listDecisions', () => {
  beforeEach(() => {
    seed();
    store.setOutcome(603, 'approved');
  });

  it('filters by kind, remote id, verdict, outcome and prompt version', () => {
    expect(store.listDecisions({ remoteId: 999 })).toHaveLength(1);
    expect(store.listDecisions({ verdict: 'drop' }).map((r) => r.remoteId)).toEqual([999]);
    expect(store.listDecisions({ outcome: 'approved' }).map((r) => r.remoteId)).toEqual([603]);
    expect(store.listDecisions({ outcome: null }).map((r) => r.remoteId)).toEqual([27205, 999]);
    expect(store.listDecisions({ promptVersion: 'v1' })).toHaveLength(3);
    expect(store.listDecisions({ promptVersion: 'v2' })).toEqual([]);
  });

  it('combines filters and honours the limit, newest first', () => {
    expect(store.listDecisions({ verdict: 'keep', outcome: null })).toHaveLength(1);
    expect(store.listDecisions({ limit: 2 }).map((r) => r.remoteId)).toEqual([27205, 999]);
  });
});

describe('Store.mismatches', () => {
  it('surfaces dropped-but-wanted and kept-but-rejected verdicts only', () => {
    seed();
    store.setOutcome(999, 'force-added'); // agent dropped it, user wanted it
    store.setOutcome(603, 'rejected'); // agent kept it, user refused
    store.setOutcome(27205, 'approved'); // agreement — not a mismatch

    expect(store.mismatches().map((m) => [m.row.remoteId, m.type])).toEqual([
      [999, 'dropped-but-wanted'],
      [603, 'kept-but-rejected'],
    ]);
  });

  it('can be scoped to one prompt version for before/after comparison', () => {
    seed();
    store.setOutcome(999, 'force-added');
    store.recordJudgement({ ...judgeResultFixture, promptVersion: 'v2' }, candidatesFixture);
    store.setOutcome(999, 'force-added');

    expect(store.mismatches('v1')).toHaveLength(1);
    expect(store.mismatches('v2')).toHaveLength(1);
    expect(store.mismatches()).toHaveLength(2);
  });

  it('is empty while nothing has an outcome', () => {
    seed();
    expect(store.mismatches()).toEqual([]);
  });
});

describe('Store.promptVersionStats', () => {
  it('scores each prompt version and taste snapshot separately', () => {
    seed();
    store.setOutcome(603, 'approved');
    store.setOutcome(999, 'force-added');
    store.recordJudgement(
      { ...judgeResultFixture, promptVersion: 'v2', tasteHash: 'zzz999' },
      candidatesFixture,
    );

    expect(store.promptVersionStats()).toEqual([
      {
        promptVersion: 'v1',
        tasteHash: 'abc123def456',
        decisions: 3,
        kept: 2,
        approved: 1,
        rejected: 0,
        forceAdded: 1,
      },
      {
        promptVersion: 'v2',
        tasteHash: 'zzz999',
        decisions: 3,
        kept: 2,
        approved: 0,
        rejected: 0,
        forceAdded: 0,
      },
    ]);
  });
});

describe('Store.expirePending', () => {
  const postSuggestion = (remoteId: number, at: Date): number => {
    const decision = store.latestDecision(remoteId)!;
    return store.recordSuggestion(
      {
        decisionId: decision.id,
        remoteId,
        title: decision.title,
        year: decision.year,
        channelId: 'c',
        messageId: `msg-${remoteId}`,
      },
      at,
    );
  };

  beforeEach(() => {
    seed();
    postSuggestion(603, new Date('2026-09-01T10:00:00.000Z')); // old
    postSuggestion(27205, new Date('2026-09-05T10:00:00.000Z')); // fresh
  });

  it('closes out only the suggestions older than the cutoff', () => {
    const expired = store.expirePending(new Date('2026-09-03T00:00:00.000Z'));

    expect(expired.map((s) => s.remoteId)).toEqual([603]);
    expect(store.suggestionByMessage('msg-603')?.state).toBe('expired');
    expect(store.suggestionByMessage('msg-27205')?.state).toBe('pending');
    expect(store.pendingSuggestions().map((s) => s.remoteId)).toEqual([27205]);
  });

  it('records expiry on the decision without calling it a yes or a no', () => {
    const at = new Date('2026-09-06T08:00:00.000Z');
    store.expirePending(new Date('2026-09-03T00:00:00.000Z'), at);

    const decision = store.latestDecision(603)!;
    expect(decision.outcome).toBe('expired');
    expect(decision.outcomeAt).toBe(at.toISOString());
    expect(store.mismatches()).toEqual([]); // not a disagreement
    expect(store.promptVersionStats()[0]).toMatchObject({ approved: 0, rejected: 0, forceAdded: 0 });
  });

  it('puts an expired title back in the pool, unlike a decided one', () => {
    store.setOutcome(27205, 'rejected');
    store.expirePending(new Date('2026-09-03T00:00:00.000Z'));

    const excluded = store.excludedIds();
    expect(excluded.has(603)).toBe(false); // expired -> ask again
    expect(excluded.has(27205)).toBe(true); // rejected -> never again
    expect(excluded.has(999)).toBe(true); // still awaiting an answer
  });

  it('lets a late answer land on an expired suggestion', () => {
    store.expirePending(new Date('2026-09-03T00:00:00.000Z'));

    expect(store.setOutcome(603, 'force-added')).toBe(true);
    expect(store.latestDecision(603)?.outcome).toBe('force-added');
  });

  it('never overwrites an outcome the user actually gave', () => {
    store.setOutcome(603, 'approved');
    expect(store.setOutcome(603, 'rejected')).toBe(false);
    expect(store.latestDecision(603)?.outcome).toBe('approved');
  });

  it('is a no-op when nothing is stale', () => {
    expect(store.expirePending(new Date('2026-01-01T00:00:00.000Z'))).toEqual([]);
    expect(store.pendingSuggestions()).toHaveLength(2);
  });
});

describe('Store.excludedIds', () => {
  it('reports every title that already has a verdict', () => {
    seed();
    seed();
    expect([...store.excludedIds()].sort((a, b) => a - b)).toEqual([603, 999, 27205]);
  });

  it('is empty on a fresh database', () => {
    expect(store.excludedIds().size).toBe(0);
  });
});

describe('Store.pruneCandidatePayloads', () => {
  it('drops the bulky payload of old rows but keeps the verdict', () => {
    seed();
    seed(judgeResultFixture, new Date('2026-09-05T12:00:00.000Z'));

    // 2, not 3: the dud candidate never had an overview or a poster to prune.
    const pruned = store.pruneCandidatePayloads(new Date('2026-09-05T11:00:00.000Z'));
    expect(pruned).toBe(2);

    const rows = store.listDecisions({ remoteId: 603 });
    expect(rows[1]).toMatchObject({ overview: null, posterUrl: null, reason: 'Anchor sci-fi, missing from the shelf.' });
    expect(rows[0]?.overview).toBe('A hacker learns reality is a simulation.');
  });

  it('is a no-op when everything is already pruned', () => {
    seed();
    store.pruneCandidatePayloads(new Date('2026-09-06T00:00:00.000Z'));
    expect(store.pruneCandidatePayloads(new Date('2026-09-06T00:00:00.000Z'))).toBe(0);
  });
});
