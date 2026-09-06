/**
 * Radarr DTOs and the internal Title model.
 *
 * `Title` is the seam between adapters: Radarr and TMDB data is mapped
 * INTO this model, and outbound payloads are built FROM it. All mapping
 * lives in this file so it can be exhaustively tested.
 *
 * Suggestarr is movies-only — there is deliberately no media-kind
 * discriminator anywhere in the model.
 */

// ---------------------------------------------------------------------------
// Radarr v3/v4 API DTOs (only the fields we consume)
// ---------------------------------------------------------------------------

export interface RadarrImage {
  coverType: string;
  url: string;
  remoteUrl?: string | null;
}

export interface RadarrMovieDto {
  id: number;
  title: string;
  sortTitle: string;
  originalTitle?: string | null;
  year: number | null;
  /** tmdb id; null for media Radarr could not match */
  tmdbId: number | null;
  monitored: boolean;
  images: RadarrImage[];
  /** ISO timestamp of when the movie was added to Radarr */
  added?: string | null;
  /** whether the file is actually on disk (vs. monitored but not grabbed) */
  hasFile?: boolean;
}

/** GET /api/v3/systemstatus */
export interface ArrSystemStatus {
  version: string;
  applicationVersion: string;
  instanceName: string;
  uptime: string;
}

/** GET /api/v3/movie/lookup — a not-yet-added movie, in add-payload shape. */
export interface RadarrLookupDto {
  title: string;
  year: number | null;
  tmdbId: number;
  titleSlug: string;
  images: RadarrImage[];
  overview?: string | null;
  /** present only when the movie is ALREADY in Radarr */
  id?: number;
}

export interface RadarrRootFolderDto {
  id: number;
  path: string;
}

export interface RadarrQualityProfileDto {
  id: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

export interface Title {
  /** Radarr's own movie id */
  localId: number;
  /** canonical remote id (TMDB). null when Radarr could not match it */
  remoteId: number | null;
  title: string;
  year: number | null;
  monitored: boolean;
  /** absolute poster URL, or null when none available */
  posterUrl: string | null;
  /**
   * When the title was added to Radarr, ISO-8601, or null when the API
   * did not say. This is the closest thing Radarr has to a taste
   * timeline: what the user chose to bring in, and when.
   */
  addedAt: string | null;
  /** true when the media is actually on disk, not merely monitored */
  hasFile: boolean;
}

// ---------------------------------------------------------------------------
// Mapping: Radarr DTO -> internal Title
// ---------------------------------------------------------------------------

/**
 * Resolve a poster URL from Radarr's `images` list.
 *
 * Radarr image `url` values are relative (`/MediaCover/...`); `remoteUrl`
 * points at the external CDN (TMDB). We prefer remoteUrl because it is
 * already absolute AND publicly reachable — a Radarr-relative URL would
 * be useless to anything outside this network, Discord included.
 */
export function resolvePosterUrl(
  images: RadarrImage[] | null | undefined,
  baseUrl: string,
): string | null {
  const poster = images?.find((i) => i.coverType === 'poster' || i.coverType === 'cover');
  if (!poster) return null;
  if (poster.remoteUrl) return poster.remoteUrl;
  return new URL(poster.url, baseUrl).toString();
}

export function mapRadarrMovieToTitle(movie: RadarrMovieDto, baseUrl: string): Title {
  return {
    localId: movie.id,
    remoteId: movie.tmdbId ?? null,
    title: movie.title,
    year: movie.year ?? null,
    monitored: movie.monitored,
    posterUrl: resolvePosterUrl(movie.images, baseUrl),
    addedAt: movie.added ?? null,
    hasFile: movie.hasFile ?? false,
  };
}

// ---------------------------------------------------------------------------
// Mapping: lookup result -> Radarr add payload
// ---------------------------------------------------------------------------

/** Where and how an approved title gets added. */
export interface AddOptions {
  rootFolderPath: string;
  qualityProfileId: number;
  /** ask Radarr to start searching indexers immediately (the whole point) */
  searchOnAdd: boolean;
}

export interface RadarrAddPayload {
  title: string;
  year: number | null;
  tmdbId: number;
  titleSlug: string;
  images: RadarrImage[];
  qualityProfileId: number;
  rootFolderPath: string;
  monitored: true;
  minimumAvailability: 'released';
  addOptions: { searchForMovie: boolean };
}

export function buildRadarrAddPayload(
  lookup: RadarrLookupDto,
  opts: AddOptions,
): RadarrAddPayload {
  return {
    title: lookup.title,
    year: lookup.year ?? null,
    tmdbId: lookup.tmdbId,
    titleSlug: lookup.titleSlug,
    images: lookup.images ?? [],
    qualityProfileId: opts.qualityProfileId,
    rootFolderPath: opts.rootFolderPath,
    monitored: true,
    minimumAvailability: 'released',
    addOptions: { searchForMovie: opts.searchOnAdd },
  };
}
