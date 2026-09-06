import type { Title } from '../arr/types.js';
import type { Store } from './db.js';

export interface TasteProfileOptions {
  /** how many titles of each kind of feedback to quote at the agent */
  perBucket?: number;
  /** free-text preferences from config, always included verbatim */
  userNotes?: string;
  /** the current *arr library, used for the "recently added" signal */
  library?: Title[];
}

export interface TasteProfile {
  /** rendered notes for the judge prompt; empty when there is no signal yet */
  notes: string;
  approved: string[];
  rejected: string[];
  forceAdded: string[];
  recentlyAdded: string[];
}

const DEFAULT_PER_BUCKET = 12;

/**
 * Turn the decision log's outcomes into instructions for the next judge
 * call (§2.4's loop, closed).
 *
 * Three signals, in increasing order of value:
 *  - approved:    the agent kept it and the user said yes — keep doing this
 *  - rejected:    the agent kept it and the user said no  — stop doing this
 *  - force-added: the agent DROPPED it and the user added it anyway, which
 *                 is the only signal that shows what the agent is blind to
 *
 * A fourth signal comes free from Radarr: what the user recently added
 * AND actually has on disk. It needs no extra integration — the library
 * is already fetched every cycle for deduping. It is weaker than a real
 * watch history (Radarr knows what was acquired and kept, never what was
 * played), but it is the same signal the user acts on when they decide
 * what to bring into the stack.
 *
 * The profile is data, not a prompt rewrite: it is hashed into every
 * verdict row (`taste_hash`), so a change in feedback is distinguishable
 * from a change in the prompt template when comparing runs.
 */
export function buildTasteProfile(store: Store, opts: TasteProfileOptions = {}): TasteProfile {
  const perBucket = opts.perBucket ?? DEFAULT_PER_BUCKET;
  const titles = (outcome: 'approved' | 'rejected' | 'force-added'): string[] =>
    store
      .listDecisions({ outcome, limit: perBucket })
      .map((r) => `${r.title}${r.year ? ` (${r.year})` : ''}`);

  const approved = titles('approved');
  const rejected = titles('rejected');
  const forceAdded = titles('force-added');

  const recentlyAdded = recentAdditions(opts.library ?? [], perBucket);

  const sections: string[] = [];
  if (opts.userNotes?.trim()) sections.push(opts.userNotes.trim());
  if (recentlyAdded.length) {
    sections.push(
      `Most recently added to their library, and present on disk — the clearest picture of ` +
        `what they are into right now: ${recentlyAdded.join('; ')}.`,
    );
  }
  if (approved.length) {
    sections.push(`Titles the user accepted: ${approved.join('; ')}.`);
  }
  if (rejected.length) {
    sections.push(
      `Titles the user rejected — do not suggest anything of this sort again: ${rejected.join('; ')}.`,
    );
  }
  if (forceAdded.length) {
    sections.push(
      `Titles you previously DROPPED but the user added anyway. You were wrong about these; ` +
        `weigh similar titles far more favourably: ${forceAdded.join('; ')}.`,
    );
  }

  return { notes: sections.join('\n'), approved, rejected, forceAdded, recentlyAdded };
}

/**
 * Newest library titles the user actually holds.
 *
 * Monitored-but-fileless entries are excluded: those are wishes, not
 * evidence — including them would feed the agent's own past suggestions
 * back to it as if they were the user's taste.
 */
function recentAdditions(library: Title[], limit: number): string[] {
  const owned: { title: string; year: number | null; addedAt: string }[] = [];
  for (const t of library) {
    if (t.hasFile && t.addedAt !== null) {
      owned.push({ title: t.title, year: t.year, addedAt: t.addedAt });
    }
  }
  return owned
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, limit)
    .map((t) => `${t.title}${t.year ? ` (${t.year})` : ''}`);
}
