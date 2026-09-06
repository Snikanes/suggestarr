import type { MigrationStep } from './types.js';

/**
 * The schema as it stood before migrations existed.
 *
 * Every statement is `IF NOT EXISTS`, and that is load-bearing: databases
 * created by the old `db.exec(SCHEMA)` on open already have these tables
 * but no record of ever having been migrated. Applying the baseline to
 * one of those has to be a no-op that simply marks it as version one.
 */
const BASELINE = `
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  provider        TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  prompt_version  TEXT    NOT NULL,
  taste_hash      TEXT    NOT NULL,
  candidate_count INTEGER NOT NULL,
  kept_count      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  remote_id      INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  year           INTEGER,
  origin         TEXT    NOT NULL,
  rating         REAL,
  votes          INTEGER,
  poster_url     TEXT,
  overview       TEXT,
  verdict        TEXT    NOT NULL CHECK (verdict IN ('keep','drop')),
  reason         TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  prompt_version TEXT    NOT NULL,
  taste_hash     TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  outcome        TEXT    CHECK (outcome IN ('approved','rejected','force-added','expired')),
  outcome_at     TEXT
);

CREATE TABLE IF NOT EXISTS suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES agent_decisions(id) ON DELETE CASCADE,
  remote_id   INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  year        INTEGER,
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL UNIQUE,
  posted_at   TEXT    NOT NULL,
  state       TEXT    NOT NULL CHECK (state IN ('pending','approved','rejected','failed','expired')),
  resolved_at TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_title   ON agent_decisions(remote_id);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON agent_decisions(outcome);
CREATE INDEX IF NOT EXISTS idx_decisions_run     ON agent_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_state ON suggestions(state);
CREATE INDEX IF NOT EXISTS idx_suggestions_title ON suggestions(remote_id);
`;

export const up: MigrationStep = (db) => {
  db.exec(BASELINE);
};

/** Dropping a table takes its indexes with it. */
export const down: MigrationStep = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS suggestions;
    DROP TABLE IF EXISTS agent_decisions;
    DROP TABLE IF EXISTS runs;
  `);
};
