import { describe, expect, it } from 'vitest';
import { mapTmdbMediaToCandidate, mapTmdbMovieToCandidate } from '../../src/tmdb/types.js';
import type { TmdbMovieDto } from '../../src/tmdb/types.js';

const movie: TmdbMovieDto = {
  id: 603,
  title: 'The Matrix',
  original_title: null,
  release_date: '1999-03-31',
  vote_average: 8.2,
  vote_count: 16000,
  overview: 'A hacker learns reality is a simulation.',
  genre_ids: [878, 28],
  poster_path: '/3ohm95KfEcg3s7aY4ox1sHbFXi.jpg',
  popularity: 61,
};

describe('mapTmdbMovieToCandidate', () => {
  it('maps a full movie DTO with poster and year', () => {
    expect(mapTmdbMovieToCandidate(movie, 'trending')).toEqual({
      remoteId: 603,
      title: 'The Matrix',
      year: 1999,
      rating: 8.2,
      votes: 16000,
      popularity: 61,
      overview: 'A hacker learns reality is a simulation.',
      genreIds: [878, 28],
      posterUrl: 'https://image.tmdb.org/t/p/w342/3ohm95KfEcg3s7aY4ox1sHbFXi.jpg',
      origin: 'trending',
    });
  });

  it('maps null date/rating/votes/overview/poster to null/empty', () => {
    const c = mapTmdbMovieToCandidate(
      {
        ...movie,
        release_date: null,
        vote_average: null,
        vote_count: null,
        overview: null,
        genre_ids: [],
        poster_path: null,
      },
      'upcoming',
    );
    expect(c).toMatchObject({
      year: null,
      rating: null,
      votes: null,
      overview: null,
      genreIds: [],
      posterUrl: null,
      origin: 'upcoming',
    });
  });

  it('rejects a nonsense release date rather than inventing a year', () => {
    expect(mapTmdbMovieToCandidate({ ...movie, release_date: 'soon' }, 'trending').year).toBeNull();
    expect(mapTmdbMovieToCandidate({ ...movie, release_date: '' }, 'trending').year).toBeNull();
  });

  it('carries popularity through as the ranking signal for unrated films', () => {
    expect(mapTmdbMovieToCandidate(movie, 'trending').popularity).toBe(61);
    expect(
      mapTmdbMovieToCandidate({ ...movie, popularity: null }, 'trending').popularity,
    ).toBeNull();
  });

  it('defaults a missing genre_ids array to empty', () => {
    const c = mapTmdbMovieToCandidate(
      { ...movie, genre_ids: undefined as unknown as number[] },
      'trending',
    );
    expect(c.genreIds).toEqual([]);
  });
});

describe('mapTmdbMediaToCandidate (mixed endpoints)', () => {
  it('passes movies through', () => {
    const c = mapTmdbMediaToCandidate({ ...movie, media_type: 'movie' }, 'trending');
    expect(c?.remoteId).toBe(603);
  });

  it('accepts entries with no media_type — kind-specific endpoints omit it', () => {
    expect(mapTmdbMediaToCandidate(movie, 'similar:550')?.title).toBe('The Matrix');
  });

  it('drops anything that is not a movie', () => {
    expect(mapTmdbMediaToCandidate({ ...movie, media_type: 'tv' }, 'trending')).toBeNull();
    expect(mapTmdbMediaToCandidate({ ...movie, media_type: 'person' }, 'trending')).toBeNull();
  });
});
