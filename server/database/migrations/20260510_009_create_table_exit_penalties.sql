PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS table_exit_penalties (
  penalty_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  stake_amount INTEGER NOT NULL CHECK (
    stake_amount > 0
  ),
  penalty_amount INTEGER NOT NULL CHECK (
    penalty_amount > 0
  ),
  charged_amount INTEGER NOT NULL CHECK (
    charged_amount >= 0
    AND charged_amount <= penalty_amount
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (room_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_table_exit_penalties_profile_id
  ON table_exit_penalties(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_table_exit_penalties_room_id
  ON table_exit_penalties(room_id, created_at);
