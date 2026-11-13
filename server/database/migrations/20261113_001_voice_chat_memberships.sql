-- Гласов чат в частните маси на Белот — Етап 2б (само добавяща миграция).
--
-- Право за говорене, обвързано с НЕПРЕКЪСНАТОТО участие (membership) на
-- конкретния играч в конкретната гласова маса. Заменя match-scoped grace
-- от Етап 2а:
--   * voice_speaking_grants (20261112_001) повече НЕ се чете и не се пише —
--     таблицата остава празна и неизползвана (приложените миграции не се
--     променят);
--   * voice_tables.match_seq остава със стойност 1 и не се използва.
--
-- Един ред = едно непрекъснато участие. Започва при сядане в чакалнята
-- (или при създаване на масата за създателя) и продължава през старта на
-- играта, повторните игри, временните disconnect-и, refresh, ротации на
-- стаята и рестарт на backend-а (ако игровата маса е възстановена).
-- Приключва (ended_at) при окончателно напускане, освобождаване на
-- мястото, изгонване, бан, разпадане на масата или изключване на гласа.
-- Ново сядане след приключено участие = НОВ ред (ново membership_id) БЕЗ
-- старото право — така напускане и повторно влизане не възстановява право.
--
-- speaking_entitled_at != NULL -> правото за говорене е придобито (играчът
-- е бил VIP при сядането или е станал VIP по време на участието, проверено
-- от backend-а) и НЕ се губи при изтичане на VIP до края на участието.
-- Това НЕ е втори VIP статус: важи само за тази маса и това участие.
--
-- Без имена, IP адреси или съдържание на разговори.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS voice_table_memberships (
  membership_id TEXT PRIMARY KEY,
  voice_table_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  speaking_entitled_at TEXT NULL,
  ended_at TEXT NULL,
  end_reason TEXT NULL,
  CHECK ((ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)),
  CHECK (end_reason IS NULL OR end_reason IN (
    'left_waiting_room',
    'kicked',
    'permanently_left',
    'banned',
    'profile_revoked',
    'superseded',
    'table_released',
    'boot_not_restored'
  )),
  FOREIGN KEY (voice_table_id) REFERENCES voice_tables(voice_table_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- Най-много едно активно участие на профил в гласова маса.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_table_memberships_one_active
  ON voice_table_memberships(voice_table_id, profile_id) WHERE ended_at IS NULL;

-- Зареждане на активните участия при старт / приключване при освобождаване.
CREATE INDEX IF NOT EXISTS idx_voice_table_memberships_active_table
  ON voice_table_memberships(voice_table_id) WHERE ended_at IS NULL;
