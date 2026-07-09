PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS guest_trial_game_starts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL,
  room_id TEXT NOT NULL UNIQUE,
  stake_amount INTEGER NOT NULL CHECK (stake_amount > 0),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_guest_trial_game_starts_started_at
  ON guest_trial_game_starts(started_at);

CREATE INDEX IF NOT EXISTS idx_guest_trial_game_starts_guest_id
  ON guest_trial_game_starts(guest_id);

-- Discriminator за profile_match_results редове, произлезли от guest trial стаи
-- (напр. истинските ботове от guest trial маса), за да не се смесват с
-- "Игри от потребители" admin статистиката. Стойност 0 за всички съществуващи редове.
ALTER TABLE profile_match_results
  ADD COLUMN is_guest_trial INTEGER NOT NULL DEFAULT 0
  CHECK (is_guest_trial IN (0, 1));

-- Покрива admin "Игри от потребители" заявката:
--   WHERE is_guest_trial = 0 AND completed_at >= ? AND completed_at < ?
CREATE INDEX IF NOT EXISTS idx_profile_match_results_trial_completed_at
  ON profile_match_results(is_guest_trial, completed_at);
