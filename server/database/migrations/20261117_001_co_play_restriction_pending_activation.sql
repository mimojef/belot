-- „Забрана за съвместна игра“ (Етап 4) — отложено активиране при общ
-- незавършил турнир. Допълва 20261116_001 (вече commit-ната) без да я пипа.
--
-- Изчакваща забрана (pending_activation): ended_at IS NULL AND activated_at IS NULL.
--   * duration_days и expires_at остават NULL до активирането (съвместимо с
--     CHECK-а от 20261116_001); заявеният срок е в requested_duration_days
--     (NULL = безсрочна). Срокът тече от activated_at.
--   * Уникалността (ux_co_play_restrictions_open_pair, ended_at IS NULL) вече
--     покрива и изчакващите — няма дублирани активни/изчакващи забрани.
-- Съществуващите записи са били активни от момента на създаване.

ALTER TABLE co_play_restrictions ADD COLUMN activated_at TEXT NULL;
ALTER TABLE co_play_restrictions ADD COLUMN requested_duration_days INTEGER NULL
  CHECK (requested_duration_days IS NULL OR requested_duration_days >= 1);
ALTER TABLE co_play_restrictions ADD COLUMN pending_reason TEXT NULL
  CHECK (pending_reason IS NULL OR pending_reason IN ('shared_tournament'));

UPDATE co_play_restrictions
SET activated_at = created_at, requested_duration_days = duration_days
WHERE activated_at IS NULL;

-- Общите турнири, заради които забраната изчаква (за администратора; самото
-- активиране винаги проверява наново актуалното състояние).
CREATE TABLE IF NOT EXISTS co_play_restriction_pending_tournaments (
  restriction_id TEXT NOT NULL,
  tournament_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (restriction_id, tournament_id)
);

-- Одитът получава две нови действия ('activate', 'tournament_conflict_detected').
-- SQLite не може да промени CHECK — таблицата се пресъздава със същите данни.
CREATE TABLE co_play_restriction_audit_v2 (
  audit_id TEXT PRIMARY KEY,
  restriction_id TEXT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'impose', 'lift', 'close_expired', 'settings_update', 'enforcement_removed',
    'activate', 'tournament_conflict_detected'
  )),
  actor_profile_id TEXT NULL,
  created_at TEXT NOT NULL,
  details_json TEXT NULL
);

INSERT INTO co_play_restriction_audit_v2 (audit_id, restriction_id, action, actor_profile_id, created_at, details_json)
SELECT audit_id, restriction_id, action, actor_profile_id, created_at, details_json
FROM co_play_restriction_audit
ORDER BY rowid;

DROP TABLE co_play_restriction_audit;
ALTER TABLE co_play_restriction_audit_v2 RENAME TO co_play_restriction_audit;

CREATE INDEX IF NOT EXISTS idx_co_play_restriction_audit_restriction
  ON co_play_restriction_audit(restriction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_co_play_restriction_audit_created
  ON co_play_restriction_audit(created_at);
