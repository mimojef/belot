PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (
    trim(email) <> ''
  ),
  password_hash TEXT NOT NULL CHECK (
    trim(password_hash) <> ''
  ),
  role TEXT NOT NULL DEFAULT 'player' CHECK (
    role IN ('player', 'admin')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_role_status
  ON accounts(role, status);

CREATE TABLE IF NOT EXISTS account_sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_account_id
  ON account_sessions(account_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_account_sessions_profile_id
  ON account_sessions(profile_id, expires_at);

