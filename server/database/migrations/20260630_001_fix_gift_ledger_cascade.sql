-- Table rebuild: friendship_id NULL + ON DELETE SET NULL
-- Запазва историята при премахване на приятелство.
-- Migration runner обвива в BEGIN/COMMIT — тук няма транзакция.

CREATE TABLE yellow_coin_gift_ledger_new (
  gift_id TEXT PRIMARY KEY,
  friendship_id TEXT NULL,
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
  FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE SET NULL,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

INSERT INTO yellow_coin_gift_ledger_new (
  gift_id,
  friendship_id,
  sender_profile_id,
  recipient_profile_id,
  amount,
  sender_balance_after,
  recipient_balance_after,
  created_at
)
SELECT
  gift_id,
  friendship_id,
  sender_profile_id,
  recipient_profile_id,
  amount,
  sender_balance_after,
  recipient_balance_after,
  created_at
FROM yellow_coin_gift_ledger;

DROP TABLE yellow_coin_gift_ledger;

ALTER TABLE yellow_coin_gift_ledger_new RENAME TO yellow_coin_gift_ledger;

CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_sender
  ON yellow_coin_gift_ledger(sender_profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_recipient
  ON yellow_coin_gift_ledger(recipient_profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_friendship
  ON yellow_coin_gift_ledger(friendship_id, created_at);
