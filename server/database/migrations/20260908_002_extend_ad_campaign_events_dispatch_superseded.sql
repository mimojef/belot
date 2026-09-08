-- MANUAL_TRANSACTION_MIGRATION
-- Разширява CHECK constraint-а на ad_campaign_events.event_type с новата
-- 'dispatch_superseded' стойност (изпратена от sendCampaign, когато нов
-- dispatch на СЪЩАТА campaign_id замества по-стар pending dispatch — виж
-- 20260908_001_add_ad_campaign_dispatch_superseded.sql). SQLite няма ALTER
-- TABLE за промяна на CHECK constraint — table rebuild, огледално на
-- established pattern-а от 20260830_004_make_ad_campaign_target_url_nullable.sql.
-- ad_campaign_events няма FOREIGN KEY колони (campaign_id/dispatch_id/
-- profile_id са plain nullable references без FK в схемата), затова не е
-- нужно PRAGMA foreign_keys=OFF тук.

BEGIN IMMEDIATE;

CREATE TABLE ad_campaign_events_new (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'campaign_created', 'campaign_deleted', 'dispatch_created',
      'dispatch_superseded', 'receipt_dismissed', 'receipt_clicked'
    )
  ),
  campaign_id TEXT NULL,
  dispatch_id TEXT NULL,
  profile_id TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ad_campaign_events_new (
  event_seq, event_type, campaign_id, dispatch_id, profile_id, created_at
)
SELECT
  event_seq, event_type, campaign_id, dispatch_id, profile_id, created_at
FROM ad_campaign_events;

DROP TABLE ad_campaign_events;

ALTER TABLE ad_campaign_events_new RENAME TO ad_campaign_events;

CREATE INDEX IF NOT EXISTS idx_ad_campaign_events_seq
  ON ad_campaign_events(event_seq);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260908_002_extend_ad_campaign_events_dispatch_superseded.sql');

COMMIT;
