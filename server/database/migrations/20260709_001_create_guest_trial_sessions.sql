CREATE TABLE IF NOT EXISTS guest_trial_sessions (
  guest_id TEXT NOT NULL PRIMARY KEY,
  games_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT,
  user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_guest_trial_sessions_last_seen_at ON guest_trial_sessions (last_seen_at);
