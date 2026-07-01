PRAGMA foreign_keys = ON;

-- Еднократни reset token-и за смяна на забравена парола.
-- token_hash е SHA-256 hex на raw token — raw token никога не се записва.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_id   TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used_at    TEXT NULL,
  revoked_at TEXT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

-- Lookup по активен token (WHERE клаузата е partial index — само неизползвани/необезсилени).
CREATE INDEX IF NOT EXISTS idx_prt_token_hash_active
  ON password_reset_tokens(token_hash)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- За обезсилване на стари token-и при нов request и за opportunistic cleanup.
CREATE INDEX IF NOT EXISTS idx_prt_account_expires
  ON password_reset_tokens(account_id, expires_at);

-- Rate-limit events за forgot-password endpoint.
-- subject_hash = SHA-256 на domain-separated стойност (scope + raw subject).
-- Raw IP, raw email и raw token никога не се записват в тази таблица.
CREATE TABLE IF NOT EXISTS password_reset_rate_limit_events (
  event_id   TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- За COUNT в прозорец по scope + subject.
CREATE INDEX IF NOT EXISTS idx_prrle_scope_subject_created
  ON password_reset_rate_limit_events(scope, subject_hash, created_at);
