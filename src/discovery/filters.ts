import type { Candidate } from '../tmdb/types.js';
import type { Title } from '../arr/types.js';

/**
 * User-tunable taste filter applied to TMDB candidates.
 * (Becomes part of the persistent taste profile in M5.)
 */
export interface DiscoveryPrefs {
  /** minimum vote_average (0..10); candidates without a rating are dropped */
  minRating: number;
  /** minimum vote_count — filters out obscure titles the LLM can't judge well */
  minVotes: number;
  /**
   * Let unreleased candidates past the rating/vote floor (default true).
   *
   * A film that is not out yet has no votes by definition, so applying
   * the same floor to it silently removes the entire upcoming source —
   * which is the most interesting one, since it is the only way to get a
   * download queued before release rather than months after.
   */
  exemptUpcoming?: boolean;
  /** inclusive lower bound on release/air year */
  yearFrom?: number;
  /** keep only candidates carrying at least one of these TMDB genre ids */
  includeGenres?: number[];
  /** drop candidates carrying any of these TMDB genre ids */
  excludeGenres?: number[];
}

export const DEFAULT_DISCOVERY_PREFS: DiscoveryPrefs = {
  minRating: 6,
  minVotes: 100,
  exemptUpcoming: true,
};

/** Origin marking a candidate that has not been released yet. */
export const UPCOMING_ORIGIN = 'upcoming';

export function isUpcoming(candidate: Candidate): boolean {
  return candidate.origin === UPCOMING_ORIGIN;
}

/**
 * Filter candidates by rating/votes/year/genre preferences.
 * Pure function — exhaustively unit tested.
 */
export function filterCandidates(candidates: Candidate[], prefs: DiscoveryPrefs): Candidate[] {
  const exemptUpcoming = prefs.exemptUpcoming ?? true;

  return candidates.filter((c) => {
    // Year and genre rules apply to everything; only the quality floor is
    // waived for films that cannot have been rated yet.
    const applyQualityFloor = !(exemptUpcoming && isUpcoming(c));
    if (applyQualityFloor) {
      if (c.rating === null || c.rating < prefs.minRating) return false;
      if (c.votes === null || c.votes < prefs.minVotes) return false;
    }
    if (prefs.yearFrom !== undefined && (c.year === null || c.year < prefs.yearFrom)) return false;
    if (prefs.includeGenres?.length && !c.genreIds.some((g) => prefs.includeGenres!.includes(g))) {
      return false;
    }
    if (prefs.excludeGenres?.length && c.genreIds.some((g) => prefs.excludeGenres!.includes(g))) {
      return false;
    }
    return true;
  });
}

/**
 * Drop candidates we already have.
 *
 * Matching is by TMDB id; library items without one (media Radarr could
 * not match) simply can't be deduped against.
 */
export function dedupeAgainstLibrary(candidates: Candidate[], library: Title[]): Candidate[] {
  const owned = new Set(
    library.filter((t): t is Title & { remoteId: number } => t.remoteId !== null).map((t) => t.remoteId),
  );
  return candidates.filter((c) => !owned.has(c.remoteId));
}
