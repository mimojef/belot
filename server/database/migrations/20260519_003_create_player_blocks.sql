CREATE TABLE IF NOT EXISTS player_blocks (
  blocker_profile_id TEXT NOT NULL,
  blocked_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_profile_id, blocked_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_player_blocks_blocked ON player_blocks (blocked_profile_id);

DELETE FROM profile_friendships WHERE status = 'blocked';
