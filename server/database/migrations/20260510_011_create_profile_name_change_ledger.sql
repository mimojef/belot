PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profile_name_change_ledger (
  change_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  old_display_name TEXT NOT NULL,
  new_display_name TEXT NOT NULL,
  price_amount INTEGER NOT NULL CHECK (
    price_amount >= 0
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_name_change_ledger_profile_id
  ON profile_name_change_ledger(profile_id, created_at);
