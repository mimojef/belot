-- MANUAL_TRANSACTION_MIGRATION
-- Разширява accounts.role до 'player' | 'chat_admin' | 'subadmin' | 'admin'.
--
-- Идентична причина/процедура като 20260727_002_extend_accounts_role_subadmin.sql
-- (виж коментара там за пълния rationale) — SQLite няма ALTER TABLE за CHECK
-- constraint, а accounts е PARENT на account_sessions/password_reset_tokens
-- (ON DELETE CASCADE), затова table rebuild с foreign_keys temporarily OFF,
-- управлявана от собствена MANUAL_TRANSACTION (виж ensureServerDatabaseReady.ts).

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
    role IN ('player', 'chat_admin', 'subadmin', 'admin')
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

-- Defensive: виж идентичния коментар в 20260727_002 — self-contained и за
-- runner-а, и за ad-hoc test скриптове, които прилагат файловете директно.
CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260729_002_extend_accounts_role_chat_admin.sql');

COMMIT;

PRAGMA foreign_keys = ON;
