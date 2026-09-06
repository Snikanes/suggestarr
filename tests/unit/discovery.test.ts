import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISCOVERY_PREFS,
  dedupeAgainstLibrary,
  filterCandidates,
  type DiscoveryPrefs,
} from '../../src/discovery/filters.js';
import type { Candidate } from '../../src/tmdb/types.js';
import type { Title } from '../../src/arr/types.js';

function candidate(partial: Partial<Candidate> & { remoteId: number }): Candidate {
  return {
    title: 'Test',
    popularity: 10,
    year: 2020,
    rating: 7,
    votes: 1000,
    overview: null,
    genreIds: [],
    posterUrl: null,
    origin: 'trending',
    ...partial,
  };
}

const prefs: DiscoveryPrefs = { ...DEFAULT_DISCOVERY_PREFS, minRating: 6, minVotes: 100 };

describe('filterCandidates', () => {
  it('drops candidates below minRating or minVotes, keeps the rest', () => {
    const input = [
      candidate({ remoteId: 1, rating: 6.1 }),
      candidate({ remoteId: 2, rating: 5.9 }), // below minRating
      candidate({ remoteId: 3, votes: 99 }), // below minVotes
      candidate({ remoteId: 4, rating: null }), // unrated
      candidate({ remoteId: 5, votes: null }), // no votes
    ];
    expect(filterCandidates(input, prefs).map((c) => c.remoteId)).toEqual([1]);
  });

  it('enforces yearFrom (null years are dropped)', () => {
    const input = [
      candidate({ remoteId: 1, year: 2014 }),
      candidate({ remoteId: 2, year: 2015 }),
      candidate({ remoteId: 3, year: null }),
    ];
    const out = filterCandidates(input, { ...prefs, yearFrom: 2015 });
    expect(out.map((c) => c.remoteId)).toEqual([2]);
  });

  it('includeGenres keeps candidates sharing at least one genre', () => {
    const input = [
      candidate({ remoteId: 1, genreIds: [18] }),
      candidate({ remoteId: 2, genreIds: [35, 53] }),
      candidate({ remoteId: 3, genreIds: [] }),
    ];
    const out = filterCandidates(input, { ...prefs, includeGenres: [18, 53] });
    expect(out.map((c) => c.remoteId)).toEqual([1, 2]); // 18 matches, 53 matches, [] dropped
  });

  it('excludeGenres drops candidates carrying any excluded genre', () => {
    const input = [
      candidate({ remoteId: 1, genreIds: [18] }),
      candidate({ remoteId: 2, genreIds: [35] }),
      candidate({ remoteId: 3, genreIds: [18, 35] }),
    ];
    const out = filterCandidates(input, { ...prefs, excludeGenres: [35] });
    expect(out.map((c) => c.remoteId)).toEqual([1]);
  });

  it('lets unreleased candidates past the rating and vote floor', () => {
    const unreleased = candidate({
      remoteId: 1,
      origin: 'upcoming',
      rating: null,
      votes: null,
      year: 2027,
    });
    const zeroed = candidate({ remoteId: 2, origin: 'upcoming', rating: 0, votes: 0 });

    expect(filterCandidates([unreleased, zeroed], prefs).map((c) => c.remoteId)).toEqual([1, 2]);
  });

  it('still applies the floor to released candidates from other sources', () => {
    const input = [
      candidate({ remoteId: 1, origin: 'trending', rating: null, votes: null }),
      candidate({ remoteId: 2, origin: 'similar:550', rating: 3, votes: 5 }),
    ];
    expect(filterCandidates(input, prefs)).toEqual([]);
  });

  it('still applies year and genre rules to unreleased candidates', () => {
    const unreleased = candidate({
      remoteId: 1,
      origin: 'upcoming',
      rating: null,
      votes: null,
      year: 1999,
      genreIds: [27],
    });

    expect(filterCandidates([unreleased], { ...prefs, yearFrom: 2020 })).toEqual([]);
    expect(filterCandidates([unreleased], { ...prefs, excludeGenres: [27] })).toEqual([]);
    expect(filterCandidates([unreleased], { ...prefs, includeGenres: [878] })).toEqual([]);
  });

  it('can be told to hold unreleased candidates to the floor as well', () => {
    const unreleased = candidate({ remoteId: 1, origin: 'upcoming', rating: null, votes: null });
    expect(filterCandidates([unreleased], { ...prefs, exemptUpcoming: false })).toEqual([]);
  });

  it('applies no genre/year constraints when unset', () => {
    const input = [candidate({ remoteId: 1, genreIds: [], year: 1980 })];
    expect(filterCandidates(input, prefs).map((c) => c.remoteId)).toEqual([1]);
  });
});

describe('dedupeAgainstLibrary', () => {
  const lib: Title[] = [
    {
      localId: 1,
      remoteId: 603,
      title: 'The Matrix',
      year: 1999,
      monitored: true,
      posterUrl: null,
      addedAt: null,
      hasFile: true,
    },
    {
      localId: 2,
      remoteId: null, // local media — unmatchable
      title: 'Local Film',
      year: null,
      monitored: false,
      posterUrl: null,
      addedAt: null,
      hasFile: true,
    },
  ];

  it('drops candidates already in the library, keeps the rest', () => {
    const out = dedupeAgainstLibrary(
      [
        candidate({ remoteId: 603 }), // already in Radarr -> drop
        candidate({ remoteId: 777 }), // not in library -> keep
      ],
      lib,
    );
    expect(out.map((c) => c.remoteId)).toEqual([777]);
  });

  it('cannot dedupe against library entries with no TMDB id', () => {
    const out = dedupeAgainstLibrary([candidate({ remoteId: 12345 })], lib);
    expect(out).toHaveLength(1);
  });

  it('keeps everything when the library is empty', () => {
    const input = [candidate({ remoteId: 1 }), candidate({ remoteId: 2 })];
    expect(dedupeAgainstLibrary(input, [])).toEqual(input);
  });
});
