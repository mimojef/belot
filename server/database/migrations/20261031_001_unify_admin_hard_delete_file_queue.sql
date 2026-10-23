-- MANUAL_TRANSACTION_MIGRATION
-- Самоизтриване на профили — Етап 4F2: административното окончателно
-- изтриване използва СЪЩАТА надеждна файлова опашка като самоизтриването.
--
-- Собствена транзакция (MANUAL_TRANSACTION_MIGRATION), защото т. 1
-- пресъздава таблица, а PRAGMA foreign_keys не може да се изключи вътре в
-- отворена транзакция (established pattern: 20260923_004, 20261026_001,
-- 20261027_001).
--
-- 1. profile_deletion_file_queue — втори легитимен собственик на ред:
--    административната операция (admin_operation_id = admin_profile_deletions.log_id
--    = operationId в регистъра на изтриванията). Без фиктивни заявки за
--    самоизтриване: request_id става NULL за тези редове, а CHECK изисква
--    ТОЧНО един собственик. Всички останали колони, CHECK-ове, UNIQUE и
--    тригери са запазени; insert guard-ът приема административен ред само за
--    одитен ред с file_cleanup_status = 'pending' (т.е. в същата транзакция
--    като изтриването). Без FK към admin_profile_deletions — връзката се
--    проверява от тригера при INSERT (одитните редове нямат UNIQUE/RESTRICT
--    история и не се пипат тук).
--    trg_profile_deletion_requests_completion_guard (върху заявките) чете
--    опашката — SQLite отказва RENAME, докато тригер сочи липсваща таблица,
--    затова той се премахва временно и се пресъздава ДОСЛОВНО.
--
-- 2. admin_profile_deletions.file_cleanup_status — разграничава "данните в
--    базата са изтрити" (одитният ред/admin_delete_completed в регистъра) от
--    "физическите файлове са обработени":
--      NULL      — изтриване отпреди 4F2 (стар best-effort механизъм);
--      'pending' — файловите операции в опашката не са приключили;
--      'done'    — всички са done/skipped_shared (тригерът го гарантира).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

DROP TRIGGER trg_profile_deletion_requests_completion_guard;

-- ─── 1. Опашката: заявка ИЛИ административна операция ───────────────────
CREATE TABLE profile_deletion_file_queue_new (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NULL,
  admin_operation_id TEXT NULL CHECK (
    admin_operation_id IS NULL OR length(admin_operation_id) BETWEEN 1 AND 128
  ),
  file_kind TEXT NOT NULL CHECK (
    file_kind IN (
      'avatar',
      'gallery_image',
      'gallery_thumbnail',
      'chat_attachment',
      'topic_attachment',
      'topic_mute_evidence_attachment',
      'support_attachment'
    )
  ),
  storage_ref TEXT NOT NULL CHECK (
    length(storage_ref) BETWEEN 1 AND 512
    AND instr(storage_ref, '..') = 0
    AND instr(storage_ref, char(92)) = 0
    AND instr(storage_ref, char(0)) = 0
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'done', 'skipped_shared', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NULL CHECK (
    next_attempt_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at
  ),
  last_error_code TEXT NULL CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 200),
  lease_owner TEXT NULL CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at TEXT NULL CHECK (
    lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT NULL CHECK (
    completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at
  ),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status IN ('done', 'skipped_shared')) = (completed_at IS NOT NULL)),
  -- Точно един собственик: заявка за самоизтриване ИЛИ административна операция.
  CHECK ((request_id IS NULL) <> (admin_operation_id IS NULL)),
  -- Идемпотентно enqueue-ване (INSERT OR IGNORE) — един файл веднъж на собственик.
  UNIQUE (request_id, file_kind, storage_ref),
  UNIQUE (admin_operation_id, file_kind, storage_ref),
  FOREIGN KEY (request_id) REFERENCES profile_deletion_requests(request_id) ON DELETE RESTRICT
);

INSERT INTO profile_deletion_file_queue_new (
  queue_id, request_id, admin_operation_id, file_kind, storage_ref, status, attempt_count,
  next_attempt_at, last_error_code, lease_owner, lease_expires_at, created_at, updated_at, completed_at
)
SELECT
  queue_id, request_id, NULL, file_kind, storage_ref, status, attempt_count,
  next_attempt_at, last_error_code, lease_owner, lease_expires_at, created_at, updated_at, completed_at
FROM profile_deletion_file_queue;

-- AUTOINCREMENT брояч: нито един queue_id не се преизползва.
UPDATE sqlite_sequence
SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'profile_deletion_file_queue'), 0))
WHERE name = 'profile_deletion_file_queue_new';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'profile_deletion_file_queue_new', seq FROM sqlite_sequence
WHERE name = 'profile_deletion_file_queue'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'profile_deletion_file_queue_new');

DROP TABLE profile_deletion_file_queue;
ALTER TABLE profile_deletion_file_queue_new RENAME TO profile_deletion_file_queue;

CREATE INDEX idx_profile_deletion_file_queue_ready
  ON profile_deletion_file_queue(next_attempt_at, queue_id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_profile_deletion_file_queue_lease
  ON profile_deletion_file_queue(lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX idx_profile_deletion_file_queue_request
  ON profile_deletion_file_queue(request_id, status);

CREATE INDEX idx_profile_deletion_file_queue_admin_operation
  ON profile_deletion_file_queue(admin_operation_id, status)
  WHERE admin_operation_id IS NOT NULL;

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

CREATE TRIGGER trg_profile_deletion_file_queue_identity_immutable
BEFORE UPDATE OF request_id, admin_operation_id, file_kind, storage_ref ON profile_deletion_file_queue
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.admin_operation_id IS NOT OLD.admin_operation_id
  OR NEW.file_kind IS NOT OLD.file_kind
  OR NEW.storage_ref IS NOT OLD.storage_ref
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_file_identity_immutable');
END;

CREATE TRIGGER trg_profile_deletion_file_queue_status_transition
BEFORE UPDATE OF status ON profile_deletion_file_queue
WHEN NEW.status IS NOT OLD.status
  AND NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('done', 'skipped_shared', 'failed', 'pending'))
    OR (OLD.status = 'failed' AND NEW.status = 'processing')
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_file_invalid_status_transition');
END;

CREATE TRIGGER trg_profile_deletion_file_queue_lease_guard
BEFORE UPDATE OF lease_owner ON profile_deletion_file_queue
WHEN OLD.status = 'processing'
  AND NEW.status = 'processing'
  AND NEW.lease_owner IS NOT OLD.lease_owner
  AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_file_lease_held');
END;

CREATE TRIGGER trg_profile_deletion_file_queue_no_delete
BEFORE DELETE ON profile_deletion_file_queue
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_file_queue_no_delete');
END;

-- Дословно пресъздаден (20261026_001).
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

-- ─── 2. Файлова фаза на административното изтриване ─────────────────────
ALTER TABLE admin_profile_deletions ADD COLUMN file_cleanup_status TEXT NULL CHECK (
  file_cleanup_status IS NULL OR file_cleanup_status IN ('pending', 'done')
);

CREATE INDEX idx_admin_profile_deletions_file_cleanup_pending
  ON admin_profile_deletions(file_cleanup_status)
  WHERE file_cleanup_status = 'pending';

-- Само pending -> done и само когато нито една файлова операция на
-- операцията не е останала недовършена.
CREATE TRIGGER trg_admin_profile_deletions_file_cleanup_guard
BEFORE UPDATE OF file_cleanup_status ON admin_profile_deletions
WHEN NEW.file_cleanup_status IS NOT OLD.file_cleanup_status
BEGIN
  SELECT CASE
    WHEN NOT (OLD.file_cleanup_status IS 'pending' AND NEW.file_cleanup_status IS 'done')
      THEN RAISE(ABORT, 'admin_profile_deletion_file_cleanup_invalid_transition')
    WHEN EXISTS (
      SELECT 1 FROM profile_deletion_file_queue q
      WHERE q.admin_operation_id = OLD.log_id
        AND q.status NOT IN ('done', 'skipped_shared')
    )
      THEN RAISE(ABORT, 'admin_profile_deletion_files_pending')
  END;
END;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261031_001_unify_admin_hard_delete_file_queue.sql');

COMMIT;

PRAGMA foreign_keys = ON;
