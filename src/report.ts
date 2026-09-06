import { writeFileSync } from 'node:fs';
import type { DecisionRow, Mismatch, Store } from './state/db.js';

/**
 * A standalone HTML view of the decision log.
 *
 * The prompt-refinement loop (§2.4) only works if the evidence is
 * actually looked at, and a CLI dump is not something anyone reads
 * twice. Self-contained: no network, no assets, opens from disk.
 */
export function buildReportHtml(store: Store, now = new Date()): string {
  const stats = store.promptVersionStats();
  const mismatches = store.mismatches();
  const pending = store.listDecisions({ verdict: 'keep', outcome: null, limit: 50 });
  const recent = store.listDecisions({ limit: 100 });

  const totals = stats.reduce(
    (acc, s) => ({
      decisions: acc.decisions + s.decisions,
      approved: acc.approved + s.approved,
      rejected: acc.rejected + s.rejected,
      forceAdded: acc.forceAdded + s.forceAdded,
    }),
    { decisions: 0, approved: 0, rejected: 0, forceAdded: 0 },
  );
  const answered = totals.approved + totals.rejected + totals.forceAdded;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Suggestarr decisions</title>
<style>
  :root { color-scheme: light dark; --line: #8883; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 2rem; max-width: 60rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  .sub { opacity: .65; margin-bottom: 2rem; }
  h2 { font-size: 1.05rem; margin: 2.5rem 0 .75rem; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; opacity: .7; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid var(--line); border-radius: .5rem; padding: .8rem 1rem; min-width: 8rem; }
  .card b { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; }
  .card span { opacity: .65; font-size: 12px; }
  .reason { opacity: .75; }
  .tag { font-size: 11px; padding: .1rem .4rem; border-radius: .25rem; border: 1px solid var(--line); }
  .empty { opacity: .6; font-style: italic; }
</style></head><body>
<h1>Suggestarr decisions</h1>
<div class="sub">Generated ${escape(now.toISOString().slice(0, 16).replace('T', ' '))}</div>

<div class="cards">
  ${card(totals.decisions, 'verdicts')}
  ${card(totals.approved, 'approved')}
  ${card(totals.rejected, 'rejected')}
  ${card(totals.forceAdded, 'force-added')}
  ${card(answered ? `${Math.round(((totals.rejected + totals.forceAdded) / answered) * 100)}%` : '—', 'you overruled')}
</div>

<h2>Prompt versions</h2>
${
  stats.length
    ? table(
        ['Prompt', 'Taste', 'Verdicts', 'Kept', 'Approved', 'Rejected', 'Force-added', 'Mismatch'],
        stats.map((s) => {
          const seen = s.approved + s.rejected + s.forceAdded;
          const rate = seen ? `${Math.round(((s.rejected + s.forceAdded) / seen) * 100)}%` : '—';
          return [
            escape(s.promptVersion),
            `<code>${escape(s.tasteHash)}</code>`,
            num(s.decisions),
            num(s.kept),
            num(s.approved),
            num(s.rejected),
            num(s.forceAdded),
            num(rate),
          ];
        }),
      )
    : '<p class="empty">No runs recorded yet.</p>'
}

<h2>Where you overruled the agent <span class="tag">${mismatches.length}</span></h2>
${
  mismatches.length
    ? table(
        ['Title', 'What happened', 'Prompt', "Agent's reasoning"],
        mismatches.map((m: Mismatch) => [
          escape(titleOf(m.row)),
          m.type === 'dropped-but-wanted'
            ? 'dropped it, you added it'
            : 'kept it, you said no',
          escape(m.row.promptVersion),
          `<span class="reason">${escape(m.row.reason)}</span>`,
        ]),
      )
    : '<p class="empty">Nothing yet — the agent and you have agreed so far.</p>'
}

<h2>Awaiting an answer <span class="tag">${pending.length}</span></h2>
${
  pending.length
    ? table(
        ['Title', 'TMDB', 'Suggested', "Agent's reasoning"],
        pending.map((d) => [
          escape(titleOf(d)),
          `<a href="https://www.themoviedb.org/movie/${d.remoteId}">${d.remoteId}</a>`,
          escape(d.createdAt.slice(0, 10)),
          `<span class="reason">${escape(d.reason)}</span>`,
        ]),
      )
    : '<p class="empty">Nothing pending.</p>'
}

<h2>Recent verdicts</h2>
${
  recent.length
    ? table(
        ['Title', 'Verdict', 'Outcome', 'Date', 'Reasoning'],
        recent.map((d) => [
          escape(titleOf(d)),
          d.verdict === 'keep' ? '✅ keep' : '❌ drop',
          escape(d.outcome ?? '—'),
          escape(d.createdAt.slice(0, 10)),
          `<span class="reason">${escape(d.reason)}</span>`,
        ]),
      )
    : '<p class="empty">No verdicts yet.</p>'
}
</body></html>`;
}

/** Writes the report and returns the path it wrote to. */
export function writeReport(store: Store, path: string, now = new Date()): string {
  writeFileSync(path, buildReportHtml(store, now), 'utf8');
  return path;
}

function titleOf(row: DecisionRow): string {
  return `${row.title}${row.year ? ` (${row.year})` : ''}`;
}

function card(value: number | string, label: string): string {
  return `<div class="card"><b>${escape(String(value))}</b><span>${escape(label)}</span></div>`;
}

function num(value: number | string): string {
  return `<td class="num">${escape(String(value))}</td>`;
}

function table(headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th>${escape(h)}</th>`).join('');
  const body = rows
    .map((cells) => `<tr>${cells.map((c) => (c.startsWith('<td') ? c : `<td>${c}</td>`)).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Titles and agent reasoning are model output — never trust them as markup. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
