PRAGMA foreign_keys = ON;

-- Persistent history за private-table игри (waiting -> playing -> finished),
-- писана от handlePrivateRoomReady (INSERT, при game start) и от
-- match-completion side effect hook-а (UPDATE, при match-ended) в index.ts.
-- Отделна е от active_room_snapshots (runtime crash-recovery кеш, изтрива
-- finished редове) и от profile_match_results (per-profile win/loss, без
-- score/timestamps на ниво стая) — нито едната не покрива "Играещи"/
-- "Приключили" lobby таб нуждите. Никога не се trie: 2-часовият visibility
-- прозорец за "Приключили" е WHERE filter (finished_at >= now - 2h) на read
-- пътя, не retention/cleanup job.
CREATE TABLE IF NOT EXISTS private_room_matches (
  room_id TEXT PRIMARY KEY,
  private_room_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('playing', 'finished')
  ),
  stake INTEGER NOT NULL CHECK (stake >= 0),
  -- JSON масив от точно 2 occupant записа (PrivateRoomOccupantSnapshot shape:
  -- profileId/displayName/avatarUrl/isBot), team A и team B поотделно.
  team_a_json TEXT NOT NULL CHECK (json_valid(team_a_json)),
  team_b_json TEXT NOT NULL CHECK (json_valid(team_b_json)),
  team_a_score INTEGER NULL,
  team_b_score INTEGER NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_private_room_matches_status
  ON private_room_matches(status);

CREATE INDEX IF NOT EXISTS idx_private_room_matches_finished_at
  ON private_room_matches(finished_at);
