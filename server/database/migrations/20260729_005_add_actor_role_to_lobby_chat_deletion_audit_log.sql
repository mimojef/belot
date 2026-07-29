-- actor_role_at_deletion snapshot-ва ролята на модератора В МОМЕНТА на
-- изтриването (роля може да се промени по-късно — audit следата трябва да
-- пази историческата истина, не текущата роля на акаунта).
--
-- DEFAULT 'admin' е исторически точен backfill: до тази миграция единствената
-- роля, която можеше да трие съобщения от общия чат, беше пълен admin (виж
-- handleLobbyChatDeleteRequest преди isLobbyChatModeratorSession) — всички
-- съществуващи редове коректно получават 'admin'.
ALTER TABLE lobby_chat_deletion_audit_log
  ADD COLUMN actor_role_at_deletion TEXT NOT NULL DEFAULT 'admin'
  CHECK (actor_role_at_deletion IN ('admin', 'subadmin', 'chat_admin'));
