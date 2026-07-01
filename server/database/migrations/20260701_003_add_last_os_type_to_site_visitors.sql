ALTER TABLE site_visitors
  ADD COLUMN last_os_type TEXT NOT NULL DEFAULT 'unknown'
  CHECK (last_os_type IN ('android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'unknown'));

-- No backfill: old visitor records predate OS tracking. SQLite fills existing
-- rows with the column DEFAULT ('unknown') when adding a NOT NULL column, so
-- old rows read as 'unknown' without reconstructing the OS from user agent,
-- IP, or other unreliable data.
