import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  LIBRARY_LIST_LIMIT,
  PROMPT_VERSION,
  tasteHash,
} from '../../src/agent/prompt.js';
import {
  candidatesFixture,
  dudCandidate,
  genreNamesFixture,
  libraryFixture,
  matrixCandidate,
} from '../fixtures/agent.js';

describe('buildPrompt', () => {
  it('renders every candidate with id, kind, rating, genres and origin', () => {
    const { user } = buildPrompt({
      candidates: candidatesFixture,
      library: libraryFixture,
      genreNames: genreNamesFixture,
    });

    expect(user).toContain('Candidates to judge (3):');
    expect(user).toContain('remote_id=603 title="The Matrix" year=1999');
    expect(user).toContain('rating=8.2 (16000 votes) genres=[Science Fiction/Action] source=trending');
    expect(user).toContain('overview=A hacker learns reality is a simulation.');
    expect(user).toContain('remote_id=27205 title="Inception"');
  });

  it('falls back to raw genre ids and placeholders for sparse candidates', () => {
    const { user } = buildPrompt({ candidates: [matrixCandidate, dudCandidate], library: [] });

    expect(user).toContain('genres=[genre:878/genre:28]');
    expect(user).toContain('genres=[no genres]');
    expect(user).toContain('overview=(none)');
  });

  it('marks unreleased candidates so the judge does not punish them for having no score', () => {
    const { system, user } = buildPrompt({
      candidates: [
        matrixCandidate,
        { ...dudCandidate, origin: 'upcoming', rating: null, votes: null },
      ],
      library: [],
    });

    expect(user).toContain('title="The Matrix" year=1999 status=released');
    expect(user).toContain('status=unreleased');
    expect(system).toContain('Candidates marked status=unreleased are not out yet');
    expect(system).toContain('Do NOT drop them for lacking a score');
  });

  it('marks an unrated candidate as unrated', () => {
    const { user } = buildPrompt({
      candidates: [{ ...matrixCandidate, rating: null, votes: null }],
      library: [],
    });
    expect(user).toContain('rating=unrated');
  });

  it('lists the library so the agent can avoid redundant picks', () => {
    const { user } = buildPrompt({ candidates: candidatesFixture, library: libraryFixture });

    expect(user).toContain('Their current library (2 titles):');
    expect(user).toContain('- Pulp Fiction (1994)');
    expect(user).toContain('- Forrest Gump (1994)');
  });

  it('says so explicitly when the library is empty', () => {
    const { user } = buildPrompt({ candidates: candidatesFixture, library: [] });
    expect(user).toContain('(empty library - use general quality judgment)');
  });

  it('omits the year for a library title without one', () => {
    const { user } = buildPrompt({
      candidates: candidatesFixture,
      library: [{ ...libraryFixture[0]!, year: null }],
    });
    expect(user).toContain('- Pulp Fiction\n');
  });

  it('demands strict JSON in the system prompt', () => {
    const { system } = buildPrompt({ candidates: candidatesFixture, library: [] });

    expect(system).toContain('STRICT JSON only');
    expect(system).toContain('"decisions"');
    expect(system).toContain('When in doubt, drop.');
  });

  it('injects taste notes into the system prompt only when present', () => {
    const without = buildPrompt({ candidates: candidatesFixture, library: [] }).system;
    expect(without).not.toContain('User taste notes');

    const withNotes = buildPrompt({
      candidates: candidatesFixture,
      library: [],
      userNotes: '  no reality TV  ',
    }).system;
    expect(withNotes).toContain('User taste notes (apply these):');
    expect(withNotes).toContain('no reality TV');

    const blank = buildPrompt({
      candidates: candidatesFixture,
      library: [],
      userNotes: '   ',
    }).system;
    expect(blank).not.toContain('User taste notes');
  });
});

describe('large libraries', () => {
  const bigLibrary = Array.from({ length: 200 }, (_, i) => ({
    localId: i,
    remoteId: 1000 + i,
    title: `Film ${String(i).padStart(3, '0')}`,
    year: 1970 + (i % 50),
    monitored: true,
    posterUrl: null,
    addedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    hasFile: true,
  }));

  it('summarises instead of listing every title', () => {
    const { user } = buildPrompt({ candidates: candidatesFixture, library: bigLibrary });

    expect(user).toContain('200 titles by decade —');
    expect(user).toContain('1970s: 40');
    expect(user).toContain('Added most recently:');
    expect(user).toContain('A cross-section of the rest:');
    // the whole list is not there
    expect(user).not.toContain('Film 042');
    expect(user.length).toBeLessThan(bigLibrary.map((t) => t.title).join('').length * 3);
  });

  it('lists every title while the library is small', () => {
    const small = bigLibrary.slice(0, LIBRARY_LIST_LIMIT);
    const { user } = buildPrompt({ candidates: candidatesFixture, library: small });

    expect(user).toContain('- Film 000 (1970)');
    expect(user).toContain(`- Film 0${LIBRARY_LIST_LIMIT - 1}`);
    expect(user).not.toContain('by decade —');
  });

  it('renders the same prompt for the same library, every time', () => {
    const first = buildPrompt({ candidates: candidatesFixture, library: bigLibrary }).user;
    const shuffled = [...bigLibrary].reverse();
    const second = buildPrompt({ candidates: candidatesFixture, library: shuffled }).user;

    expect(second).toBe(first);
  });

  it('copes with titles that have no year or no added date', () => {
    const messy = [
      ...bigLibrary.slice(0, 61),
      { ...bigLibrary[0]!, localId: 999, title: 'Undated', year: null, addedAt: null },
    ];
    const { user } = buildPrompt({ candidates: candidatesFixture, library: messy });

    expect(user).toContain('unknown: 1');
    expect(user).toContain('62 titles by decade');
  });
});

describe('tasteHash', () => {
  it('is stable, whitespace-insensitive and sensitive to content', () => {
    expect(tasteHash({ userNotes: 'a' })).toBe(tasteHash({ userNotes: ' a\n' }));
    expect(tasteHash({})).toBe(tasteHash({ userNotes: '' }));
    expect(tasteHash({ userNotes: 'a' })).not.toBe(tasteHash({ userNotes: 'b' }));
    expect(tasteHash({})).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('PROMPT_VERSION', () => {
  it('is a non-empty identifier recorded with every verdict', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+/);
  });
});
