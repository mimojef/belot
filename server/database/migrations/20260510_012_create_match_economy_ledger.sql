PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS match_economy_ledger (
  ledger_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('stake_debit', 'stake_refund', 'winner_payout')
  ),
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (room_id, profile_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_match_economy_ledger_profile_id
  ON match_economy_ledger(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_match_economy_ledger_room_id
  ON match_economy_ledger(room_id, created_at);
