import * as baseline from './001-baseline.js';
import * as qualityProfile from './002-quality-profile.js';
import type { Migration } from './types.js';

/** A migration and the name it is recorded under. */
export interface NamedMigration extends Migration {
  name: string;
}

/**
 * Every migration, oldest first.
 *
 * Listed explicitly rather than globbed off disk. Umzug's `glob` option
 * would have to match `.ts` under `tsx` and `.js` under the compiled
 * `dist/` the container actually runs, and a glob that silently matches
 * nothing looks exactly like a database that is already up to date.
 * A static import list cannot drift from what shipped.
 */
export const MIGRATIONS: NamedMigration[] = [
  { name: '001-baseline', ...baseline },
  { name: '002-quality-profile', ...qualityProfile },
];
