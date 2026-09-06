import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RadarrClient } from '../../src/arr/radarr.js';
import { ArrAdder, TitleNotFoundError } from '../../src/arr/adder.js';
import { ArrApiError } from '../../src/arr/http.js';
import { buildRadarrAddPayload, type AddOptions } from '../../src/arr/types.js';
import {
  qualityProfilesFixture,
  radarrLookupFixture,
  rootFoldersFixture,
} from '../fixtures/arr-add.js';

const RADARR = 'http://radarr.test:7878';
const radarr = new RadarrClient({ baseUrl: RADARR, apiKey: 'r-key' });

const posted: { url: string; body: any }[] = [];

const server = setupServer(
  http.get(`${RADARR}/api/v3/rootfolder`, () => HttpResponse.json(rootFoldersFixture)),
  http.get(`${RADARR}/api/v3/qualityprofile`, () => HttpResponse.json(qualityProfilesFixture)),
  http.get(`${RADARR}/api/v3/movie/lookup`, ({ request }) => {
    const term = new URL(request.url).searchParams.get('term');
    if (term !== 'tmdb:603') return HttpResponse.json([]);
    return HttpResponse.json(radarrLookupFixture);
  }),
  http.post(`${RADARR}/api/v3/movie`, async ({ request }) => {
    posted.push({ url: request.url, body: await request.json() });
    return HttpResponse.json(
      { id: 42, title: 'The Matrix', sortTitle: 'matrix', year: 1999, tmdbId: 603, monitored: true, images: [] },
      { status: 201 },
    );
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  posted.length = 0;
});
afterAll(() => server.close());

const OPTS: AddOptions = { rootFolderPath: '/movies', qualityProfileId: 4, searchOnAdd: true };

describe('add payload mapping', () => {
  it('maps a Radarr lookup result into a monitored add payload', () => {
    expect(buildRadarrAddPayload(radarrLookupFixture[0]!, OPTS)).toEqual({
      title: 'The Matrix',
      year: 1999,
      tmdbId: 603,
      titleSlug: 'the-matrix-603',
      images: radarrLookupFixture[0]!.images,
      qualityProfileId: 4,
      rootFolderPath: '/movies',
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: true },
    });
  });

  it('tolerates a lookup result with no year and no images', () => {
    const payload = buildRadarrAddPayload(
      { title: 'X', year: null, tmdbId: 1, titleSlug: 'x', images: undefined as never },
      OPTS,
    );
    expect(payload.year).toBeNull();
    expect(payload.images).toEqual([]);
  });
});

describe('RadarrClient lookup + add', () => {
  it('looks a movie up by tmdb id', async () => {
    await expect(radarr.lookupByTmdbId(603)).resolves.toMatchObject({ tmdbId: 603 });
    await expect(radarr.lookupByTmdbId(999)).resolves.toBeNull();
  });

  it('ignores a lookup result for a different tmdb id', async () => {
    server.use(
      http.get(`${RADARR}/api/v3/movie/lookup`, () =>
        HttpResponse.json([{ ...radarrLookupFixture[0]!, tmdbId: 604 }]),
      ),
    );
    await expect(radarr.lookupByTmdbId(603)).resolves.toBeNull();
  });

  it('posts the add payload and returns the created movie', async () => {
    const movie = await radarr.addMovie(radarrLookupFixture[0]!, OPTS);

    expect(movie.id).toBe(42);
    expect(posted[0]?.body).toMatchObject({ tmdbId: 603, monitored: true, rootFolderPath: '/movies' });
  });

  it('surfaces a rejected payload as an ArrApiError', async () => {
    server.use(
      http.post(`${RADARR}/api/v3/movie`, () =>
        HttpResponse.json([{ errorMessage: 'This movie has already been added' }], { status: 400 }),
      ),
    );
    const err = (await radarr.addMovie(radarrLookupFixture[0]!, OPTS).catch((e) => e)) as ArrApiError;

    expect(err).toBeInstanceOf(ArrApiError);
    expect(err.status).toBe(400);
    expect(err.body).toContain('already been added');
  });
});

describe('ArrAdder', () => {
  const placement = { searchOnAdd: true };

  it('adds a movie using the first root folder and profile by default', async () => {
    const added = await new ArrAdder(radarr, placement).add(603, 'The Matrix', 1999);

    expect(added).toEqual({
      remoteId: 603,
      localId: 42,
      title: 'The Matrix',
      rootFolderPath: '/movies',
      qualityProfileId: 4,
    });
  });

  it('honours the configured root folder and quality profile name', async () => {
    const adder = new ArrAdder(radarr, {
      rootFolder: '/movies-4k',
      qualityProfile: 'ultra-hd',
      searchOnAdd: false,
    });
    await adder.add(603, 'The Matrix', 1999);

    expect(posted[0]?.body).toMatchObject({
      rootFolderPath: '/movies-4k',
      qualityProfileId: 6,
      addOptions: { searchForMovie: false },
    });
  });

  it('resolves placement once and reuses it', async () => {
    let folderCalls = 0;
    server.use(
      http.get(`${RADARR}/api/v3/rootfolder`, () => {
        folderCalls += 1;
        return HttpResponse.json(rootFoldersFixture);
      }),
    );
    const adder = new ArrAdder(radarr, placement);
    await adder.add(603, 'The Matrix', 1999);
    await adder.add(603, 'The Matrix', 1999);

    expect(folderCalls).toBe(1);
    expect(posted).toHaveLength(2);
  });

  it('raises TitleNotFoundError when Radarr cannot resolve the title', async () => {
    const adder = new ArrAdder(radarr, placement);

    await expect(adder.add(12345, 'Ghost Movie', 2020)).rejects.toBeInstanceOf(TitleNotFoundError);
    await expect(adder.add(12345, 'Ghost Movie', 2020)).rejects.toThrow(
      /Radarr has no match for "Ghost Movie" \(tmdb 12345\)/,
    );
    expect(posted).toHaveLength(0);
  });

  it('explains a misconfigured root folder or profile', async () => {
    await expect(
      new ArrAdder(radarr, { rootFolder: '/nope', searchOnAdd: true }).add(603, 'The Matrix', 1999),
    ).rejects.toThrow(/Root folder "\/nope" not configured in Radarr/);

    await expect(
      new ArrAdder(radarr, { qualityProfile: 'Nope', searchOnAdd: true }).add(603, 'The Matrix', 1999),
    ).rejects.toThrow(/Quality profile "Nope" not found in Radarr/);
  });

  it('explains a Radarr with nothing configured at all', async () => {
    server.use(http.get(`${RADARR}/api/v3/rootfolder`, () => HttpResponse.json([])));
    await expect(new ArrAdder(radarr, placement).add(603, 'The Matrix', 1999)).rejects.toThrow(
      /Radarr has no root folders configured/,
    );

    server.use(
      http.get(`${RADARR}/api/v3/rootfolder`, () => HttpResponse.json(rootFoldersFixture)),
      http.get(`${RADARR}/api/v3/qualityprofile`, () => HttpResponse.json([])),
    );
    await expect(new ArrAdder(radarr, placement).add(603, 'The Matrix', 1999)).rejects.toThrow(
      /Radarr has no quality profiles configured/,
    );
  });
});
