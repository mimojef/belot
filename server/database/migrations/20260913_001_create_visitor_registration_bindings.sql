PRAGMA foreign_keys = ON;

-- Registration anti-evasion: DB-level "ONE DEVICE -> ONE PERMANENT ACCOUNT"
-- invariant (production security fix follow-up брифа §3). Отделна, малка,
-- canonical таблица — умишлено НЕ site_visitors/site_visit_events
-- (analytics таблици, поддържащи МНОЖЕСТВО profile_id стойности на един
-- anonymous_visitor_id по дизайн, напр. споделен компютър преди този fix —
-- UNIQUE(anonymous_visitor_id) там би счупил тяхното established
-- предназначение, виж checkRegistrationModerationRestriction/
-- findProfileIdsForVisitorId в siteVisitStore.ts, които продължават да ги
-- ползват непроменени за historical/legacy associations).
--
-- PRIMARY KEY(anonymous_visitor_id) Е самата гаранция: authStore.ts's
-- register() прави обикновен INSERT (НЕ "OR IGNORE") тук, ВЪТРЕ в СЪЩАТА
-- account/profile/wallet/progress транзакция. PK conflict хвърля грешка,
-- register()'s catch я разпознава explicit и rollback-ва ЦЯЛАТА
-- регистрация с REGISTRATION_RESTRICTED — атомарно, DB-enforced, независимо
-- от process topology (единичен PM2 fork процес днес, но невалидно да се
-- разчита само на "single process + synchronous event loop" занапред, ако
-- архитектурата се промени към cluster/multiple instances/async DB driver).
--
-- ON DELETE CASCADE на profile_id — hard-delete на профил (admin moderation)
-- освобождава device slot-а на визитора, симетрично на как email/username
-- вече се освобождават при hard delete (profileHardDeleteService.ts) — не
-- искаме "мъртъв" binding ред, вечно заключващ device за изтрит профил.
CREATE TABLE IF NOT EXISTS visitor_registration_bindings (
  anonymous_visitor_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reverse lookup index — прави ON DELETE CASCADE (profiles -> тук) индексиран
-- lookup вместо table scan на всеки profile hard-delete; таблицата и без това
-- е bounded (най-много 1 ред на регистриран акаунт), но индексът е евтин и
-- консистентен с established convention-а за FK колони в проекта.
CREATE INDEX IF NOT EXISTS idx_visitor_registration_bindings_profile_id
  ON visitor_registration_bindings(profile_id);
