import type { MigrationStep } from './types.js';

/**
 * Record which Radarr quality profile an approval actually landed at.
 *
 * Nullable, and null on every row that already exists: a suggestion
 * approved before the picker existed went to whatever the configured
 * default was at the time, which is not something this can reconstruct.
 * Pending suggestions have no profile yet either.
 */
export const up: MigrationStep = (db) => {
  db.exec(`
    ALTER TABLE suggestions ADD COLUMN quality_profile_id   INTEGER;
    ALTER TABLE suggestions ADD COLUMN quality_profile_name TEXT;
  `);
};

export const down: MigrationStep = (db) => {
  db.exec(`
    ALTER TABLE suggestions DROP COLUMN quality_profile_name;
    ALTER TABLE suggestions DROP COLUMN quality_profile_id;
  `);
};
