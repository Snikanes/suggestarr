import type { RadarrMovieDto } from '../../src/arr/types.js';

/**
 * Recorded shape of Radarr GET /api/v3/movie (trimmed to consumed fields).
 * Note: poster `url` is *relative* (/api/v3/cover/...), remoteUrl is absolute.
 */
export const radarrMoviesFixture: RadarrMovieDto[] = [
  {
    id: 1,
    title: 'The Matrix',
    sortTitle: 'matrix',
    originalTitle: null,
    year: 1999,
    tmdbId: 603,
    monitored: true,
    added: '2026-02-01T18:30:00Z',
    hasFile: true,
    images: [
      {
        coverType: 'poster',
        url: '/api/v3/cover?coverType=poster&id=1',
        remoteUrl: 'https://image.tmdb.org/t/p/w342/3ohm95KfEcg3s7aY4ox1sHbFXi.jpg',
      },
    ],
  },
  {
    id: 2,
    title: 'Local Film',
    sortTitle: 'local film',
    originalTitle: 'Local Film',
    year: null,
    tmdbId: null,
    monitored: false,
    // Monitored-but-never-grabbed: added, but nothing on disk
    added: '2026-03-10T08:00:00Z',
    hasFile: false,
    // No images at all -> posterUrl must map to null
    images: [],
  },
  {
    id: 3,
    title: 'Cover Only Film',
    sortTitle: 'cover only film',
    originalTitle: null,
    year: 2020,
    tmdbId: 615119,
    monitored: true,
    images: [
      {
        // coverType 'cover' without remoteUrl -> must be made absolute from baseUrl
        coverType: 'cover',
        url: '/api/v3/cover?coverType=cover&id=3',
      },
    ],
  },
];
