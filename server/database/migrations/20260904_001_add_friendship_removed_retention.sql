-- MANUAL_TRANSACTION_MIGRATION
-- Добавя soft-state retention за unfriend: нов status='removed' + removed_at
-- timestamp колона. SQLite не поддържа ALTER на CHECK constraints in place,
-- затова следва установения table-rebuild pattern от 20260812_005.
--
-- Защо status='removed' вместо DELETE: normal unfriend вече не трябва да е
-- destructive (product spec — 90-дневен retention на history/attachments
-- преди hard delete). status='removed' автоматично изключва реда от:
--  - chatStore.selectAcceptedFriendshipsStatement/selectAcceptedFriendshipStatement
--    (изискват status='accepted') -> изчезва от chat list, sendMessage блокиран
--  - friendshipStore.selectFriendshipsForProfileStatement/selectFriendshipByPairStatement
--    (изключват explicit по status) -> изчезва от incoming/outgoing/friends
-- без да пипа нито един ред от chatStore.ts/index.ts extra guard логика.
--
-- removed_at NULL означава active/never-removed relationship. removed_at
-- NOT NULL е retention deadline anchor (90 дни от ТОЗИ timestamp, виж
-- friendshipStore.ts's FRIENDSHIP_RETENTION_DAYS) — reset-ва се на всеки
-- unfriend/re-friend цикъл (виж removeRelationship/sendRequest промените).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE profile_friendships_new (
  friendship_id TEXT PRIMARY KEY,
  requester_profile_id TEXT NOT NULL,
  addressee_profile_id TEXT NOT NULL,
  lower_profile_id TEXT NOT NULL,
  higher_profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'blocked', 'removed')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT NULL,
  blocker_profile_id TEXT NULL,
  requester_acceptance_read_at TEXT NULL,
  kind TEXT NOT NULL DEFAULT 'friend' CHECK (
    kind IN ('friend', 'pika_support', 'vip_dm')
  ),
  removed_at TEXT NULL,
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
  kind,
  removed_at
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
  kind,
  NULL
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

-- Bounded background retention cleanup сканира по removed_at за kind='friend'
-- редове — index-ът прави "намери expired retained relationships" евтино
-- вместо table scan.
CREATE INDEX IF NOT EXISTS idx_profile_friendships_removed_at
  ON profile_friendships(removed_at)
  WHERE status = 'removed';

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260904_001_add_friendship_removed_retention.sql');

COMMIT;

PRAGMA foreign_keys = ON;
