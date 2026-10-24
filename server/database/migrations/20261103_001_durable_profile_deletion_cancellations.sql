-- Самоизтриване на профили — Етап 4J1: отмяната на доброволна заявка
-- оцелява при restore на стар backup.
--
-- Проблем (4J): отмяната беше само ред в SQLite. Restore на копие отпреди
-- отмяната връщаше чакащата заявка и worker-ът можеше да я изпълни; а запис
-- за заявката в регистъра на изтриванията (JSONL извън базата) се прилагаше
-- повторно от reconcile дори когато заявката после е била отменена.
--
-- Двуфазен протокол (виж src/core/profileDeletionCancellationFinalizer.ts):
--   1. Приемане — ред в profile_deletion_cancellations (тази таблица) в
--      същата транзакция, в която се проверяват правата/срокът. От този
--      момент worker-ът НЕ може да вземе заявката (claim + тригер) и не може
--      да маркира изтриване в базата (тригер), независимо от offsite backup-а.
--   2. Запис "request_cancelled" в СЪЩИЯ регистър (ledger_recorded_at).
--   3. Финализиране — едва когато записът е потвърден извън VPS (offsite
--      ack): finalized_at + статус 'cancelled' на заявката.
-- Заявката запазва статуса си (pending/blocked/failed) до финализирането,
-- затова профилът остава скрит, докато отмяната не е окончателна.
--
-- Правилата в базата:
--   * потребителска/системна отмяна — само pending и преди scheduled_for
--     (проверено при ПРИЕМАНЕТО; по-късното финализиране след срока е
--     валидно, защото намерението е прието навреме);
--   * административна — само с одитен ред (profile_deletion_admin_cancellations,
--     Етап 4J) в същата транзакция; и след срока, и от blocked/failed;
--   * възстановена от регистъра (recovered_from_ledger = 1: restore/worker
--     откриват запис "request_cancelled") — фактът вече е записан, затова без
--     проверка на срока/одита;
--   * никога при активен lease, след db_deleted_at или без профил;
--   * преходът към 'cancelled' изисква ФИНАЛИЗИРАН ред (без изключения);
--   * преход към 'executing' и маркиране на изтриване при наличен ред (дори
--     нефинализиран) се отказват.
-- Таблицата не съдържа лични данни — само технически идентификатори.

CREATE TABLE profile_deletion_cancellations (
  cancellation_id TEXT PRIMARY KEY CHECK (
    length(cancellation_id) BETWEEN 1 AND 64
    AND cancellation_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
  ),
  request_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (source IN ('user', 'admin', 'system')),
  recovered_from_ledger INTEGER NOT NULL DEFAULT 0 CHECK (recovered_from_ledger IN (0, 1)),
  previous_status TEXT NOT NULL CHECK (previous_status IN ('pending', 'blocked', 'failed')),
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ledger_recorded_at TEXT NULL CHECK (
    ledger_recorded_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', ledger_recorded_at) IS ledger_recorded_at
  ),
  finalized_at TEXT NULL CHECK (
    finalized_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', finalized_at) IS finalized_at
  ),
  CHECK (finalized_at IS NULL OR ledger_recorded_at IS NOT NULL),
  CHECK (recovered_from_ledger = 0 OR ledger_recorded_at IS NOT NULL),
  FOREIGN KEY (request_id) REFERENCES profile_deletion_requests(request_id) ON DELETE RESTRICT
);

CREATE INDEX idx_profile_deletion_cancellations_unfinalized
  ON profile_deletion_cancellations(accepted_at)
  WHERE finalized_at IS NULL;

CREATE TRIGGER trg_profile_deletion_cancellations_insert_guard
BEFORE INSERT ON profile_deletion_cancellations
BEGIN
  SELECT CASE
    WHEN NEW.finalized_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_cancellation_must_start_unfinalized')
    WHEN NEW.recovered_from_ledger = 0 AND NEW.ledger_recorded_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_cancellation_must_start_unrecorded')
    WHEN NOT EXISTS (
      SELECT 1 FROM profile_deletion_requests r
      WHERE r.request_id = NEW.request_id
        AND r.profile_id = NEW.profile_id
        AND r.status = NEW.previous_status
        AND r.status IN ('pending', 'blocked', 'failed')
        AND r.lease_owner IS NULL
        AND r.db_deleted_at IS NULL
    )
      THEN RAISE(ABORT, 'profile_deletion_cancellation_not_allowed')
    WHEN NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = NEW.profile_id)
      THEN RAISE(ABORT, 'profile_deletion_cancellation_profile_missing')
    WHEN NEW.recovered_from_ledger = 0 AND NEW.source IN ('user', 'system') AND NOT EXISTS (
      SELECT 1 FROM profile_deletion_requests r
      WHERE r.request_id = NEW.request_id
        AND r.status = 'pending'
        AND r.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
      THEN RAISE(ABORT, 'profile_deletion_cancel_window_closed')
    WHEN NEW.recovered_from_ledger = 0 AND NEW.source = 'admin' AND NOT EXISTS (
      SELECT 1 FROM profile_deletion_admin_cancellations a WHERE a.request_id = NEW.request_id
    )
      THEN RAISE(ABORT, 'profile_deletion_admin_cancellation_audit_required')
  END;
END;

-- Само ledger_recorded_at и finalized_at се попълват (веднъж, NULL -> стойност).
CREATE TRIGGER trg_profile_deletion_cancellations_update_guard
BEFORE UPDATE ON profile_deletion_cancellations
BEGIN
  SELECT CASE
    WHEN NEW.cancellation_id IS NOT OLD.cancellation_id
      OR NEW.request_id IS NOT OLD.request_id
      OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.source IS NOT OLD.source
      OR NEW.recovered_from_ledger IS NOT OLD.recovered_from_ledger
      OR NEW.previous_status IS NOT OLD.previous_status
      OR NEW.accepted_at IS NOT OLD.accepted_at
      OR (OLD.ledger_recorded_at IS NOT NULL AND NEW.ledger_recorded_at IS NOT OLD.ledger_recorded_at)
      OR (OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS NOT OLD.finalized_at)
      THEN RAISE(ABORT, 'profile_deletion_cancellation_immutable')
  END;
END;

CREATE TRIGGER trg_profile_deletion_cancellations_no_delete
BEFORE DELETE ON profile_deletion_cancellations
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_cancellation_immutable');
END;

-- Преходите: blocked/failed -> cancelled вече са базово допустими, но ВСЕКИ
-- преход към 'cancelled' изисква финализиран ред по-горе (замества
-- условията от 4G/4J за срока и одита — те се проверяват при приемането).
DROP TRIGGER trg_profile_deletion_requests_status_transition;

CREATE TRIGGER trg_profile_deletion_requests_status_transition
BEFORE UPDATE OF status ON profile_deletion_requests
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT CASE
    WHEN NOT (
      (OLD.status = 'pending' AND NEW.status IN ('cancelled', 'executing'))
      OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'pending', 'blocked', 'failed'))
      OR (OLD.status IN ('blocked', 'failed') AND NEW.status IN ('executing', 'cancelled'))
    )
      THEN RAISE(ABORT, 'profile_deletion_invalid_status_transition')
    WHEN NEW.status = 'cancelled' AND OLD.db_deleted_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_db_already_deleted')
    WHEN NEW.status = 'cancelled' AND NOT EXISTS (
      SELECT 1 FROM profile_deletion_cancellations c
      WHERE c.request_id = OLD.request_id AND c.finalized_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'profile_deletion_cancellation_not_finalized')
    WHEN NEW.status = 'executing' AND OLD.status IN ('pending', 'blocked', 'failed') AND EXISTS (
      SELECT 1 FROM profile_deletion_cancellations c WHERE c.request_id = OLD.request_id
    )
      THEN RAISE(ABORT, 'profile_deletion_cancellation_pending')
    WHEN OLD.status = 'pending' AND NEW.status = 'executing'
      AND OLD.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN RAISE(ABORT, 'profile_deletion_not_due')
  END;
END;

-- Защита в дълбочина: изтриване в базата при приета отмяна е невъзможно.
DROP TRIGGER trg_profile_deletion_requests_db_deleted_guard;

CREATE TRIGGER trg_profile_deletion_requests_db_deleted_guard
BEFORE UPDATE OF db_deleted_at ON profile_deletion_requests
WHEN NEW.db_deleted_at IS NOT OLD.db_deleted_at
BEGIN
  SELECT CASE
    WHEN OLD.db_deleted_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_db_deleted_immutable')
    WHEN OLD.status IS NOT 'executing'
      THEN RAISE(ABORT, 'profile_deletion_db_deleted_requires_executing')
    WHEN EXISTS (SELECT 1 FROM profile_deletion_cancellations c WHERE c.request_id = OLD.request_id)
      THEN RAISE(ABORT, 'profile_deletion_cancellation_pending')
  END;
END;
