PRAGMA foreign_keys = ON;

-- Persistent history за Ludo игри (playing -> finished), захранва
-- "Играещи"/"Приключили" lobby табовете на /games/ludo. Mirror на
-- private_room_matches (20260820_001_create_private_room_matches.sql) —
-- виж коментара там за пълния rationale защо е отделна таблица от
-- runtime crash-recovery кеша. За Ludo този кеш е active_ludo_match_snapshots
-- (20260919_002_create_active_ludo_match_snapshots.sql) — той се DELETE-ва
-- веднага след settle (load-bearing за anti-double-payout invariant, виж
-- ludoMatchRuntime.ts/index.ts коментарите), затова НЕ може да служи и за
-- history. Тази таблица е чисто additive read-model: пише се СЛЕД match
-- start / СЛЕД settle, никога не участва в economy/settlement пътя.
-- Никога не трие редове — "Приключили" visibility прозорецът е WHERE filter
-- (finished_at >= now - Nh) на read пътя, не retention/cleanup job (виж
-- listFinishedMatches в ludoRoomMatchStore.ts).
CREATE TABLE IF NOT EXISTS ludo_room_matches (
  match_id TEXT PRIMARY KEY,
  ludo_room_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('playing', 'finished')
  ),
  stake INTEGER NOT NULL CHECK (stake >= 0),
  player_count INTEGER NOT NULL CHECK (player_count IN (2, 4)),
  -- JSON масив от LudoRoomMatchOccupant записи (profileId/displayName/
  -- avatarUrl/color), по един за всеки участник в реда, в който match-ът е
  -- стартирал. Individual game — няма team A/B разделение (за разлика от
  -- private_room_matches).
  players_json TEXT NOT NULL CHECK (json_valid(players_json)),
  winner_profile_id TEXT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_ludo_room_matches_status
  ON ludo_room_matches(status);

CREATE INDEX IF NOT EXISTS idx_ludo_room_matches_finished_at
  ON ludo_room_matches(finished_at);
