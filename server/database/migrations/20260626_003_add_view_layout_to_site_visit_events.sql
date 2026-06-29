ALTER TABLE site_visit_events
  ADD COLUMN view_layout TEXT NULL
  CHECK (view_layout IN ('mobile', 'desktop'));

-- is_entry = 1 only for the initial page load (navigate/reload/back_forward
-- at app startup). SPA pushState and in-app popstate events are recorded with
-- is_entry = 0. Old rows without this column default to 0 so they are never
-- counted in the layout statistics.
ALTER TABLE site_visit_events
  ADD COLUMN is_entry INTEGER NOT NULL DEFAULT 0
  CHECK (is_entry IN (0, 1));

-- Covers the getViewLayoutSummary() query:
--   WHERE view_layout IN ('mobile','desktop') AND is_entry = 1 AND occurred_at ...
DROP INDEX IF EXISTS idx_site_visit_events_layout_navtype_time;
CREATE INDEX IF NOT EXISTS idx_site_visit_events_layout_entry_time
  ON site_visit_events(view_layout, is_entry, occurred_at);
