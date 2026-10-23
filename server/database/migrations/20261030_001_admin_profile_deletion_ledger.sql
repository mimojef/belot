-- Самоизтриване на профили — Етап 4F1: административните окончателни
-- изтривания минават през независимия регистър (deletion ledger) и restore
-- защитата.
--
-- Всяко административно изтриване вече е висяща операция в
-- pending_profile_moderation (action='delete'), свързана с ред в регистъра
-- (admin_delete_intent) чрез ledger_operation_id. Изтриването се изпълнява
-- едва когато намерението е потвърдено копирано извън VPS и профилът не е в
-- активна игра; admin_profile_deletions.log_id = ledger_operation_id, така
-- че регистърът и одитът сочат една и съща операция.
--
-- Nullable: редове отпреди тази миграция (и pending бан) нямат операция;
-- изпълнителят им създава намерение в регистъра, преди да ги изпълни.
-- Уникален, когато е зададен — една операция = един висящ ред.
ALTER TABLE pending_profile_moderation
  ADD COLUMN ledger_operation_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_profile_moderation_ledger_operation
  ON pending_profile_moderation(ledger_operation_id)
  WHERE ledger_operation_id IS NOT NULL;
