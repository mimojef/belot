-- MANUAL_TRANSACTION_MIGRATION
-- Adds the account role 'marketing' ("Маркетинг"): full access to the
-- "Реклами" (ad campaigns) section + own-content delete in Лафче/Теми, and
-- nothing else. Existing roles, audit rows and ad campaign rows are copied
-- unchanged. Same FK-safe table-rebuild pattern as the earlier role-extension
-- migrations (20260802_001_add_pika_team_role.sql,
-- 20260802_002_add_top_chat_admin_role.sql).
--
-- Rebuilt tables (only the role CHECK constraints change):
--   accounts.role                         + 'marketing'
--   admin_role_audit_log.action           + 'grant_marketing'/'revoke_marketing'
--   admin_role_audit_log.previous_role    + 'marketing'
--   admin_role_audit_log.new_role         + 'marketing'
--   ad_campaigns.created_by_role          + 'marketing'
--   ad_campaigns.deleted_by_role          + 'marketing'
--   ad_campaign_dispatches.sent_by_role   + 'marketing'
--
-- Intentionally NOT changed: topic_messages.sender_role / topics.created_by_role
-- (marketing is snapshotted as 'player' there — no badge, no 72h auto-delete
-- exemption), lobby chat / topic moderation / mute audit role columns
-- (marketing never acts through those paths).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE accounts_new (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (
    trim(email) <> ''
  ),
  password_hash TEXT NOT NULL CHECK (
    trim(password_hash) <> ''
  ),
  role TEXT NOT NULL DEFAULT 'player' CHECK (
    role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing', 'subadmin', 'admin')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT NULL
);

INSERT INTO accounts_new (
  account_id,
  email,
  password_hash,
  role,
  status,
  created_at,
  updated_at,
  last_login_at
)
SELECT
  account_id,
  email,
  password_hash,
  role,
  status,
  created_at,
  updated_at,
  last_login_at
FROM accounts;

DROP TABLE accounts;

ALTER TABLE accounts_new RENAME TO accounts;

CREATE INDEX IF NOT EXISTS idx_accounts_role_status
  ON accounts(role, status);

CREATE TABLE admin_role_audit_log_new (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  target_account_id TEXT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'grant_subadmin',
      'revoke_subadmin',
      'grant_chat_admin',
      'revoke_chat_admin',
      'grant_pika_team',
      'revoke_pika_team',
      'grant_top_chat_admin',
      'revoke_top_chat_admin',
      'grant_marketing',
      'revoke_marketing'
    )
  ),
  previous_role TEXT NOT NULL CHECK (
    previous_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing', 'subadmin', 'admin')
  ),
  new_role TEXT NOT NULL CHECK (
    new_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing', 'subadmin', 'admin')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (target_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
);

INSERT INTO admin_role_audit_log_new (
  log_id, actor_account_id, target_account_id, action, previous_role, new_role, created_at
)
SELECT
  log_id, actor_account_id, target_account_id, action, previous_role, new_role, created_at
FROM admin_role_audit_log;

DROP TABLE admin_role_audit_log;

ALTER TABLE admin_role_audit_log_new RENAME TO admin_role_audit_log;

CREATE INDEX IF NOT EXISTS idx_admin_role_audit_log_target
  ON admin_role_audit_log(target_account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_role_audit_log_actor
  ON admin_role_audit_log(actor_account_id, created_at);

CREATE TABLE ad_campaigns_new (
  campaign_id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  image_filename TEXT NOT NULL,
  target_url TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_profile_id TEXT NULL,
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('admin', 'pika_team', 'marketing')),
  deleted_at TEXT NULL,
  deleted_by_profile_id TEXT NULL,
  deleted_by_role TEXT NULL CHECK (deleted_by_role IS NULL OR deleted_by_role IN ('admin', 'pika_team', 'marketing')),
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

CREATE TABLE ad_campaign_dispatches_new (
  dispatch_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_by_profile_id TEXT NULL,
  sent_by_role TEXT NOT NULL CHECK (sent_by_role IN ('admin', 'pika_team', 'marketing')),
  superseded_at TEXT NULL,
  FOREIGN KEY (campaign_id) REFERENCES ad_campaigns(campaign_id) ON DELETE CASCADE,
  FOREIGN KEY (sent_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO ad_campaign_dispatches_new (
  dispatch_id, campaign_id, sent_at, sent_by_profile_id, sent_by_role, superseded_at
)
SELECT
  dispatch_id, campaign_id, sent_at, sent_by_profile_id, sent_by_role, superseded_at
FROM ad_campaign_dispatches;

DROP TABLE ad_campaign_dispatches;

ALTER TABLE ad_campaign_dispatches_new RENAME TO ad_campaign_dispatches;

CREATE INDEX IF NOT EXISTS idx_ad_campaign_dispatches_campaign
  ON ad_campaign_dispatches(campaign_id, sent_at);

CREATE INDEX IF NOT EXISTS idx_ad_campaign_dispatches_campaign_superseded
  ON ad_campaign_dispatches(campaign_id, superseded_at);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261005_001_add_marketing_role.sql');

COMMIT;

PRAGMA foreign_keys = ON;
