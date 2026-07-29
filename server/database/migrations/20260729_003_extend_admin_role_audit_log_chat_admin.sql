-- Разширява admin_role_audit_log за да покрива grant/revoke на chat_admin
-- роля, редом до съществуващите grant_subadmin/revoke_subadmin.
--
-- SQLite няма ALTER TABLE за промяна на CHECK constraint — table rebuild е
-- единственият начин. За разлика от accounts (20260727_002/20260729_002),
-- НИКОЯ друга таблица не референцира admin_role_audit_log (тя самата само
-- сочи КЪМ accounts с ON DELETE SET NULL) — DROP TABLE на нея не тригва
-- cascade delete върху нищо, затова тук НЕ е нужен MANUAL_TRANSACTION_MIGRATION
-- нито foreign_keys OFF; runner-ът увива този файл в собствен BEGIN/COMMIT.

CREATE TABLE admin_role_audit_log_new (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  target_account_id TEXT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('grant_subadmin', 'revoke_subadmin', 'grant_chat_admin', 'revoke_chat_admin')
  ),
  previous_role TEXT NOT NULL CHECK (
    previous_role IN ('player', 'chat_admin', 'subadmin', 'admin')
  ),
  new_role TEXT NOT NULL CHECK (
    new_role IN ('player', 'chat_admin', 'subadmin', 'admin')
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
