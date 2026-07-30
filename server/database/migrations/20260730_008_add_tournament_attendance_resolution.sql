PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS tournament_matches_stage8 (
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
  attendance_started_at TEXT NULL,
  attendance_deadline_at TEXT NULL,
  attendance_resolved_at TEXT NULL,
  attendance_resolution_kind TEXT NULL CHECK (
    attendance_resolution_kind IS NULL OR attendance_resolution_kind IN ('all_present', 'walkover', 'bots_inserted')
  ),
  game_start_at TEXT NULL,
  attendance_revision INTEGER NOT NULL DEFAULT 0,
  winner_team_id TEXT NULL,
  result_kind TEXT NULL CHECK (
    result_kind IS NULL OR result_kind IN ('played', 'played_with_bots', 'walkover')
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

INSERT INTO tournament_matches_stage8 (
  match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status,
  no_show_deadline_at, attendance_started_at, attendance_deadline_at,
  attendance_resolved_at, attendance_resolution_kind, game_start_at,
  attendance_revision, winner_team_id, result_kind, walkover_reason,
  missing_profile_ids, created_at, started_at, completed_at
)
SELECT
  match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status,
  no_show_deadline_at, NULL, no_show_deadline_at, NULL, NULL, NULL, 0,
  winner_team_id, result_kind, walkover_reason, missing_profile_ids,
  created_at, started_at, completed_at
FROM tournament_matches;

DROP TABLE tournament_matches;
ALTER TABLE tournament_matches_stage8 RENAME TO tournament_matches;

PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_tournament_matches_tournament
  ON tournament_matches(tournament_id);

CREATE INDEX IF NOT EXISTS idx_tournament_matches_round
  ON tournament_matches(round_id);

CREATE INDEX IF NOT EXISTS idx_tournament_matches_noshow_due
  ON tournament_matches(attendance_deadline_at)
  WHERE status = 'awaiting_players' AND attendance_resolution_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_tournament_matches_game_start_due
  ON tournament_matches(game_start_at)
  WHERE status = 'countdown' AND attendance_resolution_kind IN ('all_present', 'bots_inserted');

CREATE TABLE IF NOT EXISTS tournament_match_no_show_replacements (
  replacement_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  assigned_profile_id TEXT NOT NULL,
  assigned_seat TEXT NOT NULL CHECK (
    assigned_seat IN ('bottom', 'right', 'top', 'left')
  ),
  replacement_reason TEXT NOT NULL DEFAULT 'no_show' CHECK (
    replacement_reason = 'no_show'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'takeover_pending', 'completed')
  ),
  reconnect_token TEXT NOT NULL,
  inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  takeover_requested_at TEXT NULL,
  takeover_completed_at TEXT NULL,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (match_id) REFERENCES tournament_matches(match_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (match_id, assigned_profile_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tmnsr_active_seat
  ON tournament_match_no_show_replacements(match_id, assigned_seat)
  WHERE status IN ('active', 'takeover_pending');

CREATE INDEX IF NOT EXISTS idx_tmnsr_room_profile
  ON tournament_match_no_show_replacements(room_id, assigned_profile_id, status);
