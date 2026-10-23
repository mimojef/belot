-- MANUAL_TRANSACTION_MIGRATION
-- Самоизтриване на профили — Етап 4E2 (одит P5, одобрени решения 5 и 6):
-- финансовата история на Ludo и атрибуцията на кампанийните награди
-- оцеляват окончателното изтриване на профил.
--
-- Собствена транзакция (MANUAL_TRANSACTION_MIGRATION), защото т. 1
-- пресъздава таблица, а PRAGMA foreign_keys не може да се изключи вътре в
-- отворена транзакция (виж ensureServerDatabaseReady.ts и established
-- pattern-а в 20260902_002 / 20260923_004 / 20261026_001).
--
-- 1. ludo_match_economy_ledger (20260919_001): profile_id беше NOT NULL и
--    ON DELETE CASCADE — изтриване на профил премахваше дебитите на входната
--    такса и изплатените печалби. Привежда се към модела на Belot
--    (match_economy_ledger, 20260902_002): profile_id NULL + ON DELETE SET
--    NULL + deleted_profile_id_snapshot (без FK) за одитната атрибуция.
--    Всички колони, стойности, UNIQUE и индекси са запазени дословно.
--    Без CHECK "profile_id или snapshot": административното изтриване не
--    snapshot-ва този регистър и не се променя в този етап — то вече
--    запазва редовете (SET NULL) вместо да ги трие. Самоизтриването
--    проверява инварианта преди COMMIT (profileDeletionExecutor.ts).
--
-- 2. Кампании — snapshot колона (без FK) само там, където записът е
--    финансова/одитна история, а profile_id вече е SET NULL:
--      * campaign_unit_ledger        — начислените единици (основа за награди);
--      * campaign_reward_claims      — предоставените награди (жълтиците нямат
--                                      собствен регистър — това е единственото
--                                      доказателство; VIP е и във vip_grants,
--                                      подаръкът — в gift_item_transactions);
--      * campaign_manual_adjustments — ръчните корекции (одит на администратора).
--    НЕ се добавя към campaign_profile_totals (производен агрегат, възстановим
--    от campaign_unit_ledger), campaign_reward_notifications (UI известия),
--    campaign_events (actor е администратор; payload вече съдържа ID) и
--    campaign_archive_top10 (отделен етап).
--    ALTER TABLE ADD COLUMN — без пресъздаване, съществуващите редове
--    получават NULL.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- ─── 1. ludo_match_economy_ledger: CASCADE -> SET NULL + snapshot ──────────
CREATE TABLE ludo_match_economy_ledger_new (
  ledger_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('ludo_stake_debit', 'ludo_winner_payout')
  ),
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  UNIQUE (match_id, profile_id, entry_type)
);

INSERT INTO ludo_match_economy_ledger_new (
  ledger_id, match_id, profile_id, entry_type, amount, balance_after, created_at
)
SELECT
  ledger_id, match_id, profile_id, entry_type, amount, balance_after, created_at
FROM ludo_match_economy_ledger;

DROP TABLE ludo_match_economy_ledger;
ALTER TABLE ludo_match_economy_ledger_new RENAME TO ludo_match_economy_ledger;

CREATE INDEX idx_ludo_match_economy_ledger_profile_id
  ON ludo_match_economy_ledger(profile_id, created_at);

CREATE INDEX idx_ludo_match_economy_ledger_match_id
  ON ludo_match_economy_ledger(match_id, created_at);

-- Mirror на idx_match_economy_ledger_deleted_profile_snapshot (Belot) —
-- вътрешна одитна справка, не публичен интерфейс.
CREATE INDEX idx_ludo_match_economy_ledger_deleted_profile_snapshot
  ON ludo_match_economy_ledger(deleted_profile_id_snapshot);

-- ─── 2. Кампании: snapshot на атрибуцията ──────────────────────────────────
ALTER TABLE campaign_unit_ledger ADD COLUMN deleted_profile_id_snapshot TEXT NULL;
ALTER TABLE campaign_reward_claims ADD COLUMN deleted_profile_id_snapshot TEXT NULL;
ALTER TABLE campaign_manual_adjustments ADD COLUMN deleted_profile_id_snapshot TEXT NULL;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261027_001_preserve_ludo_and_campaign_financial_attribution.sql');

COMMIT;

PRAGMA foreign_keys = ON;
