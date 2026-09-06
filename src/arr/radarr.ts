import { arrFetch, type ArrEndpoint } from './http.js';
import {
  buildRadarrAddPayload,
  mapRadarrMovieToTitle,
  type AddOptions,
  type RadarrQualityProfileDto,
  type RadarrLookupDto,
  type RadarrMovieDto,
  type RadarrRootFolderDto,
  type ArrSystemStatus,
  type Title,
} from './types.js';

export class RadarrClient {
  constructor(readonly endpoint: ArrEndpoint) {}

  /** Health/version check: GET /api/v3/systemstatus */
  async systemStatus(): Promise<ArrSystemStatus> {
    return arrFetch<ArrSystemStatus>(this.endpoint, '/api/v3/systemstatus');
  }

  /** List all movies: GET /api/v3/movie */
  async listMovies(): Promise<RadarrMovieDto[]> {
    return arrFetch<RadarrMovieDto[]>(this.endpoint, '/api/v3/movie');
  }

  /** List all movies mapped to internal Titles. */
  async listTitles(): Promise<Title[]> {
    const movies = await this.listMovies();
    return movies.map((m) => mapRadarrMovieToTitle(m, this.endpoint.baseUrl));
  }

  async rootFolders(): Promise<RadarrRootFolderDto[]> {
    return arrFetch<RadarrRootFolderDto[]>(this.endpoint, '/api/v3/rootfolder');
  }

  async qualityProfiles(): Promise<RadarrQualityProfileDto[]> {
    return arrFetch<RadarrQualityProfileDto[]>(this.endpoint, '/api/v3/qualityprofile');
  }

  /**
   * GET /api/v3/movie/lookup?term=tmdb:{id} — Radarr's own metadata view of
   * a movie, which doubles as the skeleton of the add payload.
   */
  async lookupByTmdbId(tmdbId: number): Promise<RadarrLookupDto | null> {
    const results = await arrFetch<RadarrLookupDto[]>(
      this.endpoint,
      `/api/v3/movie/lookup?term=${encodeURIComponent(`tmdb:${tmdbId}`)}`,
    );
    return results.find((r) => r.tmdbId === tmdbId) ?? null;
  }

  /** POST /api/v3/movie — monitored, and searching immediately when asked. */
  async addMovie(lookup: RadarrLookupDto, opts: AddOptions): Promise<RadarrMovieDto> {
    return arrFetch<RadarrMovieDto>(this.endpoint, '/api/v3/movie', {
      method: 'POST',
      body: JSON.stringify(buildRadarrAddPayload(lookup, opts)),
    });
  }
}
