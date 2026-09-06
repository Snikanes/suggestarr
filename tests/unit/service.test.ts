import { beforeEach, describe, expect, it } from 'vitest';
import { SuggestionService } from '../../src/discord/service.js';
import { FakeGateway } from '../../src/discord/fake.js';
import { APPROVE_EMOJI, COLORS, REJECT_EMOJI } from '../../src/discord/embeds.js';
import { Store } from '../../src/state/db.js';
import { TitleNotFoundError, type AddedTitle, type TitleAdder } from '../../src/arr/adder.js';
import { candidatesFixture, judgeResultFixture } from '../fixtures/agent.js';

/** Records what would have been added; can be told to fail. */
class StubAdder implements TitleAdder {
  readonly added: { remoteId: number; title: string }[] = [];
  failure: Error | null = null;

  async add(remoteId: number, title: string): Promise<AddedTitle> {
    if (this.failure) throw this.failure;
    this.added.push({ remoteId, title });
    return { remoteId, localId: 42, title, rootFolderPath: '/movies', qualityProfileId: 4 };
  }
}

let store: Store;
let gateway: FakeGateway;
let adder: StubAdder;
let service: SuggestionService;

beforeEach(async () => {
  store = await Store.open(':memory:');
  gateway = new FakeGateway();
  adder = new StubAdder();
  service = new SuggestionService({ store, gateway, adder });
  service.register();
  store.recordJudgement(judgeResultFixture, candidatesFixture);
  await service.postVerdicts(judgeResultFixture, candidatesFixture);
});

/** msg-1 = The Matrix (kept), msg-2 = Inception (kept); 999 was dropped. */
const MATRIX_MSG = 'msg-1';

describe('postVerdicts', () => {
  it('posts only what the agent kept, with both reaction affordances', () => {
    expect(gateway.posted).toHaveLength(2);
    expect(gateway.posted.map((p) => p.embed.title)).toEqual([
      'The Matrix (1999)',
      'Inception (2010)',
    ]);
    expect(gateway.posted[0]?.reactions).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);
  });

  it('records each posted suggestion against its decision row', () => {
    const pending = store.pendingSuggestions();
    expect(pending.map((p) => p.remoteId).sort((a, b) => a - b)).toEqual([603, 27205]);
    expect(pending[0]?.decisionId).toBe(store.latestDecision(pending[0]!.remoteId)?.id);
    expect(store.latestDecision(999)?.verdict).toBe('drop');
    expect(store.pendingSuggestionFor(999)).toBeNull();
  });

  it('skips verdicts whose candidate or decision is missing', async () => {
    const fresh = new FakeGateway();
    const svc = new SuggestionService({ store: await Store.open(':memory:'), gateway: fresh, adder });
    await svc.postVerdicts(judgeResultFixture, candidatesFixture);
    expect(fresh.posted).toHaveLength(0);
  });
});

describe('reactions', () => {
  it('✅ adds the title, records the outcome and rewrites the embed', async () => {
    await gateway.react(MATRIX_MSG, APPROVE_EMOJI);

    expect(adder.added).toEqual([{ remoteId: 603, title: 'The Matrix' }]);
    expect(store.latestDecision(603)?.outcome).toBe('approved');
    expect(store.suggestionByMessage(MATRIX_MSG)?.state).toBe('approved');

    const embed = gateway.embedOf(MATRIX_MSG)!;
    expect(embed.color).toBe(COLORS.approved);
    expect(embed.fields.at(-1)?.value).toContain('/movies');
  });

  it('❌ records the rejection without touching the *arr', async () => {
    await gateway.react(MATRIX_MSG, REJECT_EMOJI);

    expect(adder.added).toEqual([]);
    expect(store.latestDecision(603)?.outcome).toBe('rejected');
    expect(store.suggestionByMessage(MATRIX_MSG)?.state).toBe('rejected');
    expect(gateway.embedOf(MATRIX_MSG)?.color).toBe(COLORS.rejected);
  });

  it('keeps the decision retryable when the *arr refuses the add', async () => {
    adder.failure = new TitleNotFoundError(603, 'The Matrix');
    await gateway.react(MATRIX_MSG, APPROVE_EMOJI);

    const suggestion = store.suggestionByMessage(MATRIX_MSG)!;
    expect(suggestion.state).toBe('failed');
    expect(suggestion.error).toMatch(/Radarr has no match/);
    // outcome stays null: the human said yes, the machine failed
    expect(store.latestDecision(603)?.outcome).toBeNull();
    expect(gateway.embedOf(MATRIX_MSG)?.color).toBe(COLORS.failed);
  });

  it('ignores bots, unrelated emoji, unknown messages and second reactions', async () => {
    await gateway.react(MATRIX_MSG, APPROVE_EMOJI, { userIsBot: true });
    await gateway.react(MATRIX_MSG, '🍿');
    await gateway.react('msg-unknown', APPROVE_EMOJI);
    expect(adder.added).toEqual([]);

    await gateway.react(MATRIX_MSG, APPROVE_EMOJI);
    await gateway.react(MATRIX_MSG, REJECT_EMOJI);
    expect(adder.added).toHaveLength(1);
    expect(store.latestDecision(603)?.outcome).toBe('approved');
  });
});

describe('/add', () => {
  it('approves a pending suggestion', async () => {
    const reply = await gateway.command('add', { tmdb_id: 603 });

    expect(reply.ephemeral).toBe(true);
    expect(reply.text).toContain('Monitored in Radarr');
    expect(store.latestDecision(603)?.outcome).toBe('approved');
  });

  it('force-adds a title the agent dropped and flags the mismatch', async () => {
    const reply = await gateway.command('add', { tmdb_id: 999 });

    expect(reply.text).toContain('despite the agent dropping it');
    expect(adder.added).toEqual([{ remoteId: 999, title: 'Direct To Streaming 4' }]);
    expect(store.latestDecision(999)?.outcome).toBe('force-added');
    expect(store.mismatches().map((m) => m.type)).toEqual(['dropped-but-wanted']);
  });

  it('approves any pending suggestion by its TMDB id', async () => {
    await gateway.command('add', { tmdb_id: 27205 });
    expect(adder.added).toEqual([{ remoteId: 27205, title: 'Inception' }]);
  });

  it('reports bad input and titles it has never judged', async () => {
    expect((await gateway.command('add', {})).text).toMatch(/Give me a TMDB id/);
    expect((await gateway.command('add', { tmdb_id: 'abc' })).text).toMatch(/Give me a TMDB id/);
    expect((await gateway.command('add', { tmdb_id: 42 })).text).toMatch(/No verdict on record/);
  });

  it('refuses to act twice on the same title', async () => {
    await gateway.command('add', { tmdb_id: 999 });
    expect((await gateway.command('add', { tmdb_id: 999 })).text).toMatch(
      /already force-added — nothing to do/,
    );
  });

  it('reports an *arr failure on a force-add without recording an outcome', async () => {
    adder.failure = new Error('Radarr is down');
    const reply = await gateway.command('add', { tmdb_id: 999 });

    expect(reply.text).toContain('Could not add **Direct To Streaming 4**: Radarr is down');
    expect(store.latestDecision(999)?.outcome).toBeNull();
  });
});

describe('/skip', () => {
  it('rejects a pending suggestion', async () => {
    const reply = await gateway.command('skip', { tmdb_id: 603 });

    expect(reply.text).toMatch(/will not be suggested again/);
    expect(store.suggestionByMessage(MATRIX_MSG)?.state).toBe('rejected');
    expect(store.latestDecision(603)?.outcome).toBe('rejected');
  });

  it('records a no on a dropped title that was never posted', async () => {
    const reply = await gateway.command('skip', { tmdb_id: 999 });

    expect(reply.text).toContain('Recorded **Direct To Streaming 4** as a no.');
    expect(store.latestDecision(999)?.outcome).toBe('rejected');
  });

  it('reports unknown and already-decided titles', async () => {
    expect((await gateway.command('skip', { tmdb_id: 42 })).text).toMatch(/No verdict on record/);
    await gateway.command('skip', { tmdb_id: 999 });
    expect((await gateway.command('skip', { tmdb_id: 999 })).text).toMatch(/already rejected/);
    expect((await gateway.command('skip', {})).text).toMatch(/Give me a TMDB id/);
  });
});

describe('/decisions', () => {
  it('lists what the agent dropped, with the mismatch tally', async () => {
    const reply = await gateway.command('decisions');

    expect(reply.text).toContain('`999` Direct To Streaming 4 — Weak ratings, thin premise.');
    expect(reply.text).toContain('**Mismatches so far:** 0');

    await gateway.command('add', { tmdb_id: 999 });
    const after = await gateway.command('decisions');
    expect(after.text).toContain('**Mismatches so far:** 1 — 1 dropped-but-wanted, 0 kept-but-rejected');
    expect(after.text).toContain('(nothing dropped yet)');
  });

  it('shows every verdict for one title, including the outcome', async () => {
    await gateway.react(MATRIX_MSG, APPROVE_EMOJI);
    const reply = await gateway.command('decisions', { tmdb_id: 603 });

    expect(reply.text).toContain('**Verdicts for tmdb 603:**');
    expect(reply.text).toContain('`keep` The Matrix');
    expect(reply.text).toContain('*(you: approved)*');
  });

  it('says so when a title has no verdicts', async () => {
    expect((await gateway.command('decisions', { tmdb_id: 42 })).text).toMatch(
      /No verdicts recorded for tmdb id 42/,
    );
  });
});

describe('/status and unknown commands', () => {
  it('reports pending suggestions and the lifetime tally', async () => {
    await gateway.react(MATRIX_MSG, REJECT_EMOJI);
    const reply = await gateway.command('status');

    expect(reply.text).toContain('**1 pending suggestion:**');
    expect(reply.text).toContain('`27205` Inception (2010)');
    expect(reply.text).toContain('3 verdicts · 0 approved · 1 rejected · 0 force-added');
  });

  it('rejects a command it does not know', async () => {
    expect((await gateway.command('suggest')).text).toMatch(/Unknown command `\/suggest`/);
  });
});

describe('reconcilePending', () => {
  it('applies a ✅ that landed while nothing was listening', async () => {
    gateway.seedReaction(MATRIX_MSG, APPROVE_EMOJI);

    const result = await service.reconcilePending();

    expect(result).toEqual({ approved: 1, rejected: 0, unreadable: 0 });
    expect(adder.added).toEqual([{ remoteId: 603, title: 'The Matrix' }]);
    expect(store.latestDecision(603)?.outcome).toBe('approved');
    expect(store.suggestionByMessage(MATRIX_MSG)?.state).toBe('approved');
  });

  it('applies a ❌ the same way', async () => {
    gateway.seedReaction(MATRIX_MSG, REJECT_EMOJI);
    await service.reconcilePending();

    expect(adder.added).toEqual([]);
    expect(store.latestDecision(603)?.outcome).toBe('rejected');
  });

  it('lets ❌ win when both are present', async () => {
    gateway.seedReaction(MATRIX_MSG, APPROVE_EMOJI);
    gateway.seedReaction(MATRIX_MSG, REJECT_EMOJI);

    const result = await service.reconcilePending();

    expect(result).toMatchObject({ approved: 0, rejected: 1 });
    expect(adder.added).toEqual([]);
    expect(store.latestDecision(603)?.outcome).toBe('rejected');
  });

  it("ignores the bot's own seeded reactions", async () => {
    gateway.seedReaction(MATRIX_MSG, APPROVE_EMOJI, []); // nobody but the bot
    gateway.seedReaction(MATRIX_MSG, '🍿', ['user-1']); // unrelated emoji

    const result = await service.reconcilePending();

    expect(result).toEqual({ approved: 0, rejected: 0, unreadable: 0 });
    expect(store.latestDecision(603)?.outcome).toBeNull();
  });

  it('leaves a suggestion pending when its message cannot be read', async () => {
    gateway.deleteMessage(MATRIX_MSG);

    const result = await service.reconcilePending();

    expect(result).toMatchObject({ unreadable: 1 });
    expect(store.suggestionByMessage(MATRIX_MSG)?.state).toBe('pending');
  });

  it('only looks at pending suggestions', async () => {
    await gateway.react(MATRIX_MSG, REJECT_EMOJI);
    gateway.seedReaction(MATRIX_MSG, APPROVE_EMOJI);

    const result = await service.reconcilePending();

    expect(result).toEqual({ approved: 0, rejected: 0, unreadable: 0 });
    expect(store.latestDecision(603)?.outcome).toBe('rejected'); // unchanged
  });

  it('does nothing when there is nothing pending', async () => {
    await gateway.react(MATRIX_MSG, APPROVE_EMOJI);
    await gateway.react('msg-2', REJECT_EMOJI);

    expect(await service.reconcilePending()).toEqual({
      approved: 0,
      rejected: 0,
      unreadable: 0,
    });
  });
});

describe('markExpired', () => {
  it('greys out the embed and says the title will come back', async () => {
    const pending = store.pendingSuggestions();
    await service.markExpired(pending);

    const embed = gateway.embedOf(MATRIX_MSG)!;
    expect(embed.color).toBe(COLORS.expired);
    expect(embed.fields.at(-1)?.name).toBe('⌛ Expired');
    expect(embed.fields.at(-1)?.value).toContain('may be suggested again');
  });
});

describe('reportFailures', () => {
  it('posts a notice listing every problem, and nothing when there are none', async () => {
    await service.reportFailures([]);
    expect(gateway.notices).toHaveLength(0);

    await service.reportFailures(['Radarr unreachable', 'TMDB trending failed']);
    expect(gateway.notices[0]).toContain('⚠️ **Cycle problems:**');
    expect(gateway.notices[0]).toContain('• Radarr unreachable');
    expect(gateway.notices[0]).toContain('• TMDB trending failed');
  });
});
