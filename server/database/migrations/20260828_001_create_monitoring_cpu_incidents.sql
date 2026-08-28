PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS monitoring_cpu_incidents (
  id                              INTEGER PRIMARY KEY,
  detection_type                  TEXT    NOT NULL,
  started_at                      INTEGER NOT NULL,
  ended_at                        INTEGER,
  duration_ms                     INTEGER,

  process_cpu_max                 REAL,
  process_cpu_avg                 REAL,
  process_cpu_p95                 REAL,

  server_cpu_max                  REAL,

  game_worker_cpu_max             REAL,
  non_game_worker_process_cpu_max REAL,

  event_loop_utilization_max      REAL,
  event_loop_delay_p99_max_ms     REAL,

  rss_max_mb                      REAL,

  online_players_avg              REAL,
  active_matches_avg              REAL,
  ws_connections_avg              REAL,

  gameplay_per_min                REAL,
  lobby_chat_per_min              REAL,
  direct_chat_per_min             REAL,
  pika_team_chat_per_min          REAL,
  official_support_per_min        REAL,
  private_room_chat_per_min       REAL,
  topics_per_min                  REAL,
  lafche_per_min                  REAL,
  http_per_min                    REAL,

  top_http_categories_json        TEXT,
  top_ws_inbound_types_json       TEXT,
  top_ws_outbound_types_json      TEXT
);

CREATE INDEX IF NOT EXISTS idx_monitoring_cpu_incidents_started_at
  ON monitoring_cpu_incidents(started_at);

CREATE INDEX IF NOT EXISTS idx_monitoring_cpu_incidents_detection_type
  ON monitoring_cpu_incidents(detection_type);

CREATE TABLE IF NOT EXISTS monitoring_cpu_incident_samples (
  id                               INTEGER PRIMARY KEY,
  incident_id                      INTEGER NOT NULL,
  t                                INTEGER NOT NULL,
  sample_resolution_ms             INTEGER NOT NULL,

  process_cpu                      REAL,
  server_cpu                       REAL,
  game_worker_cpu                  REAL,
  non_game_worker_process_cpu      REAL,

  event_loop_utilization           REAL,
  event_loop_delay_p99_ms          REAL,

  rss_mb                           REAL,

  online_players                   INTEGER,
  active_matches                   INTEGER,
  ws_connections                   INTEGER,

  FOREIGN KEY (incident_id) REFERENCES monitoring_cpu_incidents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monitoring_cpu_incident_samples_incident_id
  ON monitoring_cpu_incident_samples(incident_id, t);
