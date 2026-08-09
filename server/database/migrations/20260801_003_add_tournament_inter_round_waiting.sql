-- Persistent inter-round waiting gate for semifinal winners.
--
-- Acknowledgements are recorded per winning human finalist after their
-- semifinal result screen is accepted. final_start_at is stored on the final
-- match row exactly once, so refresh/reconnect sees the same countdown.
ALTER TABLE tournament_matches ADD COLUMN final_start_at TEXT NULL;

CREATE TABLE IF NOT EXISTS tournament_semifinal_result_acknowledgements (
  acknowledgement_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  semifinal_match_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (semifinal_match_id) REFERENCES tournament_matches(match_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (tournament_id, semifinal_match_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_semifinal_ack_match
  ON tournament_semifinal_result_acknowledgements(tournament_id, semifinal_match_id);

CREATE INDEX IF NOT EXISTS idx_tournament_semifinal_ack_profile
  ON tournament_semifinal_result_acknowledgements(profile_id);
