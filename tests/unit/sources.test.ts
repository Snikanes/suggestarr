import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gatherCandidates } from '../../src/discovery/sources.js';
import { TmdbClient } from '../../src/tmdb/client.js';
import type { Title } from '../../src/arr/types.js';
import { trendingMoviesFixture } from '../fixtures/tmdb.js';

const BASE = 'http://tmdb.test/3';
const tmdb = new TmdbClient({ baseUrl: BASE, apiKey: 'k' });

const title = (over: Partial<Title>): Title => ({
  localId: 1,
  remoteId: 550,
  title: 'Pulp Fiction',
  year: 1994,
  monitored: true,
  posterUrl: null,
  addedAt: '2026-02-01T00:00:00Z',
  hasFile: true,
  ...over,
});

const library: Title[] = [
  title({}),
  title({ localId: 2, remoteId: 603, title: 'The Matrix', year: 1999 }),
  title({ localId: 3, remoteId: 13, title: 'Forrest Gump', year: 1994 }),
];

const seen: string[] = [];
/** path plus the page it asked for, so paging is observable */
const record = (request: Request) => {
  const url = new URL(request.url);
  seen.push(`${url.pathname}?page=${url.searchParams.get('page')}`);
};

/** one result per page, id = page number, so results are traceable */
const pageOf = (page: number, totalPages: number) => ({
  page,
  total_pages: totalPages,
  results: [{ ...trendingMoviesFixture[0]!, id: page * 100 }],
});

const server = setupServer(
  http.get(`${BASE}/trending/movie/week`, ({ request }) => {
    record(request);
    return HttpResponse.json({ results: trendingMoviesFixture, page: 1, total_pages: 10 });
  }),
  http.get(`${BASE}/discover/movie`, ({ request }) => {
    record(request);
    return HttpResponse.json({ results: [trendingMoviesFixture[0]], page: 1, total_pages: 10 });
  }),
  http.get(`${BASE}/movie/:id/similar`, ({ request }) => {
    record(request);
    return HttpResponse.json({ results: [trendingMoviesFixture[1]] });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

describe('gatherCandidates', () => {
  it('gathers trending and upcoming movies', async () => {
    const { candidates, failures } = await gatherCandidates(tmdb, library, {
      similarSeeds: 0,
      pages: 1,
    });

    expect(failures).toEqual([]);
    expect(seen.sort()).toEqual(['/3/discover/movie?page=1', '/3/trending/movie/week?page=1']);
    expect(candidates.some((c) => c.origin === 'trending')).toBe(true);
    expect(candidates.some((c) => c.origin === 'upcoming')).toBe(true);
  });

  it('seeds "more like this" from the newest owned titles', async () => {
    const { candidates } = await gatherCandidates(tmdb, library, { similarSeeds: 2, pages: 1 });

    // The Matrix (1999) and Pulp Fiction (1994) beat Forrest Gump on the tie-break order
    expect(seen).toContain('/3/movie/603/similar?page=1');
    expect(seen).toContain('/3/movie/550/similar?page=1');
    expect(seen.some((p) => p.startsWith('/3/movie/13/similar'))).toBe(false);
    expect(candidates.some((c) => c.origin === 'similar:603')).toBe(true);
  });

  it('never seeds from unmonitored or unmatched library entries', async () => {
    await gatherCandidates(
      tmdb,
      [
        title({ remoteId: 111, monitored: false }),
        title({ localId: 9, remoteId: null, title: 'Local Film' }),
      ],
      { similarSeeds: 3, pages: 1 },
    );
    expect(seen.filter((p) => p.includes('similar'))).toEqual([]);
  });

  it('defaults to a small number of seeds when unspecified', async () => {
    await gatherCandidates(tmdb, library, { pages: 1 });
    expect(seen.filter((p) => p.includes('similar'))).toHaveLength(3);
  });

  it('walks the requested number of pages per broad source', async () => {
    server.use(
      http.get(`${BASE}/trending/movie/week`, ({ request }) => {
        record(request);
        const page = Number(new URL(request.url).searchParams.get('page'));
        return HttpResponse.json(pageOf(page, 10));
      }),
    );
    const { candidates } = await gatherCandidates(tmdb, library, { similarSeeds: 0, pages: 3 });

    expect(seen.filter((p) => p.startsWith('/3/trending')).sort()).toEqual([
      '/3/trending/movie/week?page=1',
      '/3/trending/movie/week?page=2',
      '/3/trending/movie/week?page=3',
    ]);
    expect(candidates.filter((c) => c.origin === 'trending').map((c) => c.remoteId).sort()).toEqual([
      100, 200, 300,
    ]);
  });

  it('stops at the last page TMDB actually has', async () => {
    server.use(
      http.get(`${BASE}/trending/movie/week`, ({ request }) => {
        record(request);
        const page = Number(new URL(request.url).searchParams.get('page'));
        return HttpResponse.json(pageOf(page, 2));
      }),
    );
    await gatherCandidates(tmdb, library, { similarSeeds: 0, pages: 5 });

    expect(seen.filter((p) => p.startsWith('/3/trending'))).toHaveLength(2);
  });

  it('treats a response with no total_pages as a single page', async () => {
    server.use(
      http.get(`${BASE}/trending/movie/week`, ({ request }) => {
        record(request);
        return HttpResponse.json({ results: trendingMoviesFixture });
      }),
    );
    await gatherCandidates(tmdb, library, { similarSeeds: 0, pages: 4 });

    expect(seen.filter((p) => p.startsWith('/3/trending'))).toHaveLength(1);
  });

  it('keeps the pages that worked when a later page fails', async () => {
    server.use(
      http.get(`${BASE}/trending/movie/week`, ({ request }) => {
        record(request);
        const page = Number(new URL(request.url).searchParams.get('page'));
        if (page === 2) return HttpResponse.json({}, { status: 500 });
        return HttpResponse.json(pageOf(page, 10));
      }),
    );
    const { candidates, failures } = await gatherCandidates(tmdb, library, {
      similarSeeds: 0,
      pages: 3,
    });

    expect(failures.filter((f) => f.includes('trending'))).toEqual([]);
    expect(candidates.filter((c) => c.origin === 'trending').map((c) => c.remoteId).sort()).toEqual([
      100, 300,
    ]);
  });

  it('fails the whole source when its first page fails', async () => {
    server.use(
      http.get(`${BASE}/trending/movie/week`, ({ request }) => {
        record(request);
        const page = Number(new URL(request.url).searchParams.get('page'));
        return page === 1
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json(pageOf(page, 10));
      }),
    );
    const { candidates, failures } = await gatherCandidates(tmdb, library, {
      similarSeeds: 0,
      pages: 3,
    });

    expect(failures[0]).toContain('TMDB trending movies failed');
    expect(candidates.some((c) => c.origin === 'trending')).toBe(false);
    expect(seen.filter((p) => p.startsWith('/3/trending'))).toHaveLength(1);
  });

  it('tags everything from the upcoming source so the filters can exempt it', async () => {
    const { candidates } = await gatherCandidates(tmdb, library, { similarSeeds: 0, pages: 1 });
    expect(candidates.filter((c) => c.origin === 'upcoming').length).toBeGreaterThan(0);
  });

  it('isolates a failing source and keeps the rest', async () => {
    server.use(http.get(`${BASE}/discover/movie`, () => HttpResponse.json({}, { status: 503 })));
    const { candidates, failures } = await gatherCandidates(tmdb, library, {
      similarSeeds: 0,
      pages: 1,
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('TMDB upcoming movies failed');
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('labels a failing similar lookup with the title it was seeded from', async () => {
    server.use(http.get(`${BASE}/movie/:id/similar`, () => HttpResponse.json({}, { status: 404 })));
    const { failures } = await gatherCandidates(tmdb, library, { similarSeeds: 1, pages: 1 });

    expect(failures[0]).toContain('TMDB movies similar to The Matrix failed');
  });
});
