PRAGMA foreign_keys = ON;

-- Session fast lookup (CPU hotspot fix): hashSessionToken() правеше
-- synchronous scryptSync() на Node MainThread при ВСЕКИ getSession()/
-- touchSession()/logout(). Session token-ът е randomBytes(32) (256 бита
-- ентропия) — KDF stretching не добавя сигурност за такава тайна, затова
-- lookup-ът минава на SHA-256(raw token) в тази нова колона.
--
-- Additive + backward compatible:
--   - token_hash (legacy scrypt, NOT NULL UNIQUE) остава непроменен и се
--     попълва и за нови сесии -> rollback към стар build продължава да
--     намира всички сесии.
--   - token_lookup_hash е NULL за съществуващите редове; authStore.ts
--     lazy backfill-ва при първия успешен (валиден) legacy lookup.
--   - Partial UNIQUE index — NULL редовете не участват.
ALTER TABLE account_sessions ADD COLUMN token_lookup_hash TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_sessions_token_lookup_hash
  ON account_sessions(token_lookup_hash)
  WHERE token_lookup_hash IS NOT NULL;
