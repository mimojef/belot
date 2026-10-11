PRAGMA foreign_keys = ON;

-- Фаза 6.2 — добавя 'belot_win_legacy' source_type ключ за ОТДЕЛЕН durable
-- cursor на legacy sweep-а (campaignGameHooks.ts::reconcileMissingBelotCampaignCredits),
-- mirror на вече съществуващия 20261015_001 прецедент (3 нови purchase
-- ключове, същия rebuild pattern).
--
-- ЗАЩО е нужен: legacy sweep-ът (profile_match_results, редове писани
-- ПРЕДИ belot_match_completion_ledger да съществува) първоначално нямаше
-- собствен cursor — чист LIMIT без cursor би спирал да напредва, ако
-- първите N реда (по completed_at ASC) са ПОСТОЯННО недопустими (извън
-- прозореца на всяка кампания, или ineligible_profile) — NOT EXISTS
-- филтъра никога не ги маха от "липсващи", затова следващия tick пак би
-- върнал СЪЩИТЕ N реда, вместо да напредне към следващите, допустими
-- редове. Собствен durable cursor (идентичен 4-statement cursor/wrap
-- pattern на 'belot_win'-а, виж campaignGameHooks.ts) гарантира монотонно
-- напредване през (completed_at, room_id, profile_id) подредбата,
-- независимо дали конкретния ред в крайна сметка се credit-ва или само се
-- "прескача" като недопустим.
--
-- SQLite не поддържа ALTER ... пряка промяна на CHECK clause — стандартният
-- rebuild pattern (виж 20260923_004/20260902_002/20261015_001 за
-- прецедента): НЯМА входящи/изходящи FK към/от тая таблица, затова
-- rebuild-ът е прост, без нужда от PRAGMA foreign_keys=OFF/MANUAL_TRANSACTION
-- маркер (migration runner-ът wrap-ва целия файл в собствен BEGIN/COMMIT).
CREATE TABLE campaign_credit_reconciliation_state_new (
  source_type TEXT PRIMARY KEY CHECK (source_type IN (
    'belot_win', 'belot_win_legacy', 'ludo_win', 'package_purchase_coin', 'package_purchase_bundle', 'package_purchase_vip'
  )),
  cursor_event_at TEXT NOT NULL DEFAULT '',
  cursor_source_id TEXT NOT NULL DEFAULT '',
  cursor_profile_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO campaign_credit_reconciliation_state_new (
  source_type, cursor_event_at, cursor_source_id, cursor_profile_id, updated_at
)
SELECT source_type, cursor_event_at, cursor_source_id, cursor_profile_id, updated_at
FROM campaign_credit_reconciliation_state;

DROP TABLE campaign_credit_reconciliation_state;
ALTER TABLE campaign_credit_reconciliation_state_new RENAME TO campaign_credit_reconciliation_state;
