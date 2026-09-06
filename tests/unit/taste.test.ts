import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/state/db.js';
import { buildTasteProfile } from '../../src/state/taste.js';
import { candidatesFixture, judgeResultFixture, libraryFixture } from '../fixtures/agent.js';

let store: Store;

beforeEach(async () => {
  store = await Store.open(':memory:');
  store.recordJudgement(judgeResultFixture, candidatesFixture);
});

describe('buildTasteProfile', () => {
  it('is empty while nobody has reacted to anything', () => {
    expect(buildTasteProfile(store)).toEqual({
      notes: '',
      approved: [],
      rejected: [],
      forceAdded: [],
      recentlyAdded: [],
    });
  });

  it('quotes accepted, rejected and force-added titles as separate signals', () => {
    store.setOutcome(603, 'approved');
    store.setOutcome(27205, 'rejected');
    store.setOutcome(999, 'force-added');

    const profile = buildTasteProfile(store);

    expect(profile.approved).toEqual(['The Matrix (1999)']);
    expect(profile.rejected).toEqual(['Inception (2010)']);
    expect(profile.forceAdded).toEqual(['Direct To Streaming 4 (2025)']);
    expect(profile.notes).toContain('Titles the user accepted: The Matrix (1999).');
    expect(profile.notes).toContain('do not suggest anything of this sort again: Inception (2010)');
    expect(profile.notes).toContain('You were wrong about these');
    expect(profile.notes).toContain('Direct To Streaming 4 (2025)');
  });

  it('puts configured notes first, above anything learned', () => {
    store.setOutcome(603, 'approved');
    const notes = buildTasteProfile(store, { userNotes: '  No horror, ever.  ' }).notes;

    expect(notes.startsWith('No horror, ever.')).toBe(true);
    expect(notes).toContain('Titles the user accepted');
  });

  it('includes configured notes even with no feedback at all', () => {
    expect(buildTasteProfile(store, { userNotes: 'More documentaries.' }).notes).toBe(
      'More documentaries.',
    );
    expect(buildTasteProfile(store, { userNotes: '   ' }).notes).toBe('');
  });

  it('uses the *arr library as the "what are they into now" signal', () => {
    const profile = buildTasteProfile(store, { library: libraryFixture });

    // newest addition first; only titles actually on disk
    expect(profile.recentlyAdded).toEqual(['Pulp Fiction (1994)', 'Forrest Gump (1994)']);
    expect(profile.notes).toContain('Most recently added to their library, and present on disk');
  });

  it('ignores monitored-but-fileless titles — those are wishes, not evidence', () => {
    const profile = buildTasteProfile(store, {
      library: [
        { ...libraryFixture[0]!, hasFile: false },
        { ...libraryFixture[1]!, title: 'On Disk', year: 2011, addedAt: '2020-01-01T00:00:00Z' },
      ],
    });
    expect(profile.recentlyAdded).toEqual(['On Disk (2011)']);
  });

  it('ignores library titles with no added timestamp', () => {
    const profile = buildTasteProfile(store, {
      library: [{ ...libraryFixture[0]!, addedAt: null }],
    });
    expect(profile.recentlyAdded).toEqual([]);
    expect(profile.notes).toBe('');
  });

  it('caps each bucket so the prompt cannot grow without bound', () => {
    for (let i = 0; i < 5; i += 1) {
      const remoteId = 5000 + i;
      store.recordJudgement(
        {
          ...judgeResultFixture,
          verdicts: [{ remoteId, keep: true, reason: 'ok' }],
        },
        [{ ...candidatesFixture[0]!, remoteId, title: `Film ${i}` }],
      );
      store.setOutcome(remoteId, 'approved');
    }

    const profile = buildTasteProfile(store, { perBucket: 2 });
    expect(profile.approved).toHaveLength(2);
    // newest first
    expect(profile.approved[0]).toBe('Film 4 (1999)');
  });

  it('omits the year when a title has none', () => {
    store.recordJudgement(
      {
        ...judgeResultFixture,
        verdicts: [{ remoteId: 7000, keep: true, reason: 'ok' }],
      },
      [{ ...candidatesFixture[0]!, remoteId: 7000, title: 'Yearless', year: null }],
    );
    store.setOutcome(7000, 'approved');

    expect(buildTasteProfile(store).approved).toContain('Yearless');
  });
});
