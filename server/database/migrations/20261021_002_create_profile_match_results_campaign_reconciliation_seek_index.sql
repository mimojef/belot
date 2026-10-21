-- Campaign credit reconciliation — legacy Belot sweep (profile_match_results)
-- seek index. Legacy cursor заявките (campaignGameHooks.ts) сравняват ключа
-- като row value: (completed_at, room_id, profile_id) > / <= (?, ?, ?) и
-- подреждат ORDER BY completed_at, room_id, profile_id. Старият
-- idx_profile_match_results_campaign_reconciliation има did_win на второ
-- място (останал от премахнатия did_win=1 филтър), което прави range-а и
-- подредбата неизползваеми -> пълно обхождане + TEMP B-TREE на всеки tick.
-- Тоя индекс дава equality по is_guest_trial + seek/range по точно cursor
-- ключа в правилния ред (LIMIT спира рано); did_win е включен само за да е
-- покриващ за SELECT-а. Старият индекс НЕ се трие тук (отделна, по-късна
-- миграция след потвърждение на плана в production). Без ANALYZE.
CREATE INDEX IF NOT EXISTS idx_profile_match_results_campaign_reconciliation_seek
  ON profile_match_results(is_guest_trial, completed_at, room_id, profile_id, did_win);
