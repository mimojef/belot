PRAGMA foreign_keys = ON;

ALTER TABLE tournaments ADD COLUMN total_entry_amount INTEGER NULL CHECK (total_entry_amount IS NULL OR total_entry_amount > 0);
ALTER TABLE tournaments ADD COLUMN system_fee_percent INTEGER NULL CHECK (system_fee_percent IS NULL OR system_fee_percent = 20);
ALTER TABLE tournaments ADD COLUMN system_fee_amount INTEGER NULL CHECK (system_fee_amount IS NULL OR system_fee_amount > 0);
ALTER TABLE tournaments ADD COLUMN prize_pool_amount INTEGER NULL CHECK (prize_pool_amount IS NULL OR prize_pool_amount > 0);
ALTER TABLE tournaments ADD COLUMN winner_share_percent INTEGER NULL CHECK (winner_share_percent IS NULL OR winner_share_percent = 65);
ALTER TABLE tournaments ADD COLUMN runner_up_share_percent INTEGER NULL CHECK (runner_up_share_percent IS NULL OR runner_up_share_percent = 35);
ALTER TABLE tournaments ADD COLUMN winner_team_prize_amount INTEGER NULL CHECK (winner_team_prize_amount IS NULL OR winner_team_prize_amount > 0);
ALTER TABLE tournaments ADD COLUMN runner_up_team_prize_amount INTEGER NULL CHECK (runner_up_team_prize_amount IS NULL OR runner_up_team_prize_amount > 0);
ALTER TABLE tournaments ADD COLUMN winner_player_prize_amount INTEGER NULL CHECK (winner_player_prize_amount IS NULL OR winner_player_prize_amount > 0);
ALTER TABLE tournaments ADD COLUMN runner_up_player_prize_amount INTEGER NULL CHECK (runner_up_player_prize_amount IS NULL OR runner_up_player_prize_amount > 0);
ALTER TABLE tournaments ADD COLUMN financial_rules_version TEXT NULL CHECK (
  financial_rules_version IS NULL OR financial_rules_version = 'v1_20_65_35'
);

CREATE INDEX IF NOT EXISTS idx_tournaments_scheduler_mode_status
  ON tournaments(status, start_mode, scheduled_start_at);

CREATE INDEX IF NOT EXISTS idx_tournament_economy_ledger_tournament_entry_type
  ON tournament_economy_ledger(tournament_id, entry_type);

CREATE INDEX IF NOT EXISTS idx_tpi_tournament_status_expires
  ON tournament_partner_invites(tournament_id, status, expires_at);
