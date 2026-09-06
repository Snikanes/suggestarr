import type { Database } from 'better-sqlite3';
import { Umzug, type RunnableMigration } from 'umzug';
import { MIGRATIONS, type NamedMigration } from './migrations/index.js';
import { SqliteStorage } from './migrations/storage.js';
import type { MigrationContext, MigrationStep } from './migrations/types.js';

/** What `migrate()` will say it did. */
export interface MigrationLogger {
  info: (o: Record<string, unknown>) => void;
  warn: (o: Record<string, unknown>) => void;
  error: (o: Record<string, unknown>) => void;
  debug: (o: Record<string, unknown>) => void;
}

export type Migrator = Umzug<MigrationContext>;

/**
 * The Umzug instance for one open database.
 *
 * Each step runs inside a real transaction, so a migration that fails
 * half way leaves the schema exactly as it was. Umzug writes the ledger
 * row after the step commits, which leaves a hair-thin window where a
 * process killed between the two would re-run the step on restart —
 * every migration therefore has to be safe to apply twice.
 */
export function createMigrator(db: Database, logger?: MigrationLogger): Migrator {
  return new Umzug<MigrationContext>({
    migrations: MIGRATIONS.map(transactional),
    context: { db },
    storage: new SqliteStorage(),
    logger: logger && relabel(logger),
  });
}

/** Bring a database up to the newest migration. */
export async function migrate(db: Database, logger?: MigrationLogger): Promise<string[]> {
  const applied = await createMigrator(db, logger).up();
  return applied.map((m) => m.name);
}

/**
 * Umzug logs the migration under `name`, which is also what pino calls
 * the logger itself — so unrelabelled, every migration line claims the
 * process is called `001-baseline`.
 */
export function relabel(logger: MigrationLogger): MigrationLogger {
  // Called through the logger, not lifted off it: pino's methods need
  // their receiver.
  const payload = ({ name, ...rest }: Record<string, unknown>): Record<string, unknown> =>
    name === undefined ? rest : { ...rest, migration: name };

  return {
    info: (o) => logger.info(payload(o)),
    warn: (o) => logger.warn(payload(o)),
    error: (o) => logger.error(payload(o)),
    debug: (o) => logger.debug(payload(o)),
  };
}

/**
 * Wrap a migration so its whole body commits or none of it does. Exported
 * because that guarantee is the reason this file exists, and it deserves
 * a test of its own.
 */
export function transactional(migration: NamedMigration): RunnableMigration<MigrationContext> {
  const inTransaction =
    (step: MigrationStep) =>
    async ({ context }: { context: MigrationContext }): Promise<void> => {
      context.db.transaction(step)(context.db);
    };

  return {
    name: migration.name,
    up: inTransaction(migration.up),
    down: inTransaction(migration.down),
  };
}
