PRAGMA foreign_keys = ON;

-- Fix за "натрупване на dispatches": преди тази миграция всяко натискане на
-- "Изпрати" за същата campaign_id създаваше нов независим dispatch ред, и
-- listPendingDispatchesForProfile ги връщаше всичките (offline потребител,
-- изпратена 3 пъти -> 3 отделни popup-а). superseded_at маркира по-стар
-- pending dispatch на СЪЩАТА campaign_id като заменен от по-ново изпращане —
-- listPendingDispatchesForProfile вече го филтрира и той никога не се
-- показва. dispatch_count/history в ad_campaign_dispatches остава непроменена
-- (superseded_at е отделна колона, не UPDATE/DELETE на реда) — admin
-- "Изпратено X пъти" статистиката не се засяга.

ALTER TABLE ad_campaign_dispatches ADD COLUMN superseded_at TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_ad_campaign_dispatches_campaign_superseded
  ON ad_campaign_dispatches(campaign_id, superseded_at);
