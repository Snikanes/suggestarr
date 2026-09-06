import type { Database } from 'better-sqlite3';

/**
 * A migration step.
 *
 * Deliberately synchronous: better-sqlite3 is, the rest of the store is,
 * and keeping the steps sync means each one can be wrapped in a real
 * `db.transaction()`. Umzug's async surface stops at `migrator.ts`.
 */
export type MigrationStep = (db: Database) => void;

/** A migration module: how to apply it, and how to take it back out. */
export interface Migration {
  up: MigrationStep;
  down: MigrationStep;
}

/** What Umzug hands every migration and the storage adapter. */
export interface MigrationContext {
  db: Database;
}
