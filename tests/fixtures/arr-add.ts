import type { RadarrLookupDto } from '../../src/arr/types.js';

/** Recorded GET /api/v3/movie/lookup?term=tmdb:603 */
export const radarrLookupFixture: RadarrLookupDto[] = [
  {
    title: 'The Matrix',
    year: 1999,
    tmdbId: 603,
    titleSlug: 'the-matrix-603',
    images: [
      {
        coverType: 'poster',
        url: '/MediaCover/603/poster.jpg',
        remoteUrl: 'https://image.tmdb.org/t/p/original/matrix.jpg',
      },
    ],
    overview: 'A hacker learns reality is a simulation.',
  },
];

export const rootFoldersFixture = [
  { id: 1, path: '/movies' },
  { id: 2, path: '/movies-4k' },
];

export const qualityProfilesFixture = [
  { id: 4, name: 'HD-1080p' },
  { id: 6, name: 'Ultra-HD' },
];
