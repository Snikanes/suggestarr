import { createHash } from 'node:crypto';
import type { JudgeRequest } from './types.js';
import type { Candidate } from '../tmdb/types.js';
import type { Title } from '../arr/types.js';
import { isUpcoming } from '../discovery/filters.js';

/**
 * Bump when the prompt content changes — recorded with every verdict
 * in agent_decisions so we can measure prompt iterations over time.
 */
export const PROMPT_VERSION = 'v2';

const SYSTEM_LINES = [
  'You are Suggestarr, a movie acquisition agent for a personal media server.',
  'The user already owns the library listed below and is being shown candidate titles.',
  'Decide, for EACH candidate, whether it is worth adding to their server.',
  '',
  'Consider: quality (TMDB rating and votes), how well it matches the taste evident in their',
  'existing library, whether it is a redundant or similar follow-up to what they already own,',
  'and whether the overview reads like a project worth the download bandwidth and disk space.',
  'Be decisive: keep only titles you would genuinely recommend. When in doubt, drop.',
  '',
  'Candidates marked status=unreleased are not out yet, so they have no meaningful rating.',
  'Do NOT drop them for lacking a score — judge them on premise, franchise, and how well they',
  'fit the library, and keep the ones worth queuing the moment they land.',
];

/**
 * Stable fingerprint of the taste snapshot a prompt was rendered with.
 * Stored next to PROMPT_VERSION on every verdict so a change in taste
 * notes is distinguishable from a change in the prompt template itself.
 */
export function tasteHash(req: Pick<JudgeRequest, 'userNotes'>): string {
  const snapshot = JSON.stringify({ userNotes: req.userNotes?.trim() ?? '' });
  return createHash('sha256').update(snapshot).digest('hex').slice(0, 12);
}

/**
 * Above this many titles the library is summarised rather than listed.
 *
 * A 900-title list is thousands of tokens of very little signal — the
 * agent needs the *shape* of the collection (eras, recent additions) far
 * more than it needs every title, and the dedupe already guarantees no
 * candidate is something they own.
 */
export const LIBRARY_LIST_LIMIT = 60;

/** Deterministic, so an unchanged library renders an unchanged prompt. */
function summariseLibrary(library: Title[], sampleSize = 25): string {
  const byDecade = new Map<string, number>();
  for (const title of library) {
    const decade = title.year ? `${Math.floor(title.year / 10) * 10}s` : 'unknown';
    byDecade.set(decade, (byDecade.get(decade) ?? 0) + 1);
  }
  const decades = [...byDecade.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([decade, count]) => `${decade}: ${count}`)
    .join(', ');

  const dated = library.filter((t) => t.addedAt !== null);
  const newest = [...dated]
    // Title breaks ties, so titles added the same day render in a fixed
    // order however the *arr happened to return them.
    .sort(
      (a, b) =>
        (b.addedAt ?? '').localeCompare(a.addedAt ?? '') || a.title.localeCompare(b.title),
    )
    .slice(0, 10)
    .map(format);

  // An evenly spaced walk of the alphabetical list: a fair cross-section
  // of the collection that does not move when the library does not.
  const sorted = [...library].sort((a, b) => a.title.localeCompare(b.title));
  const step = Math.max(1, Math.floor(sorted.length / sampleSize));
  const sample = sorted.filter((_, i) => i % step === 0).slice(0, sampleSize).map(format);

  return [
    `${library.length} titles by decade — ${decades}.`,
    ...(newest.length ? [`Added most recently: ${newest.join('; ')}.`] : []),
    `A cross-section of the rest: ${sample.join('; ')}.`,
  ].join('\n');
}

function format(t: Title): string {
  return `${t.title}${t.year ? ` (${t.year})` : ''}`;
}

export function buildPrompt(req: JudgeRequest): { system: string; user: string } {
  const lines = [
    ...SYSTEM_LINES,
    ...(req.userNotes?.trim()
      ? [`User taste notes (apply these):`, req.userNotes.trim(), '']
      : []),
    'Respond with STRICT JSON only - no prose, no markdown fences - in exactly this shape:',
    '{"decisions":[{"remote_id":123,"keep":true,"reason":"one or two sentences"}]}',
    "Emit one decision object per candidate, using each candidate's exact remote_id.",
    'The reason must be specific, not generic.',
  ];
  const system = lines.join('\n');

  const libraryLines = !req.library.length
    ? '(empty library - use general quality judgment)'
    : req.library.length <= LIBRARY_LIST_LIMIT
      ? req.library.map((t) => `- ${format(t)}`).join('\n')
      : summariseLibrary(req.library);

  const candidateLines = req.candidates.map((c) => formatCandidate(c, req.genreNames)).join('\n');

  const user = [
    `Their current library (${req.library.length} titles):`,
    libraryLines,
    '',
    `Candidates to judge (${req.candidates.length}):`,
    candidateLines,
    '',
    'Return the JSON decisions object now.',
  ].join('\n');

  return { system, user };
}

function formatCandidate(c: Candidate, genreNames?: Record<number, string>): string {
  const genres = c.genreIds.length
    ? c.genreIds.map((g) => genreNames?.[g] ?? `genre:${g}`).join('/')
    : 'no genres';
  const rating = c.rating !== null ? `${c.rating.toFixed(1)} (${c.votes ?? 0} votes)` : 'unrated';
  const status = isUpcoming(c) ? 'unreleased' : 'released';
  return [
    `- remote_id=${c.remoteId} title="${c.title}"${c.year ? ` year=${c.year}` : ''} status=${status}`,
    `  rating=${rating} genres=[${genres}] source=${c.origin}`,
    `  overview=${c.overview ?? '(none)'}`,
  ].join('\n');
}
