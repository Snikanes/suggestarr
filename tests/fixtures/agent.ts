import type { Candidate } from '../../src/tmdb/types.js';
import type { Title } from '../../src/arr/types.js';
import type { JudgeResult } from '../../src/agent/types.js';

export const matrixCandidate: Candidate = {
  remoteId: 603,
  title: 'The Matrix',
  year: 1999,
  rating: 8.2,
  votes: 16000,
  popularity: 61,
  overview: 'A hacker learns reality is a simulation.',
  genreIds: [878, 28],
  posterUrl: 'https://image.tmdb.org/t/p/w342/matrix.jpg',
  origin: 'trending',
};

export const dudCandidate: Candidate = {
  remoteId: 999,
  title: 'Direct To Streaming 4',
  year: 2025,
  rating: 4.1,
  votes: 120,
  popularity: 3,
  overview: null,
  genreIds: [],
  posterUrl: null,
  origin: 'trending',
};

/** Not out yet: no rating, no votes, ranked on popularity alone. */
export const unreleasedCandidate: Candidate = {
  remoteId: 1061474,
  title: 'Superman',
  year: 2026,
  rating: null,
  votes: null,
  popularity: 480,
  overview: 'The last son of Krypton, again.',
  genreIds: [878, 28],
  posterUrl: 'https://image.tmdb.org/t/p/w342/superman.jpg',
  origin: 'upcoming',
};

export const inceptionCandidate: Candidate = {
  remoteId: 27205,
  title: 'Inception',
  year: 2010,
  rating: 8.4,
  votes: 30000,
  popularity: 55,
  overview: 'A thief who steals corporate secrets through dream-sharing.',
  genreIds: [878, 28],
  posterUrl: 'https://image.tmdb.org/t/p/w342/inception.jpg',
  origin: 'trending',
};

export const candidatesFixture: Candidate[] = [matrixCandidate, dudCandidate, inceptionCandidate];

export const libraryFixture: Title[] = [
  {
    localId: 1,
    remoteId: 550,
    title: 'Pulp Fiction',
    year: 1994,
    monitored: true,
    posterUrl: null,
    addedAt: '2026-01-05T12:00:00Z',
    hasFile: true,
  },
  {
    localId: 7,
    remoteId: 13,
    title: 'Forrest Gump',
    year: 1994,
    monitored: false,
    posterUrl: null,
    addedAt: '2025-11-20T09:00:00Z',
    hasFile: true,
  },
];

export const genreNamesFixture: Record<number, string> = {
  18: 'Drama',
  28: 'Action',
  80: 'Crime',
  878: 'Science Fiction',
};

/** A well-formed judge reply covering every candidate in candidatesFixture. */
export function fullDecisionsJson(): string {
  return JSON.stringify({
    decisions: [
      { remote_id: 603, keep: true, reason: 'Anchor sci-fi, missing from the shelf.' },
      { remote_id: 999, keep: false, reason: 'Weak ratings, thin premise.' },
      { remote_id: 27205, keep: true, reason: 'Nolan, and it matches the sci-fi they own.' },
    ],
  });
}

export const judgeResultFixture: JudgeResult = {
  verdicts: [
    { remoteId: 603, keep: true, reason: 'Anchor sci-fi, missing from the shelf.' },
    { remoteId: 999, keep: false, reason: 'Weak ratings, thin premise.' },
    { remoteId: 27205, keep: true, reason: 'Nolan, and it matches the sci-fi they own.' },
  ],
  provider: 'scripted',
  model: 'mock-1',
  promptVersion: 'v1',
  tasteHash: 'abc123def456',
  attempts: 1,
  inputTokens: 1200,
  outputTokens: 90,
};
