PRAGMA foreign_keys = ON;

-- Виж task-а "Ludo -> level/rank progression" — минимален, generic idempotency
-- ledger за "тоя profile вече получи +1 completed_games_count за тоя match/
-- room/scope". Belot вече има profile_match_results (room_id+profile_id
-- PRIMARY KEY), но тя изисква Belot-only колони (team CHECK IN ('A','B'),
-- did_win, is_guest_trial) — Ludo (особено 4-playerCount free-for-all) няма
-- team концепция, и подаването на фалшив team би било невярна данна. Затова
-- отделна, напълно generic таблица тук, БЕЗ Belot/Ludo-specific колони —
-- Belot продължава да ползва profile_match_results непроменено (без broad
-- refactor), Ludo пише единствено тук.
--
-- scope_id е caller-defined uniqueness scope (за Ludo: matchId) — НЕ FK към
-- никоя конкретна game-specific таблица, за да остане helper-ът истински
-- game-agnostic (виж playerProgressStore.ts::recordCompletedGameForProfile).
-- source е свободен текст (НЕ CHECK enum, за разлика от
-- ludo_match_economy_ledger.entry_type) — умишлено, за да не изисква нова
-- migration при бъдещ трети source (напр. турнирен режим извън текущия Belot
-- path) — application-level convention вместо schema-level whitelist.
--
-- Идемпотентност: PRIMARY KEY (scope_id, profile_id) — INSERT ... ON
-- CONFLICT DO NOTHING в playerProgressStore.ts гарантира максимум едно +1 на
-- profile за даден scope_id, дори при theoretично повторно извикване на hook-а.
CREATE TABLE IF NOT EXISTS profile_completed_game_ledger (
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_id, profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_completed_game_ledger_profile
  ON profile_completed_game_ledger(profile_id, recorded_at);
