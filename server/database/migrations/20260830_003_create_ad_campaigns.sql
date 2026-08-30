PRAGMA foreign_keys = ON;

-- "Рекламни кампании" (admin/pika_team marketing banners) — campaign е
-- реюзируем шаблон (image + target URL), dispatch е еднократно "изпращане"
-- действие (всяко натискане на "Изпрати" създава нов ред), receipt е
-- per-(dispatch,profile) статус (shown/dismissed/clicked). Delete на
-- campaign е soft delete (deleted_at) — image файлът не се трие
-- автоматично (audit trail).
--
-- created_by_profile_id/sent_by_profile_id са nullable с ON DELETE SET
-- NULL (не CASCADE) — ако admin/pika_team профилът по-късно бъде изтрит,
-- campaign/dispatch историята остава; created_by_role/sent_by_role са
-- snapshot стойности (NOT NULL), независими от FK нулирането.
--
-- ad_campaign_events е lightweight append-only cross-instance sync log
-- (за realtime fan-out между PM2 инстанции, mirror на lobby-chat seq-poll
-- pattern-а) — не source of truth за business логиката, само trigger сигнал.

CREATE TABLE IF NOT EXISTS ad_campaigns (
  campaign_id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  image_filename TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_profile_id TEXT NULL,
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('admin', 'pika_team')),
  deleted_at TEXT NULL,
  deleted_by_profile_id TEXT NULL,
  deleted_by_role TEXT NULL CHECK (deleted_by_role IS NULL OR deleted_by_role IN ('admin', 'pika_team')),
  FOREIGN KEY (created_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_active_created
  ON ad_campaigns(deleted_at, created_at);

CREATE TABLE IF NOT EXISTS ad_campaign_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_by_profile_id TEXT NULL,
  sent_by_role TEXT NOT NULL CHECK (sent_by_role IN ('admin', 'pika_team')),
  FOREIGN KEY (campaign_id) REFERENCES ad_campaigns(campaign_id) ON DELETE CASCADE,
  FOREIGN KEY (sent_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ad_campaign_dispatches_campaign
  ON ad_campaign_dispatches(campaign_id, sent_at);

CREATE TABLE IF NOT EXISTS ad_campaign_receipts (
  dispatch_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  shown_at TEXT NULL,
  dismissed_at TEXT NULL,
  clicked_at TEXT NULL,
  PRIMARY KEY (dispatch_id, profile_id),
  FOREIGN KEY (dispatch_id) REFERENCES ad_campaign_dispatches(dispatch_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ad_campaign_receipts_profile
  ON ad_campaign_receipts(profile_id);

CREATE TABLE IF NOT EXISTS ad_campaign_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('campaign_created', 'campaign_deleted', 'dispatch_created', 'receipt_dismissed', 'receipt_clicked')
  ),
  campaign_id TEXT NULL,
  dispatch_id TEXT NULL,
  profile_id TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ad_campaign_events_seq
  ON ad_campaign_events(event_seq);
