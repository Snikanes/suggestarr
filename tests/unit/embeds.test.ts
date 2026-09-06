import { describe, expect, it } from 'vitest';
import {
  APPROVE_EMOJI,
  COLORS,
  REJECT_EMOJI,
  buildResolvedEmbed,
  buildSuggestionEmbed,
  embedFromDecision,
  formatPendingList,
  tmdbUrl,
} from '../../src/discord/embeds.js';
import { toDiscordEmbed } from '../../src/discord/discordjs.js';
import type { DecisionRow, SuggestionRow } from '../../src/state/db.js';
import { dudCandidate, inceptionCandidate, matrixCandidate } from '../fixtures/agent.js';

const keepVerdict = {
  remoteId: 603,
  keep: true,
  reason: 'Anchor sci-fi, missing from the shelf.',
};
const meta = { model: 'mock-1', promptVersion: 'v1' };

describe('buildSuggestionEmbed', () => {
  it('carries title, year, poster, rating, reasoning and provenance', () => {
    const embed = buildSuggestionEmbed(matrixCandidate, keepVerdict, meta);

    expect(embed).toMatchObject({
      title: 'The Matrix (1999)',
      url: 'https://www.themoviedb.org/movie/603',
      description: 'Anchor sci-fi, missing from the shelf.',
      color: COLORS.pending,
      imageUrl: 'https://image.tmdb.org/t/p/w342/matrix.jpg',
      footer: 'tmdb:603 · mock-1 · prompt v1',
    });
    expect(embed.fields).toEqual([
      { name: 'TMDB', value: '★ 8.2 (16000 votes)', inline: true },
      { name: 'Source', value: 'trending', inline: true },
      {
        name: 'React to decide',
        value: `${APPROVE_EMOJI} add to Radarr · ${REJECT_EMOJI} never suggest again`,
        inline: false,
      },
    ]);
  });

  it('links each candidate to its own TMDB page', () => {
    const embed = buildSuggestionEmbed(inceptionCandidate, { ...keepVerdict, remoteId: 27205 }, meta);

    expect(embed.url).toBe('https://www.themoviedb.org/movie/27205');
    expect(embed.footer).toContain('tmdb:27205');
  });

  it('handles a candidate with no year, no poster and no rating', () => {
    const embed = buildSuggestionEmbed(
      { ...dudCandidate, year: null, rating: null, votes: null },
      { ...keepVerdict, remoteId: 999 },
      meta,
    );

    expect(embed.title).toBe('Direct To Streaming 4');
    expect(embed.imageUrl).toBeNull();
    expect(embed.fields[0]?.value).toBe('unrated');
  });
});

describe('buildResolvedEmbed', () => {
  const base = buildSuggestionEmbed(matrixCandidate, keepVerdict, meta);

  it('swaps the call-to-action for the outcome', () => {
    const approved = buildResolvedEmbed(base, 'approved', 'Monitored in Radarr.');

    expect(approved.color).toBe(COLORS.approved);
    expect(approved.fields.some((f) => f.name === 'React to decide')).toBe(false);
    expect(approved.fields.at(-1)).toEqual({
      name: `${APPROVE_EMOJI} Added`,
      value: 'Monitored in Radarr.',
      inline: false,
    });
    expect(approved.title).toBe(base.title);
  });

  it('colours rejection and failure differently', () => {
    expect(buildResolvedEmbed(base, 'rejected', 'no').color).toBe(COLORS.rejected);
    expect(buildResolvedEmbed(base, 'failed', 'boom').fields.at(-1)?.name).toBe('⚠️ Could not add');
    expect(buildResolvedEmbed(base, 'failed', 'boom').color).toBe(COLORS.failed);
  });

  it('does not accumulate outcome fields when applied twice', () => {
    const once = buildResolvedEmbed(base, 'failed', 'boom');
    const twice = buildResolvedEmbed(once, 'approved', 'retried');
    expect(twice.fields.filter((f) => f.name.includes('Could not add'))).toHaveLength(1);
    expect(twice.fields.at(-1)?.name).toBe(`${APPROVE_EMOJI} Added`);
  });
});

describe('embedFromDecision', () => {
  const row: DecisionRow = {
    id: 1,
    runId: 1,
    remoteId: 603,
    title: 'The Matrix',
    year: 1999,
    origin: 'trending',
    rating: 8.2,
    votes: 16000,
    posterUrl: 'https://image.tmdb.org/t/p/w342/matrix.jpg',
    overview: 'A hacker learns reality is a simulation.',
    verdict: 'keep',
    reason: 'Anchor sci-fi, missing from the shelf.',
    provider: 'scripted',
    model: 'mock-1',
    promptVersion: 'v1',
    tasteHash: 'abc',
    createdAt: '2026-09-05T10:00:00.000Z',
    outcome: null,
    outcomeAt: null,
  };

  it('rebuilds the posted embed from persisted state alone', () => {
    expect(embedFromDecision(row)).toEqual(buildSuggestionEmbed(matrixCandidate, keepVerdict, meta));
  });

  it('survives a row whose payload was pruned', () => {
    const embed = embedFromDecision({ ...row, overview: null, posterUrl: null });
    expect(embed.imageUrl).toBeNull();
    expect(embed.description).toBe(row.reason);
  });
});

describe('formatPendingList', () => {
  const row = (over: Partial<SuggestionRow>): SuggestionRow => ({
    id: 1,
    decisionId: 1,
    remoteId: 603,
    title: 'The Matrix',
    year: 1999,
    channelId: 'c',
    messageId: 'm',
    postedAt: '2026-09-05T10:00:00.000Z',
    state: 'pending',
    resolvedAt: null,
    error: null,
    ...over,
  });

  it('lists pending titles with their ids', () => {
    const text = formatPendingList([
      row({}),
      row({ id: 2, remoteId: 27205, title: 'Inception', year: null }),
    ]);
    expect(text).toContain('**2 pending suggestions:**');
    expect(text).toContain('`603` The Matrix (1999)');
    expect(text).toContain('`27205` Inception');
  });

  it('says something useful when there is nothing pending', () => {
    expect(formatPendingList([])).toMatch(/Nothing pending/);
  });

  it('uses the singular for one row', () => {
    expect(formatPendingList([row({})])).toContain('1 pending suggestion:');
  });
});

describe('tmdbUrl / toDiscordEmbed', () => {
  it('builds the TMDB movie URL', () => {
    expect(tmdbUrl(1)).toBe('https://www.themoviedb.org/movie/1');
  });

  it('converts the internal embed to discord.js embed JSON', () => {
    const embed = toDiscordEmbed(buildSuggestionEmbed(matrixCandidate, keepVerdict, meta));

    expect(embed).toMatchObject({
      title: 'The Matrix (1999)',
      url: 'https://www.themoviedb.org/movie/603',
      color: COLORS.pending,
      thumbnail: { url: 'https://image.tmdb.org/t/p/w342/matrix.jpg' },
      footer: { text: 'tmdb:603 · mock-1 · prompt v1' },
    });
  });

  it('omits url and thumbnail when the source had none', () => {
    const embed = toDiscordEmbed({
      title: 't',
      url: null,
      description: 'd',
      color: 1,
      fields: [],
      imageUrl: null,
      footer: 'f',
    });
    expect(embed).not.toHaveProperty('url');
    expect(embed).not.toHaveProperty('thumbnail');
  });
});
