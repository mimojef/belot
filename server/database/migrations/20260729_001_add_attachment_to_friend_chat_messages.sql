-- MANUAL_TRANSACTION_MIGRATION
-- Добавя поддръжка на снимки в личния (приятелски) чат.
--
-- friend_chat_messages.body в момента е NOT NULL CHECK (trim(body) <> '' ...)
-- — не позволява съобщение само със снимка (празен body). SQLite няма
-- ALTER TABLE за промяна на CHECK constraint, единственият начин е table
-- rebuild (CREATE нова таблица → INSERT SELECT → DROP старата → RENAME),
-- по същата процедура както 20260727_002_extend_accounts_role_subadmin.sql.
--
-- friend_chat_messages НЕ е FK parent на никоя друга таблица към момента на
-- писане на тази миграция (grep за "REFERENCES friend_chat_messages" в
-- migrations/ връща 0 резултата) — DROP TABLE тук не тригерва cascade
-- delete на чужди редове, така че не се налага PRAGMA foreign_keys = OFF за
-- тази конкретна причина. Все пак пазим целия скрипт под
-- MANUAL_TRANSACTION_MIGRATION + explicit BEGIN IMMEDIATE/COMMIT, защото
-- INSERT...SELECT копирането на потенциално голяма таблица трябва да е
-- атомарно spрямо самата DROP/RENAME стъпка (ако runner-ът добавеше свой
-- собствен BEGIN върху вече отворена транзакция, SQLite би грешил).
--
-- Новите таблици (friend_chat_attachments, friend_chat_attachment_deletions)
-- се създават СЛЕД rename-а, за да могат безопасно да REFERENCES
-- friend_chat_messages(message_id) — по време на самия rebuild старата
-- таблица временно не съществува под финалното си име.

BEGIN IMMEDIATE;

CREATE TABLE friend_chat_messages_new (
  message_id TEXT PRIMARY KEY,
  friendship_id TEXT NOT NULL,
  sender_profile_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (
    length(body) <= 1000
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT NULL,
  FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

INSERT INTO friend_chat_messages_new (
  message_id,
  friendship_id,
  sender_profile_id,
  body,
  created_at,
  deleted_at
)
SELECT
  message_id,
  friendship_id,
  sender_profile_id,
  body,
  created_at,
  deleted_at
FROM friend_chat_messages;

DROP TABLE friend_chat_messages;

ALTER TABLE friend_chat_messages_new RENAME TO friend_chat_messages;

CREATE INDEX IF NOT EXISTS idx_friend_chat_messages_friendship
  ON friend_chat_messages(friendship_id, created_at);

CREATE INDEX IF NOT EXISTS idx_friend_chat_messages_sender
  ON friend_chat_messages(sender_profile_id, created_at);

-- 1:1 разширение на съобщение със снимка. Отделна таблица (не колони
-- директно в friend_chat_messages), за да остане message_id непроменен PK
-- и ON DELETE CASCADE автоматично да премахва attachment реда, ако
-- съобщението изчезне (напр. бъдещ "изтрий съобщение" feature).
--
-- CHECK-ът "съобщение без text И без attachment е забранено" не може да
-- живее като SQLite CHECK constraint (изисква cross-table lookup, което
-- SQLite CHECK не поддържа) — прилага се на application ниво в
-- chatStore.sendMessage() преди INSERT.
CREATE TABLE IF NOT EXISTS friend_chat_attachments (
  message_id TEXT PRIMARY KEY,
  storage_filename TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL DEFAULT 'image/webp',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES friend_chat_messages(message_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_chat_attachments_filename
  ON friend_chat_attachments(storage_filename);

-- Deletion-intent опашка ("трябва да се изтрие физически файл X") —
-- populated в СЪЩАТА транзакция, в която съответното съобщение отпада от
-- историята (500-съобщения prune в chatStore.sendMessage, виж
-- pruneOldMessagesStatement), точно по модела на
-- lobby_chat_deletion_events от 20260728_001_create_lobby_chat_messages.sql
-- (там: cross-instance broadcast fanout; тук: физическо файлово чистене).
-- cleanup_status позволява на background job-а (index.ts) да маркира
-- 'done'/'failed' и да НЕ обработва повторно вече обработени записи.
CREATE TABLE IF NOT EXISTS friend_chat_attachment_deletions (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    cleanup_status IN ('pending', 'done', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_friend_chat_attachment_deletions_status
  ON friend_chat_attachment_deletions(cleanup_status);

-- Defensive: ensureServerDatabaseReady.ts винаги създава server_migrations
-- ПРЕДИ да изпълни каквато и да е миграция, но някои ad-hoc test скриптове в
-- server/scripts/ прилагат migration файловете директно (без runner-а) и не
-- я създават сами — IF NOT EXISTS прави тази миграция self-contained и в двата случая.
CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260729_001_add_attachment_to_friend_chat_messages.sql');

COMMIT;
