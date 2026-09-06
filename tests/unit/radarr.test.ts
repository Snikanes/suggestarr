import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RadarrClient } from '../../src/arr/radarr.js';
import { ArrApiError } from '../../src/arr/http.js';
import { radarrMoviesFixture } from '../fixtures/radarr-movies.js';

const endpoint = { baseUrl: 'http://radarr.test:7878', apiKey: 'radarr-key' };
const client = new RadarrClient(endpoint);

const server = setupServer(
  http.get('http://radarr.test:7878/api/v3/systemstatus', () =>
    HttpResponse.json({
      version: '4.0.0.0',
      applicationVersion: '1234',
      instanceName: 'radarr',
      uptime: '1:02:03',
    }),
  ),
  http.get('http://radarr.test:7878/api/v3/movie', ({ request }) => {
    if (request.headers.get('X-Api-Key') !== 'radarr-key') {
      return HttpResponse.json({ status: 401, message: 'Invalid API Key' }, { status: 401 });
    }
    return HttpResponse.json(radarrMoviesFixture);
  }),
);

beforeEach(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe('RadarrClient', () => {
  it('systemStatus() hits /api/v3/systemstatus and parses the DTO', async () => {
    const status = await client.systemStatus();
    expect(status).toEqual({
      version: '4.0.0.0',
      applicationVersion: '1234',
      instanceName: 'radarr',
      uptime: '1:02:03',
    });
  });

  it('listMovies() returns the raw DTO list', async () => {
    await expect(client.listMovies()).resolves.toEqual(radarrMoviesFixture);
  });

  it('listTitles() maps every movie to the internal Title model', async () => {
    const titles = await client.listTitles();
    expect(titles).toEqual([
      {
        localId: 1,
        remoteId: 603,
        title: 'The Matrix',
        year: 1999,
        monitored: true,
        posterUrl: 'https://image.tmdb.org/t/p/w342/3ohm95KfEcg3s7aY4ox1sHbFXi.jpg',
        addedAt: '2026-02-01T18:30:00Z',
        hasFile: true,
      },
      {
        localId: 2,
        remoteId: null,
        title: 'Local Film',
        year: null,
        monitored: false,
        posterUrl: null,
        addedAt: '2026-03-10T08:00:00Z',
        hasFile: false,
      },
      {
        localId: 3,
        remoteId: 615119,
        title: 'Cover Only Film',
        year: 2020,
        monitored: true,
        // relative url made absolute against the client base URL
        posterUrl: 'http://radarr.test:7878/api/v3/cover?coverType=cover&id=3',
        addedAt: null,
        hasFile: false,
      },
    ]);
  });

  it('surfaces 401 as ArrApiError', async () => {
    const badClient = new RadarrClient({ baseUrl: endpoint.baseUrl, apiKey: 'wrong-key' });
    await expect(badClient.listMovies()).rejects.toBeInstanceOf(ArrApiError);
    await expect(badClient.listMovies()).rejects.toMatchObject({ status: 401 });
  });
});
