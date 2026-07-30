PRAGMA foreign_keys = ON;

-- Идемпотентността тук е explicit чрез idempotency_key (UNIQUE), а не чрез
-- композитен (tournament_id, profile_id, entry_type) UNIQUE както в
-- match_economy_ledger — турнирна финансова операция може легитимно да се
-- повтори за същия (tournament, profile, entry_type) при различен scope
-- (напр. бъдещ по-фин retry ключ), затова ключът е explicit generated от
-- бъдещата бизнес логика, не implицитно от тези три колони.
--
-- profile_id е NULL само за 'system_fee' (изгорената 10% такса — няма
-- system wallet/system profile в схемата, затова таксата е чист audit ред
-- без съответен credit). За всички други entry_type NOT NULL.
--
-- ON DELETE SET NULL (не CASCADE) за profile_id: изтриване/анонимизиране на
-- профил не бива да заличава финансовата история — same reasoning като
-- admin_role_audit_log (20260727_003).
CREATE TABLE IF NOT EXISTS tournament_economy_ledger (
  ledger_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tournament_id TEXT NOT NULL,
  profile_id TEXT NULL,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('entry_fee_debit', 'entry_fee_refund', 'prize_payout', 'system_fee')
  ),
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  balance_after INTEGER NULL CHECK (
    balance_after IS NULL OR balance_after >= 0
  ),
  metadata_json TEXT NULL CHECK (
    metadata_json IS NULL OR json_valid(metadata_json)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (entry_type = 'system_fee' AND profile_id IS NULL)
    OR (entry_type <> 'system_fee' AND profile_id IS NOT NULL)
  ),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tournament_economy_ledger_tournament
  ON tournament_economy_ledger(tournament_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tournament_economy_ledger_profile
  ON tournament_economy_ledger(profile_id, created_at);

-- Генеричен audit trail за турнирни събития. admin_role_audit_log
-- (20260727_003) е прегледана и НЕ е преизползвана — тя е тясно обвързана
-- с role-change action enum + accounts FK, несъвместима с турнирни събития.
--
-- ON DELETE SET NULL за actor_profile_id по същата причина като по-горе —
-- изтрит профил не бива да заличава кой е извършил дадено действие.
CREATE TABLE IF NOT EXISTS tournament_events (
  event_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    trim(event_type) <> ''
  ),
  actor_profile_id TEXT NULL,
  actor_role TEXT NULL CHECK (
    actor_role IS NULL OR actor_role IN ('player', 'admin', 'system')
  ),
  payload_json TEXT NULL CHECK (
    payload_json IS NULL OR json_valid(payload_json)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tournament_events_tournament
  ON tournament_events(tournament_id, created_at);
