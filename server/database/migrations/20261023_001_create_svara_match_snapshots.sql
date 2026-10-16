-- Svara server-only full internal snapshots; no wallet or other-game changes.
CREATE TABLE IF NOT EXISTS svara_match_snapshots (
  match_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  match_status TEXT NOT NULL CHECK (match_status IN ('lobby', 'in-progress', 'finished', 'closed')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_svara_match_snapshots_active
  ON svara_match_snapshots(match_status) WHERE match_status IN ('lobby', 'in-progress');
