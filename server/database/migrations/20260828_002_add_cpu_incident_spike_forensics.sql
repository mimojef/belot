PRAGMA foreign_keys = ON;

-- Diagnostic fix за false-zero activity/context на extreme_spike incidents
-- (виж forensic audit) — background job timing и GC агрегати за incident
-- прозореца, компактни JSON колони (bounded, fixed-cardinality producer,
-- виж backgroundJobMetrics.ts/gcMetrics.ts).
ALTER TABLE monitoring_cpu_incidents ADD COLUMN background_jobs_json TEXT;
ALTER TABLE monitoring_cpu_incidents ADD COLUMN gc_json TEXT;

-- Raw 1-секундни spike семпли с пълен forensic context — ОТДЕЛНА таблица от
-- monitoring_cpu_incident_samples (която е 10s bucket-aggregated). Тук
-- пазим точния 1s прозорец, в който CPU е достигнал extreme spike прага,
-- за да не разчитаме единствено на 10s bucket агрегация (виж diagnostic fix
-- брифа т.5 — "не е достатъчно тези данни да съществуват само в 10-second
-- pre-context row").
CREATE TABLE IF NOT EXISTS monitoring_cpu_incident_spike_samples (
  id                               INTEGER PRIMARY KEY,
  incident_id                      INTEGER NOT NULL,
  sampled_at                       INTEGER NOT NULL,
  process_cpu                      REAL    NOT NULL,

  server_cpu                       REAL,
  game_worker_cpu                  REAL,
  non_game_worker_process_cpu      REAL,

  event_loop_utilization           REAL,
  event_loop_delay_p99_ms          REAL,

  rss_mb                           REAL,
  heap_used_mb                     REAL,

  online_players                   INTEGER,
  active_matches                   INTEGER,
  ws_connections                   INTEGER,
  matchmaking_waiters               INTEGER,

  -- Worker CPU freshness (виж final fix pass брифа §9) — game_worker_cpu се
  -- семплира само на 10s интервал (async worker.cpuUsage() round-trip),
  -- независимо от 1s spike sample-а. Age показва колко стара е стойността
  -- СПРЯМО sampled_at по-горе, за да не се представя мълчаливо като "точно
  -- сега измерена". NULL когато worker CPU е недостъпно.
  game_worker_cpu_sample_age_ms     INTEGER,
  non_game_worker_process_cpu_sample_age_ms INTEGER,

  -- Компактен JSON snapshot на activity/background/gc — bounded producer
  -- (ActivityCountersSnapshot/BackgroundJobStatsSnapshot/GcStatsSnapshot),
  -- никога произволни ключове от user input. Без message съдържание,
  -- username, profileId, IP, raw URL — виж diagnostic fix брифа т.9.
  activity_json                    TEXT,
  background_jobs_json             TEXT,
  gc_json                          TEXT,

  FOREIGN KEY (incident_id) REFERENCES monitoring_cpu_incidents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monitoring_cpu_incident_spike_samples_incident_id
  ON monitoring_cpu_incident_spike_samples(incident_id, sampled_at);
