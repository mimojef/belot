PRAGMA foreign_keys = ON;

-- Display Name Reservation (FINAL PLAN v5) — pending_registrations е вече
-- authoritative за email reservation (UNIQUE(normalized_email), виж
-- 20260914_001_create_pending_registrations.sql), но НЕ за display name:
-- GET /api/profile/check-name и register()'s early uniqueness check
-- преди тази задача проверяваха САМО profiles-таблицата, никога други pending
-- registrations. Резултат (доказано с real-server concurrency test): User A
-- вижда име свободно, подава регистрация, получава verification code; преди
-- A да потвърди, User B вижда СЪЩОТО име свободно и може да го claim-не; ако
-- B verify-ва пръв, A получава DISPLAY_NAME_TAKEN за име, което А е бил ПРЪВ
-- да заяви.
--
-- Тази миграция добавя normalized_display_name (nullable — виж backfill
-- policy по-долу) + UNIQUE INDEX върху нея, mirror на съществуващия
-- normalized_email pattern. Bизнес правило: успешен register() COMMIT
-- claim-ва И email-а, И display name-а АТОМАРНО, за 24 часа (или до успешен
-- verify), точно както email reservation-ът вече работи.
--
-- ВАЖНО: DDL-ът тук е ЧИСТО документационен — не се изпълнява literal. Тази
-- миграция изисква TS backfill (normalizeProfileDisplayName() върху
-- съществуващи redове, deterministic winner/loser resolution за duplicate
-- pending groups, conflict resolution срещу вече съществуващи profiles) ПРЕДИ
-- unique index-ът може безопасно да се създаде — не SQL-изразимо в статичен
-- .sql текст. Затова реалното изпълнение живее в SMART_MIGRATION_HANDLERS
-- registry-то (ensureServerDatabaseReady.ts), keyed по filename-а на този
-- файл — виж applyPendingRegistrationDisplayNameReservationMigration() там
-- за точната, атомарна 9-стъпкова последователност (add column -> delete
-- expired -> normalize backfill -> malformed->NULL -> duplicate winner/loser
-- -> profiles-conflict->NULL -> postcondition validation -> create index ->
-- ledger), обвита в ЕДНА транзакция от runner-а (BEGIN...COMMIT, ROLLBACK
-- при грешка -> safe startup failure, никога частично приложена схема).

ALTER TABLE pending_registrations
  ADD COLUMN normalized_display_name TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_registrations_display_name_unique
  ON pending_registrations(normalized_display_name);
