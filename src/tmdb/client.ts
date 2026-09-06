import type { TmdbGenreDto, TmdbMovieDto } from './types.js';

export class TmdbApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusMessage: string,
  ) {
    super(message);
    this.name = 'TmdbApiError';
  }
}

export interface TmdbEndpoint {
  baseUrl: string; // e.g. https://api.themoviedb.org/3
  apiKey: string;
}

export interface DiscoverParams {
  /** keep candidates whose genre_ids intersect these */
  genres?: number[];
  year?: number;
  primaryReleaseDateGte?: string;
  sortBy?: string; // e.g. "vote_count.desc", "popularity.desc"
  page?: number;
}

/** TMDB "page" response envelope (trimmed to consumed fields) */
export interface TmdbPage<T> {
  results: T[];
  /** 1-based page this response represents; absent on some endpoints */
  page?: number;
  /** how many pages exist in total — the bound for paging */
  total_pages?: number;
}

/**
 * Minimal TMDB v3 REST client, movies only. Auth via the `api_key` query
 * parameter (TMDB does not support header auth on the public API).
 */
export class TmdbClient {
  constructor(readonly endpoint: TmdbEndpoint) {}

  /**
   * Generic TMDB request. Public escape hatch for ad-hoc endpoints and
   * for tests.
   */
  async request<T>(path: string, query: Record<string, string>): Promise<T> {
    const params = new URLSearchParams({ api_key: this.endpoint.apiKey, ...query });
    const url = `${this.endpoint.baseUrl}${path}?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as {
        status_code?: number;
        status_message?: string;
      } | null;
      throw new TmdbApiError(
        `TMDB ${res.status} ${res.statusText} for ${path}`,
        res.status,
        errBody?.status_message ?? '',
      );
    }
    return (await res.json()) as T;
  }

  /** GET /trending/movie/{time_window} */
  async trending(window: 'day' | 'week' = 'week', page = 1): Promise<TmdbPage<TmdbMovieDto>> {
    return this.request<TmdbPage<TmdbMovieDto>>(`/trending/movie/${window}`, {
      language: 'en-US',
      page: String(page),
    });
  }

  /**
   * Movies released from `fromDate` onward.
   *
   * Note this goes through `/discover/movie`, NOT `/movie/upcoming`: the
   * latter ignores date parameters entirely (it filters by region and
   * returns whatever TMDB considers "upcoming" there), so asking it for a
   * date range silently returns an unfiltered list.
   */
  async upcomingMovies(fromDate: string, page = 1): Promise<TmdbPage<TmdbMovieDto>> {
    return this.request<TmdbPage<TmdbMovieDto>>('/discover/movie', {
      language: 'en-US',
      'primary_release_date.gte': fromDate,
      sort_by: 'popularity.desc',
      page: String(page),
    });
  }

  /** GET /movie/{id}/similar */
  async similar(id: number, page = 1): Promise<TmdbPage<TmdbMovieDto>> {
    return this.request<TmdbPage<TmdbMovieDto>>(`/movie/${id}/similar`, {
      language: 'en-US',
      page: String(page),
    });
  }

  /** GET /discover/movie */
  async discover(params: DiscoverParams): Promise<TmdbPage<TmdbMovieDto>> {
    const query: Record<string, string> = { language: 'en-US', page: String(params.page ?? 1) };
    if (params.genres?.length) query.with_genres = params.genres.join(',');
    if (params.year !== undefined) {
      query['primary_release_date.gte'] = `${params.year}-01-01`;
      query['primary_release_date.lte'] = `${params.year}-12-31`;
    }
    if (params.primaryReleaseDateGte !== undefined) {
      query['primary_release_date.gte'] = params.primaryReleaseDateGte;
    }
    if (params.sortBy !== undefined) query.sort_by = params.sortBy;
    return this.request<TmdbPage<TmdbMovieDto>>('/discover/movie', query);
  }

  /** GET /genre/movie/list */
  async genres(): Promise<{ genres: TmdbGenreDto[] }> {
    return this.request<{ genres: TmdbGenreDto[] }>('/genre/movie/list', { language: 'en-US' });
  }
}
