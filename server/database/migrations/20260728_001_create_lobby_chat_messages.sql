PRAGMA foreign_keys = ON;

-- Общ (публичен) лайв чат в лобито — за разлика от friend_chat_messages
-- (1:1 между приети приятели), тук ВСИЧКИ логнати потребители (вкл.
-- guest-trial) пишат в един общ поток, видим за всички (вкл. напълно
-- нерегистрирани посетители за четене).
--
-- seq (AUTOINCREMENT) е детерминираният ред и същевременно евтин cursor
-- за cross-instance fanout (виж lobbyChatStore.ts) — created_at (с
-- милисекундна точност) е само за показване, НЕ за подредба/cursor,
-- защото няколко съобщения могат да паднат в една и съща секунда/ms.
--
-- sender_display_name е snapshot към момента на публикуване (проектът
-- няма по-надежден съществуващ стандарт за "исторически" display name),
-- за да не се налага JOIN/заявка към профила за всеки исторически ред.
CREATE TABLE IF NOT EXISTS lobby_chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  sender_profile_id TEXT NOT NULL,
  sender_display_name TEXT NOT NULL,
  body TEXT NOT NULL CHECK (
    trim(body) <> ''
    AND length(body) <= 1200
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  deleted_at TEXT NULL,
  deleted_by_profile_id TEXT NULL,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

-- seq е INTEGER PRIMARY KEY (= rowid alias в SQLite) — вече си има вграден
-- индекс; отделен CREATE INDEX върху него би бил чисто излишен overhead при
-- всеки INSERT, затова НЕ се създава.

CREATE INDEX IF NOT EXISTS idx_lobby_chat_messages_created_at
  ON lobby_chat_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_lobby_chat_messages_deleted_at
  ON lobby_chat_messages(deleted_at);

-- Транзиентен "fanout log" САМО за cross-instance известяване на изтривания
-- (виж т. 6/12 от спецификацията — няколко PM2 процеса споделят една SQLite
-- база, но всеки има собствена in-memory socket регистрация). Отделен
-- монотонен event_seq, защото самото изтриване се случва МНОГО по-късно от
-- вмъкването на съобщението — не може да се преизползва message seq cursor-а.
-- НЕ е одитна следа (виж lobby_chat_deletion_audit_log по-долу за това) —
-- може безопасно да се чисти заедно с retention-а на съобщенията.
CREATE TABLE IF NOT EXISTS lobby_chat_deletion_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

-- event_seq също е INTEGER PRIMARY KEY (rowid alias) — виж коментара по-горе
-- за message.seq; отделен индекс тук би бил същия ненужен overhead.

CREATE INDEX IF NOT EXISTS idx_lobby_chat_deletion_events_created_at
  ON lobby_chat_deletion_events(created_at);

-- Одит на модераторско изтриване (само пълен admin — виж isFullAdminSession).
-- ON DELETE SET NULL за actor/sender: пази следата дори ако акаунт/профил
-- бъде изтрит по-късно — аналог на admin_role_audit_log.
CREATE TABLE IF NOT EXISTS lobby_chat_deletion_audit_log (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  message_id TEXT NOT NULL,
  sender_profile_id TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_lobby_chat_deletion_audit_log_message
  ON lobby_chat_deletion_audit_log(message_id);
