PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS player_mission_progress (
  progress_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES mission_templates(mission_id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  progress_count INTEGER NOT NULL DEFAULT 0,
  is_claimed INTEGER NOT NULL DEFAULT 0 CHECK (is_claimed IN (0, 1)),
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profile_id, mission_id, date)
);

CREATE INDEX IF NOT EXISTS idx_player_mission_progress_profile_date
  ON player_mission_progress(profile_id, date);

CREATE INDEX IF NOT EXISTS idx_player_mission_progress_mission_date
  ON player_mission_progress(mission_id, date);
