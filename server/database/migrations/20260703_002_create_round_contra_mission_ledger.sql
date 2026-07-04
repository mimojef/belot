PRAGMA foreign_keys = ON;

-- Idempotency ledger for round-level contra mission progress.
-- Prevents double-counting if the same scoring candidate is applied more than once
-- (repeated worker tick, reconnect, or room restore) for the same room+round+player.
-- round_key is "dealerSeat:matchScoreTeamA:matchScoreTeamB" recorded BEFORE scoring is applied,
-- making it unique per round within a match.
CREATE TABLE IF NOT EXISTS round_contra_mission_ledger (
  ledger_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  round_key TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (room_id, round_key, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_round_contra_mission_ledger_room
  ON round_contra_mission_ledger(room_id);
