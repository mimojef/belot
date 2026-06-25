PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_visitors (
  anonymous_visitor_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_profile_id TEXT NULL,
  last_profile_id TEXT NULL,
  first_ip_address TEXT NULL,
  last_ip_address TEXT NULL,
  first_user_agent TEXT NULL,
  last_user_agent TEXT NULL,
  first_referrer TEXT NULL,
  last_referrer TEXT NULL,
  first_source TEXT NULL,
  last_source TEXT NULL,
  FOREIGN KEY (first_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (last_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_site_visitors_last_seen_at
  ON site_visitors(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_site_visitors_last_profile_id
  ON site_visitors(last_profile_id, last_seen_at);

CREATE TABLE IF NOT EXISTS site_visit_events (
  page_view_id TEXT PRIMARY KEY,
  anonymous_visitor_id TEXT NOT NULL,
  profile_id TEXT NULL,
  path TEXT NOT NULL,
  navigation_type TEXT NOT NULL CHECK (
    navigation_type IN ('navigate', 'reload', 'back_forward', 'spa')
  ),
  referrer TEXT NULL,
  source TEXT NULL,
  utm_source TEXT NULL,
  utm_medium TEXT NULL,
  utm_campaign TEXT NULL,
  utm_term TEXT NULL,
  utm_content TEXT NULL,
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (anonymous_visitor_id) REFERENCES site_visitors(anonymous_visitor_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_site_visit_events_occurred_at
  ON site_visit_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_site_visit_events_visitor_time
  ON site_visit_events(anonymous_visitor_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_site_visit_events_profile_time
  ON site_visit_events(profile_id, occurred_at);
