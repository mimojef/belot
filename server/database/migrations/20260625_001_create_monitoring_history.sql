CREATE TABLE IF NOT EXISTS monitoring_history (
  id             INTEGER PRIMARY KEY,
  sampled_at     INTEGER NOT NULL,
  server_cpu     REAL,
  node_cpu       REAL,
  ram_used_mb    REAL    NOT NULL,
  ram_percent    REAL    NOT NULL,
  rss_mb         REAL    NOT NULL,
  ws_conns       INTEGER NOT NULL,
  online_players INTEGER NOT NULL,
  active_rooms   INTEGER NOT NULL,
  mm_waiters     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monitoring_history_sampled_at
  ON monitoring_history(sampled_at);
