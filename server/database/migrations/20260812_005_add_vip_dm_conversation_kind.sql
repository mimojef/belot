-- MANUAL_TRANSACTION_MIGRATION
-- Extend profile_friendships.kind with vip_dm while preserving the existing
-- friend/pika_support data, foreign-key relationships, and partial unique
-- indexes. SQLite cannot alter CHECK constraints in place, so this follows the
-- established table-rebuild pattern from 20260804_002.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE profile_friendships_new (
  friendship_id TEXT PRIMARY KEY,
  requester_profile_id TEXT NOT NULL,
  addressee_profile_id TEXT NOT NULL,
  lower_profile_id TEXT NOT NULL,
  higher_profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'blocked')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT NULL,
  blocker_profile_id TEXT NULL,
  requester_acceptance_read_at TEXT NULL,
  kind TEXT NOT NULL DEFAULT 'friend' CHECK (
    kind IN ('friend', 'pika_support', 'vip_dm')
  ),
  CHECK (requester_profile_id <> addressee_profile_id),
  CHECK (lower_profile_id <> higher_profile_id),
  FOREIGN KEY (requester_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (addressee_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (lower_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (higher_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

INSERT INTO profile_friendships_new (
  friendship_id,
  requester_profile_id,
  addressee_profile_id,
  lower_profile_id,
  higher_profile_id,
  status,
  created_at,
  updated_at,
  responded_at,
  blocker_profile_id,
  requester_acceptance_read_at,
  kind
)
SELECT
  friendship_id,
  requester_profile_id,
  addressee_profile_id,
  lower_profile_id,
  higher_profile_id,
  status,
  created_at,
  updated_at,
  responded_at,
  blocker_profile_id,
  requester_acceptance_read_at,
  kind
FROM profile_friendships;

DROP TABLE profile_friendships;

ALTER TABLE profile_friendships_new RENAME TO profile_friendships;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_friendships_friend_pair
  ON profile_friendships(lower_profile_id, higher_profile_id)
  WHERE kind = 'friend';

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_friendships_pika_support_pair
  ON profile_friendships(lower_profile_id, higher_profile_id)
  WHERE kind = 'pika_support';

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_friendships_vip_dm_pair
  ON profile_friendships(lower_profile_id, higher_profile_id)
  WHERE kind = 'vip_dm';

CREATE INDEX IF NOT EXISTS idx_profile_friendships_requester
  ON profile_friendships(requester_profile_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_addressee
  ON profile_friendships(addressee_profile_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_status_updated
  ON profile_friendships(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_blocker
  ON profile_friendships(blocker_profile_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_profile_friendships_unread_acceptance
  ON profile_friendships(requester_profile_id, requester_acceptance_read_at)
  WHERE status = 'accepted' AND requester_acceptance_read_at IS NULL;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260812_005_add_vip_dm_conversation_kind.sql');

COMMIT;

PRAGMA foreign_keys = ON;
