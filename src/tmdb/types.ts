/**
 * TMDB v3 API DTOs and the internal Candidate model.
 *
 * `Title` (arr/types.ts) represents movies we *own* in Radarr;
 * `Candidate` represents a movie TMDB *suggests* we might want.
 * Movies only — TMDB's TV endpoints are deliberately not wired up.
 */

// ---------------------------------------------------------------------------
// TMDB API DTOs (only the fields we consume)
// ---------------------------------------------------------------------------

export interface TmdbMovieDto {
  id: number;
  title: string;
  original_title?: string | null;
  release_date: string | null; // ISO date or null
  vote_average: number | null;
  vote_count: number | null;
  overview: string | null;
  genre_ids: number[];
  poster_path: string | null; // relative, e.g. "/abc.jpg"
  popularity: number | null;
}

export interface TmdbGenreDto {
  id: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Internal candidate model
// ---------------------------------------------------------------------------

/** Where a candidate came from, e.g. "trending", "upcoming", "similar:603" */
export type CandidateOrigin = string;

export interface Candidate {
  /** canonical TMDB id */
  remoteId: number;
  title: string;
  year: number | null;
  rating: number | null; // vote_average (0..10)
  votes: number | null; // vote_count
  /**
   * TMDB popularity. The only ranking signal an unreleased film has —
   * it cannot have a meaningful vote average yet.
   */
  popularity: number | null;
  overview: string | null;
  genreIds: number[];
  posterUrl: string | null;
  origin: CandidateOrigin;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

function posterToUrl(posterPath: string | null): string | null {
  if (!posterPath) return null;
  return `${TMDB_IMAGE_BASE}${posterPath}`;
}

/** "2024-05-21" -> 2024; null/invalid -> null */
function yearFromIsoDate(date: string | null): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

export function mapTmdbMovieToCandidate(movie: TmdbMovieDto, origin: CandidateOrigin): Candidate {
  return {
    remoteId: movie.id,
    title: movie.title,
    year: yearFromIsoDate(movie.release_date),
    rating: movie.vote_average ?? null,
    votes: movie.vote_count ?? null,
    popularity: movie.popularity ?? null,
    overview: movie.overview ?? null,
    genreIds: movie.genre_ids ?? [],
    posterUrl: posterToUrl(movie.poster_path),
    origin,
  };
}

/**
 * Some endpoints (e.g. `/trending/all`) return mixed media with a
 * `media_type` discriminator. Anything that is not a movie is dropped.
 */
export function mapTmdbMediaToCandidate(
  media: TmdbMovieDto & { media_type?: string },
  origin: CandidateOrigin,
): Candidate | null {
  if (media.media_type !== undefined && media.media_type !== 'movie') return null;
  return mapTmdbMovieToCandidate(media, origin);
}
