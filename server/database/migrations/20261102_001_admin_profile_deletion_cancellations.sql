-- Самоизтриване на профили — Етап 4J: контролирана административна отмяна
-- на доброволна заявка за изтриване.
--
-- 1. profile_deletion_admin_cancellations — одитен ред за всяка
--    административна отмяна: кой администратор (profile/account), причина,
--    предишният статус и кога. Append-only (без UPDATE/DELETE). Най-много
--    един ред на заявка. Без лични данни на потребителя — само ID-то на
--    заявката (самата заявка не се трие никога).
--
-- 2. trg_profile_deletion_requests_status_transition се пресъздава с
--    ЕДИНСТВЕНОТО разширение: когато в СЪЩАТА транзакция има одитен ред от
--    т. 1, отмяната е позволена и след крайния срок (pending -> cancelled) и
--    от blocked/failed -> cancelled. Без такъв ред всичко остава дословно
--    като досега — потребителската (и системната) отмяна след срока
--    продължава да се отказва с profile_deletion_cancel_window_closed, а
--    blocked/failed -> cancelled с profile_deletion_invalid_status_transition.
--    Нова защита: отмяна след db_deleted_at (необратимата граница) се
--    отказва винаги.
--
--    Сървърът допуска административна отмяна САМО за заявка без запис в
--    регистъра на изтриванията (регистърът е append-only и се копира извън
--    VPS — вече записано намерение не може да бъде оттеглено без отделен
--    протокол); тази проверка е в кода (регистърът е файл извън SQLite).

CREATE TABLE profile_deletion_admin_cancellations (
  cancellation_id TEXT PRIMARY KEY CHECK (length(cancellation_id) BETWEEN 1 AND 64),
  request_id TEXT NOT NULL UNIQUE,
  actor_profile_id TEXT NOT NULL CHECK (length(actor_profile_id) BETWEEN 1 AND 128),
  actor_account_id TEXT NOT NULL CHECK (length(actor_account_id) BETWEEN 1 AND 128),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500 AND length(reason) <= 500),
  previous_status TEXT NOT NULL CHECK (previous_status IN ('pending', 'blocked', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (request_id) REFERENCES profile_deletion_requests(request_id) ON DELETE RESTRICT
);

-- Одитният ред се създава само за заявка, която в момента може да бъде
-- отменена от администратор: pending/blocked/failed, без lease, преди
-- необратимата граница, и previous_status съвпада с текущия статус.
CREATE TRIGGER trg_profile_deletion_admin_cancellations_insert_guard
BEFORE INSERT ON profile_deletion_admin_cancellations
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM profile_deletion_requests r
      WHERE r.request_id = NEW.request_id
        AND r.status = NEW.previous_status
        AND r.status IN ('pending', 'blocked', 'failed')
        AND r.lease_owner IS NULL
        AND r.db_deleted_at IS NULL
    )
      THEN RAISE(ABORT, 'profile_deletion_admin_cancellation_not_allowed')
  END;
END;

CREATE TRIGGER trg_profile_deletion_admin_cancellations_no_update
BEFORE UPDATE ON profile_deletion_admin_cancellations
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_admin_cancellations_append_only');
END;

CREATE TRIGGER trg_profile_deletion_admin_cancellations_no_delete
BEFORE DELETE ON profile_deletion_admin_cancellations
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_admin_cancellations_append_only');
END;

DROP TRIGGER trg_profile_deletion_requests_status_transition;

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
      OR (
        OLD.status IN ('blocked', 'failed') AND NEW.status = 'cancelled'
        AND EXISTS (SELECT 1 FROM profile_deletion_admin_cancellations a WHERE a.request_id = OLD.request_id)
      )
    )
      THEN RAISE(ABORT, 'profile_deletion_invalid_status_transition')
    WHEN NEW.status = 'cancelled' AND OLD.db_deleted_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_db_already_deleted')
    WHEN OLD.status = 'pending' AND NEW.status = 'executing'
      AND OLD.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN RAISE(ABORT, 'profile_deletion_not_due')
    WHEN OLD.status = 'pending' AND NEW.status = 'cancelled'
      AND OLD.scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND NOT EXISTS (SELECT 1 FROM profile_deletion_admin_cancellations a WHERE a.request_id = OLD.request_id)
      THEN RAISE(ABORT, 'profile_deletion_cancel_window_closed')
  END;
END;
