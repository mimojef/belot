PRAGMA foreign_keys = ON;

ALTER TABLE tournaments ADD COLUMN champion_team_id TEXT NULL REFERENCES tournament_teams(team_id) ON DELETE SET NULL;
ALTER TABLE tournaments ADD COLUMN runner_up_team_id TEXT NULL REFERENCES tournament_teams(team_id) ON DELETE SET NULL;
ALTER TABLE tournaments ADD COLUMN settlement_state TEXT NOT NULL DEFAULT 'pending' CHECK (
  settlement_state IN ('pending', 'settled')
);
ALTER TABLE tournaments ADD COLUMN settled_at TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tournaments_settlement_due
  ON tournaments(status, settlement_state, updated_at)
  WHERE status = 'final_in_progress' AND settlement_state = 'pending';

CREATE INDEX IF NOT EXISTS idx_tournament_economy_ledger_prize_payout
  ON tournament_economy_ledger(tournament_id, entry_type, profile_id)
  WHERE entry_type = 'prize_payout';
