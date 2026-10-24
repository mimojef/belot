-- MANUAL_TRANSACTION_MIGRATION
-- Самоизтриване на профили — Етап 4G: срокът за отмяна на доброволна заявка
-- става 30 дни (точно 2 592 000 секунди) вместо 45 (3 888 000 секунди).
--
-- Собствена транзакция (MANUAL_TRANSACTION_MIGRATION), защото таблицата се
-- пресъздава (CHECK ограничение в SQLite не може да се промени), а PRAGMA
-- foreign_keys не може да се изключи вътре в отворена транзакция
-- (established pattern: 20261026_001, 20261031_001).
--
-- profile_deletion_requests получава колона grace_period_days (30 | 45) и
-- CHECK: scheduled_for - requested_at = grace_period_days × 86 400 секунди
-- (същите милисекунди). Така:
--   * историческите заявки ЗАПАЗВАТ оригиналния си 45-дневен краен срок —
--     нищо не се преизчислява, requested_at/scheduled_for се копират дословно;
--   * insert guard-ът приема само grace_period_days = 30 — нов код не може да
--     създаде 45-дневна заявка;
--   * идентичността и срокът остават неизменими (identity_immutable тригерът
--     пази и grace_period_days).
--
-- Fail-closed: исторически ред, чиято продължителност НЕ е точно 3 888 000
-- секунди, получава grace_period_days = NULL -> NOT NULL отказва копирането и
-- цялата миграция се връща назад, без да променя каквото и да е. Висящи
-- външни ключове след пресъздаването също отказват миграцията (guard таблица
-- с CHECK (0) върху pragma_foreign_key_check).
--
-- Миграцията не създава заявки, не сменя статуси и не стартира изтриване.
-- Всички колони, индекси, CHECK-ове и тригери са запазени; външните ключове
-- от profile_deletion_events / profile_deletion_file_queue /
-- profile_deletion_restore_tokens сочат по име и остават валидни. Тригерите
-- върху ДРУГИ таблици, които четат profile_deletion_requests, блокират
-- RENAME (SQLite проверява целия schema), затова се премахват временно и се
-- пресъздават ДОСЛОВНО.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

DROP TRIGGER trg_profile_deletion_events_profile_match;
DROP TRIGGER trg_profile_deletion_file_queue_insert_guard;
DROP TRIGGER trg_profile_deletion_restore_tokens_insert_guard;
DROP TRIGGER trg_tournament_entries_profile_deletion_admission_insert;
DROP TRIGGER trg_tournament_entries_profile_deletion_admission_update;

CREATE TABLE profile_deletion_requests_new (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 64),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  account_id_snapshot TEXT NOT NULL CHECK (length(account_id_snapshot) BETWEEN 1 AND 128),
  -- Дословно копие на profiles.created_at (формат CURRENT_TIMESTAMP) —
  -- втори независим идентификатор освен profile_id/account_id.
  profile_created_at_snapshot TEXT NOT NULL CHECK (length(profile_created_at_snapshot) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'cancelled', 'executing', 'completed', 'blocked', 'failed')
  ),
  requested_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', requested_at) IS requested_at
  ),
  -- Етап 4G: 30 за всички нови заявки; 45 само за запазени исторически.
  grace_period_days INTEGER NOT NULL DEFAULT 30 CHECK (grace_period_days IN (30, 45)),
  scheduled_for TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for) IS scheduled_for
    AND substr(scheduled_for, 20, 4) = substr(requested_at, 20, 4)
  ),
  cancelled_at TEXT NULL CHECK (
    cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) IS cancelled_at
  ),
  completed_at TEXT NULL CHECK (
    completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NULL CHECK (
    next_attempt_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at
  ),
  last_error_code TEXT NULL CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 200),
  last_error_at TEXT NULL CHECK (
    last_error_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_error_at) IS last_error_at
  ),
  lease_owner TEXT NULL CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at TEXT NULL CHECK (
    lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  db_deleted_at TEXT NULL CHECK (
    db_deleted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', db_deleted_at) IS db_deleted_at
  ),
  -- Точно grace_period_days × 24 часа след requested_at (реално изминало
  -- време в UTC — смяната на лятно/зимно време не го променя); срокът не
  -- може да бъде съкратен/удължен дори с ръчен SQL.
  CHECK (
    CAST(strftime('%s', scheduled_for) AS INTEGER) - CAST(strftime('%s', requested_at) AS INTEGER)
      = grace_period_days * 86400
  ),
  -- Lease съществува ТОЧНО когато заявката се изпълнява.
  CHECK (
    (status = 'executing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'executing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- Дословно копие; grace_period_days се извежда САМО от точните 3 888 000
-- секунди на стария CHECK (всичко друго -> NULL -> отказ на миграцията).
INSERT INTO profile_deletion_requests_new (
  request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, status,
  requested_at, grace_period_days, scheduled_for, cancelled_at, completed_at,
  attempt_count, next_attempt_at, last_error_code, last_error_at,
  lease_owner, lease_expires_at, created_at, updated_at, db_deleted_at
)
SELECT
  request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, status,
  requested_at,
  CASE
    WHEN CAST(strftime('%s', scheduled_for) AS INTEGER) - CAST(strftime('%s', requested_at) AS INTEGER) = 3888000
      THEN 45
    ELSE NULL
  END,
  scheduled_for, cancelled_at, completed_at,
  attempt_count, next_attempt_at, last_error_code, last_error_at,
  lease_owner, lease_expires_at, created_at, updated_at, db_deleted_at
FROM profile_deletion_requests;

DROP TABLE profile_deletion_requests;
ALTER TABLE profile_deletion_requests_new RENAME TO profile_deletion_requests;

-- ─── Индекси (дословно) ──────────────────────────────────────────────────
CREATE UNIQUE INDEX idx_profile_deletion_requests_active_profile
  ON profile_deletion_requests(profile_id)
  WHERE status IN ('pending', 'executing', 'blocked', 'failed');

CREATE INDEX idx_profile_deletion_requests_profile
  ON profile_deletion_requests(profile_id, requested_at);

CREATE INDEX idx_profile_deletion_requests_due
  ON profile_deletion_requests(scheduled_for)
  WHERE status = 'pending';

CREATE INDEX idx_profile_deletion_requests_lease
  ON profile_deletion_requests(lease_expires_at)
  WHERE status = 'executing';

CREATE INDEX idx_profile_deletion_requests_retry
  ON profile_deletion_requests(next_attempt_at)
  WHERE status IN ('blocked', 'failed');

-- ─── Тригери върху заявките ──────────────────────────────────────────────
-- Insert guard: както досега + Етап 4G — новата заявка е само 30-дневна
-- (45 съществува единствено в запазените исторически редове).
CREATE TRIGGER trg_profile_deletion_requests_insert_guard
BEFORE INSERT ON profile_deletion_requests
BEGIN
  SELECT CASE
    WHEN NEW.status IS NOT 'pending' OR NEW.attempt_count IS NOT 0
      OR NEW.lease_owner IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_request_must_start_pending')
    WHEN NEW.grace_period_days IS NOT 30
      THEN RAISE(ABORT, 'profile_deletion_grace_period_must_be_30_days')
    WHEN NEW.requested_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
      OR NEW.requested_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
      THEN RAISE(ABORT, 'profile_deletion_requested_at_out_of_window')
    WHEN NOT EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.profile_id = NEW.profile_id
        AND p.account_id = NEW.account_id_snapshot
        AND p.created_at = NEW.profile_created_at_snapshot
        AND p.profile_kind = 'human'
        AND p.is_temporary = 0
    )
      THEN RAISE(ABORT, 'profile_deletion_identity_mismatch')
  END;
END;

-- Идентичността и срокът (вкл. grace_period_days) са неизменими.
CREATE TRIGGER trg_profile_deletion_requests_identity_immutable
BEFORE UPDATE OF profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days
ON profile_deletion_requests
WHEN NEW.profile_id IS NOT OLD.profile_id
  OR NEW.account_id_snapshot IS NOT OLD.account_id_snapshot
  OR NEW.profile_created_at_snapshot IS NOT OLD.profile_created_at_snapshot
  OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.scheduled_for IS NOT OLD.scheduled_for
  OR NEW.grace_period_days IS NOT OLD.grace_period_days
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_request_identity_immutable');
END;

CREATE TRIGGER trg_profile_deletion_requests_status_transition
BEFORE UPDATE OF status ON profile_deletion_requests
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT CASE
    WHEN NOT (
      (OLD.status = 'pending' AND NEW.status IN ('cancelled', 'executing'))
      OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'pending', 'blocked', 'failed'))
      OR (OLD.status = 'blocked' AND NEW.status = 'executing')
      OR (OLD.status = 'failed' AND NEW.status = 'executing')
    )
      THEN RAISE(ABORT, 'profile_deletion_invalid_status_transition')
    WHEN OLD.status = 'pending' AND NEW.status = 'executing'
      AND OLD.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN RAISE(ABORT, 'profile_deletion_not_due')
    WHEN OLD.status = 'pending' AND NEW.status = 'cancelled'
      AND OLD.scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN RAISE(ABORT, 'profile_deletion_cancel_window_closed')
  END;
END;

CREATE TRIGGER trg_profile_deletion_requests_lease_guard
BEFORE UPDATE OF lease_owner ON profile_deletion_requests
WHEN OLD.status = 'executing'
  AND NEW.status = 'executing'
  AND NEW.lease_owner IS NOT OLD.lease_owner
  AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_lease_held');
END;

CREATE TRIGGER trg_profile_deletion_requests_close_restore_tokens
AFTER UPDATE OF status ON profile_deletion_requests
WHEN OLD.status = 'pending' AND NEW.status IS NOT 'pending'
BEGIN
  UPDATE profile_deletion_restore_tokens
  SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      consumed_reason = 'request_closed'
  WHERE request_id = NEW.request_id
    AND consumed_at IS NULL;
END;

CREATE TRIGGER trg_profile_deletion_requests_db_deleted_guard
BEFORE UPDATE OF db_deleted_at ON profile_deletion_requests
WHEN NEW.db_deleted_at IS NOT OLD.db_deleted_at
BEGIN
  SELECT CASE
    WHEN OLD.db_deleted_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_db_deleted_immutable')
    WHEN OLD.status IS NOT 'executing'
      THEN RAISE(ABORT, 'profile_deletion_db_deleted_requires_executing')
  END;
END;

CREATE TRIGGER trg_profile_deletion_requests_after_db_deleted
BEFORE UPDATE OF status ON profile_deletion_requests
WHEN OLD.db_deleted_at IS NOT NULL
  AND OLD.status = 'executing'
  AND NEW.status IN ('pending', 'blocked')
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_db_already_deleted');
END;

CREATE TRIGGER trg_profile_deletion_requests_completion_guard
BEFORE UPDATE OF status ON profile_deletion_requests
WHEN OLD.status = 'executing' AND NEW.status = 'completed'
BEGIN
  SELECT CASE
    WHEN NEW.db_deleted_at IS NULL
      THEN RAISE(ABORT, 'profile_deletion_completion_requires_db_deleted')
    WHEN EXISTS (
      SELECT 1 FROM profile_deletion_file_queue q
      WHERE q.request_id = OLD.request_id
        AND q.status NOT IN ('done', 'skipped_shared')
    )
      THEN RAISE(ABORT, 'profile_deletion_completion_files_pending')
  END;
END;

-- ─── Тригери върху други таблици (дословно) ──────────────────────────────
CREATE TRIGGER trg_profile_deletion_events_profile_match
BEFORE INSERT ON profile_deletion_events
WHEN NEW.profile_id IS NOT (
  SELECT profile_id FROM profile_deletion_requests WHERE request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_event_profile_mismatch');
END;

CREATE TRIGGER trg_profile_deletion_file_queue_insert_guard
BEFORE INSERT ON profile_deletion_file_queue
BEGIN
  SELECT CASE
    WHEN NEW.status IS NOT 'pending' OR NEW.attempt_count IS NOT 0
      OR NEW.lease_owner IS NOT NULL OR NEW.completed_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_file_must_start_pending')
    WHEN NEW.admin_operation_id IS NULL
      AND (SELECT status FROM profile_deletion_requests WHERE request_id = NEW.request_id) IS NOT 'executing'
      THEN RAISE(ABORT, 'profile_deletion_file_requires_executing_request')
    WHEN NEW.admin_operation_id IS NOT NULL AND (
      NEW.request_id IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM admin_profile_deletions a
        WHERE a.log_id = NEW.admin_operation_id AND a.file_cleanup_status = 'pending'
      )
    )
      THEN RAISE(ABORT, 'profile_deletion_file_requires_admin_operation')
  END;
END;

CREATE TRIGGER trg_profile_deletion_restore_tokens_insert_guard
BEFORE INSERT ON profile_deletion_restore_tokens
BEGIN
  SELECT CASE
    WHEN NEW.consumed_at IS NOT NULL OR NEW.consumed_reason IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_restore_token_must_start_unused')
    WHEN NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      OR NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes')
      THEN RAISE(ABORT, 'profile_deletion_restore_token_invalid_expiry')
    WHEN NOT EXISTS (
      SELECT 1 FROM profile_deletion_requests r
      WHERE r.request_id = NEW.request_id
        AND r.profile_id = NEW.profile_id
        AND r.status = 'pending'
        AND r.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
      THEN RAISE(ABORT, 'profile_deletion_restore_token_request_not_pending')
  END;
END;

CREATE TRIGGER trg_tournament_entries_profile_deletion_admission_insert
BEFORE INSERT ON tournament_entries
WHEN NEW.profile_id IS NOT NULL
  AND NEW.status IN ('confirmed', 'finalist')
  AND EXISTS (
    SELECT 1 FROM profile_deletion_requests r
    WHERE r.profile_id = NEW.profile_id
      AND r.status IN ('pending', 'executing', 'blocked', 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_pending_tournament_admission');
END;

CREATE TRIGGER trg_tournament_entries_profile_deletion_admission_update
BEFORE UPDATE OF status, profile_id ON tournament_entries
WHEN NEW.profile_id IS NOT NULL
  AND NEW.status IN ('confirmed', 'finalist')
  AND (OLD.status NOT IN ('confirmed', 'finalist') OR NEW.profile_id IS NOT OLD.profile_id)
  AND EXISTS (
    SELECT 1 FROM profile_deletion_requests r
    WHERE r.profile_id = NEW.profile_id
      AND r.status IN ('pending', 'executing', 'blocked', 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_pending_tournament_admission');
END;

-- ─── Fail-closed: външните ключове към заявките остават валидни ─────────
CREATE TEMP TABLE profile_deletion_4g_fk_guard (
  table_name TEXT,
  CHECK (0)
);
INSERT INTO profile_deletion_4g_fk_guard (table_name)
  SELECT "table" FROM pragma_foreign_key_check('profile_deletion_events')
  UNION ALL SELECT "table" FROM pragma_foreign_key_check('profile_deletion_file_queue')
  UNION ALL SELECT "table" FROM pragma_foreign_key_check('profile_deletion_restore_tokens');
DROP TABLE profile_deletion_4g_fk_guard;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261101_001_voluntary_deletion_30_day_grace_period.sql');

COMMIT;

PRAGMA foreign_keys = ON;
