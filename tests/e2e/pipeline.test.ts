import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentClient } from '../../src/agent/agent.js';
import { PROMPT_VERSION } from '../../src/agent/prompt.js';
import { HeuristicProvider, ScriptedProvider } from '../../src/agent/providers/index.js';
import { ArrAdder } from '../../src/arr/adder.js';
import { RadarrClient } from '../../src/arr/radarr.js';
import { runCycle } from '../../src/cycle.js';
import { APPROVE_EMOJI, COLORS, REJECT_EMOJI } from '../../src/discord/embeds.js';
import { FakeGateway } from '../../src/discord/fake.js';
import { SuggestionService } from '../../src/discord/service.js';
import { Store } from '../../src/state/db.js';
import { TmdbClient } from '../../src/tmdb/client.js';
import { qualityProfilesFixture } from '../fixtures/arr-add.js';

/**
 * §5.3 — every integration mocked at once: TMDB, Radarr and the LLM are
 * stubbed HTTP, Discord is the in-memory gateway, and the database is a
 * real SQLite file in a temp dir. No network, no keys.
 */

const RADARR = 'http://radarr.test:7878';
const TMDB = 'http://tmdb.test/3';

/** Library: the user already owns Pulp Fiction (550) and Forrest Gump (13). */
const ownedMovies = [
  { id: 1, title: 'Pulp Fiction', sortTitle: 'pulp fiction', year: 1994, tmdbId: 550, monitored: true, images: [], added: '2026-02-01T18:30:00Z', hasFile: true },
  { id: 2, title: 'Forrest Gump', sortTitle: 'forrest gump', year: 1994, tmdbId: 13, monitored: true, images: [], added: '2026-01-15T10:00:00Z', hasFile: true },
];

/** Discovery: one great movie, one weak movie, one owned movie, one more great movie. */
const trendingMovies = [
  { id: 603, title: 'The Matrix', release_date: '1999-03-31', vote_average: 8.2, vote_count: 16000, overview: 'A hacker learns reality is a simulation.', genre_ids: [878], poster_path: '/m.jpg', popularity: 60, media_type: 'movie' },
  { id: 999, title: 'Direct To Streaming 4', release_date: '2025-01-01', vote_average: 6.4, vote_count: 400, overview: 'Nothing much.', genre_ids: [28], poster_path: null, popularity: 3, media_type: 'movie' },
  { id: 550, title: 'Pulp Fiction', release_date: '1994-10-14', vote_average: 8.5, vote_count: 14000, overview: 'Owned already.', genre_ids: [53], poster_path: null, popularity: 9, media_type: 'movie' },
];
const upcomingMovies = [
  { id: 27205, title: 'Inception', release_date: '2026-10-01', vote_average: 8.4, vote_count: 30000, overview: 'Dreams within dreams.', genre_ids: [878], poster_path: '/i.jpg', popularity: 50, media_type: 'movie' },
  // Not out yet: no rating, no votes — the case the quality floor used to eat
  { id: 1061474, title: 'Superman', release_date: '2026-07-11', vote_average: 0, vote_count: 0, overview: 'The last son of Krypton, again.', genre_ids: [878], poster_path: '/s.jpg', popularity: 480, media_type: 'movie' },
];

const arrPosts: { url: string; body: any }[] = [];

const server = setupServer(
  http.get(`${RADARR}/api/v3/movie`, () => HttpResponse.json(ownedMovies)),
  http.get(`${RADARR}/api/v3/rootfolder`, () => HttpResponse.json([{ id: 1, path: '/movies' }])),
  http.get(`${RADARR}/api/v3/qualityprofile`, () => HttpResponse.json(qualityProfilesFixture)),
  http.get(`${RADARR}/api/v3/movie/lookup`, ({ request }) => {
    const term = new URL(request.url).searchParams.get('term') ?? '';
    const tmdbId = Number(term.replace('tmdb:', ''));
    const found = [...trendingMovies, ...upcomingMovies].find((m) => m.id === tmdbId);
    if (!found) return HttpResponse.json([]);
    return HttpResponse.json([
      { title: found.title, year: found.release_date.slice(0, 4), tmdbId, titleSlug: `slug-${tmdbId}`, images: [] },
    ]);
  }),
  http.post(`${RADARR}/api/v3/movie`, async ({ request }) => {
    const body = (await request.json()) as { title: string; tmdbId: number };
    arrPosts.push({ url: request.url, body });
    return HttpResponse.json(
      { id: 101, title: body.title, sortTitle: body.title.toLowerCase(), year: 1999, tmdbId: body.tmdbId, monitored: true, images: [] },
      { status: 201 },
    );
  }),
  http.get(`${TMDB}/trending/movie/week`, () => HttpResponse.json({ results: trendingMovies })),
  http.get(`${TMDB}/genre/movie/list`, () =>
    HttpResponse.json({
      genres: [
        { id: 878, name: 'Science Fiction' },
        { id: 28, name: 'Action' },
        { id: 53, name: 'Thriller' },
      ],
    }),
  ),
  // /discover/movie backs upcomingMovies()
  http.get(`${TMDB}/discover/movie`, () => HttpResponse.json({ results: upcomingMovies })),
  // "more like what you own", seeded from the library itself
  http.get(`${TMDB}/movie/:id/similar`, () => HttpResponse.json({ results: [] })),
);

let dir: string;
let store: Store;
let gateway: FakeGateway;
let service: SuggestionService;

const radarr = new RadarrClient({ baseUrl: RADARR, apiKey: 'r-key' });
const tmdb = new TmdbClient({ baseUrl: TMDB, apiKey: 't-key' });

function pipeline(agent: AgentClient) {
  return { store, radarr, tmdb, agent, service };
}

function heuristicAgent(): AgentClient {
  return new AgentClient(new HeuristicProvider());
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'suggestarr-e2e-'));
  store = await Store.open(join(dir, 'state.db'));
  gateway = new FakeGateway();
  service = new SuggestionService({
    store,
    gateway,
    adder: new ArrAdder(radarr, { searchOnAdd: true }),
  });
  service.register();
  arrPosts.length = 0;
});

afterEach(() => {
  server.resetHandlers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a full daily cycle', () => {
  it('discovers, judges, posts, and turns a ✅ into a monitored *arr item', async () => {
    const report = await runCycle(pipeline(heuristicAgent()));

    // Owned titles never reach the agent (§5.3 scenario 3)
    expect(report.libraryTitles).toBe(2);
    expect(report.candidates).toBe(4);
    expect(store.excludedIds().has(550)).toBe(false);
    expect(store.excludedIds().has(13)).toBe(false);

    // The weak movie is dropped; the two strong ones and the unreleased one post
    expect(report.kept).toBe(3);
    expect(report.posted).toBe(3);
    expect(gateway.posted.map((p) => p.embed.title).sort()).toEqual([
      'Inception (2026)',
      'Superman (2026)',
      'The Matrix (1999)',
    ]);
    expect(report.failures).toEqual([]);

    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    await gateway.react(matrix.messageId, APPROVE_EMOJI);

    // ... which lands as a monitored, search-on-add payload in Radarr
    expect(arrPosts).toHaveLength(1);
    expect(arrPosts[0]?.body).toMatchObject({
      tmdbId: 603,
      monitored: true,
      rootFolderPath: '/movies',
      addOptions: { searchForMovie: true },
    });

    // ... and the decision row now carries the human's answer
    const decision = store.latestDecision(603)!;
    expect(decision).toMatchObject({ verdict: 'keep', outcome: 'approved' });
    expect(decision.reason).toContain('at or above the 7 bar');
    expect(store.suggestionByMessage(matrix.messageId)?.state).toBe('approved');
    expect(gateway.embedOf(matrix.messageId)?.color).toBe(COLORS.approved);
  });

  it('adds a second approved suggestion independently', async () => {
    await runCycle(pipeline(heuristicAgent()));
    const inception = gateway.posted.find((p) => p.embed.title.startsWith('Inception'))!;
    await gateway.react(inception.messageId, APPROVE_EMOJI);

    expect(arrPosts[0]?.body).toMatchObject({ tmdbId: 27205, rootFolderPath: '/movies' });
    expect(store.latestDecision(27205)?.outcome).toBe('approved');
  });
});

describe('a ❌ rejection', () => {
  it('records the no and never suggests that title again', async () => {
    await runCycle(pipeline(heuristicAgent()));
    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    await gateway.react(matrix.messageId, REJECT_EMOJI);

    expect(store.latestDecision(603)?.outcome).toBe('rejected');
    expect(arrPosts).toHaveLength(0);

    const second = await runCycle(pipeline(heuristicAgent()));
    expect(second.candidates).toBe(0);
    expect(second.runId).toBeNull();
    expect(gateway.posted).toHaveLength(3); // nothing new posted
  });
});

describe('a malformed agent reply', () => {
  it('retries once and completes the cycle', async () => {
    const provider = new ScriptedProvider([
      'sorry, I only speak prose',
      JSON.stringify({
        decisions: [
          { remote_id: 603, keep: true, reason: 'Second time lucky.' },
          { remote_id: 999, keep: false, reason: 'Still weak.' },
          { remote_id: 27205, keep: true, reason: 'Nolan.' },
        ],
      }),
    ]);
    const report = await runCycle(pipeline(new AgentClient(provider)));

    expect(provider.calls).toHaveLength(2);
    expect(report.kept).toBe(2);
    expect(report.posted).toBe(2);
    expect(store.latestDecision(603)?.reason).toBe('Second time lucky.');
  });

  it('writes nothing and reports to Discord when both attempts fail', async () => {
    const report = await runCycle(
      pipeline(new AgentClient(new ScriptedProvider(['nonsense', 'still nonsense']))),
    );

    expect(report.runId).toBeNull();
    expect(store.listDecisions()).toEqual([]);
    expect(gateway.posted).toHaveLength(0);
    expect(gateway.notices[0]).toContain('The agent returned nothing usable');
    expect(report.failures).toHaveLength(1);
  });
});

describe('an unreachable LLM', () => {
  it('reports the provider error and leaves the candidates for next cycle', async () => {
    const provider = {
      name: 'openai',
      model: 'gpt-4o-mini',
      complete: async () => {
        throw new Error('openai API error 503: upstream unavailable');
      },
    };
    const report = await runCycle(pipeline(new AgentClient(provider)));

    expect(report.runId).toBeNull();
    expect(report.failures[0]).toContain('Judging failed: openai API error 503');
    expect(store.listDecisions()).toEqual([]);
    expect(store.excludedIds().size).toBe(0);
    expect(gateway.notices[0]).toContain('Judging failed');

    // Nothing was consumed: a healthy provider judges the same four next time
    const recovered = await runCycle(pipeline(heuristicAgent()));
    expect(recovered.judged).toBe(4);
  });
});

describe('an *arr outage', () => {
  it('stops the cycle entirely when Radarr is unreachable', async () => {
    server.use(http.get(`${RADARR}/api/v3/movie`, () => HttpResponse.json({}, { status: 500 })));

    const report = await runCycle(pipeline(heuristicAgent()));

    expect(report.libraryAvailable).toBe(false);
    expect(report.runId).toBeNull();
    expect(store.listDecisions()).toEqual([]);
    expect(store.excludedIds().size).toBe(0);
    expect(gateway.posted).toHaveLength(0);
    expect(gateway.notices[0]).toContain('Radarr unreachable');
  });

  it('reports a failed add and leaves the suggestion retryable', async () => {
    await runCycle(pipeline(heuristicAgent()));
    server.use(
      http.post(`${RADARR}/api/v3/movie`, () =>
        HttpResponse.json([{ errorMessage: 'This movie has already been added' }], { status: 400 }),
      ),
    );
    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    await gateway.react(matrix.messageId, APPROVE_EMOJI);

    const suggestion = store.suggestionByMessage(matrix.messageId)!;
    expect(suggestion.state).toBe('failed');
    expect(suggestion.error).toContain('400');
    expect(store.latestDecision(603)?.outcome).toBeNull();
    expect(gateway.embedOf(matrix.messageId)?.color).toBe(COLORS.failed);
  });

  it('survives TMDB being partially down', async () => {
    server.use(http.get(`${TMDB}/discover/movie`, () => HttpResponse.json({}, { status: 503 })));

    const report = await runCycle(pipeline(heuristicAgent()));

    expect(report.candidates).toBe(2); // trending only, Inception lost with /discover
    expect(report.failures.join()).toContain('TMDB upcoming movies failed');
    expect(report.posted).toBe(1);
  });
});

describe('a dropped title the user actually wanted', () => {
  it('force-adds it via /add and records the prompt mismatch', async () => {
    await runCycle(pipeline(heuristicAgent()));
    expect(store.latestDecision(999)?.verdict).toBe('drop');

    const reply = await gateway.command('add', { tmdb_id: 999 });

    expect(reply.text).toContain('despite the agent dropping it');
    expect(arrPosts[0]?.body).toMatchObject({ tmdbId: 999, monitored: true });
    expect(store.latestDecision(999)?.outcome).toBe('force-added');
    expect(store.mismatches()).toMatchObject([{ type: 'dropped-but-wanted' }]);

    const status = await gateway.command('status');
    expect(status.text).toContain('4 verdicts · 0 approved · 0 rejected · 1 force-added');
  });
});

describe('genre names', () => {
  it('gives the agent readable genres instead of TMDB ids', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [
          { remote_id: 603, keep: false, reason: 'no' },
          { remote_id: 999, keep: false, reason: 'no' },
          { remote_id: 27205, keep: false, reason: 'no' },
          { remote_id: 1061474, keep: false, reason: 'no' },
        ],
      }),
    ]);
    await runCycle(pipeline(new AgentClient(provider)));

    expect(provider.calls[0]!.user).toContain('genres=[Science Fiction]');
    expect(provider.calls[0]!.user).not.toContain('genre:878');
  });

  it('falls back to ids when TMDB will not hand over the genre list', async () => {
    server.use(http.get(`${TMDB}/genre/movie/list`, () => HttpResponse.json({}, { status: 503 })));
    const provider = new ScriptedProvider([
      JSON.stringify({ decisions: [{ remote_id: 603, keep: false, reason: 'no' }] }),
    ]);
    const report = await runCycle(pipeline(new AgentClient(provider)));

    expect(provider.calls[0]!.user).toContain('genre:878');
    expect(report.failures.join()).toContain('TMDB genre list unavailable');
    expect(report.runId).not.toBeNull(); // non-fatal: the cycle still ran
  });
});

describe('unreleased films', () => {
  it('survives the quality floor and reaches the agent marked as unreleased', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [
          { remote_id: 603, keep: false, reason: 'no' },
          { remote_id: 999, keep: false, reason: 'no' },
          { remote_id: 27205, keep: false, reason: 'no' },
          { remote_id: 1061474, keep: true, reason: 'Worth queuing before release.' },
        ],
      }),
    ]);
    const report = await runCycle(pipeline(new AgentClient(provider)));

    // 0 votes and no score, yet it is judged rather than filtered away
    expect(report.judged).toBe(4);
    expect(provider.calls[0]!.user).toContain('title="Superman" year=2026 status=unreleased');
    // TMDB reports 0/0 rather than null for a film nobody can have rated
    expect(provider.calls[0]!.user).toContain('rating=0.0 (0 votes)');

    const decision = store.latestDecision(1061474)!;
    expect(decision).toMatchObject({ origin: 'upcoming', verdict: 'keep', rating: 0, votes: 0 });
    expect(gateway.posted.map((p) => p.embed.title)).toContain('Superman (2026)');
  });

  it('keeps its reserved batch slots even when better-rated films compete', async () => {
    const report = await runCycle({ ...pipeline(heuristicAgent()), batchSize: 2, upcomingSlots: 1 });

    expect(report.candidates).toBe(2);
    const judged = store.listDecisions().map((d) => d.remoteId);
    expect(judged).toContain(1061474); // the unreleased one held its slot
    expect(judged).toContain(603); // and the best-rated released film took the other
  });

  it('is added to Radarr like any other approval', async () => {
    await runCycle(pipeline(heuristicAgent()));
    const superman = gateway.posted.find((p) => p.embed.title.startsWith('Superman'))!;
    await gateway.react(superman.messageId, APPROVE_EMOJI);

    expect(arrPosts[0]?.body).toMatchObject({ tmdbId: 1061474, monitored: true });
    expect(store.latestDecision(1061474)?.outcome).toBe('approved');
  });
});

describe('the learning loop', () => {
  it('caps a cycle at the batch size and picks up the rest next time', async () => {
    const first = await runCycle({ ...pipeline(heuristicAgent()), batchSize: 1, upcomingSlots: 0 });

    expect(first.eligible).toBe(4);
    expect(first.candidates).toBe(1);
    // With no slots reserved it is purely best-rated-released-first:
    // The Matrix (8.2) leads Direct To Streaming 4 (6.1)
    expect(store.listDecisions()).toHaveLength(1);
    expect(store.listDecisions()[0]?.title).toBe('The Matrix');

    const second = await runCycle({ ...pipeline(heuristicAgent()), batchSize: 1, upcomingSlots: 0 });
    expect(second.candidates).toBe(1);
    expect(store.listDecisions()[0]?.title).toBe('Direct To Streaming 4');
  });

  it('feeds accepts, rejects and force-adds back into the next prompt', async () => {
    await runCycle(pipeline(heuristicAgent()));
    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    const inception = gateway.posted.find((p) => p.embed.title.startsWith('Inception'))!;
    await gateway.react(matrix.messageId, APPROVE_EMOJI);
    await gateway.react(inception.messageId, REJECT_EMOJI);
    await gateway.command('add', { tmdb_id: 999 });

    // A later cycle with a fresh candidate must carry that history
    server.use(
      http.get(`${TMDB}/trending/movie/week`, () =>
        HttpResponse.json({
          results: [
            { id: 680, title: 'Reservoir Dogs', release_date: '1992-09-02', vote_average: 8.2, vote_count: 12000, overview: 'Heist gone wrong.', genre_ids: [80], poster_path: '/r.jpg', popularity: 20, media_type: 'movie' },
          ],
        }),
      ),
      http.get(`${TMDB}/discover/movie`, () => HttpResponse.json({ results: [] })),
    );
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [{ remote_id: 680, keep: true, reason: 'Same director energy.' }],
      }),
    ]);
    await runCycle(pipeline(new AgentClient(provider)));

    const system = provider.calls[0]!.system;
    expect(system).toContain('User taste notes (apply these):');
    expect(system).toContain('Titles the user accepted: The Matrix (1999).');
    expect(system).toContain('do not suggest anything of this sort again: Inception (2026)');
    expect(system).toContain('You were wrong about these');
    expect(system).toContain('Direct To Streaming 4 (2025)');
  });

  it('tells the agent what was recently added to the library', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        decisions: [
          { remote_id: 603, keep: false, reason: 'no' },
          { remote_id: 999, keep: false, reason: 'no' },
          { remote_id: 27205, keep: false, reason: 'no' },
        ],
      }),
    ]);
    await runCycle(pipeline(new AgentClient(provider)));

    const system = provider.calls[0]!.system;
    expect(system).toContain('Most recently added to their library, and present on disk');
    expect(system).toContain('Pulp Fiction (1994)');
    expect(system).toContain('Forrest Gump (1994)');
  });

  it('discovers from every source, including "more like what you own"', async () => {
    server.use(
      http.get(`${TMDB}/movie/550/similar`, () =>
        HttpResponse.json({
          results: [
            { id: 680, title: 'Reservoir Dogs', release_date: '1992-09-02', vote_average: 8.2, vote_count: 12000, overview: 'Heist gone wrong.', genre_ids: [80], poster_path: '/r.jpg', popularity: 20 },
          ],
        }),
      ),
    );
    await runCycle(pipeline(heuristicAgent()));

    const origins = store.listDecisions().map((d) => d.origin);
    expect(origins).toContain('similar:550');
    expect(origins).toContain('upcoming');
    expect(origins).toContain('trending');
    expect(store.latestDecision(680)?.title).toBe('Reservoir Dogs');
  });

  it('records a different taste hash once feedback exists', async () => {
    await runCycle(pipeline(heuristicAgent()));
    const before = store.listDecisions()[0]!.tasteHash;

    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    await gateway.react(matrix.messageId, APPROVE_EMOJI);

    server.use(
      http.get(`${TMDB}/trending/movie/week`, () =>
        HttpResponse.json({
          results: [
            { id: 680, title: 'Reservoir Dogs', release_date: '1992-09-02', vote_average: 8.2, vote_count: 12000, overview: 'Heist gone wrong.', genre_ids: [80], poster_path: '/r.jpg', popularity: 20, media_type: 'movie' },
          ],
        }),
      ),
      http.get(`${TMDB}/discover/movie`, () => HttpResponse.json({ results: [] })),
    );
    await runCycle(pipeline(heuristicAgent()));

    const after = store.latestDecision(680)!;
    expect(after.tasteHash).not.toBe(before);
    expect(after.promptVersion).toBe(PROMPT_VERSION); // template unchanged, only the taste snapshot
    expect(store.promptVersionStats()).toHaveLength(2); // measurable before/after
  });
});

describe('answers given while the bot was down', () => {
  it('are picked up at startup and added to Radarr', async () => {
    await runCycle(pipeline(heuristicAgent()));
    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;

    // The user reacts with nothing listening — Discord replays none of it
    gateway.seedReaction(matrix.messageId, APPROVE_EMOJI, ['user-1']);
    expect(store.latestDecision(603)?.outcome).toBeNull();

    const caughtUp = await service.reconcilePending();

    expect(caughtUp).toMatchObject({ approved: 1, rejected: 0 });
    expect(arrPosts[0]?.body).toMatchObject({ tmdbId: 603, monitored: true });
    expect(store.latestDecision(603)?.outcome).toBe('approved');
  });
});

describe('suggestions nobody answers', () => {
  it('expire, grey out, and come back in a later cycle', async () => {
    const day = 24 * 60 * 60 * 1000;
    const posted = new Date('2026-09-01T18:00:00.000Z');
    await runCycle({ ...pipeline(heuristicAgent()), now: () => posted });
    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    expect(store.pendingSuggestions()).toHaveLength(3);

    // Two days later, still no answer
    const later = new Date(posted.getTime() + 3 * day);
    const second = await runCycle({
      ...pipeline(heuristicAgent()),
      expireAfterDays: 2,
      now: () => later,
    });

    expect(second.expired).toBe(3);
    expect(store.pendingSuggestions()).toHaveLength(3); // re-posted, not the old ones
    expect(gateway.embedOf(matrix.messageId)?.color).toBe(COLORS.expired);

    // Expiry is not a "no": the same titles were judged again
    expect(second.judged).toBeGreaterThan(0);
    expect(store.listDecisions({ remoteId: 603 })).toHaveLength(2);
    expect(store.listDecisions({ remoteId: 603 })[1]?.outcome).toBe('expired');
  });

  it('never resurrect a title the user actually answered', async () => {
    const day = 24 * 60 * 60 * 1000;
    const posted = new Date('2026-09-01T18:00:00.000Z');
    await runCycle({ ...pipeline(heuristicAgent()), now: () => posted });
    const matrix = gateway.posted.find((p) => p.embed.title.startsWith('The Matrix'))!;
    await gateway.react(matrix.messageId, REJECT_EMOJI);

    const second = await runCycle({
      ...pipeline(heuristicAgent()),
      expireAfterDays: 2,
      now: () => new Date(posted.getTime() + 3 * day),
    });

    expect(store.listDecisions({ remoteId: 603 })).toHaveLength(1); // not re-judged
    expect(store.latestDecision(603)?.outcome).toBe('rejected');
    expect(second.expired).toBe(2); // the two nobody answered
  });
});

describe('state survives a restart', () => {
  it('reopens the same database file and keeps every verdict', async () => {
    const path = join(dir, 'state.db');
    await runCycle(pipeline(heuristicAgent()));
    const before = store.listDecisions().length;
    store.close();

    store = await Store.open(path);
    expect(store.listDecisions()).toHaveLength(before);
    expect(store.pendingSuggestions()).toHaveLength(3);
  });
});
