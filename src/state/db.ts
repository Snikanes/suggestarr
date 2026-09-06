import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { QualityProfile } from '../arr/adder.js';
import { migrate, type MigrationLogger } from './migrator.js';
import type { Candidate } from '../tmdb/types.js';
import type { JudgeResult, Verdict } from '../agent/types.js';

/**
 * What eventually happened to a judged title. `null` while the
 * suggestion is still pending in Discord.
 *
 * - approved:    agent kept it, user reacted ✅
 * - rejected:    agent kept it, user reacted ❌
 * - force-added: agent DROPPED it, user added it anyway via /add
 *                (the highest-value prompt-refinement signal, §2.4)
 * - expired:     nobody reacted before the suggestion aged out
 */
export type Outcome = 'approved' | 'rejected' | 'force-added' | 'expired';

export interface DecisionRow {
  id: number;
  runId: number;
  remoteId: number;
  title: string;
  year: number | null;
  origin: string;
  rating: number | null;
  votes: number | null;
  posterUrl: string | null;
  overview: string | null;
  verdict: 'keep' | 'drop';
  reason: string;
  provider: string;
  model: string;
  promptVersion: string;
  tasteHash: string;
  createdAt: string;
  outcome: Outcome | null;
  outcomeAt: string | null;
}

export interface DecisionFilter {
  remoteId?: number;
  verdict?: 'keep' | 'drop';
  outcome?: Outcome | null;
  promptVersion?: string;
  limit?: number;
}

/** A verdict the human overruled — the evidence base for prompt edits. */
export interface Mismatch {
  row: DecisionRow;
  /** dropped-but-wanted, or kept-but-refused */
  type: 'dropped-but-wanted' | 'kept-but-rejected';
}

/** Lifecycle of one posted Discord suggestion. */
export type SuggestionState = 'pending' | 'approved' | 'rejected' | 'failed' | 'expired';

export interface SuggestionRow {
  id: number;
  decisionId: number;
  remoteId: number;
  title: string;
  year: number | null;
  channelId: string;
  messageId: string;
  postedAt: string;
  state: SuggestionState;
  resolvedAt: string | null;
  error: string | null;
  /** the profile it was actually added at; null until approved */
  qualityProfileId: number | null;
  qualityProfileName: string | null;
}

export interface NewSuggestion {
  decisionId: number;
  remoteId: number;
  title: string;
  year: number | null;
  channelId: string;
  messageId: string;
}

interface RawSuggestion {
  id: number;
  decision_id: number;
  remote_id: number;
  title: string;
  year: number | null;
  channel_id: string;
  message_id: string;
  posted_at: string;
  state: SuggestionState;
  resolved_at: string | null;
  error: string | null;
  quality_profile_id: number | null;
  quality_profile_name: string | null;
}

interface RawDecision {
  id: number;
  run_id: number;
  remote_id: number;
  title: string;
  year: number | null;
  origin: string;
  rating: number | null;
  votes: number | null;
  poster_url: string | null;
  overview: string | null;
  verdict: 'keep' | 'drop';
  reason: string;
  provider: string;
  model: string;
  prompt_version: string;
  taste_hash: string;
  created_at: string;
  outcome: Outcome | null;
  outcome_at: string | null;
}

/**
 * SQLite-backed state. Single-process app, so better-sqlite3's
 * synchronous API keeps the call sites free of await noise.
 *
 * Every verdict — kept AND dropped — is persisted, because the dropped
 * ones are what make the prompt-refinement loop (§2.4) possible.
 */
export class Store {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Open a database and bring it up to the newest migration.
   *
   * Async because migrations are: the schema is no longer applied
   * blindly on every open, it is a versioned ledger Umzug walks. Every
   * query below stays synchronous — only getting the file open costs an
   * await.
   */
  static async open(path: string, logger?: MigrationLogger): Promise<Store> {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    await migrate(db, logger);
    return new Store(db);
  }

  /**
   * Persist one judging run and all of its verdicts atomically.
   * Candidates are matched to verdicts by TMDB id; a verdict with no
   * matching candidate is ignored (AgentClient never emits one).
   */
  recordJudgement(result: JudgeResult, candidates: Candidate[], now = new Date()): number {
    const iso = now.toISOString();
    const byRemoteId = new Map(candidates.map((c) => [c.remoteId, c]));

    const insertRun = this.db.prepare(`
      INSERT INTO runs (started_at, provider, model, prompt_version, taste_hash,
                        candidate_count, kept_count, attempts, input_tokens, output_tokens)
      VALUES (@started_at, @provider, @model, @prompt_version, @taste_hash,
              @candidate_count, @kept_count, @attempts, @input_tokens, @output_tokens)
    `);
    const insertDecision = this.db.prepare(`
      INSERT INTO agent_decisions (run_id, remote_id, title, year, origin, rating, votes,
                                   poster_url, overview, verdict, reason, provider, model,
                                   prompt_version, taste_hash, created_at)
      VALUES (@run_id, @remote_id, @title, @year, @origin, @rating, @votes,
              @poster_url, @overview, @verdict, @reason, @provider, @model,
              @prompt_version, @taste_hash, @created_at)
    `);

    const tx = this.db.transaction((verdicts: Verdict[]): number => {
      const runId = Number(
        insertRun.run({
          started_at: iso,
          provider: result.provider,
          model: result.model,
          prompt_version: result.promptVersion,
          taste_hash: result.tasteHash,
          candidate_count: verdicts.length,
          kept_count: verdicts.filter((v) => v.keep).length,
          attempts: result.attempts,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
        }).lastInsertRowid,
      );

      for (const v of verdicts) {
        const c = byRemoteId.get(v.remoteId);
        if (!c) continue;
        insertDecision.run({
          run_id: runId,
          remote_id: v.remoteId,
          title: c.title,
          year: c.year,
          origin: c.origin,
          rating: c.rating,
          votes: c.votes,
          poster_url: c.posterUrl,
          overview: c.overview,
          verdict: v.keep ? 'keep' : 'drop',
          reason: v.reason,
          provider: result.provider,
          model: result.model,
          prompt_version: result.promptVersion,
          taste_hash: result.tasteHash,
          created_at: iso,
        });
      }
      return runId;
    });

    return tx(result.verdicts);
  }

  /**
   * Join the human's reaction back onto the agent's verdict.
   *
   * Updates the most recent row that is still open — pending, or expired
   * without an answer. A row the user actually decided is never
   * overwritten, so a late reaction cannot flip a recorded yes into a no.
   */
  setOutcome(remoteId: number, outcome: Outcome, now = new Date()): boolean {
    const res = this.db
      .prepare(
        `UPDATE agent_decisions SET outcome = ?, outcome_at = ?
         WHERE id = (
           SELECT id FROM agent_decisions
           WHERE remote_id = ? AND (outcome IS NULL OR outcome = 'expired')
           ORDER BY id DESC LIMIT 1
         )`,
      )
      .run(outcome, now.toISOString(), remoteId);
    return res.changes > 0;
  }

  latestDecision(remoteId: number): DecisionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_decisions WHERE remote_id = ? ORDER BY id DESC LIMIT 1`)
      .get(remoteId) as RawDecision | undefined;
    return row ? toDecisionRow(row) : null;
  }

  listDecisions(filter: DecisionFilter = {}): DecisionRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.remoteId !== undefined) {
      where.push('remote_id = ?');
      params.push(filter.remoteId);
    }
    if (filter.verdict !== undefined) {
      where.push('verdict = ?');
      params.push(filter.verdict);
    }
    if (filter.promptVersion !== undefined) {
      where.push('prompt_version = ?');
      params.push(filter.promptVersion);
    }
    if (filter.outcome !== undefined) {
      if (filter.outcome === null) {
        where.push('outcome IS NULL');
      } else {
        where.push('outcome = ?');
        params.push(filter.outcome);
      }
    }
    const sql = [
      'SELECT * FROM agent_decisions',
      where.length ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY id DESC',
      filter.limit !== undefined ? `LIMIT ${Number(filter.limit)}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (this.db.prepare(sql).all(...params) as RawDecision[]).map(toDecisionRow);
  }

  /**
   * The two ways the agent and the human disagreed. Reviewing these is
   * how the prompt gets edited; grouping them by prompt_version is how
   * an edit is shown to have helped.
   */
  mismatches(promptVersion?: string): Mismatch[] {
    const params: unknown[] = [];
    const versionClause = promptVersion ? 'AND prompt_version = ?' : '';
    if (promptVersion) params.push(promptVersion);
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_decisions
         WHERE ((verdict = 'drop' AND outcome = 'force-added')
             OR (verdict = 'keep' AND outcome = 'rejected'))
         ${versionClause}
         ORDER BY id DESC`,
      )
      .all(...params) as RawDecision[];
    return rows.map((r) => ({
      row: toDecisionRow(r),
      type: r.verdict === 'drop' ? 'dropped-but-wanted' : 'kept-but-rejected',
    }));
  }

  /** Per-prompt-version scoreboard for before/after comparison (§2.4). */
  promptVersionStats(): {
    promptVersion: string;
    tasteHash: string;
    decisions: number;
    kept: number;
    approved: number;
    rejected: number;
    forceAdded: number;
  }[] {
    return this.db
      .prepare(
        `SELECT prompt_version AS promptVersion,
                taste_hash     AS tasteHash,
                COUNT(*)                                                    AS decisions,
                SUM(CASE WHEN verdict = 'keep'        THEN 1 ELSE 0 END)     AS kept,
                SUM(CASE WHEN outcome = 'approved'    THEN 1 ELSE 0 END)     AS approved,
                SUM(CASE WHEN outcome = 'rejected'    THEN 1 ELSE 0 END)     AS rejected,
                SUM(CASE WHEN outcome = 'force-added' THEN 1 ELSE 0 END)     AS forceAdded
         FROM agent_decisions
         GROUP BY prompt_version, taste_hash
         ORDER BY prompt_version, taste_hash`,
      )
      .all() as ReturnType<Store['promptVersionStats']>;
  }

  /**
   * Remember that a suggestion was posted to Discord, keyed by the
   * message the user will react to.
   */
  recordSuggestion(s: NewSuggestion, now = new Date()): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO suggestions (decision_id, remote_id, title, year, channel_id,
                                    message_id, posted_at, state)
           VALUES (@decision_id, @remote_id, @title, @year, @channel_id,
                   @message_id, @posted_at, 'pending')`,
        )
        .run({
          decision_id: s.decisionId,
          remote_id: s.remoteId,
          title: s.title,
          year: s.year,
          channel_id: s.channelId,
          message_id: s.messageId,
          posted_at: now.toISOString(),
        }).lastInsertRowid,
    );
  }

  /** The reaction handler's entry point: which suggestion is this message? */
  suggestionByMessage(messageId: string): SuggestionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM suggestions WHERE message_id = ?`)
      .get(messageId) as RawSuggestion | undefined;
    return row ? toSuggestionRow(row) : null;
  }

  /** Newest still-open suggestion for a title, for `/add` and `/skip`. */
  pendingSuggestionFor(remoteId: number): SuggestionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM suggestions WHERE remote_id = ? AND state = 'pending'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(remoteId) as RawSuggestion | undefined;
    return row ? toSuggestionRow(row) : null;
  }

  pendingSuggestions(): SuggestionRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM suggestions WHERE state = 'pending' ORDER BY id DESC`)
        .all() as RawSuggestion[]
    ).map(toSuggestionRow);
  }

  /**
   * Close out a suggestion. `failed` keeps the error text so the Discord
   * message can say why the *arr refused it; an approval keeps the
   * quality profile it actually landed at, which may not be the default.
   */
  markSuggestion(
    id: number,
    state: SuggestionState,
    opts: { error?: string; qualityProfile?: QualityProfile } = {},
    now = new Date(),
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE suggestions
            SET state = ?, resolved_at = ?, error = ?,
                quality_profile_id = ?, quality_profile_name = ?
          WHERE id = ?`,
      )
      .run(
        state,
        now.toISOString(),
        opts.error ?? null,
        opts.qualityProfile?.id ?? null,
        opts.qualityProfile?.name ?? null,
        id,
      );
    return res.changes > 0;
  }

  /**
   * TMDB ids a cycle must not suggest: everything the user actually
   * decided, plus anything still waiting for an answer.
   *
   * Expiry is deliberately absent from that list. An expired suggestion
   * is not a "no" — it is a question nobody got round to answering, so
   * the title returns to the pool and gets asked again later. A title
   * whose only verdicts expired is therefore eligible again; one that
   * was approved, rejected or force-added never is.
   */
  excludedIds(): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT remote_id FROM agent_decisions
         WHERE outcome IS NULL OR outcome <> 'expired'`,
      )
      .all() as { remote_id: number }[];
    return new Set(rows.map((r) => r.remote_id));
  }

  /**
   * Close out suggestions nobody answered before the cutoff.
   *
   * Both halves move together: the suggestion row becomes `expired`, and
   * so does the decision's outcome — recording that the question went
   * unanswered without pretending it was a yes or a no.
   */
  expirePending(before: Date, now = new Date()): SuggestionRow[] {
    const stale = (
      this.db
        .prepare(`SELECT * FROM suggestions WHERE state = 'pending' AND posted_at < ?`)
        .all(before.toISOString()) as RawSuggestion[]
    ).map(toSuggestionRow);

    const iso = now.toISOString();
    const expireSuggestion = this.db.prepare(
      `UPDATE suggestions SET state = 'expired', resolved_at = ? WHERE id = ?`,
    );
    const expireDecision = this.db.prepare(
      `UPDATE agent_decisions SET outcome = 'expired', outcome_at = ? WHERE id = ?`,
    );

    const tx = this.db.transaction((rows: SuggestionRow[]) => {
      for (const row of rows) {
        expireSuggestion.run(iso, row.id);
        expireDecision.run(iso, row.decisionId);
      }
    });
    tx(stale);

    return stale;
  }

  /**
   * Retention (§2.4): verdicts are kept forever, but the bulky raw
   * candidate payload is dropped once it is older than the cutoff.
   */
  pruneCandidatePayloads(before: Date): number {
    return this.db
      .prepare(
        `UPDATE agent_decisions SET overview = NULL, poster_url = NULL
         WHERE created_at < ? AND (overview IS NOT NULL OR poster_url IS NOT NULL)`,
      )
      .run(before.toISOString()).changes;
  }

  close(): void {
    this.db.close();
  }
}

function toSuggestionRow(r: RawSuggestion): SuggestionRow {
  return {
    id: r.id,
    decisionId: r.decision_id,
    remoteId: r.remote_id,
    title: r.title,
    year: r.year,
    channelId: r.channel_id,
    messageId: r.message_id,
    postedAt: r.posted_at,
    state: r.state,
    resolvedAt: r.resolved_at,
    error: r.error,
    qualityProfileId: r.quality_profile_id,
    qualityProfileName: r.quality_profile_name,
  };
}

function toDecisionRow(r: RawDecision): DecisionRow {
  return {
    id: r.id,
    runId: r.run_id,
    remoteId: r.remote_id,
    title: r.title,
    year: r.year,
    origin: r.origin,
    rating: r.rating,
    votes: r.votes,
    posterUrl: r.poster_url,
    overview: r.overview,
    verdict: r.verdict,
    reason: r.reason,
    provider: r.provider,
    model: r.model,
    promptVersion: r.prompt_version,
    tasteHash: r.taste_hash,
    createdAt: r.created_at,
    outcome: r.outcome,
    outcomeAt: r.outcome_at,
  };
}
