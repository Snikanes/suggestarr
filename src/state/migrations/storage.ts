import type { Database } from 'better-sqlite3';
import type { MigrationParams, UmzugStorage } from 'umzug';
import type { MigrationContext } from './types.js';

/**
 * Umzug ships storage adapters for JSON files, Sequelize and MongoDB —
 * none of which apply here. This keeps the ledger in the same SQLite file
 * as the data it describes, so a database and its migration history can
 * never be separated by a stray volume mount.
 */
const LEDGER = `
CREATE TABLE IF NOT EXISTS migrations (
  name        TEXT PRIMARY KEY,
  executed_at TEXT NOT NULL
);
`;

export class SqliteStorage implements UmzugStorage<MigrationContext> {
  async logMigration({ name, context }: MigrationParams<MigrationContext>): Promise<void> {
    ledger(context.db)
      .prepare(`INSERT OR REPLACE INTO migrations (name, executed_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());
  }

  async unlogMigration({ name, context }: MigrationParams<MigrationContext>): Promise<void> {
    ledger(context.db).prepare(`DELETE FROM migrations WHERE name = ?`).run(name);
  }

  async executed({ context }: Pick<MigrationParams<MigrationContext>, 'context'>): Promise<string[]> {
    const rows = ledger(context.db)
      .prepare(`SELECT name FROM migrations ORDER BY name`)
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }
}

/** The ledger table has to exist before the first read, not the first write. */
function ledger(db: Database): Database {
  db.exec(LEDGER);
  return db;
}
