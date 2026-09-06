import type { TmdbClient, TmdbPage } from '../tmdb/client.js';
import { mapTmdbMovieToCandidate } from '../tmdb/types.js';
import type { Candidate, TmdbMovieDto } from '../tmdb/types.js';
import type { Title } from '../arr/types.js';
import { UPCOMING_ORIGIN } from './filters.js';

export interface SourceOptions {
  /** how many owned titles to seed "more like this" lookups with */
  similarSeeds?: number;
  /**
   * TMDB pages to walk per broad source (20 results each).
   *
   * One page is 20 titles, and every judged title is excluded forever —
   * so a single page dries up within weeks of daily cycles. Paging keeps
   * the pool deep enough to stay useful.
   */
  pages?: number;
}

export interface SourceResult {
  candidates: Candidate[];
  /** one entry per source that failed, ready for the Discord notice */
  failures: string[];
}

const DEFAULT_SIMILAR_SEEDS = 3;
const DEFAULT_PAGES = 3;

/**
 * Every discovery source, gathered concurrently, with per-source failure
 * isolation: one dead endpoint costs its own candidates and nothing else.
 */
export async function gatherCandidates(
  tmdb: TmdbClient,
  library: Title[],
  opts: SourceOptions = {},
): Promise<SourceResult> {
  const pages = opts.pages ?? DEFAULT_PAGES;
  const releasedFrom = isoDateDaysFromNow(1);

  const jobs: { label: string; run: () => Promise<Candidate[]> }[] = [
    {
      label: 'TMDB trending movies',
      run: async () => paged((page) => tmdb.trending('week', page), pages, 'trending'),
    },
    {
      label: 'TMDB upcoming movies',
      run: async () =>
        paged((page) => tmdb.upcomingMovies(releasedFrom, page), pages, UPCOMING_ORIGIN),
    },
  ];

  for (const seed of pickSeeds(library, opts.similarSeeds ?? DEFAULT_SIMILAR_SEEDS)) {
    jobs.push({
      label: `TMDB movies similar to ${seed.title}`,
      // One page of "similar" per seed is plenty — relevance falls off a
      // cliff after the first 20, and there are several seeds.
      run: async () => map(await tmdb.similar(seed.remoteId!), `similar:${seed.remoteId}`),
    });
  }

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const candidates: Candidate[] = [];
  const failures: string[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value);
    } else {
      failures.push(`${jobs[i]!.label} failed: ${errorText(result.reason)}`);
    }
  });

  return { candidates, failures };
}

/**
 * Seed "more like this" with the newest monitored titles that carry a
 * TMDB id — monitored means the user cared enough to keep it current.
 */
function pickSeeds(library: Title[], count: number): Title[] {
  if (count <= 0) return [];
  return library
    .filter((t) => t.remoteId !== null && t.monitored)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, count);
}

function map(page: TmdbPage<TmdbMovieDto>, origin: string): Candidate[] {
  return page.results.map((m) => mapTmdbMovieToCandidate(m, origin));
}

/**
 * Walk up to `pages` pages of one source.
 *
 * Page 1 is fetched first because its `total_pages` says how far the
 * source actually goes; the rest go out together. A failing later page
 * costs its own 20 results and nothing else — only a failing first page
 * fails the source, since that is the one that proves the source works.
 */
async function paged(
  fetchPage: (page: number) => Promise<TmdbPage<TmdbMovieDto>>,
  pages: number,
  origin: string,
): Promise<Candidate[]> {
  const first = await fetchPage(1);
  const candidates = map(first, origin);

  const available = first.total_pages ?? 1;
  const lastPage = Math.min(pages, available);
  if (lastPage < 2) return candidates;

  const rest = await Promise.allSettled(
    Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(i + 2)),
  );
  for (const result of rest) {
    if (result.status === 'fulfilled') candidates.push(...map(result.value, origin));
  }
  return candidates;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
