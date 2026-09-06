import type { TmdbGenreDto, TmdbMovieDto } from '../../src/tmdb/types.js';

/** Recorded shape of TMDB /trending/movie/week results */
export const trendingMoviesFixture: TmdbMovieDto[] = [
  {
    id: 550,
    title: 'Pulp Fiction',
    original_title: null,
    release_date: '1994-10-14',
    vote_average: 8.5,
    vote_count: 14000,
    overview: 'A hitman, a box, and a tale told out of order.',
    genre_ids: [53, 18],
    poster_path: '/d5iDquNudjd15fxutTSQ3qC6Ft.jpg',
    popularity: 82.3,
  },
  {
    id: 603,
    title: 'The Matrix',
    original_title: null,
    release_date: '1999-03-31',
    vote_average: 8.2,
    vote_count: 16000,
    overview: 'A hacker learns reality is a simulation.',
    genre_ids: [878, 28],
    poster_path: '/3ohm95KfEcg3s7aY4ox1sHbFXi.jpg',
    popularity: 61.0,
  },
  {
    id: 999999,
    title: 'Obscure Film',
    original_title: null,
    release_date: null,
    vote_average: 2.0,
    vote_count: 3,
    overview: null,
    genre_ids: [],
    poster_path: null,
    popularity: 0.1,
  },
];

/** Recorded shape of TMDB /trending/tv/week results */
export const movieGenresFixture: TmdbGenreDto[] = [
  { id: 28, name: 'Action' },
  { id: 18, name: 'Drama' },
  { id: 35, name: 'Comedy' },
  { id: 53, name: 'Thriller' },
  { id: 80, name: 'Crime' },
  { id: 878, name: 'Science Fiction' },
];
