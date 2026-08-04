-- MANUAL_TRANSACTION_MIGRATION
-- Добавя profile_friendships.kind ('friend' | 'pika_support') за официалния
-- служебен Pika.bg чат — table rebuild (не ALTER TABLE ADD COLUMN), защото
-- оригиналната table-level UNIQUE (lower_profile_id, higher_profile_id) би
-- блокирала ВСЕКИ втори ред за същата двойка, независимо от kind (напр.
-- PIKABG вече приятел с recipient → опит да се INSERT-не отделен
-- pika_support ред би се провалил с constraint violation). Заменяме единния
-- table-level UNIQUE с ДВА отделни partial unique indexes — по един за
-- всеки kind — за да може за една и съща (lower,higher) двойка да
-- съществуват едновременно най-много 1 kind='friend' И най-много 1
-- kind='pika_support' ред, без да се засяга досегашното "макс 1 приятелство
-- на двойка" правило.
--
-- profile_friendships е PARENT на friend_chat_messages/chat_conversation_reads
-- (ON DELETE CASCADE), затова foreign_keys е временно OFF по време на
-- rebuild-а — идентичен pattern като 20260729_002_extend_accounts_role_chat_admin.sql
-- (виж коментара там за пълния rationale).

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
    kind IN ('friend', 'pika_support')
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
  'friend'
FROM profile_friendships;

DROP TABLE profile_friendships;

ALTER TABLE profile_friendships_new RENAME TO profile_friendships;

-- Заменя старата безусловна UNIQUE (lower_profile_id, higher_profile_id) —
-- по един partial unique index на kind, вместо един table-level constraint,
-- пазещ уникалност независимо от kind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_friendships_friend_pair
  ON profile_friendships(lower_profile_id, higher_profile_id)
  WHERE kind = 'friend';

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_friendships_pika_support_pair
  ON profile_friendships(lower_profile_id, higher_profile_id)
  WHERE kind = 'pika_support';

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

-- Defensive: self-contained и за runner-а, и за ad-hoc test скриптове, които
-- прилагат файловете директно (виж идентичния коментар в 20260729_002).
CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260804_002_add_pika_support_conversation_kind.sql');

COMMIT;

PRAGMA foreign_keys = ON;
