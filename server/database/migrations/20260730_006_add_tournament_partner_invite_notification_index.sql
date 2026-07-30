PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_tpi_pending_undismissed_invitee_created
  ON tournament_partner_invites(invitee_profile_id, created_at)
  WHERE status = 'pending' AND popup_dismissed_at IS NULL;
