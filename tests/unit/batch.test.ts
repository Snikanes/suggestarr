import { describe, expect, it } from 'vitest';
import { selectBatch } from '../../src/discovery/batch.js';
import type { Candidate } from '../../src/tmdb/types.js';

const candidate = (over: Partial<Candidate> & { remoteId: number }): Candidate => ({
  title: `Film ${over.remoteId}`,
  year: 2026,
  rating: 7,
  votes: 500,
  popularity: 10,
  overview: null,
  genreIds: [],
  posterUrl: null,
  origin: 'trending',
  ...over,
});

const released = (remoteId: number, rating: number) => candidate({ remoteId, rating });
const upcoming = (remoteId: number, popularity: number) =>
  candidate({ remoteId, origin: 'upcoming', rating: null, votes: null, popularity });

describe('selectBatch', () => {
  it('orders released films by rating and unreleased ones by popularity', () => {
    const batch = selectBatch(
      [released(1, 6.5), upcoming(10, 50), released(2, 8.9), upcoming(11, 900)],
      { batchSize: 4 },
    );
    expect(batch.map((c) => c.remoteId)).toEqual([2, 1, 11, 10]);
  });

  it('reserves slots so unreleased films are never crowded out', () => {
    const eligible = [
      ...Array.from({ length: 20 }, (_, i) => released(i + 1, 9 - i * 0.1)),
      upcoming(100, 500),
      upcoming(101, 400),
      upcoming(102, 300),
      upcoming(103, 200),
    ];
    const batch = selectBatch(eligible, { batchSize: 10 });

    expect(batch).toHaveLength(10);
    expect(batch.filter((c) => c.origin === 'upcoming').map((c) => c.remoteId)).toEqual([
      100, 101, 102,
    ]);
    // ... and the 7 best-rated released films fill the rest
    expect(batch.filter((c) => c.origin !== 'upcoming').map((c) => c.remoteId)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('honours a custom reservation, including zero', () => {
    const eligible = [released(1, 9), released(2, 8), upcoming(10, 100), upcoming(11, 90)];

    expect(selectBatch(eligible, { batchSize: 2, upcomingSlots: 2 }).map((c) => c.remoteId)).toEqual(
      [10, 11],
    );
    expect(selectBatch(eligible, { batchSize: 2, upcomingSlots: 0 }).map((c) => c.remoteId)).toEqual(
      [1, 2],
    );
  });

  it('gives unused reservations back to released films', () => {
    const batch = selectBatch([released(1, 9), released(2, 8), released(3, 7)], { batchSize: 3 });
    expect(batch.map((c) => c.remoteId)).toEqual([1, 2, 3]);
  });

  it('fills the batch with unreleased films when released ones run short', () => {
    const batch = selectBatch(
      [released(1, 9), upcoming(10, 100), upcoming(11, 90), upcoming(12, 80), upcoming(13, 70)],
      { batchSize: 5 },
    );
    expect(batch).toHaveLength(5);
    expect(batch.map((c) => c.remoteId)).toEqual([1, 10, 11, 12, 13]);
  });

  it('never exceeds the reservation when the cap is smaller than it', () => {
    const batch = selectBatch([released(1, 9), upcoming(10, 100)], { batchSize: 1 });
    expect(batch.map((c) => c.remoteId)).toEqual([10]);
  });

  it('returns everything, ordered, when there is no cap', () => {
    const batch = selectBatch([upcoming(10, 5), released(1, 9), released(2, 9.5)]);
    expect(batch.map((c) => c.remoteId)).toEqual([2, 1, 10]);
  });

  it('handles an empty pool and a zero batch size', () => {
    expect(selectBatch([], { batchSize: 5 })).toEqual([]);
    expect(selectBatch([released(1, 9)], { batchSize: 0 })).toEqual([]);
  });

  it('treats a missing popularity as the least anticipated', () => {
    const batch = selectBatch(
      [upcoming(10, 0), candidate({ remoteId: 11, origin: 'upcoming', rating: null, popularity: null }), upcoming(12, 5)],
      { batchSize: 3 },
    );
    expect(batch[0]?.remoteId).toBe(12);
  });
});
