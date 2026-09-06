import type { Logger } from 'pino';
import type { AgentClient } from './agent/agent.js';
import { AgentError } from './agent/types.js';
import type { RadarrClient } from './arr/radarr.js';
import type { Title } from './arr/types.js';
import { DEFAULT_DISCOVERY_PREFS, dedupeAgainstLibrary, filterCandidates } from './discovery/filters.js';
import { selectBatch } from './discovery/batch.js';
import type { DiscoveryPrefs } from './discovery/filters.js';
import type { SuggestionService } from './discord/service.js';
import type { Store } from './state/db.js';
import { buildTasteProfile } from './state/taste.js';
import type { TmdbClient } from './tmdb/client.js';
import { gatherCandidates } from './discovery/sources.js';
import type { Candidate } from './tmdb/types.js';

export interface CycleDeps {
  store: Store;
  radarr: RadarrClient;
  tmdb: TmdbClient;
  agent: AgentClient;
  /** absent for the console-only `judge` command */
  service?: SuggestionService;
  prefs?: DiscoveryPrefs;
  /** hard cap on candidates handed to the agent in one call */
  batchSize?: number;
  /** static taste notes from config, merged with the learned profile */
  userNotes?: string;
  /** how many owned titles seed "more like this" discovery */
  similarSeeds?: number;
  /** TMDB pages to walk per broad source */
  pages?: number;
  /** batch slots reserved for unreleased films */
  upcomingSlots?: number;
  /** close out suggestions older than this, in days; unset = never */
  expireAfterDays?: number;
  /** TMDB genre id -> name, so the agent reads genres not numbers */
  genreNames?: Record<number, string>;
  logger?: Pick<Logger, 'info' | 'error'>;
  now?: () => Date;
}

export interface CycleReport {
  libraryTitles: number;
  /** suggestions nobody answered, closed out at the start of this cycle */
  expired: number;
  /** false when Radarr was unreachable and the cycle could not run */
  libraryAvailable: boolean;
  /** candidates that survived filtering before the batch cap */
  eligible: number;
  candidates: number;
  judged: number;
  kept: number;
  posted: number;
  runId: number | null;
  /** non-fatal problems worth telling the user about */
  failures: string[];
}

const NOOP_LOGGER = { info: () => undefined, error: () => undefined };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One full suggestion cycle: library -> TMDB discovery -> agent -> decision
 * log -> Discord.
 *
 * The guiding rule when something breaks: never suggest a title we cannot
 * prove we don't already own. If Radarr is unreachable the cycle stops
 * rather than risk re-suggesting the user's own library.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const failures: string[] = [];
  const report: CycleReport = {
    libraryTitles: 0,
    expired: 0,
    libraryAvailable: false,
    eligible: 0,
    candidates: 0,
    judged: 0,
    kept: 0,
    posted: 0,
    runId: null,
    failures,
  };

  // --- expiry ---------------------------------------------------------
  // Before anything else, so titles whose question went unanswered are
  // back in the pool for this very cycle.
  if (deps.expireAfterDays !== undefined) {
    const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - deps.expireAfterDays * DAY_MS);
    const expired = deps.store.expirePending(cutoff, deps.now?.() ?? new Date());
    report.expired = expired.length;
    if (expired.length) {
      logger.info({ expired: expired.length }, 'expired unanswered suggestions');
      if (deps.service) await deps.service.markExpired(expired);
    }
  }

  // --- library -----------------------------------------------------------
  // Never suggest a title we cannot prove is absent: if Radarr is down we
  // have no library to dedupe against, so the cycle stops here.
  let library: Title[];
  try {
    library = await deps.radarr.listTitles();
  } catch (e) {
    const message = `Radarr unreachable — skipping this cycle: ${errorText(e)}`;
    failures.push(message);
    logger.error({ err: e }, 'radarr library fetch failed');
    await notify(deps, failures);
    return report;
  }

  report.libraryAvailable = true;
  report.libraryTitles = library.length;

  // --- discovery ---------------------------------------------------------
  const gathered = await gatherCandidates(deps.tmdb, library, {
    ...(deps.similarSeeds !== undefined ? { similarSeeds: deps.similarSeeds } : {}),
    ...(deps.pages !== undefined ? { pages: deps.pages } : {}),
  });
  failures.push(...gathered.failures);
  for (const failure of gathered.failures) logger.error({ failure }, 'discovery source failed');

  const seen = new Set<number>();
  const unique = gathered.candidates.filter((c) => {
    if (seen.has(c.remoteId)) return false;
    seen.add(c.remoteId);
    return true;
  });

  const judged = deps.store.excludedIds();
  const eligible = dedupeAgainstLibrary(
    filterCandidates(unique, deps.prefs ?? DEFAULT_DISCOVERY_PREFS),
    library,
  ).filter((c) => !judged.has(c.remoteId));

  // One agent call per cycle, so the batch is capped: the best-rated
  // released films go first, a reserved share of upcoming ones rides
  // along, and the rest wait for the next cycle rather than inflating
  // the prompt (and the bill).
  const candidates = selectBatch(eligible, {
    ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
    ...(deps.upcomingSlots !== undefined ? { upcomingSlots: deps.upcomingSlots } : {}),
  });

  report.eligible = eligible.length;
  report.candidates = candidates.length;
  if (candidates.length === 0) {
    logger.info({ seen: unique.length }, 'nothing new to judge this cycle');
    await notify(deps, failures);
    return report;
  }

  // --- judge + persist ---------------------------------------------------
  try {
    const taste = buildTasteProfile(deps.store, {
      ...(deps.userNotes !== undefined ? { userNotes: deps.userNotes } : {}),
      library,
    });
    const genreNames = await resolveGenreNames(deps, failures, logger);
    const result = await deps.agent.judge({
      candidates,
      library,
      ...(taste.notes ? { userNotes: taste.notes } : {}),
      ...(Object.keys(genreNames).length ? { genreNames } : {}),
    });
    report.runId = deps.store.recordJudgement(result, candidates, deps.now?.() ?? new Date());
    report.judged = result.verdicts.length;
    report.kept = result.verdicts.filter((v) => v.keep).length;

    if (deps.service) {
      report.posted = await deps.service.postVerdicts(
        result,
        candidates,
        deps.now?.() ?? new Date(),
      );
    }
    logger.info(
      { runId: report.runId, judged: report.judged, kept: report.kept, posted: report.posted },
      'cycle complete',
    );
  } catch (e) {
    // A judge failure is loud but not corrupting: nothing was written, so
    // the same candidates are simply judged again next cycle.
    const message =
      e instanceof AgentError
        ? `The agent returned nothing usable this cycle: ${e.message}`
        : `Judging failed: ${errorText(e)}`;
    failures.push(message);
    logger.error({ err: e }, 'judging failed');
  }

  await notify(deps, failures);
  return report;
}

/**
 * TMDB genre ids mean nothing to the agent on their own. Fetched per
 * cycle (one cheap call) and non-fatal: without it the prompt falls back
 * to `genre:878`, which is worse but not wrong.
 */
async function resolveGenreNames(
  deps: CycleDeps,
  failures: string[],
  logger: Pick<Logger, 'info' | 'error'>,
): Promise<Record<number, string>> {
  if (deps.genreNames) return deps.genreNames;
  try {
    const { genres } = await deps.tmdb.genres();
    return Object.fromEntries(genres.map((g) => [g.id, g.name]));
  } catch (e) {
    failures.push(`TMDB genre list unavailable, judging on genre ids: ${errorText(e)}`);
    logger.error({ err: e }, 'genre list fetch failed');
    return {};
  }
}

async function notify(deps: CycleDeps, failures: string[]): Promise<void> {
  if (!deps.service || failures.length === 0) return;
  await deps.service.reportFailures(failures);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
