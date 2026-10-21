-- Самоизтриване на профили — Етап 3: краткосрочни токени за отмяна на заявка.
--
-- Допълваща миграция (20261024_001 остава непроменена). Токенът се издава
-- САМО след успешен вход с вярна парола за профил с активна (pending)
-- заявка и позволява отмяна ("Отмени изтриването") или изрично запазване
-- ("Остави заявката активна") — без нормална сесия.
--
-- Сигурност:
--   * Пази се само SHA-256 хешът (64 hex символа) — суровият токен никога
--     не се записва в базата/логовете.
--   * Еднократен: consumed_at/consumed_reason се задават веднъж и не се
--     променят повече (тригер).
--   * Кратка валидност: expires_at е най-много 15 минути след създаването.
--   * Вързан към точния request_id И profile_id (проверено от тригер).
--   * Щом заявката напусне pending (отмяна, изпълнение, ...), всички нейни
--     неизползвани токени се обезсилват автоматично (тригер върху
--     profile_deletion_requests) — токен не може да надживее заявката.

CREATE TABLE profile_deletion_restore_tokens (
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  consumed_at TEXT NULL CHECK (
    consumed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS consumed_at
  ),
  -- cancelled      — използван за успешна отмяна;
  -- kept           — потребителят избра "Остави заявката активна";
  -- superseded     — издаден е по-нов токен за същата заявка;
  -- request_closed — заявката вече не е pending (тригерът по-долу).
  consumed_reason TEXT NULL CHECK (
    consumed_reason IS NULL OR consumed_reason IN ('cancelled', 'kept', 'superseded', 'request_closed')
  ),
  CHECK ((consumed_at IS NULL) = (consumed_reason IS NULL)),
  FOREIGN KEY (request_id) REFERENCES profile_deletion_requests(request_id) ON DELETE RESTRICT
);

CREATE INDEX idx_profile_deletion_restore_tokens_active_request
  ON profile_deletion_restore_tokens(request_id)
  WHERE consumed_at IS NULL;

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

CREATE TRIGGER trg_profile_deletion_restore_tokens_immutable
BEFORE UPDATE ON profile_deletion_restore_tokens
WHEN NEW.token_hash IS NOT OLD.token_hash
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.profile_id IS NOT OLD.profile_id
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.consumed_at IS NOT NULL AND (
    NEW.consumed_at IS NOT OLD.consumed_at OR NEW.consumed_reason IS NOT OLD.consumed_reason
  ))
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_restore_token_immutable');
END;

CREATE TRIGGER trg_profile_deletion_restore_tokens_no_delete
BEFORE DELETE ON profile_deletion_restore_tokens
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_restore_token_no_delete');
END;

-- Заявка, напуснала pending, обезсилва всичките си неизползвани токени
-- (в СЪЩАТА транзакция като промяната на статуса).
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
