PRAGMA foreign_keys = ON;

-- The old partial UNIQUE index treated every confirmed/finalist entry as
-- globally active, even when its tournament was already finished/cancelled.
-- SQLite partial indexes cannot reference tournaments.status, so the
-- lifecycle-aware invariant is enforced by tournamentEconomyStore under
-- BEGIN IMMEDIATE. Keep a non-unique profile/status helper index for lookups.
DROP INDEX IF EXISTS idx_tournament_entries_one_active_per_profile;

CREATE INDEX IF NOT EXISTS idx_tournament_entries_profile_active_status
  ON tournament_entries(profile_id, status)
  WHERE status IN ('confirmed', 'finalist');
