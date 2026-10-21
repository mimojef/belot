-- Самоизтриване на профили — Етап 1: неактивна инфраструктура.
--
-- Три нови таблици, които НИКОЙ runtime код все още не чете/пише (няма
-- endpoint, worker или UI на този етап). Съществуващите таблици profiles и
-- accounts НЕ се променят — само тригерът при INSERT чете profiles, за да
-- провери идентичността на профила в момента на подаване на заявката.
--
-- Формат на времената: каноничен UTC ISO-8601 с милисекунди
-- ('YYYY-MM-DDTHH:MM:SS.sssZ') — същият като Date.prototype.toISOString() и
-- strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), затова низовото сравнение е
-- хронологично коректно (виж authStore.ts buildValidSessionSelectSql за
-- капана с формата на CURRENT_TIMESTAMP). CHECK-овете по-долу отхвърлят
-- всеки друг формат чрез round-trip през strftime().

-- ─── 1. profile_deletion_requests ───────────────────────────────────────────
--
-- Без FOREIGN KEY към profiles НАРОЧНО: редът трябва да оцелее
-- окончателното DELETE FROM profiles и да остане като tombstone (нужен за
-- повторно прилагане на изтриването след restore от бекъп). Идентичността
-- на профила се snapshot-ва (account_id + created_at) и се проверява от
-- тригера при INSERT; worker-ът в следващ етап ще я провери отново вътре в
-- транзакцията на окончателното изтриване (защита от изтриване на грешен
-- профил).
--
-- Статуси:
--   pending   — 45-дневният срок тече; заявката може да бъде отменена.
--   cancelled — отменена от потребителя преди scheduled_for (терминален).
--   executing — взета от worker (lease_owner/lease_expires_at задължителни).
--   completed — окончателното изтриване е извършено (терминален, tombstone).
--   blocked   — изтриването е спряно от защитна проверка; повторен опит.
--   failed    — изчерпани опити; изисква намеса, повторен опит през executing.
CREATE TABLE profile_deletion_requests (
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
  -- Точно 45 × 24 часа след requested_at (3 888 000 секунди, същите
  -- милисекунди) — сроят не може да бъде съкратен/удължен дори с ръчен SQL.
  scheduled_for TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for) IS scheduled_for
    AND CAST(strftime('%s', scheduled_for) AS INTEGER) - CAST(strftime('%s', requested_at) AS INTEGER) = 3888000
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
  -- Lease съществува ТОЧНО когато заявката се изпълнява.
  CHECK (
    (status = 'executing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'executing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- Най-много една активна заявка на профил. cancelled/completed не участват,
-- затова след отмяна може да се подаде нова заявка.
CREATE UNIQUE INDEX idx_profile_deletion_requests_active_profile
  ON profile_deletion_requests(profile_id)
  WHERE status IN ('pending', 'executing', 'blocked', 'failed');

CREATE INDEX idx_profile_deletion_requests_profile
  ON profile_deletion_requests(profile_id, requested_at);

-- Worker claim: чакащи заявки с изтекъл срок.
CREATE INDEX idx_profile_deletion_requests_due
  ON profile_deletion_requests(scheduled_for)
  WHERE status = 'pending';

-- Поемане на изоставен lease (срив/рестарт на процеса по време на изпълнение).
CREATE INDEX idx_profile_deletion_requests_lease
  ON profile_deletion_requests(lease_expires_at)
  WHERE status = 'executing';

CREATE INDEX idx_profile_deletion_requests_retry
  ON profile_deletion_requests(next_attempt_at)
  WHERE status IN ('blocked', 'failed');

-- Нова заявка винаги започва като pending с 0 опита, с requested_at близо до
-- часовника на базата (±5 мин — не може да бъде датирана назад, за да се
-- съкрати реалният 45-дневен срок), и само за съществуващ, постоянен
-- човешки профил, чиято идентичност съвпада със snapshot-а.
CREATE TRIGGER trg_profile_deletion_requests_insert_guard
BEFORE INSERT ON profile_deletion_requests
BEGIN
  SELECT CASE
    WHEN NEW.status IS NOT 'pending' OR NEW.attempt_count IS NOT 0
      OR NEW.lease_owner IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_request_must_start_pending')
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

-- Идентичността и срокът са неизменими след създаване.
CREATE TRIGGER trg_profile_deletion_requests_identity_immutable
BEFORE UPDATE OF profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for
ON profile_deletion_requests
WHEN NEW.profile_id IS NOT OLD.profile_id
  OR NEW.account_id_snapshot IS NOT OLD.account_id_snapshot
  OR NEW.profile_created_at_snapshot IS NOT OLD.profile_created_at_snapshot
  OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.scheduled_for IS NOT OLD.scheduled_for
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_request_identity_immutable');
END;

-- Позволени статусни преходи (огледало на ALLOWED_TRANSITIONS в
-- server/src/db/profileDeletionSchedule.ts — тестът проверява, че двете
-- съвпадат за всички 36 двойки):
--   pending   -> cancelled | executing
--   executing -> completed | pending | blocked | failed
--   blocked   -> executing
--   failed    -> executing
--   cancelled, completed — терминални.
-- Плюс времевата граница спрямо часовника на базата — двете условия са
-- взаимно допълващи се (без празнина и без застъпване):
--   отмяна  е възможна само при now <  scheduled_for;
--   изпълнение започва само при now >= scheduled_for.
-- Един тригер с CASE (не няколко), за да е детерминирано коя грешка се връща.
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

-- Жив lease не може да бъде отнет от друг worker (защита от двойна
-- обработка при няколко процеса). Поемане е възможно само след изтичане.
CREATE TRIGGER trg_profile_deletion_requests_lease_guard
BEFORE UPDATE OF lease_owner ON profile_deletion_requests
WHEN OLD.status = 'executing'
  AND NEW.status = 'executing'
  AND NEW.lease_owner IS NOT OLD.lease_owner
  AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_lease_held');
END;

-- ─── 2. profile_deletion_events ─────────────────────────────────────────────
--
-- Append-only журнал. Без лични данни освен ID-та; detail_json е само за
-- технически кодове/броячи. FK към заявката (не към profiles) — заявките
-- не се трият, затова FK-ът допълнително пази tombstone-а.
CREATE TABLE profile_deletion_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'requested',
      'cancelled',
      'claimed',
      'lease_reclaimed',
      'retry_scheduled',
      'blocked',
      'failed',
      'db_deleted',
      'file_enqueued',
      'file_deleted',
      'file_skipped_shared',
      'file_failed',
      'completed'
    )
  ),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system', 'admin')),
  worker_id TEXT NULL CHECK (worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 128),
  detail_json TEXT NULL CHECK (detail_json IS NULL OR (json_valid(detail_json) AND length(detail_json) <= 4000)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (request_id) REFERENCES profile_deletion_requests(request_id) ON DELETE RESTRICT
);

CREATE INDEX idx_profile_deletion_events_request
  ON profile_deletion_events(request_id, event_seq);

CREATE INDEX idx_profile_deletion_events_profile
  ON profile_deletion_events(profile_id, event_seq);

-- profile_id в събитието трябва да е същият като в заявката.
CREATE TRIGGER trg_profile_deletion_events_profile_match
BEFORE INSERT ON profile_deletion_events
WHEN NEW.profile_id IS NOT (
  SELECT profile_id FROM profile_deletion_requests WHERE request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_event_profile_mismatch');
END;

CREATE TRIGGER trg_profile_deletion_events_no_update
BEFORE UPDATE ON profile_deletion_events
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_events_append_only');
END;

CREATE TRIGGER trg_profile_deletion_events_no_delete
BEFORE DELETE ON profile_deletion_events
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_events_append_only');
END;

-- ─── 3. profile_deletion_file_queue ─────────────────────────────────────────
--
-- Постоянна опашка за физическите файлове. Записите ще се създават в СЪЩАТА
-- транзакция като окончателното изтриване в базата (следващ етап), а
-- самият unlink — едва след COMMIT, с повторни опити. Тригерът по-долу
-- разрешава INSERT само за заявка в статус executing — т.е. никой файл на
-- профил в 45-дневния (възстановим) период не може да попадне в опашката.
--
-- storage_ref е URL под /uploads/ или storage filename; CHECK-ът е само
-- първа линия — реалната path-safety проверка остава в кода (както днес в
-- deleteUploadFileByUrl).
--
-- Статуси:
--   pending        — чака обработка (или повторен опит след next_attempt_at).
--   processing     — взет от worker (lease задължителен).
--   done           — файлът е изтрит или вече липсва (ENOENT) — терминален.
--   skipped_shared — файлът още се реферира другаде, НЕ е изтрит — терминален.
--   failed         — грешка; повторен опит през processing.
CREATE TABLE profile_deletion_file_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
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
  -- Идемпотентно enqueue-ване (INSERT OR IGNORE) — един файл веднъж на заявка.
  UNIQUE (request_id, file_kind, storage_ref),
  FOREIGN KEY (request_id) REFERENCES profile_deletion_requests(request_id) ON DELETE RESTRICT
);

CREATE INDEX idx_profile_deletion_file_queue_ready
  ON profile_deletion_file_queue(next_attempt_at, queue_id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_profile_deletion_file_queue_lease
  ON profile_deletion_file_queue(lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX idx_profile_deletion_file_queue_request
  ON profile_deletion_file_queue(request_id, status);

CREATE TRIGGER trg_profile_deletion_file_queue_insert_guard
BEFORE INSERT ON profile_deletion_file_queue
BEGIN
  SELECT CASE
    WHEN NEW.status IS NOT 'pending' OR NEW.attempt_count IS NOT 0
      OR NEW.lease_owner IS NOT NULL OR NEW.completed_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_file_must_start_pending')
    WHEN (SELECT status FROM profile_deletion_requests WHERE request_id = NEW.request_id) IS NOT 'executing'
      THEN RAISE(ABORT, 'profile_deletion_file_requires_executing_request')
  END;
END;

CREATE TRIGGER trg_profile_deletion_file_queue_identity_immutable
BEFORE UPDATE OF request_id, file_kind, storage_ref ON profile_deletion_file_queue
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.file_kind IS NOT OLD.file_kind
  OR NEW.storage_ref IS NOT OLD.storage_ref
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_file_identity_immutable');
END;

-- Позволени преходи (огледало на ALLOWED_FILE_TRANSITIONS):
--   pending    -> processing
--   processing -> done | skipped_shared | failed | pending
--   failed     -> processing
--   done, skipped_shared — терминални.
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
