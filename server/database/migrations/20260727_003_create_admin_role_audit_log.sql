PRAGMA foreign_keys = ON;

-- Одит на назначаване/премахване на субадмин роля.
-- actor_account_id  = кой ПЪЛЕН администратор е извършил действието.
-- target_account_id = чийто акаунт е променен.
-- ON DELETE SET NULL — пази историята дори ако някой от акаунтите
-- (actor или target) бъде изтрит по-късно; не CASCADE, защото изтриване
-- на акаунт не бива тихо да заличава одитната следа.
CREATE TABLE IF NOT EXISTS admin_role_audit_log (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT NULL,
  target_account_id TEXT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('grant_subadmin', 'revoke_subadmin')
  ),
  previous_role TEXT NOT NULL CHECK (
    previous_role IN ('player', 'subadmin', 'admin')
  ),
  new_role TEXT NOT NULL CHECK (
    new_role IN ('player', 'subadmin', 'admin')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (target_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_role_audit_log_target
  ON admin_role_audit_log(target_account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_role_audit_log_actor
  ON admin_role_audit_log(actor_account_id, created_at);
