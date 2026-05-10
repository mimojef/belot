PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS active_room_snapshots (
  room_id TEXT PRIMARY KEY,
  snapshot_version INTEGER NOT NULL CHECK (
    snapshot_version >= 1
  ),
  room_status TEXT NOT NULL CHECK (
    room_status IN ('waiting', 'playing', 'finished')
  ),
  game_phase TEXT NULL,
  state_version INTEGER NOT NULL CHECK (
    state_version >= 0
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

CREATE INDEX IF NOT EXISTS idx_active_room_snapshots_is_active
  ON active_room_snapshots(is_active, updated_at);

CREATE INDEX IF NOT EXISTS idx_active_room_snapshots_room_status
  ON active_room_snapshots(room_status, updated_at);
