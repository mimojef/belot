-- sender_is_chat_admin е snapshot КЪМ МОМЕНТА НА ИЗПРАЩАНЕ (същия модел като
-- sender_display_name — виж 20260728_001_create_lobby_chat_messages.sql) —
-- дали подателят е бил chat_admin, когато е публикувал съобщението. Ползва се
-- само за визуално различаване на името му в общия лайв чат (виж
-- renderLobbyChatMessageRow) — НЕ за авторизация (изтриването винаги проверява
-- живата роля през isLobbyChatModeratorSession, не този snapshot флаг).
--
-- DEFAULT 0 е исторически точен backfill: ролята chat_admin не е съществувала
-- преди тази миграция, така че всички съществуващи редове коректно остават 0.
ALTER TABLE lobby_chat_messages
  ADD COLUMN sender_is_chat_admin INTEGER NOT NULL DEFAULT 0
  CHECK (sender_is_chat_admin IN (0, 1));
