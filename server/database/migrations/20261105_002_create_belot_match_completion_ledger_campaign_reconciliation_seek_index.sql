-- Етап 2 на campaignCreditReconciliation оптимизацията — seek индекс за
-- Belot primary scan-а (belot_match_completion_ledger).
--
-- Защо: idx_belot_match_completion_ledger_ended_at (20261016_001) започва с
-- did_win, а "Само при победа" (Фаза 13) премахна did_win филтъра от
-- reconciliation заявките. Без equality по did_win SQLite не може да мине
-- по индекса в реда на ORDER BY (ended_at, match_scope, profile_id) — планът
-- става MULTI-INDEX OR + USE TEMP B-TREE FOR ORDER BY, т.е. всички редове
-- след cursor-а се събират и сортират на всеки tick, за да се върнат 500
-- (локално ~500 ms при 100k реда, синхронно в main thread-а). Същият дефект,
-- който 20261021_002 поправи за legacy profile_match_results scan-а.
--
-- Колоните: is_guest_trial (equality в WHERE), след това точно cursor/ORDER BY
-- ключа (ended_at, match_scope, profile_id) за row-value seek, и did_win
-- накрая (селектира се). Само индекс — данните не се променят; повторно
-- прилагане е no-op; старият индекс НЕ се премахва.
CREATE INDEX IF NOT EXISTS idx_belot_match_completion_ledger_campaign_reconciliation_seek
  ON belot_match_completion_ledger(is_guest_trial, ended_at, match_scope, profile_id, did_win);
