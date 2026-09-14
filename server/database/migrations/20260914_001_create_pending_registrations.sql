PRAGMA foreign_keys = ON;

-- Email verification + "pending first" registration flow — нова регистрация
-- вече НЕ създава account/profile/wallet/progress веднага (виж
-- authStore.ts's register() doc коментар). Първо се създава ред тук; акаунтът
-- се материализира едва след успешно потвърждение на 6-цифрения код
-- (authStore.ts's verifyRegistrationEmail()) — виж production report-а
-- "PENDING REGISTRATION" секцията.
--
-- password_hash тук е СЪЩИЯТ scrypt формат като accounts.password_hash
-- (createPasswordHash в authHelpers.ts) — plaintext парола никога не се
-- пази, нито тук, нито другаде. code_hash е HMAC-SHA256(code, secret)
-- (hashVerificationCode в authHelpers.ts) — plaintext 6-цифрен код никога
-- не се пази.
--
-- expires_at = created_at + 24 часа, УСТАНОВЕН ЕДНОКРАТНО при INSERT-а и
-- НИКОГА не се удължава (нито при resend, нито при login опит, нито при
-- нов verification attempt) — виж resendRegistrationVerificationCode()
-- doc коментара за пълния rationale. last_code_sent_at/resend_count
-- проследяват resend throttle-а (60 секунди минимум между resend-и, плюс
-- rate-limit events таблицата по-долу за по-широк anti-spam capping).
-- failed_attempts capped-ва wrong-code опитите (виж verifyRegistrationEmail()).
--
-- UNIQUE(normalized_email) — самата DB гаранция за "email-ът е временно
-- резервиран, докато има unexpired pending registration за него":
-- createPendingRegistration() прави opportunistic DELETE на вече expired
-- редове за email-а ПРЕДИ INSERT-а (в СЪЩАТА транзакция), затова UNIQUE
-- конфликт тук означава реално ВСЕ ОЩЕ unexpired pending registration —
-- mapped към EMAIL_VERIFICATION_PENDING резултата.
CREATE TABLE IF NOT EXISTS pending_registrations (
  pending_registration_id TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  gender TEXT NULL CHECK (
    gender IS NULL OR gender IN ('male', 'female')
  ),
  visitor_id TEXT NULL,
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_code_sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resend_count INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_registrations_email_unique
  ON pending_registrations(normalized_email);

-- Opportunistic cleanup на expired редове (по всякакъв email) — bounded scan.
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires_at
  ON pending_registrations(expires_at);

-- Rate-limit events за registration verification flow-а (resend + verify
-- endpoints) — отделна таблица от password_reset_rate_limit_events (различен
-- feature/domain, но идентичен pattern: scope + HMAC subject_hash + created_at,
-- виж checkAndRecordRateLimit-style логиката в authStore.ts). Raw IP/email/
-- pendingRegistrationId никога не се записват тук, само HMAC hash-ове.
CREATE TABLE IF NOT EXISTS registration_rate_limit_events (
  event_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rrle_scope_subject_created
  ON registration_rate_limit_events(scope, subject_hash, created_at);
