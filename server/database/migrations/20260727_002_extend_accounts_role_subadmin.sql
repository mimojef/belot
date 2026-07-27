-- MANUAL_TRANSACTION_MIGRATION
-- Разширява accounts.role до 'player' | 'subadmin' | 'admin'.
--
-- SQLite няма ALTER TABLE за промяна на CHECK constraint — единственият
-- начин е table rebuild (CREATE нова таблица → INSERT SELECT → DROP старата
-- → RENAME). accounts обаче е PARENT на account_sessions и
-- password_reset_tokens (двете с ON DELETE CASCADE). Ако DROP TABLE
-- accounts се изпълни с foreign_keys=ON, SQLite прави implicit
-- "DELETE FROM accounts" преди дропа и ИЗПЪЛНЯВА cascade actions — това би
-- изтрило БЕЗВЪЗВРАТНО всички активни сесии и password reset token-и.
--
-- Затова тази миграция управлява собствената си транзакция и temporарно
-- изключва foreign_keys ИЗВЪН BEGIN/COMMIT (SQLite отказва да промени
-- PRAGMA foreign_keys вътре в отворена транзакция) — точната процедура,
-- официално препоръчана от SQLite за table rebuild с входящи FK
-- references. Runner-ът (ensureServerDatabaseReady.ts) разпознава маркера
-- по-горе и изпълнява целия файл с един exec(), без свой BEGIN/COMMIT wrap.
--
-- PRAGMA foreign_key_check се изпълнява отделно (извън тази миграция) от
-- deploy/check процедурата, защото PRAGMA резултатите не могат да се
-- verify-нат вътре в чист .exec() SQL script.

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
    role IN ('player', 'subadmin', 'admin')
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

-- Defensive: ensureServerDatabaseReady.ts винаги създава server_migrations
-- ПРЕДИ да изпълни каквато и да е миграция, но някои ad-hoc test скриптове в
-- server/scripts/ прилагат migration файловете директно (без runner-а) и не
-- я създават сами — IF NOT EXISTS прави тази миграция self-contained и в двата случая.
CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260727_002_extend_accounts_role_subadmin.sql');

COMMIT;

PRAGMA foreign_keys = ON;
