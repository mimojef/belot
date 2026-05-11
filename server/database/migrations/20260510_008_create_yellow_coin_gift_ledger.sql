PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS yellow_coin_gift_ledger (
  gift_id TEXT PRIMARY KEY,
  friendship_id TEXT NOT NULL,
  sender_profile_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  sender_balance_after INTEGER NOT NULL CHECK (
    sender_balance_after >= 0
  ),
  recipient_balance_after INTEGER NOT NULL CHECK (
    recipient_balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (sender_profile_id <> recipient_profile_id),
  FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_sender
  ON yellow_coin_gift_ledger(sender_profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_recipient
  ON yellow_coin_gift_ledger(recipient_profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_friendship
  ON yellow_coin_gift_ledger(friendship_id, created_at);
