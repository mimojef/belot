PRAGMA foreign_keys = ON;

ALTER TABLE profiles
  ADD COLUMN average_rating REAL NOT NULL DEFAULT 0 CHECK (
    average_rating >= 0
    AND average_rating <= 6
  );

ALTER TABLE profiles
  ADD COLUMN total_ratings_count INTEGER NOT NULL DEFAULT 0 CHECK (
    total_ratings_count >= 0
  );

CREATE TABLE IF NOT EXISTS profile_progress (
  profile_id TEXT PRIMARY KEY,
  completed_games_count INTEGER NOT NULL DEFAULT 0 CHECK (
    completed_games_count >= 0
  ),
  won_games_count INTEGER NOT NULL DEFAULT 0 CHECK (
    won_games_count >= 0
  ),
  rank_level INTEGER NOT NULL DEFAULT 1 CHECK (
    rank_level >= 1
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_match_results (
  room_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  team TEXT NOT NULL CHECK (
    team IN ('A', 'B')
  ),
  did_win INTEGER NOT NULL CHECK (
    did_win IN (0, 1)
  ),
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_match_results_profile_id
  ON profile_match_results(profile_id, completed_at);

CREATE TABLE IF NOT EXISTS profile_partner_ratings (
  rating_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rated_profile_id TEXT NOT NULL,
  rated_by_profile_id TEXT NOT NULL,
  rating_value INTEGER NOT NULL CHECK (
    rating_value BETWEEN 1 AND 6
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rated_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (rated_by_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (room_id, rated_by_profile_id, rated_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_partner_ratings_rated_profile_id
  ON profile_partner_ratings(rated_profile_id, created_at);

