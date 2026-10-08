-- MANUAL_TRANSACTION_MIGRATION
-- marketing role permission model брифа §1: role='marketing' получава право
-- да публикува И да трие (собствени И чужди) публикации в "Публикации от
-- Pika.bg" — ИДЕНТИЧНО на pika_team, но ИЗРИЧНО САМО за тази секция. Нищо
-- друго се променя (Лафче/Теми moderator права остават непроменени — виж
-- 20261005_001_add_marketing_role.sql §"Intentionally NOT changed").
--
-- Rebuilt tables (само role CHECK constraints се променят):
--   lobby_chat_messages.sender_role                    + 'marketing'
--   lobby_chat_deletion_audit_log.actor_role_at_deletion + 'marketing'
--
-- Съществуващи редове се копират непроменени. Same FK-safe table-rebuild
-- pattern като предишните role-extension migrations (20260802_001,
-- 20260802_002, 20261005_001).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE lobby_chat_messages_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  sender_profile_id TEXT NOT NULL,
  sender_display_name TEXT NOT NULL CHECK (trim(sender_display_name) <> ''),
  sender_is_chat_admin INTEGER NOT NULL DEFAULT 0 CHECK (sender_is_chat_admin IN (0, 1)),
  sender_role TEXT NOT NULL DEFAULT 'player'
    CHECK (sender_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing', 'subadmin', 'admin')),
  body TEXT NOT NULL CHECK (
    trim(body) <> ''
    AND length(body) <= 1200
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT NULL,
  deleted_by_profile_id TEXT NULL,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO lobby_chat_messages_new (
  seq, message_id, sender_profile_id, sender_display_name, sender_is_chat_admin,
  sender_role, body, created_at, deleted_at, deleted_by_profile_id
)
SELECT
  seq, message_id, sender_profile_id, sender_display_name, sender_is_chat_admin,
  sender_role, body, created_at, deleted_at, deleted_by_profile_id
FROM lobby_chat_messages;

DROP TABLE lobby_chat_messages;

ALTER TABLE lobby_chat_messages_new RENAME TO lobby_chat_messages;

CREATE INDEX IF NOT EXISTS idx_lobby_chat_messages_created_at
  ON lobby_chat_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_lobby_chat_messages_deleted_at
  ON lobby_chat_messages(deleted_at);

CREATE TABLE lobby_chat_deletion_audit_log_new (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  message_id TEXT NOT NULL,
  sender_profile_id TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_role_at_deletion TEXT NOT NULL DEFAULT 'admin'
    CHECK (actor_role_at_deletion IN ('admin', 'subadmin', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing')),
  FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO lobby_chat_deletion_audit_log_new (
  log_id, actor_account_id, message_id, sender_profile_id, created_at, actor_role_at_deletion
)
SELECT
  log_id, actor_account_id, message_id, sender_profile_id, created_at, actor_role_at_deletion
FROM lobby_chat_deletion_audit_log;

DROP TABLE lobby_chat_deletion_audit_log;

ALTER TABLE lobby_chat_deletion_audit_log_new RENAME TO lobby_chat_deletion_audit_log;

CREATE INDEX IF NOT EXISTS idx_lobby_chat_deletion_audit_log_message
  ON lobby_chat_deletion_audit_log(message_id);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261007_002_add_marketing_to_lobby_chat.sql');

COMMIT;

PRAGMA foreign_keys = ON;
