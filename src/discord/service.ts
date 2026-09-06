import type { Logger } from 'pino';
import type { TitleAdder } from '../arr/adder.js';
import type { Candidate } from '../tmdb/types.js';
import type { JudgeResult } from '../agent/types.js';
import type { DecisionRow, Outcome, Store, SuggestionRow } from '../state/db.js';
import {
  APPROVE_EMOJI,
  REJECT_EMOJI,
  buildResolvedEmbed,
  buildSuggestionEmbed,
  embedFromDecision,
  formatPendingList,
} from './embeds.js';
import type {
  CommandEvent,
  CommandReply,
  DiscordGateway,
  PostedMessage,
  ReactionEvent,
} from './gateway.js';

export interface SuggestionServiceDeps {
  store: Store;
  adder: TitleAdder;
  gateway: DiscordGateway;
  logger?: Pick<Logger, 'info' | 'error'>;
}

const NOOP_LOGGER = { info: () => undefined, error: () => undefined };

/**
 * The approve/reject loop: post what the agent kept, turn a ✅ into a
 * monitored *arr item, turn a ❌ into a permanent no, and write both back
 * onto the decision row so the prompt-refinement loop (§2.4) can see them.
 */
export class SuggestionService {
  private readonly store: Store;
  private readonly adder: TitleAdder;
  private readonly gateway: DiscordGateway;
  private readonly logger: SuggestionServiceDeps['logger'] & object;

  constructor(deps: SuggestionServiceDeps) {
    this.store = deps.store;
    this.adder = deps.adder;
    this.gateway = deps.gateway;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /** Attach to the gateway. Call once, before `gateway.start()`. */
  register(): void {
    this.gateway.onReaction((e) => this.handleReaction(e));
    this.gateway.onCommand((e) => this.handleCommand(e));
  }

  /**
   * Post everything the agent kept. Dropped titles are not posted — they
   * live in the decision log, reachable via `/decisions`, and can still be
   * pulled in with `/add`.
   */
  async postVerdicts(
    result: JudgeResult,
    candidates: Candidate[],
    now = new Date(),
  ): Promise<number> {
    const byRemoteId = new Map(candidates.map((c) => [c.remoteId, c]));
    let posted = 0;

    for (const verdict of result.verdicts) {
      if (!verdict.keep) continue;
      const candidate = byRemoteId.get(verdict.remoteId);
      const decision = this.store.latestDecision(verdict.remoteId);
      if (!candidate || !decision) continue;

      const embed = buildSuggestionEmbed(candidate, verdict, {
        model: result.model,
        promptVersion: result.promptVersion,
      });
      const message = await this.gateway.post(embed, [APPROVE_EMOJI, REJECT_EMOJI]);
      this.store.recordSuggestion(
        {
          decisionId: decision.id,
          remoteId: candidate.remoteId,
          title: candidate.title,
          year: candidate.year,
          channelId: message.channelId,
          messageId: message.messageId,
        },
        now,
      );
      posted += 1;
    }
    return posted;
  }

  /**
   * Catch up on answers given while nothing was listening.
   *
   * Discord replays nothing to a gateway that was disconnected, so a ✅
   * pressed while the bot was down would otherwise sit unnoticed forever.
   * Run once at startup, before the schedule is armed.
   *
   * A ❌ wins over a ✅ on the same message: the two together are
   * ambiguous, and refusing to add is the recoverable half of that.
   */
  async reconcilePending(): Promise<{ approved: number; rejected: number; unreadable: number }> {
    const result = { approved: 0, rejected: 0, unreadable: 0 };

    for (const suggestion of this.store.pendingSuggestions()) {
      let reactions;
      try {
        reactions = await this.gateway.reactionsOn({
          channelId: suggestion.channelId,
          messageId: suggestion.messageId,
        });
      } catch (e) {
        // Deleted message, lost permission — leave it pending and let
        // expiry deal with it rather than guessing.
        result.unreadable += 1;
        this.logger.info(
          { remoteId: suggestion.remoteId, err: (e as Error).message },
          'could not read reactions for a pending suggestion',
        );
        continue;
      }

      const answered = (emoji: string): boolean =>
        reactions.some((r) => r.emoji === emoji && r.userIds.length > 0);

      if (answered(REJECT_EMOJI)) {
        await this.reject(suggestion);
        result.rejected += 1;
      } else if (answered(APPROVE_EMOJI)) {
        await this.approve(suggestion);
        result.approved += 1;
      }
    }

    if (result.approved || result.rejected || result.unreadable) {
      this.logger.info(result, 'reconciled reactions missed while offline');
    }
    return result;
  }

  /**
   * Grey out suggestions that timed out, so a stale ✅ is visibly dead.
   *
   * Expiry is not an answer: the title goes back in the pool and will be
   * suggested again, which the embed says out loud.
   */
  async markExpired(expired: SuggestionRow[]): Promise<void> {
    for (const suggestion of expired) {
      await this.editResolved(
        suggestion,
        'expired',
        'Nobody answered in time, so this went back in the pool — it may be suggested again.',
      );
    }
  }

  /** Tell the channel about non-fatal cycle problems (*arr down, etc.). */
  async reportFailures(failures: string[]): Promise<void> {
    if (failures.length === 0) return;
    await this.gateway.notice(
      ['⚠️ **Cycle problems:**', ...failures.map((f) => `• ${f}`)].join('\n'),
    );
  }

  /** ✅ / ❌ on a suggestion message. Anything else is ignored. */
  async handleReaction(event: ReactionEvent): Promise<void> {
    if (event.userIsBot) return;
    if (event.emoji !== APPROVE_EMOJI && event.emoji !== REJECT_EMOJI) return;

    const suggestion = this.store.suggestionByMessage(event.messageId);
    if (!suggestion) return;
    if (suggestion.state !== 'pending') {
      this.logger.info(
        { messageId: event.messageId, state: suggestion.state },
        'reaction on an already-resolved suggestion, ignored',
      );
      return;
    }

    if (event.emoji === APPROVE_EMOJI) {
      await this.approve(suggestion);
    } else {
      await this.reject(suggestion);
    }
  }

  /** `/add`, `/skip`, `/decisions`, `/status`. */
  async handleCommand(event: CommandEvent): Promise<CommandReply> {
    switch (event.name) {
      case 'add':
        return this.commandAdd(event);
      case 'skip':
        return this.commandSkip(event);
      case 'decisions':
        return this.commandDecisions(event);
      case 'status':
        return this.commandStatus();
      default:
        return ephemeral(`Unknown command \`/${event.name}\`.`);
    }
  }

  // -------------------------------------------------------------------------
  // Approve / reject
  // -------------------------------------------------------------------------

  private async approve(suggestion: SuggestionRow): Promise<string> {
    const decision = this.store.latestDecision(suggestion.remoteId);
    const outcome = decision?.verdict === 'drop' ? 'force-added' : 'approved';

    try {
      const added = await this.adder.add(suggestion.remoteId, suggestion.title, suggestion.year);
      this.store.markSuggestion(suggestion.id, 'approved');
      this.store.setOutcome(suggestion.remoteId, outcome);
      const detail = `Monitored in Radarr at \`${added.rootFolderPath}\` — the download starts on its own.`;
      await this.editResolved(suggestion, 'approved', detail);
      this.logger.info(
        { remoteId: suggestion.remoteId, localId: added.localId, outcome },
        'suggestion approved and added',
      );
      return detail;
    } catch (e) {
      const message = (e as Error).message;
      // The *arr refused it: keep the decision pending so a retry is
      // still possible, but say plainly what went wrong.
      this.store.markSuggestion(suggestion.id, 'failed', message);
      await this.editResolved(suggestion, 'failed', message);
      this.logger.error(
        { remoteId: suggestion.remoteId, err: message },
        'could not add approved suggestion',
      );
      return `Could not add **${suggestion.title}**: ${message}`;
    }
  }

  private async reject(suggestion: SuggestionRow): Promise<string> {
    this.store.markSuggestion(suggestion.id, 'rejected');
    this.store.setOutcome(suggestion.remoteId, 'rejected');
    const detail = 'Recorded as a no — this title will not be suggested again.';
    await this.editResolved(suggestion, 'rejected', detail);
    this.logger.info({ remoteId: suggestion.remoteId }, 'suggestion rejected');
    return detail;
  }

  private async editResolved(
    suggestion: SuggestionRow,
    outcome: 'approved' | 'rejected' | 'failed' | 'expired',
    detail: string,
  ): Promise<void> {
    const decision = this.store.latestDecision(suggestion.remoteId);
    if (!decision) return;
    const message: PostedMessage = {
      channelId: suggestion.channelId,
      messageId: suggestion.messageId,
    };
    await this.gateway.edit(
      message,
      buildResolvedEmbed(embedFromDecision(decision), outcome, detail),
    );
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private async commandAdd(event: CommandEvent): Promise<CommandReply> {
    const remoteId = numberOption(event.options.tmdb_id);
    if (remoteId === undefined) return ephemeral(TMDB_ID_HELP);

    const pending = this.store.pendingSuggestionFor(remoteId);
    if (pending) return ephemeral(await this.approve(pending));

    const decision = this.store.latestDecision(remoteId);
    if (!decision) {
      return ephemeral(
        `No verdict on record for tmdb id ${remoteId} — only judged titles can be added this way.`,
      );
    }
    if (isDecided(decision.outcome)) {
      return ephemeral(`\`${decision.title}\` is already ${decision.outcome} — nothing to do.`);
    }
    return ephemeral(await this.forceAdd(decision));
  }

  /**
   * `/add` on a title the agent dropped. This is the signal the whole
   * decision log exists for, so it is recorded as `force-added` rather
   * than as an ordinary approval.
   */
  private async forceAdd(decision: DecisionRow): Promise<string> {
    try {
      const added = await this.adder.add(decision.remoteId, decision.title, decision.year);
      this.store.setOutcome(decision.remoteId, 'force-added');
      this.logger.info(
        { remoteId: decision.remoteId, localId: added.localId },
        'dropped title force-added by the user',
      );
      return `Added **${decision.title}** despite the agent dropping it. Logged as a prompt mismatch.`;
    } catch (e) {
      const message = (e as Error).message;
      this.logger.error(
        { remoteId: decision.remoteId, err: message },
        'could not force-add title',
      );
      return `Could not add **${decision.title}**: ${message}`;
    }
  }

  private async commandSkip(event: CommandEvent): Promise<CommandReply> {
    const remoteId = numberOption(event.options.tmdb_id);
    if (remoteId === undefined) return ephemeral(TMDB_ID_HELP);

    const pending = this.store.pendingSuggestionFor(remoteId);
    if (pending) return ephemeral(await this.reject(pending));

    const decision = this.store.latestDecision(remoteId);
    if (!decision) return ephemeral(`No verdict on record for tmdb id ${remoteId}.`);
    if (isDecided(decision.outcome)) {
      return ephemeral(`\`${decision.title}\` is already ${decision.outcome} — nothing to do.`);
    }
    this.store.setOutcome(decision.remoteId, 'rejected');
    return ephemeral(`Recorded **${decision.title}** as a no.`);
  }

  private commandDecisions(event: CommandEvent): CommandReply {
    const remoteId = numberOption(event.options.tmdb_id);
    if (remoteId !== undefined) {
      const rows = this.store.listDecisions({ remoteId, limit: 10 });
      if (rows.length === 0) return ephemeral(`No verdicts recorded for tmdb id ${remoteId}.`);
      return ephemeral(
        [
          `**Verdicts for tmdb ${remoteId}:**`,
          ...rows.map(
            (r) =>
              `• ${r.createdAt.slice(0, 10)} \`${r.verdict}\` ${r.title} — ${r.reason}` +
              (r.outcome ? ` *(you: ${r.outcome})*` : ''),
          ),
        ].join('\n'),
      );
    }

    const dropped = this.store.listDecisions({ verdict: 'drop', outcome: null, limit: 10 });
    const mismatches = this.store.mismatches();
    return ephemeral(
      [
        `**Recently dropped by the agent** (add one with \`/add <tmdb-id>\`):`,
        ...(dropped.length
          ? dropped.map((r) => `• \`${r.remoteId}\` ${r.title} — ${r.reason}`)
          : ['• (nothing dropped yet)']),
        '',
        `**Mismatches so far:** ${mismatches.length}` +
          (mismatches.length
            ? ` — ${mismatches.filter((m) => m.type === 'dropped-but-wanted').length} dropped-but-wanted, ` +
              `${mismatches.filter((m) => m.type === 'kept-but-rejected').length} kept-but-rejected`
            : ''),
      ].join('\n'),
    );
  }

  private commandStatus(): CommandReply {
    const pending = this.store.pendingSuggestions();
    const stats = this.store.promptVersionStats();
    const totals = stats.reduce(
      (acc, s) => ({
        decisions: acc.decisions + s.decisions,
        approved: acc.approved + s.approved,
        rejected: acc.rejected + s.rejected,
        forceAdded: acc.forceAdded + s.forceAdded,
      }),
      { decisions: 0, approved: 0, rejected: 0, forceAdded: 0 },
    );

    return ephemeral(
      [
        formatPendingList(pending),
        '',
        `**Lifetime:** ${totals.decisions} verdicts · ${totals.approved} approved · ` +
          `${totals.rejected} rejected · ${totals.forceAdded} force-added`,
      ].join('\n'),
    );
  }

}

const TMDB_ID_HELP = 'Give me a TMDB id, e.g. `/add tmdb_id:603`.';

/**
 * `expired` is not a decision — the user never answered — so `/add` and
 * `/skip` still act on an expired title rather than refusing it.
 */
function isDecided(outcome: Outcome | null): boolean {
  return outcome !== null && outcome !== 'expired';
}

function numberOption(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function ephemeral(text: string): CommandReply {
  return { text, ephemeral: true };
}
