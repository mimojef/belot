PRAGMA foreign_keys = ON;

-- Фаза 5 (кампанийни единици при покупки) — разширява
-- campaign_credit_reconciliation_state (20261014_001) с 3 нови source_type
-- ключове за durable-cursor purchase reconciliation (campaignPurchaseHooks.ts),
-- mirror на вече съществуващите belot_win/ludo_win ключове. Отделни ключове
-- за coin/bundle/VIP (не един общ "package_purchase") — трите покупкови
-- ledger-а са РАЗЛИЧНИ таблици с различни схеми, всеки със собствен
-- независим cursor, точно както belot_win/ludo_win вече имат отделни
-- cursor-и за собствените си source таблици.
--
-- SQLite не поддържа ALTER ... пряка промяна на CHECK clause — стандартният
-- rebuild pattern (виж 20260923_004/20260902_002 за прецедента): НЯМА
-- входящи/изходящи FK към/от тая таблица, затова rebuild-ът е прост,
-- без нужда от PRAGMA foreign_keys=OFF/MANUAL_TRANSACTION маркер.
CREATE TABLE campaign_credit_reconciliation_state_new (
  source_type TEXT PRIMARY KEY CHECK (source_type IN (
    'belot_win', 'ludo_win', 'package_purchase_coin', 'package_purchase_bundle', 'package_purchase_vip'
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

-- Cursor-ordering индекси за трите purchase ledger-а, mirror на
-- idx_profile_match_results_campaign_reconciliation/
-- idx_ludo_room_matches_campaign_reconciliation (20261014_001).
CREATE INDEX IF NOT EXISTS idx_coin_purchase_ledger_campaign_reconciliation
  ON coin_purchase_ledger(status, credited_at, purchase_id, profile_id);

CREATE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_campaign_reconciliation
  ON bundle_purchase_ledger(status, credited_at, purchase_id, profile_id);

CREATE INDEX IF NOT EXISTS idx_vip_purchase_ledger_campaign_reconciliation
  ON vip_purchase_ledger(status, credited_at, purchase_id, profile_id);
