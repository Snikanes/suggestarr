import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReportHtml, writeReport } from '../../src/report.js';
import { Store } from '../../src/state/db.js';
import { candidatesFixture, judgeResultFixture } from '../fixtures/agent.js';

let store: Store;
let dir: string;

beforeEach(async () => {
  store = await Store.open(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'suggestarr-report-'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildReportHtml', () => {
  it('renders an empty database without falling over', () => {
    const html = buildReportHtml(store);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('No runs recorded yet.');
    expect(html).toContain('Nothing pending.');
  });

  it('summarises verdicts, outcomes and the overrule rate', () => {
    store.recordJudgement(judgeResultFixture, candidatesFixture);
    store.setOutcome(603, 'approved');
    store.setOutcome(999, 'force-added');

    const html = buildReportHtml(store);

    expect(html).toContain('>3</b><span>verdicts');
    expect(html).toContain('>1</b><span>approved');
    expect(html).toContain('>1</b><span>force-added');
    expect(html).toContain('>50%</b><span>you overruled'); // 1 of 2 answered
    expect(html).toContain('v1');
  });

  it('shows every mismatch with the reasoning that produced it', () => {
    store.recordJudgement(judgeResultFixture, candidatesFixture);
    store.setOutcome(999, 'force-added');

    const html = buildReportHtml(store);

    expect(html).toContain('dropped it, you added it');
    expect(html).toContain('Direct To Streaming 4 (2025)');
    expect(html).toContain('Weak ratings, thin premise.');
  });

  it('shows the other kind of mismatch too', () => {
    store.recordJudgement(judgeResultFixture, candidatesFixture);
    store.setOutcome(603, 'rejected'); // agent kept it, user said no

    const html = buildReportHtml(store);

    expect(html).toContain('kept it, you said no');
    expect(html).toContain('The Matrix (1999)');
  });

  it('links pending suggestions to TMDB', () => {
    store.recordJudgement(judgeResultFixture, candidatesFixture);
    const html = buildReportHtml(store);

    expect(html).toContain('https://www.themoviedb.org/movie/603');
    expect(html).toContain('Awaiting an answer');
  });

  it('escapes model output rather than trusting it as markup', () => {
    store.recordJudgement(
      {
        ...judgeResultFixture,
        verdicts: [{ remoteId: 42, keep: true, reason: '<script>alert("xss")</script> & more' }],
      },
      [{ ...candidatesFixture[0]!, remoteId: 42, title: 'Attack <img src=x>' }],
    );

    const html = buildReportHtml(store);

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; more');
  });

  it('stamps the time it was generated', () => {
    expect(buildReportHtml(store, new Date('2026-09-05T18:30:00Z'))).toContain('2026-09-05 18:30');
  });
});

describe('writeReport', () => {
  it('writes a self-contained file with no external references', () => {
    store.recordJudgement(judgeResultFixture, candidatesFixture);
    const path = writeReport(store, join(dir, 'decisions.html'));
    const html = readFileSync(path, 'utf8');

    expect(path).toContain('decisions.html');
    expect(html).toContain('The Matrix (1999)');
    expect(html).not.toMatch(/<script src=|<link rel="stylesheet"/);
  });
});
