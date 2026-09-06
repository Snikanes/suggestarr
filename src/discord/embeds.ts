import type { Candidate } from '../tmdb/types.js';
import type { Verdict } from '../agent/types.js';
import type { DecisionRow, SuggestionRow } from '../state/db.js';

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/**
 * A Discord embed as plain data. The gateway turns this into whatever
 * discord.js wants, so embed construction stays testable without a
 * gateway connection or a discord.js mock.
 */
export interface SuggestionEmbed {
  title: string;
  url: string | null;
  description: string;
  color: number;
  fields: EmbedField[];
  imageUrl: string | null;
  footer: string;
}

export const COLORS = {
  pending: 0x3498db,
  approved: 0x2ecc71,
  rejected: 0xe74c3c,
  failed: 0xe67e22,
  expired: 0x95a5a6,
} as const;

export const APPROVE_EMOJI = '✅';
export const REJECT_EMOJI = '❌';

/**
 * The field explaining how to answer. Named once because it is written
 * in `buildSuggestionEmbed` and stripped again in `buildResolvedEmbed` —
 * the two must not drift apart.
 */
export const ANSWER_FIELD_NAME = 'How to answer';

export function tmdbUrl(remoteId: number): string {
  return `https://www.themoviedb.org/movie/${remoteId}`;
}

/** The suggestion as first posted: poster, score, and the agent's reasoning. */
export function buildSuggestionEmbed(
  candidate: Candidate,
  verdict: Verdict,
  meta: { model: string; promptVersion: string },
): SuggestionEmbed {
  const year = candidate.year ? ` (${candidate.year})` : '';
  return {
    title: `${candidate.title}${year}`,
    url: tmdbUrl(candidate.remoteId),
    description: verdict.reason,
    color: COLORS.pending,
    fields: [
      { name: 'TMDB', value: formatRating(candidate), inline: true },
      { name: 'Source', value: candidate.origin, inline: true },
      {
        name: ANSWER_FIELD_NAME,
        value:
          `${APPROVE_EMOJI} add at the default quality profile · ` +
          `${REJECT_EMOJI} never suggest again · ` +
          'or pick a quality profile from the menu below',
        inline: false,
      },
    ],
    imageUrl: candidate.posterUrl,
    footer: `tmdb:${candidate.remoteId} · ${meta.model} · prompt ${meta.promptVersion}`,
  };
}

/**
 * Rebuild a suggestion's embed from its persisted decision row.
 *
 * Editing a message hours after it was posted must not depend on the
 * process still holding the original embed — the decision log already
 * stores everything the embed was built from.
 */
export function embedFromDecision(row: DecisionRow): SuggestionEmbed {
  return buildSuggestionEmbed(
    {
      remoteId: row.remoteId,
      title: row.title,
      year: row.year,
      rating: row.rating,
      votes: row.votes,
      popularity: null,
      overview: row.overview,
      genreIds: [],
      posterUrl: row.posterUrl,
      origin: row.origin,
    },
    { remoteId: row.remoteId, keep: row.verdict === 'keep', reason: row.reason },
    { model: row.model, promptVersion: row.promptVersion },
  );
}

/** The same embed after the user (or an *arr failure) resolved it. */
export function buildResolvedEmbed(
  base: SuggestionEmbed,
  outcome: 'approved' | 'rejected' | 'failed' | 'expired',
  detail: string,
): SuggestionEmbed {
  const headline = {
    approved: `${APPROVE_EMOJI} Added`,
    rejected: `${REJECT_EMOJI} Skipped`,
    failed: '⚠️ Could not add',
    expired: '⌛ Expired',
  }[outcome];

  return {
    ...base,
    color: COLORS[outcome],
    fields: [
      ...base.fields.filter((f) => f.name !== ANSWER_FIELD_NAME),
      { name: headline, value: detail, inline: false },
    ],
  };
}

/** `/status` and `/decisions` replies are plain text, not embeds. */
export function formatPendingList(rows: SuggestionRow[]): string {
  if (rows.length === 0) return 'Nothing pending — the next scheduled cycle will post more.';
  return [
    `**${rows.length} pending suggestion${rows.length === 1 ? '' : 's'}:**`,
    ...rows.map((r) => `• \`${r.remoteId}\` ${r.title}${r.year ? ` (${r.year})` : ''}`),
  ].join('\n');
}

function formatRating(c: Candidate): string {
  if (c.rating === null) return 'unrated';
  return `★ ${c.rating.toFixed(1)} (${c.votes ?? 0} votes)`;
}
