PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  profile_id TEXT PRIMARY KEY,
  account_id TEXT NULL,
  profile_kind TEXT NOT NULL DEFAULT 'human' CHECK (
    profile_kind IN ('human', 'bot')
  ),
  username TEXT NULL,
  normalized_username TEXT NULL,
  display_name TEXT NOT NULL CHECK (
    trim(display_name) <> ''
  ),
  normalized_display_name TEXT NOT NULL CHECK (
    trim(normalized_display_name) <> ''
  ),
  avatar_url TEXT NULL,
  level INTEGER NOT NULL DEFAULT 1 CHECK (
    level >= 1
  ),
  rank_title TEXT NULL,
  skill_rating INTEGER NOT NULL DEFAULT 1000 CHECK (
    skill_rating >= 0
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_normalized_display_name_unique
  ON profiles(normalized_display_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_normalized_username_unique
  ON profiles(normalized_username)
  WHERE normalized_username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_profile_kind_status
  ON profiles(profile_kind, status);

CREATE TABLE IF NOT EXISTS profile_wallets (
  profile_id TEXT PRIMARY KEY,
  yellow_coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (
    yellow_coins_balance >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_wallets_yellow_coins_balance
  ON profile_wallets(yellow_coins_balance);

CREATE TABLE IF NOT EXISTS bot_metadata (
  profile_id TEXT PRIMARY KEY,
  bot_code TEXT NOT NULL UNIQUE,
  difficulty TEXT NOT NULL DEFAULT 'normal' CHECK (
    difficulty IN ('easy', 'normal', 'hard')
  ),
  behavior_preset TEXT NOT NULL DEFAULT 'balanced' CHECK (
    behavior_preset IN ('balanced', 'aggressive', 'conservative', 'supportive')
  ),
  logic_source TEXT NOT NULL DEFAULT 'existing-core-v1',
  selection_weight INTEGER NOT NULL DEFAULT 1 CHECK (
    selection_weight > 0
  ),
  auto_refill_threshold INTEGER NOT NULL CHECK (
    auto_refill_threshold >= 0
  ),
  auto_refill_target_balance INTEGER NOT NULL CHECK (
    auto_refill_target_balance >= auto_refill_threshold
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_metadata_logic_source
  ON bot_metadata(logic_source);

CREATE INDEX IF NOT EXISTS idx_bot_metadata_selection_weight
  ON bot_metadata(selection_weight);

CREATE INDEX IF NOT EXISTS idx_bot_metadata_difficulty_behavior
  ON bot_metadata(difficulty, behavior_preset);

CREATE TABLE IF NOT EXISTS bot_allowed_stakes (
  profile_id TEXT NOT NULL,
  stake_amount INTEGER NOT NULL CHECK (
    stake_amount > 0
  ),
  PRIMARY KEY (profile_id, stake_amount),
  FOREIGN KEY (profile_id) REFERENCES bot_metadata(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_allowed_stakes_stake_amount
  ON bot_allowed_stakes(stake_amount, profile_id);
