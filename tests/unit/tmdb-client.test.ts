import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TmdbClient, TmdbApiError } from '../../src/tmdb/client.js';
import { movieGenresFixture, trendingMoviesFixture } from '../fixtures/tmdb.js';

const BASE = 'http://tmdb.test/3';
const client = new TmdbClient({ baseUrl: BASE, apiKey: 'tmdb-key' });

/** Extract the raw query string msw saw for a request */
function qsOf(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

const discoverQueries: URLSearchParams[] = [];

const server = setupServer(
  http.get(`${BASE}/trending/movie/week`, ({ request }) => {
    const qs = qsOf(request);
    expect(qs.get('api_key')).toBe('tmdb-key');
    expect(qs.get('language')).toBe('en-US');
    return HttpResponse.json({ results: trendingMoviesFixture });
  }),
  http.get(`${BASE}/trending/movie/day`, () =>
    HttpResponse.json({ results: trendingMoviesFixture.slice(0, 1) }),
  ),
  http.get(`${BASE}/movie/603/similar`, ({ request }) => {
    expect(qsOf(request).get('page')).toBe('2');
    return HttpResponse.json({ results: trendingMoviesFixture.slice(0, 1) });
  }),
  http.get(`${BASE}/movie/550/similar`, ({ request }) => {
    expect(qsOf(request).get('page')).toBe('1');
    return HttpResponse.json({ results: trendingMoviesFixture.slice(0, 2) });
  }),
  http.get(`${BASE}/discover/movie`, ({ request }) => {
    discoverQueries.push(qsOf(request));
    return HttpResponse.json({ results: trendingMoviesFixture });
  }),
  http.get(`${BASE}/genre/movie/list`, () => HttpResponse.json({ genres: movieGenresFixture })),
  http.get(`${BASE}/movie/123`, () =>
    HttpResponse.json(
      { status_code: 34, status_message: 'The resource you requested could not be found.' },
      { status: 404 },
    ),
  ),
);

beforeEach(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.close();
  discoverQueries.length = 0;
});

describe('TmdbClient', () => {
  it('trending() sends api_key + language, and defaults to the weekly window', async () => {
    const week = await client.trending();
    expect(week.results[0]).toMatchObject({ id: 550, title: 'Pulp Fiction' });

    const day = await client.trending('day');
    expect(day.results).toHaveLength(1);
  });

  it('upcomingMovies() filters through /discover, not /movie/upcoming', async () => {
    const res = await client.upcomingMovies('2026-07-01');

    expect(res.results).toHaveLength(3);
    expect(discoverQueries[0]?.get('primary_release_date.gte')).toBe('2026-07-01');
    expect(discoverQueries[0]?.get('sort_by')).toBe('popularity.desc');
  });

  it('similar() hits /movie/{id}/similar, defaulting to page 1', async () => {
    expect((await client.similar(603, 2)).results).toHaveLength(1);
    expect((await client.similar(550)).results).toHaveLength(2);
  });

  it('discover() encodes genres, year range, sort and page', async () => {
    await client.discover({ genres: [18, 28], year: 2015, sortBy: 'vote_count.desc', page: 3 });

    const qs = discoverQueries[0]!;
    expect(qs.get('with_genres')).toBe('18,28');
    expect(qs.get('primary_release_date.gte')).toBe('2015-01-01');
    expect(qs.get('primary_release_date.lte')).toBe('2015-12-31');
    expect(qs.get('sort_by')).toBe('vote_count.desc');
    expect(qs.get('page')).toBe('3');
  });

  it('discover() defaults to page 1 and omits unset filters', async () => {
    await client.discover({});

    const qs = discoverQueries[0]!;
    expect(qs.get('page')).toBe('1');
    expect(qs.get('with_genres')).toBeNull();
    expect(qs.get('sort_by')).toBeNull();
  });

  it('discover() lets an explicit date floor win over the year window', async () => {
    await client.discover({ year: 2015, primaryReleaseDateGte: '2015-06-01' });

    expect(discoverQueries[0]?.get('primary_release_date.gte')).toBe('2015-06-01');
    expect(discoverQueries[0]?.get('primary_release_date.lte')).toBe('2015-12-31');
  });

  it('genres() lists movie genres', async () => {
    expect((await client.genres()).genres).toEqual(movieGenresFixture);
  });

  it('throws TmdbApiError with TMDB status message on errors', async () => {
    await expect(client.request('/movie/123', {})).rejects.toMatchObject({
      name: 'TmdbApiError',
      status: 404,
      statusMessage: 'The resource you requested could not be found.',
    });
  });

  it('throws TmdbApiError with empty status message when the error body is not JSON', async () => {
    server.use(
      http.get(
        `${BASE}/movie/123`,
        () => new HttpResponse('Bad Gateway', { status: 502, statusText: 'Bad Gateway' }),
      ),
    );
    const err = await client.request('/movie/123', {}).catch((e) => e);
    expect(err).toBeInstanceOf(TmdbApiError);
    expect((err as TmdbApiError).status).toBe(502);
    expect((err as TmdbApiError).statusMessage).toBe('');
  });
});
