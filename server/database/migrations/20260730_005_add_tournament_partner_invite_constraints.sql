PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tpi_one_pending_per_team
  ON tournament_partner_invites(team_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tpi_one_pending_outgoing_per_inviter
  ON tournament_partner_invites(tournament_id, inviter_profile_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_tpi_pending_reservations
  ON tournament_partner_invites(tournament_id, status);

CREATE INDEX IF NOT EXISTS idx_tournament_entries_team_status
  ON tournament_entries(team_id, status);
