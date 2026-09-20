PRAGMA foreign_keys = ON;

-- Mirrors active_room_snapshots (20260510_001) for Ludo: a durable
-- authoritative snapshot of every STARTED Ludo match (stake already
-- debited), so a backend process restart can restore the in-memory
-- ludoMatchRuntime state instead of losing it. Waiting rooms (no debit yet)
-- are intentionally NOT persisted here — see activeLudoMatchSnapshotStore.ts.
CREATE TABLE IF NOT EXISTS active_ludo_match_snapshots (
  match_id TEXT PRIMARY KEY,
  snapshot_version INTEGER NOT NULL CHECK (
    snapshot_version >= 1
  ),
  ludo_room_id TEXT NOT NULL,
  match_status TEXT NOT NULL CHECK (
    match_status IN ('in_progress', 'finished')
  ),
  revision INTEGER NOT NULL CHECK (
    revision >= 0
  ),
  snapshot_json TEXT NOT NULL CHECK (
    json_valid(snapshot_json)
  ),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (
    is_active IN (0, 1)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT NULL,
  removed_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_ludo_match_snapshots_is_active
  ON active_ludo_match_snapshots(is_active, updated_at);

CREATE INDEX IF NOT EXISTS idx_active_ludo_match_snapshots_match_status
  ON active_ludo_match_snapshots(match_status, updated_at);
