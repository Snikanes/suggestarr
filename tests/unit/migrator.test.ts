import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMigrator,
  migrate,
  relabel,
  transactional,
  type MigrationLogger,
} from '../../src/state/migrator.js';
import { MIGRATIONS } from '../../src/state/migrations/index.js';
import { Store } from '../../src/state/db.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suggestarr-migrate-'));
  db = new Database(join(dir, 'state.db'));
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tables = (): string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);

describe('migrate', () => {
  it('brings an empty database up to the newest migration', async () => {
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(tables()).toEqual(expect.arrayContaining(['agent_decisions', 'runs', 'suggestions']));
  });

  it('records what it applied, in order, with a timestamp', async () => {
    await migrate(db);
    const ledger = db
      .prepare(`SELECT name, executed_at FROM migrations ORDER BY name`)
      .all() as { name: string; executed_at: string }[];

    expect(ledger.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
    for (const row of ledger) expect(Date.parse(row.executed_at)).not.toBeNaN();
  });

  it('is a no-op on a database that is already current', async () => {
    await migrate(db);
    expect(await migrate(db)).toEqual([]);
  });

  it('adopts a database that predates the ledger without touching its rows', async () => {
    // Exactly what the old `db.exec(SCHEMA)`-on-open left behind: the
    // tables, real data, and no record of any migration ever running.
    db.exec(`
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
        taste_hash TEXT NOT NULL, candidate_count INTEGER NOT NULL, kept_count INTEGER NOT NULL,
        attempts INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER);
      INSERT INTO runs (started_at, provider, model, prompt_version, taste_hash,
                        candidate_count, kept_count, attempts)
      VALUES ('2026-09-05T10:00:00.000Z', 'mock', 'heuristic-1', 'v1', 'abc', 4, 3, 1);
    `);

    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(db.prepare(`SELECT count(*) AS c FROM runs`).get()).toEqual({ c: 1 });
    expect(tables()).toEqual(expect.arrayContaining(['agent_decisions', 'suggestions']));
  });
});

describe('createMigrator', () => {
  it('reports what is applied and what is still pending', async () => {
    const migrator = createMigrator(db);
    expect((await migrator.executed()).map((m) => m.name)).toEqual([]);
    expect((await migrator.pending()).map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));

    await migrator.up();

    expect((await migrator.executed()).map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await migrator.pending()).toEqual([]);
  });

  it('takes the newest migration back out again, one step at a time', async () => {
    await migrate(db);
    const migrator = createMigrator(db);

    expect((await migrator.down()).map((m) => m.name)).toEqual(['002-quality-profile']);
    expect(tables()).toContain('suggestions');

    expect((await migrator.down()).map((m) => m.name)).toEqual(['001-baseline']);
    expect(tables()).not.toContain('suggestions');
    expect(db.prepare(`SELECT count(*) AS c FROM migrations`).get()).toEqual({ c: 0 });
  });

  it('says what it is doing through the logger it was given', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger: MigrationLogger = {
      info: (o) => void lines.push(o),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    await migrate(db, logger);

    expect(lines.map((l) => l.event)).toContain('migrated');
    // umzug's own `name` would otherwise overwrite pino's logger name
    expect(lines.some((l) => l.migration === '001-baseline')).toBe(true);
    expect(lines.some((l) => 'name' in l)).toBe(false);
  });
});

describe('relabel', () => {
  it('moves umzug’s name onto `migration` at every level', () => {
    const seen: [string, Record<string, unknown>][] = [];
    const spy = (level: string) => (o: Record<string, unknown>) => void seen.push([level, o]);
    const wrapped = relabel({
      info: spy('info'),
      warn: spy('warn'),
      error: spy('error'),
      debug: spy('debug'),
    });

    wrapped.info({ event: 'migrating', name: '001-baseline' });
    wrapped.warn({ name: 'x' });
    wrapped.error({ name: 'y' });
    wrapped.debug({ event: 'noisy' });

    expect(seen).toEqual([
      ['info', { event: 'migrating', migration: '001-baseline' }],
      ['warn', { migration: 'x' }],
      ['error', { migration: 'y' }],
      // nothing to rename: passed through untouched
      ['debug', { event: 'noisy' }],
    ]);
  });
});

describe('transactional', () => {
  it('rolls the whole step back when it throws half way', async () => {
    const step = transactional({
      name: 'explodes',
      up: (d) => {
        d.exec(`CREATE TABLE half_done (a TEXT)`);
        throw new Error('boom');
      },
      down: (d) => d.exec(`DROP TABLE IF EXISTS half_done`),
    });

    await expect(step.up({ name: 'explodes', context: { db } })).rejects.toThrow('boom');
    expect(tables()).not.toContain('half_done');
  });

  it('commits a step that succeeds, and reverts it the same way', async () => {
    const step = transactional({
      name: 'adds-a-table',
      up: (d) => d.exec(`CREATE TABLE kept (a TEXT)`),
      down: (d) => d.exec(`DROP TABLE kept`),
    });
    const params = { name: 'adds-a-table', context: { db } };

    await step.up(params);
    expect(tables()).toContain('kept');

    await step.down?.(params);
    expect(tables()).not.toContain('kept');
  });
});

describe('002-quality-profile', () => {
  it('adds the columns to a database that predates the picker, keeping its rows', async () => {
    // Suggestions recorded before the quality profile could be chosen.
    await createMigrator(db).up({ to: '001-baseline' });
    db.exec(`
      INSERT INTO runs (started_at, provider, model, prompt_version, taste_hash,
                        candidate_count, kept_count, attempts)
      VALUES ('2026-09-05T10:00:00.000Z', 'mock', 'heuristic-1', 'v1', 'abc', 1, 1, 1);
      INSERT INTO agent_decisions (run_id, remote_id, title, year, origin, verdict, reason,
                                   provider, model, prompt_version, taste_hash, created_at)
      VALUES (1, 603, 'The Matrix', 1999, 'trending', 'keep', 'anchor sci-fi',
              'mock', 'heuristic-1', 'v1', 'abc', '2026-09-05T10:00:00.000Z');
      INSERT INTO suggestions (decision_id, remote_id, title, year, channel_id, message_id,
                               posted_at, state)
      VALUES (1, 603, 'The Matrix', 1999, 'c-1', 'm-old', '2026-09-05T10:00:00.000Z', 'pending');
    `);

    expect(await migrate(db)).toEqual(['002-quality-profile']);

    const store = await Store.open(join(dir, 'state.db'));
    expect(store.suggestionByMessage('m-old')).toMatchObject({
      title: 'The Matrix',
      qualityProfileId: null,
      qualityProfileName: null,
    });
    store.close();
  });

  it('takes the columns back out again', async () => {
    await migrate(db);
    await createMigrator(db).down();

    const columns = (
      db.prepare(`PRAGMA table_info(suggestions)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).not.toContain('quality_profile_id');
    expect(columns).not.toContain('quality_profile_name');
    expect(columns).toContain('message_id');
  });
});

describe('Store.open', () => {
  it('migrates the database it opens, so a fresh file is usable at once', async () => {
    const store = await Store.open(join(dir, 'fresh.db'));
    expect(store.pendingSuggestions()).toEqual([]);
    expect(store.listDecisions()).toEqual([]);
    store.close();

    const reopened = new Database(join(dir, 'fresh.db'), { readonly: true });
    expect(
      (reopened.prepare(`SELECT name FROM migrations`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.name));
    reopened.close();
  });

  it('creates the directory a database is asked for', async () => {
    const store = await Store.open(join(dir, 'nested', 'deeper', 'state.db'));
    expect(store.pendingSuggestions()).toEqual([]);
    store.close();
  });
});
