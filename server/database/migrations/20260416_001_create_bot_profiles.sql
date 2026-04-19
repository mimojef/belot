PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_profiles (
  profile_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  logic_source TEXT NOT NULL DEFAULT 'existing-core-v1',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  selection_weight INTEGER NOT NULL DEFAULT 1 CHECK (selection_weight > 0),

  username TEXT NOT NULL UNIQUE CHECK (
    username <> ''
    AND username NOT GLOB '*[^a-z0-9]*'
  ),
  display_name TEXT NOT NULL CHECK (
    display_name <> ''
    AND display_name NOT GLOB '*[^a-z0-9]*'
  ),
  avatar_url TEXT,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  rank_title TEXT NOT NULL,
  skill_rating INTEGER NOT NULL DEFAULT 1000 CHECK (skill_rating >= 0),

  average_rating REAL NOT NULL DEFAULT 0 CHECK (average_rating >= 0 AND average_rating <= 5),
  total_ratings_count INTEGER NOT NULL DEFAULT 0 CHECK (total_ratings_count >= 0),
  yellow_coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (yellow_coins_balance >= 0),

  bio_text TEXT,
  is_temporary_identity INTEGER NOT NULL DEFAULT 0 CHECK (is_temporary_identity IN (0, 1)),

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_profile_allowed_stakes (
  profile_id TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (profile_id, stake),
  FOREIGN KEY (profile_id) REFERENCES bot_profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_profile_gallery_images (
  image_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (profile_id) REFERENCES bot_profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (profile_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_bot_profiles_status
  ON bot_profiles(status);

CREATE INDEX IF NOT EXISTS idx_bot_profiles_status_selection_weight
  ON bot_profiles(status, selection_weight);

CREATE INDEX IF NOT EXISTS idx_bot_profile_allowed_stakes_stake
  ON bot_profile_allowed_stakes(stake);

CREATE INDEX IF NOT EXISTS idx_bot_profile_gallery_images_profile_id
  ON bot_profile_gallery_images(profile_id);