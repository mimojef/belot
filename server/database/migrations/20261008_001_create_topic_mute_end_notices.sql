PRAGMA foreign_keys = ON;

-- Трайни известия за ПРИКЛЮЧВАНЕ на мют ("Заглушението изтече" /
-- "Заглушението е премахнато"). Нужна е отделна таблица, защото нито една
-- съществуваща не пази "приключването е известено и потвърдено":
--  - topic_section_mutes пази само активното наказание (ред на профил);
--    естественото изтичане никога не се персистира (computed at read time);
--  - topic_mute_evidence е история на НАЛАГАНЕТО (един ред на мют), без
--    поле за доставка/потвърждение на известие към потребителя.
-- Генерични pending-notification таблица в проекта няма — другите трайни
-- popup-и са domain-specific (ad_campaign dispatches, tournament partner
-- invites), затова и тук следваме същия модел.
--
-- end_key е уникалната идентичност на ЕДНО приключване на мют: mute_history_id
-- на evidence реда (или 'section:<profile_id>:<muted_until>' за legacy mute
-- без evidence ред). UNIQUE гарантира, че едно приключване дава точно едно
-- известие — никога и 'expired', и 'unmuted' за същия мют, и никакъв
-- дубликат при restart/повторен sweep (INSERT OR IGNORE).
--
-- status: 'pending' (за доставяне) -> 'acknowledged' (OK натиснат на което и
-- да е устройство) или 'superseded' (междувременно има нов активен мют —
-- "Вече можете да пишете" би било подвеждащо).
CREATE TABLE IF NOT EXISTS topic_mute_end_notices (
  notice_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  end_key TEXT NOT NULL UNIQUE,
  mute_history_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('expired', 'unmuted')),
  muted_until TEXT,
  ended_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'superseded')),
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Hot path: pending известия на профил при connect/доставка.
CREATE INDEX IF NOT EXISTS idx_topic_mute_end_notices_profile_status
  ON topic_mute_end_notices(profile_id, status);
