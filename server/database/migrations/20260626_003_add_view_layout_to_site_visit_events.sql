ALTER TABLE site_visit_events
  ADD COLUMN view_layout TEXT NULL
  CHECK (view_layout IN ('mobile', 'desktop'));

CREATE INDEX IF NOT EXISTS idx_site_visit_events_layout_navtype_time
  ON site_visit_events(view_layout, navigation_type, occurred_at);
