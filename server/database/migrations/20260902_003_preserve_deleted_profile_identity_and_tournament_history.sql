-- MANUAL_TRANSACTION_MIGRATION
-- Blocker fix (admin hard-delete брифа, round 2): "historical row survives"
-- != "historical IDENTITY survives". ON DELETE SET NULL (20260902_002)
-- пази РЕДА, но веднъж profile_id стане NULL, вече не можем да кажем КОЙ
-- изтрит профил е бил замесен — forensic multi-profile проверка (напр.
-- "ZLOBA имаше ли и друг профил от същия IP") губи атрибуцията си точно
-- когато е най-нужна (профилът е бил изтрит заради нарушение).
--
-- Модел: snapshot колона БЕЗ FK (mirror на established
-- admin_profile_deletions.deleted_profile_id pattern-а — immutable UUID
-- reference, populated ЕДИНСТВЕНО в момента на hard delete, ПРЕДИ живата
-- FK колона да бъде нулирана от cascade-а). НЕ email — само UUID (spec: "Не
-- пази email като forensic snapshot").
--
-- profile_bans: profile_id (живата FK, вече SET NULL) остава за нормалната
-- "активен бан за профил X" заявка; deleted_profile_id_snapshot се пълни
-- САМО когато редът принадлежи на профил, който току-що е бил hard-deleted
-- (profileHardDeleteService.ts попълва И двете — снапва СТАРАТА стойност
-- на profile_id в snapshot полето, ПРЕДИ да изпълни DELETE FROM profiles,
-- което кара cascade-а да нулира живата profile_id колона). Резултат след
-- delete: profile_id=NULL, deleted_profile_id_snapshot=<старото UUID> —
-- "този бан е бил на deleted profile UUID X" остава директно четимо.
--
-- tournaments.creator_profile_id / tournament_entries.profile_id: огледално
-- — snapshot полето пази кой е бил creator/participant, дори след като
-- профилът е изтрит. ВАЖНО: за да се стигне въобще до SET NULL тук,
-- profileHardDeleteService.hardDeleteProfile() вече ОТКАЗВА delete, ако
-- target е creator/active participant в турнир с НЕ-terminal lifecycle
-- (виж кода — 'active_tournament_dependency' guard). SET NULL тук покрива
-- само FINISHED/CANCELLED/终 турнири, за да не се чупи "не можеш да
-- изтриеш чужд/цял active tournament" гаранцията (турнирът вече не се
-- каскадно трие само защото target е creator — CASCADE→SET NULL е самата
-- поправка на този blocker).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- ─── profile_bans: + deleted_profile_id_snapshot (no FK) ───────────────────
CREATE TABLE profile_bans_new (
  ban_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  banned_until TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    trim(reason) <> ''
  ),
  banned_by_profile_id TEXT NULL,
  lifted_at TEXT NULL,
  lifted_by_profile_id TEXT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (banned_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (lifted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO profile_bans_new (
  ban_id, profile_id, banned_at, banned_until, reason,
  banned_by_profile_id, lifted_at, lifted_by_profile_id
)
SELECT
  ban_id, profile_id, banned_at, banned_until, reason,
  banned_by_profile_id, lifted_at, lifted_by_profile_id
FROM profile_bans;

DROP TABLE profile_bans;
ALTER TABLE profile_bans_new RENAME TO profile_bans;

CREATE INDEX idx_profile_bans_profile_active
  ON profile_bans(profile_id, lifted_at, banned_until);
CREATE INDEX idx_profile_bans_deleted_profile_snapshot
  ON profile_bans(deleted_profile_id_snapshot);

-- ─── tournaments: creator_profile_id CASCADE → SET NULL + snapshot ─────────
-- Verbatim rebuild на текущата live schema (само creator_profile_id
-- nullable/SET NULL + новата snapshot колона добавена — всички други
-- колони/CHECK/UNIQUE/index-и запазени byte-for-byte).
CREATE TABLE tournaments_new (
  tournament_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'community' CHECK (
    kind IN ('community', 'official')
  ),
  name TEXT NOT NULL CHECK (
    trim(name) <> ''
  ),
  creator_profile_id TEXT NULL,
  deleted_creator_profile_id_snapshot TEXT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (
    visibility IN ('public', 'password')
  ),
  password_hash TEXT NULL,
  entry_fee INTEGER NOT NULL CHECK (
    entry_fee > 0
  ),
  player_capacity INTEGER NOT NULL DEFAULT 8 CHECK (
    player_capacity > 0
  ),
  start_mode TEXT NOT NULL CHECK (
    start_mode IN ('fill', 'scheduled')
  ),
  scheduled_start_at TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN (
      'open',
      'starting',
      'semifinal_in_progress',
      'final_in_progress',
      'finished',
      'cancelled',
      'admin_cancelled',
      'auto_cancelled',
      'failed'
    )
  ),
  cancel_reason TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  total_entry_amount INTEGER NULL CHECK (total_entry_amount IS NULL OR total_entry_amount > 0),
  system_fee_percent INTEGER NULL CHECK (system_fee_percent IS NULL OR system_fee_percent = 20),
  system_fee_amount INTEGER NULL CHECK (system_fee_amount IS NULL OR system_fee_amount > 0),
  prize_pool_amount INTEGER NULL CHECK (prize_pool_amount IS NULL OR prize_pool_amount > 0),
  winner_share_percent INTEGER NULL CHECK (winner_share_percent IS NULL OR winner_share_percent = 65),
  runner_up_share_percent INTEGER NULL CHECK (runner_up_share_percent IS NULL OR runner_up_share_percent = 35),
  winner_team_prize_amount INTEGER NULL CHECK (winner_team_prize_amount IS NULL OR winner_team_prize_amount > 0),
  runner_up_team_prize_amount INTEGER NULL CHECK (runner_up_team_prize_amount IS NULL OR runner_up_team_prize_amount > 0),
  winner_player_prize_amount INTEGER NULL CHECK (winner_player_prize_amount IS NULL OR winner_player_prize_amount > 0),
  runner_up_player_prize_amount INTEGER NULL CHECK (runner_up_player_prize_amount IS NULL OR runner_up_player_prize_amount > 0),
  financial_rules_version TEXT NULL CHECK (
    financial_rules_version IS NULL OR financial_rules_version = 'v1_20_65_35'
  ),
  champion_team_id TEXT NULL REFERENCES tournament_teams(team_id) ON DELETE SET NULL,
  runner_up_team_id TEXT NULL REFERENCES tournament_teams(team_id) ON DELETE SET NULL,
  settlement_state TEXT NOT NULL DEFAULT 'pending' CHECK (
    settlement_state IN ('pending', 'settled')
  ),
  settled_at TEXT NULL,
  fill_expires_at TEXT NULL,
  CHECK (
    (visibility = 'public' AND password_hash IS NULL)
    OR (visibility = 'password' AND password_hash IS NOT NULL)
  ),
  CHECK (
    (start_mode = 'fill' AND scheduled_start_at IS NULL)
    OR (start_mode = 'scheduled' AND scheduled_start_at IS NOT NULL)
  ),
  FOREIGN KEY (creator_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO tournaments_new (
  tournament_id, kind, name, creator_profile_id, visibility, password_hash,
  entry_fee, player_capacity, start_mode, scheduled_start_at, status,
  cancel_reason, created_at, updated_at, started_at, finished_at,
  total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
  winner_share_percent, runner_up_share_percent, winner_team_prize_amount,
  runner_up_team_prize_amount, winner_player_prize_amount, runner_up_player_prize_amount,
  financial_rules_version, champion_team_id, runner_up_team_id,
  settlement_state, settled_at, fill_expires_at
)
SELECT
  tournament_id, kind, name, creator_profile_id, visibility, password_hash,
  entry_fee, player_capacity, start_mode, scheduled_start_at, status,
  cancel_reason, created_at, updated_at, started_at, finished_at,
  total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
  winner_share_percent, runner_up_share_percent, winner_team_prize_amount,
  runner_up_team_prize_amount, winner_player_prize_amount, runner_up_player_prize_amount,
  financial_rules_version, champion_team_id, runner_up_team_id,
  settlement_state, settled_at, fill_expires_at
FROM tournaments;

DROP TABLE tournaments;
ALTER TABLE tournaments_new RENAME TO tournaments;

CREATE INDEX idx_tournaments_status
  ON tournaments(status, created_at);
CREATE INDEX idx_tournaments_creator
  ON tournaments(creator_profile_id, created_at);
CREATE INDEX idx_tournaments_scheduled_due
  ON tournaments(scheduled_start_at)
  WHERE status = 'open' AND start_mode = 'scheduled';
CREATE INDEX idx_tournaments_public_active
  ON tournaments(status, created_at)
  WHERE visibility = 'public';
CREATE UNIQUE INDEX idx_tournaments_one_active_per_creator
  ON tournaments(creator_profile_id)
  WHERE status IN ('open', 'starting', 'semifinal_in_progress', 'final_in_progress');
CREATE INDEX idx_tournaments_scheduler_mode_status
  ON tournaments(status, start_mode, scheduled_start_at);
CREATE INDEX idx_tournaments_settlement_due
  ON tournaments(status, settlement_state, updated_at)
  WHERE status = 'final_in_progress' AND settlement_state = 'pending';
CREATE INDEX idx_tournaments_fill_expiry_due
  ON tournaments(fill_expires_at)
  WHERE status = 'open' AND start_mode = 'fill';
CREATE INDEX idx_tournaments_deleted_creator_snapshot
  ON tournaments(deleted_creator_profile_id_snapshot);

-- ─── tournament_entries: profile_id CASCADE → SET NULL + snapshot ─────────
CREATE TABLE tournament_entries_new (
  entry_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  team_id TEXT NULL,
  joined_as TEXT NOT NULL CHECK (
    joined_as IN ('solo', 'partner_inviter', 'partner_invitee')
  ),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (
    status IN ('confirmed', 'withdrawn', 'refunded', 'eliminated', 'finalist', 'champion')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at TEXT NULL,
  refunded_at TEXT NULL,
  UNIQUE (tournament_id, profile_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (team_id) REFERENCES tournament_teams(team_id) ON DELETE SET NULL
);

INSERT INTO tournament_entries_new (
  entry_id, tournament_id, profile_id, team_id, joined_as, status,
  created_at, updated_at, withdrawn_at, refunded_at
)
SELECT
  entry_id, tournament_id, profile_id, team_id, joined_as, status,
  created_at, updated_at, withdrawn_at, refunded_at
FROM tournament_entries;

DROP TABLE tournament_entries;
ALTER TABLE tournament_entries_new RENAME TO tournament_entries;

CREATE INDEX idx_tournament_entries_tournament_status
  ON tournament_entries(tournament_id, status);
CREATE INDEX idx_tournament_entries_profile
  ON tournament_entries(profile_id);
CREATE INDEX idx_tournament_entries_team
  ON tournament_entries(team_id);
CREATE INDEX idx_tournament_entries_team_status
  ON tournament_entries(team_id, status);
CREATE INDEX idx_tournament_entries_profile_active_status
  ON tournament_entries(profile_id, status)
  WHERE status IN ('confirmed', 'finalist');
CREATE INDEX idx_tournament_entries_deleted_profile_snapshot
  ON tournament_entries(deleted_profile_id_snapshot);

-- ─── admin_profile_deletion_visitor_snapshots ──────────────────────────────
-- Компактен, АГРЕГИРАН forensic snapshot, populated ЕДИНСТВЕНО в момента на
-- hard delete (profileHardDeleteService.ts), НЕ FK-driven trigger/cascade —
-- site_visit_events/site_visitors НЕ се rebuild-ват (голяма, непрекъснато
-- растяща analytics таблица в production — рисковано и ненужно да се пипа
-- schema-та ѝ само заради рядкото hard-delete събитие).
--
-- ИЗТОЧНИК: site_visit_events.profile_id (НЕ site_visitors.first/last_profile_id
-- — round 2 корекция). site_visitors пази само first/last seen ЗА ЦЕЛИЯ
-- anonymous_visitor_id живот, затова "A -> TARGET -> B" сценарий (TARGET
-- нито е first, нито last owner на visitor V) би пропуснал TARGET изцяло
-- при source=site_visitors, въпреки реални TARGET events в
-- site_visit_events. Directен query "SELECT ... FROM site_visit_events
-- WHERE profile_id = ?" хваща ВСЯКО събитие, независимо от позицията на
-- профила в multi-profile visitor историята. Query план (verified): SEARCH
-- site_visit_events USING INDEX idx_site_visit_events_profile_time
-- (profile_id=?) — вече съществуващ индекс (20260625_002_create_site_visits.sql),
-- НЕ добавяме нов индекс върху тази high-write таблица (rare admin
-- operation, bounded по единичния profile_id, не постоянен overhead).
--
-- АГРЕГАЦИЯ: един ред на (deleted_profile_id, anonymous_visitor_id,
-- ip_address) — не копираме всеки individual site_visit_events ред
-- (spec: "не копирай всеки ред, искам агрегирана история"). event_count +
-- MIN/MAX(occurred_at) правят "колко пъти и кога" reconstructable без
-- пълния event log. Множество IP-та за същия (profile, visitor) чифт
-- получават отделни редове (UNIQUE включва ip_address) — reconstruction
-- заявка "deleted profile UUID X -> всички visitor IDs -> всички IP-та за
-- всеки visitor ID -> first/last seen -> event count" е директен
-- WHERE deleted_profile_id = ? срещу тази таблица, без JOIN към живата
-- (вече cascade-нала) site_visit_events.
CREATE TABLE IF NOT EXISTS admin_profile_deletion_visitor_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  deleted_profile_id TEXT NOT NULL,
  anonymous_visitor_id TEXT NOT NULL,
  ip_address TEXT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (deleted_profile_id, anonymous_visitor_id, ip_address)
);

CREATE INDEX IF NOT EXISTS idx_admin_profile_deletion_visitor_snapshots_deleted_profile
  ON admin_profile_deletion_visitor_snapshots(deleted_profile_id);
CREATE INDEX IF NOT EXISTS idx_admin_profile_deletion_visitor_snapshots_visitor
  ON admin_profile_deletion_visitor_snapshots(anonymous_visitor_id);

-- ─── tournament_economy_ledger: latent bug fix + snapshot ──────────────────
-- profile_id тук вече беше ON DELETE SET NULL от самото начало (20260730_002)
-- — но табличният CHECK constraint "(entry_type='system_fee' AND
-- profile_id IS NULL) OR (entry_type<>'system_fee' AND profile_id IS NOT
-- NULL)" всъщност НИКОГА не е позволявал NULL profile_id за не-system_fee
-- редове. Реален latent bug, открит именно от hard-delete E2E теста тук:
-- opit за DELETE FROM profiles на профил с entry_fee_debit/prize_payout/
-- entry_fee_refund ред фактически би минал transaction ROLLBACK
-- (CHECK constraint violation) и delete-ът никога не би завършил успешно.
-- Фиксваме CHECK-а да позволява NULL profile_id и за не-system_fee редове,
-- САМО когато redът реално е бил snapshot-нат при profile hard delete
-- (deleted_profile_id_snapshot IS NOT NULL) — с други думи NULL profile_id
-- остава невалиден за ВСЯКА друга причина освен "профилът е бил изтрит".
CREATE TABLE tournament_economy_ledger_new (
  ledger_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tournament_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
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
    OR (entry_type <> 'system_fee' AND profile_id IS NULL AND deleted_profile_id_snapshot IS NOT NULL)
  ),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO tournament_economy_ledger_new (
  ledger_id, idempotency_key, tournament_id, profile_id, entry_type,
  amount, balance_after, metadata_json, created_at
)
SELECT
  ledger_id, idempotency_key, tournament_id, profile_id, entry_type,
  amount, balance_after, metadata_json, created_at
FROM tournament_economy_ledger;

DROP TABLE tournament_economy_ledger;
ALTER TABLE tournament_economy_ledger_new RENAME TO tournament_economy_ledger;

CREATE INDEX idx_tournament_economy_ledger_tournament
  ON tournament_economy_ledger(tournament_id, created_at);
CREATE INDEX idx_tournament_economy_ledger_profile
  ON tournament_economy_ledger(profile_id, created_at);
CREATE INDEX idx_tournament_economy_ledger_tournament_entry_type
  ON tournament_economy_ledger(tournament_id, entry_type);
CREATE INDEX idx_tournament_economy_ledger_prize_payout
  ON tournament_economy_ledger(tournament_id, entry_type, profile_id)
  WHERE entry_type = 'prize_payout';
CREATE INDEX idx_tournament_economy_ledger_deleted_profile_snapshot
  ON tournament_economy_ledger(deleted_profile_id_snapshot);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260902_003_preserve_deleted_profile_identity_and_tournament_history.sql');

COMMIT;

PRAGMA foreign_keys = ON;
