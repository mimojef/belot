-- Самоизтриване на профили — Етап 4K2: еднократно уведомление след
-- автоматична (системна) отмяна на доброволна заявка заради установен
-- игрови ангажимент (заето място на маса или участие в игра, открити от друг
-- процес или при възстановяване на игра след рестарт).
--
-- Само ID-то на отмяната и кога уведомлението е показано — без лични данни и
-- без текстове. Не се записва в регистъра на изтриванията (уведомлението не е
-- част от решението дали профилът да бъде изтрит).
--
-- Инварианти (тригери):
--   * ред има само за отмяна с source = 'system';
--   * започва непоказан; показва се (delivered_at) веднъж и само след като
--     отмяната е окончателна (finalized_at — след offsite потвърждението);
--   * delivered_at не се връща обратно.

CREATE TABLE profile_deletion_auto_cancellation_notices (
  cancellation_id TEXT PRIMARY KEY REFERENCES profile_deletion_cancellations(cancellation_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT NULL CHECK (
    delivered_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) IS delivered_at
  )
);

CREATE TRIGGER trg_profile_deletion_auto_cancellation_notices_insert_guard
BEFORE INSERT ON profile_deletion_auto_cancellation_notices
BEGIN
  SELECT CASE
    WHEN NEW.delivered_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_notice_must_start_undelivered')
    WHEN NOT EXISTS (
      SELECT 1 FROM profile_deletion_cancellations c
      WHERE c.cancellation_id = NEW.cancellation_id AND c.source = 'system'
    )
      THEN RAISE(ABORT, 'profile_deletion_notice_requires_system_cancellation')
  END;
END;

CREATE TRIGGER trg_profile_deletion_auto_cancellation_notices_update_guard
BEFORE UPDATE ON profile_deletion_auto_cancellation_notices
BEGIN
  SELECT CASE
    WHEN NEW.cancellation_id IS NOT OLD.cancellation_id
      OR NEW.created_at IS NOT OLD.created_at
      OR OLD.delivered_at IS NOT NULL
      OR NEW.delivered_at IS NULL
      THEN RAISE(ABORT, 'profile_deletion_notice_immutable')
    WHEN NOT EXISTS (
      SELECT 1 FROM profile_deletion_cancellations c
      WHERE c.cancellation_id = NEW.cancellation_id AND c.finalized_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'profile_deletion_notice_requires_finalized_cancellation')
  END;
END;
