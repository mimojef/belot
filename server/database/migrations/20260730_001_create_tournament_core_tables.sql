PRAGMA foreign_keys = ON;

-- Community турнири се създават от потребители; official е запазено за
-- бъдещи Pika.bg-организирани турнири върху същата инфраструктура (V1
-- използва само 'community').
--
-- password_hash пази само хеш (никога чист текст) — самото hashing/проверка
-- се реализира в по-късен етап; тук schema само гарантира консистентност
-- чрез CHECK constraints (public → NULL, password → NOT NULL).
--
-- entry_fee/player_capacity са фиксирани формат-стойности за V1 (8 играчи),
-- но не са хардкоднати в CHECK-а над конкретно число, за да не пречат на
-- бъдещо разширение към 16/32 играчи без нова миграция на самата колона.
CREATE TABLE IF NOT EXISTS tournaments (
  tournament_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'community' CHECK (
    kind IN ('community', 'official')
  ),
  name TEXT NOT NULL CHECK (
    trim(name) <> ''
  ),
  creator_profile_id TEXT NOT NULL,
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
  CHECK (
    (visibility = 'public' AND password_hash IS NULL)
    OR (visibility = 'password' AND password_hash IS NOT NULL)
  ),
  CHECK (
    (start_mode = 'fill' AND scheduled_start_at IS NULL)
    OR (start_mode = 'scheduled' AND scheduled_start_at IS NOT NULL)
  ),
  FOREIGN KEY (creator_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tournaments_status
  ON tournaments(status, created_at);

CREATE INDEX IF NOT EXISTS idx_tournaments_creator
  ON tournaments(creator_profile_id, created_at);

-- Due-queue за бъдещия scheduler tick: намира отворени scheduled турнири,
-- чийто старт вече е дошъл.
CREATE INDEX IF NOT EXISTS idx_tournaments_scheduled_due
  ON tournaments(scheduled_start_at)
  WHERE status = 'open' AND start_mode = 'scheduled';

-- Публичен списък "Турнири" (бъдещ UI): активни community турнири, най-нови първо.
CREATE INDEX IF NOT EXISTS idx_tournaments_public_active
  ON tournaments(status, created_at)
  WHERE visibility = 'public';

-- seed_slot присвоен само при tournament start (1-4, кой отбор в кой
-- полуфинал/позиция). status е самостоятелна колона, не се извлича от
-- match резултати, защото трябва да е query-able преди да съществува
-- какъвто и да е match ред (напр. 'forming' веднага след първия entry).
CREATE TABLE IF NOT EXISTS tournament_teams (
  team_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'forming' CHECK (
    status IN ('forming', 'complete', 'locked', 'eliminated', 'finalist', 'champion')
  ),
  seed_slot INTEGER NULL CHECK (
    seed_slot IS NULL OR seed_slot IN (1, 2, 3, 4)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tournament_teams_tournament
  ON tournament_teams(tournament_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_teams_seed_slot_unique
  ON tournament_teams(tournament_id, seed_slot)
  WHERE seed_slot IS NOT NULL;

-- Не пазим "failed_payment" entries: ако бъдещият join-transaction debit
-- fail-не, редът просто не се INSERT-ва (rollback на цялата транзакция) —
-- по-чист модел от персистиране на неуспешен опит, аналогичен на липсата
-- на "failed" ред в match_economy_ledger при insufficient funds.
CREATE TABLE IF NOT EXISTS tournament_entries (
  entry_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
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
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES tournament_teams(team_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tournament_entries_tournament_status
  ON tournament_entries(tournament_id, status);

CREATE INDEX IF NOT EXISTS idx_tournament_entries_profile
  ON tournament_entries(profile_id);

CREATE INDEX IF NOT EXISTS idx_tournament_entries_team
  ON tournament_entries(team_id);

-- team_id тук е "резервираният" отбор (винаги 'forming', докато поканата
-- виси) — не FK към entries, защото поканеният още няма entry ред докато
-- не приеме. popup_dismissed_at и notification_read_at са НАРОЧНО отделни
-- колони (виж коментарите по-долу) — нито едно от двете action не променя
-- status; поканата остава 'pending' до explicit accept/decline/cancel/expire.
CREATE TABLE IF NOT EXISTS tournament_partner_invites (
  invite_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  inviter_profile_id TEXT NOT NULL,
  invitee_profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')
  ),
  expires_at TEXT NOT NULL,
  -- X бутон (затвори popup, без резолюция) → само тази колона.
  popup_dismissed_at TEXT NULL,
  -- "Виж турнира" (затвори popup + маркирай видяно) → тази И popup_dismissed_at.
  notification_read_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT NULL,
  CHECK (inviter_profile_id <> invitee_profile_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES tournament_teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (invitee_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- Delivery-on-connect due-queue: непрочетени pending покани по получател.
CREATE INDEX IF NOT EXISTS idx_tpi_invitee_pending
  ON tournament_partner_invites(invitee_profile_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_tpi_tournament
  ON tournament_partner_invites(tournament_id);

-- Expiry tick due-queue.
CREATE INDEX IF NOT EXISTS idx_tpi_expiry_due
  ON tournament_partner_invites(expires_at)
  WHERE status = 'pending';

-- Не позволява дублирана pending покана към същия човек за същия турнир.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tpi_one_pending_per_pair
  ON tournament_partner_invites(tournament_id, inviter_profile_id, invitee_profile_id)
  WHERE status = 'pending';

-- round_index: 1,2 за двата полуфинала; 1 за финала (round_type вече
-- различава контекста, затова индексите не се пресичат).
CREATE TABLE IF NOT EXISTS tournament_rounds (
  round_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  round_type TEXT NOT NULL CHECK (
    round_type IN ('semifinal', 'final')
  ),
  round_index INTEGER NOT NULL CHECK (
    round_index IN (1, 2)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (round_type = 'final' AND round_index = 1)
    OR (round_type = 'semifinal' AND round_index IN (1, 2))
  ),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  UNIQUE (tournament_id, round_type, round_index)
);

-- room_id сочи към бъдещ game room (без FK — активните room-и живеят в
-- active_room_snapshots и се release-ват/архивират по различен lifecycle;
-- room_id тук е само référence за UI/audit, не притежание).
--
-- result_kind различава нормално изигран мач от служебна победа — schema
-- никога не пази фиктивен резултат (напр. 151:0) за walkover.
CREATE TABLE IF NOT EXISTS tournament_matches (
  match_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  room_id TEXT NULL,
  team_a_id TEXT NOT NULL,
  team_b_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_players' CHECK (
    status IN ('awaiting_players', 'countdown', 'in_progress', 'completed', 'walkover', 'cancelled')
  ),
  no_show_deadline_at TEXT NULL,
  winner_team_id TEXT NULL,
  result_kind TEXT NULL CHECK (
    result_kind IS NULL OR result_kind IN ('played', 'walkover')
  ),
  walkover_reason TEXT NULL,
  missing_profile_ids TEXT NULL CHECK (
    missing_profile_ids IS NULL OR json_valid(missing_profile_ids)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT NULL,
  completed_at TEXT NULL,
  CHECK (team_a_id <> team_b_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES tournament_rounds(round_id) ON DELETE CASCADE,
  FOREIGN KEY (team_a_id) REFERENCES tournament_teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (team_b_id) REFERENCES tournament_teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (winner_team_id) REFERENCES tournament_teams(team_id) ON DELETE SET NULL,
  UNIQUE (room_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_matches_tournament
  ON tournament_matches(tournament_id);

CREATE INDEX IF NOT EXISTS idx_tournament_matches_round
  ON tournament_matches(round_id);

-- No-show tick due-queue (3-минутен walkover прозорец, absolute-timestamp,
-- restart-safe по модела на съществуващите game timers).
CREATE INDEX IF NOT EXISTS idx_tournament_matches_noshow_due
  ON tournament_matches(no_show_deadline_at)
  WHERE status = 'awaiting_players';
