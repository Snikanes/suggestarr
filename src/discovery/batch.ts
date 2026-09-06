import { isUpcoming } from './filters.js';
import type { Candidate } from '../tmdb/types.js';

export interface BatchOptions {
  /** hard cap on how many candidates reach the agent; unset = no cap */
  batchSize?: number;
  /**
   * Slots held for unreleased films (default 3, clamped to batchSize).
   *
   * Without a reservation, upcoming titles never reach the agent: they
   * are unrated by definition, so a rating-ordered batch always puts
   * released films ahead of them and the cap cuts them off.
   */
  upcomingSlots?: number;
}

const DEFAULT_UPCOMING_SLOTS = 3;

const byRating = (a: Candidate, b: Candidate): number => (b.rating ?? 0) - (a.rating ?? 0);
const byPopularity = (a: Candidate, b: Candidate): number =>
  (b.popularity ?? 0) - (a.popularity ?? 0);

/**
 * Pick the batch the agent judges this cycle: the best-rated released
 * films, plus a reserved share of the most anticipated unreleased ones.
 *
 * Unused reservations are given back — a cycle with no upcoming titles
 * still hands over a full batch of released ones, and vice versa.
 */
export function selectBatch(eligible: Candidate[], opts: BatchOptions = {}): Candidate[] {
  const released = eligible.filter((c) => !isUpcoming(c)).sort(byRating);
  const upcoming = eligible.filter(isUpcoming).sort(byPopularity);

  if (opts.batchSize === undefined) return [...released, ...upcoming];

  const size = Math.max(0, opts.batchSize);
  const reserved = Math.min(opts.upcomingSlots ?? DEFAULT_UPCOMING_SLOTS, size);

  const pickedUpcoming = upcoming.slice(0, reserved);
  const pickedReleased = released.slice(0, size - pickedUpcoming.length);
  const batch = [...pickedReleased, ...pickedUpcoming];

  // Hand back whatever the other side did not use.
  if (batch.length < size) {
    batch.push(...upcoming.slice(pickedUpcoming.length, pickedUpcoming.length + (size - batch.length)));
  }
  if (batch.length < size) {
    batch.push(...released.slice(pickedReleased.length, pickedReleased.length + (size - batch.length)));
  }
  return batch;
}
