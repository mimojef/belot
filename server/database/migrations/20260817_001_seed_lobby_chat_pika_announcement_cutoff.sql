PRAGMA foreign_keys = ON;

-- "Публикации от Pika.bg" замени стария общ Live Chat в лобито
-- (permission-narrowing промяна, виж CLAUDE.md/задачата) — старите
-- съобщения остават в lobby_chat_messages (НЕ се трият), но вече не
-- трябва да се показват като история на новата секция.
--
-- Тази миграция сяда ЕДНАГА при първо изпълнение: улавя текущия MAX(seq)
-- от lobby_chat_messages В МОМЕНТА, В КОЙТО МИГРАЦИЯТА СЕ ИЗПЪЛНЯВА ПЪРВИ
-- ПЪТ, и го пази постоянно в admin_settings. Миграциите се прилагат точно
-- веднъж (виж server_migrations ledger в ensureServerDatabaseReady.ts) —
-- значи cutoff стойността е "запечатана" завинаги при cutover момента и
-- НЕ се преизчислява при всеки server restart (за разлика от runtime
-- MAX(seq) baseline, който би "изяждал" всяко ново официално съобщение
-- при следващ restart).
--
-- seq е INTEGER PRIMARY KEY (rowid alias, автоматично monotonically
-- increasing) — надежден persistent marker, не се нуждае от нова колона
-- или таблица. Съобщения с seq > cutoff са "новите публикации";
-- seq <= cutoff остават в базата за архив/одит, но не се изпращат към
-- клиента като история (виж lobbyChatStore.listRecentMessages).
-- LIMIT 1 е задължителен, не само семантично (един ред очакван от агрегат
-- без GROUP BY) — SQLite-овата граматика третира "ON" след "INSERT ...
-- SELECT ... FROM table" като двусмислен (join condition vs upsert clause)
-- без терминиращ clause преди ON CONFLICT; LIMIT 1 премахва двусмислието.
INSERT INTO admin_settings (setting_key, setting_value)
SELECT 'lobby_chat_pika_announcement_cutoff_seq', CAST(COALESCE(MAX(seq), 0) AS TEXT)
FROM lobby_chat_messages
LIMIT 1
ON CONFLICT(setting_key) DO NOTHING;
