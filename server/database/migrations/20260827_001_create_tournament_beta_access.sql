PRAGMA foreign_keys = ON;

-- Server-authoritative beta password gate за секция "Турнири" (§ TOURNAMENT
-- BETA GATE task spec). Singleton config row (row_id='singleton') следва
-- established admin_settings single-row pattern — enabled/password_hash/
-- password_version, без in-memory cache (всеки request чете директно от
-- тук, виж tournamentBetaAccessStore.ts), за да важат CLI промени веднага,
-- без restart.
CREATE TABLE IF NOT EXISTS tournament_beta_access_config (
  row_id TEXT PRIMARY KEY CHECK (row_id = 'singleton'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  password_hash TEXT NULL,
  password_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Disabled/no-password default — deploy сам по себе си НЕ заключва секцията
-- (виж task spec DEFAULT MIGRATION STATE). Production паролата се задава
-- отделно, интерактивно, чрез `npm run tournament:beta-password` след deploy.
INSERT INTO tournament_beta_access_config (row_id, enabled, password_hash, password_version)
VALUES ('singleton', 0, NULL, 1)
ON CONFLICT(row_id) DO NOTHING;

-- Per-profile grant — валиден само докато grant.password_version съвпада с
-- текущия tournament_beta_access_config.password_version (виж hasValidGrant
-- в tournamentBetaAccessStore.ts). Смяна на паролата инкрементира version-а
-- в config-а без да пипа тук — старите редове остават (не се delete-ват),
-- но автоматично спират да важат чрез version mismatch проверката.
CREATE TABLE IF NOT EXISTS tournament_beta_access_grants (
  profile_id TEXT PRIMARY KEY,
  password_version INTEGER NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tournament_beta_access_grants_version
  ON tournament_beta_access_grants(password_version);
