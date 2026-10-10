-- MANUAL_TRANSACTION_MIGRATION
-- Фаза 2 от системата "Кампании" (одобрено бизнес решение: ВСИЧКИ кампанийни
-- награди — жълтици/VIP/подарък — са служебни, платформата ги финансира,
-- без дебит на друг профил). За VIP наградата трябва да се запише с
-- различим reason от съществуващите ('launch_gift'/'purchase'/'admin_grant')
-- — 'admin_grant' би било подвеждащо (предполага ръчно admin действие,
-- докато campaign reward е 100% автоматично, scheduler/game-win driven).
--
-- Единствената промяна: разширяване на vip_grants.reason CHECK с
-- 'campaign_reward'. FK-safe table-rebuild pattern (SQLite няма ALTER
-- COLUMN за CHECK) — mirror на established прецедент
-- 20261005_001_add_marketing_role.sql. CREATE TABLE vip_grants_new по-долу е
-- ТОЧНО verbatim копие на текущата live schema (извлечена през
-- `SELECT sql FROM sqlite_master WHERE name='vip_grants'` на реално
-- мигрирана тестова база, НЕ reconstruct-вана на ръка от историята на
-- migration файловете — виж предупреждението в коментара на
-- 20260902_002_preserve_financial_and_ban_history_on_profile_delete.sql за
-- точно този риск), с единствена промяна в reason CHECK-а. Всички други
-- колони/CHECK/FK/индекси се пазят byte-for-byte, вкл. по-късно добавените
-- purchase_id/amount_paid_cents/currency (20260818_008),
-- deleted_profile_id_snapshot + profile_id -> SET NULL (20260902_002), и
-- bundle_purchase_id + idx_vip_grants_bundle_purchase_id_once (20260923_005).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE vip_grants_new (
  grant_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('launch_gift', 'purchase', 'admin_grant', 'campaign_reward')
  ),
  interval_unit TEXT NOT NULL CHECK (
    interval_unit IN ('days', 'months', 'years')
  ),
  interval_amount INTEGER NOT NULL CHECK (
    interval_amount > 0
  ),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, granted_by_profile_id TEXT NULL
  REFERENCES profiles(profile_id) ON DELETE SET NULL, resulting_active_until TEXT NULL, purchase_id TEXT NULL
  REFERENCES vip_purchase_ledger(purchase_id) ON DELETE SET NULL, amount_paid_cents INTEGER NULL, currency TEXT NULL, bundle_purchase_id TEXT NULL
  REFERENCES bundle_purchase_ledger(purchase_id) ON DELETE SET NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO vip_grants_new (
  grant_id, profile_id, deleted_profile_id_snapshot, reason, interval_unit, interval_amount,
  granted_at, granted_by_profile_id, resulting_active_until, purchase_id,
  amount_paid_cents, currency, bundle_purchase_id
)
SELECT
  grant_id, profile_id, deleted_profile_id_snapshot, reason, interval_unit, interval_amount,
  granted_at, granted_by_profile_id, resulting_active_until, purchase_id,
  amount_paid_cents, currency, bundle_purchase_id
FROM vip_grants;

DROP TABLE vip_grants;

ALTER TABLE vip_grants_new RENAME TO vip_grants;

CREATE INDEX idx_vip_grants_profile
  ON vip_grants(profile_id, granted_at);

CREATE UNIQUE INDEX idx_vip_grants_launch_gift_once
  ON vip_grants(profile_id)
  WHERE reason = 'launch_gift';

CREATE UNIQUE INDEX idx_vip_grants_purchase_id_once
  ON vip_grants(purchase_id)
  WHERE reason = 'purchase' AND purchase_id IS NOT NULL;

CREATE INDEX idx_vip_grants_deleted_profile_snapshot
  ON vip_grants(deleted_profile_id_snapshot);

CREATE UNIQUE INDEX idx_vip_grants_bundle_purchase_id_once
  ON vip_grants(bundle_purchase_id)
  WHERE reason = 'purchase' AND bundle_purchase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261012_001_add_campaign_reward_to_vip_grants_reason.sql');

COMMIT;

PRAGMA foreign_keys = ON;
