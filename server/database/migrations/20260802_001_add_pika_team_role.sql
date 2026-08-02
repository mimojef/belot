-- MANUAL_TRANSACTION_MIGRATION
-- Adds the account role 'pika_team' for official Pika.bg team profiles.
-- Existing roles are copied unchanged. The accounts rebuild follows the same
-- FK-safe pattern as the earlier role-extension migrations.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE accounts_new (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (
    trim(email) <> ''
  ),
  password_hash TEXT NOT NULL CHECK (
    trim(password_hash) <> ''
  ),
  role TEXT NOT NULL DEFAULT 'player' CHECK (
    role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT NULL
);

INSERT INTO accounts_new (
  account_id,
  email,
  password_hash,
  role,
  status,
  created_at,
  updated_at,
  last_login_at
)
SELECT
  account_id,
  email,
  password_hash,
  role,
  status,
  created_at,
  updated_at,
  last_login_at
FROM accounts;

DROP TABLE accounts;

ALTER TABLE accounts_new RENAME TO accounts;

CREATE INDEX IF NOT EXISTS idx_accounts_role_status
  ON accounts(role, status);

CREATE TABLE admin_role_audit_log_new (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  target_account_id TEXT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'grant_subadmin',
      'revoke_subadmin',
      'grant_chat_admin',
      'revoke_chat_admin',
      'grant_pika_team',
      'revoke_pika_team'
    )
  ),
  previous_role TEXT NOT NULL CHECK (
    previous_role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')
  ),
  new_role TEXT NOT NULL CHECK (
    new_role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (target_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
);

INSERT INTO admin_role_audit_log_new (
  log_id, actor_account_id, target_account_id, action, previous_role, new_role, created_at
)
SELECT
  log_id, actor_account_id, target_account_id, action, previous_role, new_role, created_at
FROM admin_role_audit_log;

DROP TABLE admin_role_audit_log;

ALTER TABLE admin_role_audit_log_new RENAME TO admin_role_audit_log;

CREATE INDEX IF NOT EXISTS idx_admin_role_audit_log_target
  ON admin_role_audit_log(target_account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_role_audit_log_actor
  ON admin_role_audit_log(actor_account_id, created_at);

ALTER TABLE lobby_chat_messages
  ADD COLUMN sender_role TEXT NOT NULL DEFAULT 'player'
  CHECK (sender_role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin'));

UPDATE lobby_chat_messages
SET sender_role = 'chat_admin'
WHERE sender_is_chat_admin = 1;

CREATE TABLE lobby_chat_deletion_audit_log_new (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  message_id TEXT NOT NULL,
  sender_profile_id TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_role_at_deletion TEXT NOT NULL DEFAULT 'admin'
    CHECK (actor_role_at_deletion IN ('admin', 'subadmin', 'chat_admin', 'pika_team')),
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
  VALUES ('20260802_001_add_pika_team_role.sql');

COMMIT;

PRAGMA foreign_keys = ON;
