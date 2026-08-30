-- MANUAL_TRANSACTION_MIGRATION
-- Прави ad_campaigns.target_url nullable — рекламна кампания вече може да
-- бъде създадена и БЕЗ target link/path (само изображение). Отсъствието на
-- target означава: popup-ът не показва бутон "Виж"; X/backdrop dismiss
-- продължават да работят нормално (виж §"Кампания без target" в брифа).
--
-- SQLite няма ALTER TABLE за промяна на NOT NULL -> NULL — единственият
-- начин е table rebuild (CREATE нова таблица → INSERT SELECT → DROP старата
-- → RENAME), огледално на established pattern-а от
-- 20260727_002_extend_accounts_role_subadmin.sql. ad_campaigns обаче е
-- PARENT на ad_campaign_dispatches (FOREIGN KEY campaign_id ON DELETE
-- CASCADE) — ако DROP TABLE ad_campaigns се изпълни с foreign_keys=ON,
-- SQLite прави implicit cascade delete на ВСИЧКИ dispatch редове преди
-- дропа, което би изтрило безвъзвратно цялата dispatch история. Затова тази
-- миграция управлява собствената си транзакция и temporарно изключва
-- foreign_keys ИЗВЪН BEGIN/COMMIT (SQLite отказва да промени PRAGMA
-- foreign_keys вътре в отворена транзакция) — runner-ът (ensureServerDatabaseReady.ts)
-- разпознава MANUAL_TRANSACTION_MIGRATION маркера по-горе и изпълнява целия
-- файл с един exec(), без свой BEGIN/COMMIT wrap.
--
-- ad_campaign_dispatches/ad_campaign_receipts/ad_campaign_events НЕ се
-- пипат — техните редове (включително campaign_id references) остават
-- непокътнати; след RENAME ad_campaigns_new -> ad_campaigns, съществуващата
-- FOREIGN KEY на ad_campaign_dispatches отново коректно сочи към
-- преименуваната таблица (SQLite FK-та резолвят по table name, не по
-- вътрешен OID).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE ad_campaigns_new (
  campaign_id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  image_filename TEXT NOT NULL,
  target_url TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_profile_id TEXT NULL,
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('admin', 'pika_team')),
  deleted_at TEXT NULL,
  deleted_by_profile_id TEXT NULL,
  deleted_by_role TEXT NULL CHECK (deleted_by_role IS NULL OR deleted_by_role IN ('admin', 'pika_team')),
  FOREIGN KEY (created_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO ad_campaigns_new (
  campaign_id, image_url, image_filename, target_url, created_at,
  created_by_profile_id, created_by_role, deleted_at, deleted_by_profile_id, deleted_by_role
)
SELECT
  campaign_id, image_url, image_filename, target_url, created_at,
  created_by_profile_id, created_by_role, deleted_at, deleted_by_profile_id, deleted_by_role
FROM ad_campaigns;

DROP TABLE ad_campaigns;

ALTER TABLE ad_campaigns_new RENAME TO ad_campaigns;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_active_created
  ON ad_campaigns(deleted_at, created_at);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260830_004_make_ad_campaign_target_url_nullable.sql');

COMMIT;

PRAGMA foreign_keys = ON;
