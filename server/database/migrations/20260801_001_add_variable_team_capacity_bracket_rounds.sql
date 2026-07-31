-- MANUAL_TRANSACTION_MIGRATION
-- Разширява bracket schema-та за variable team capacity (4/8/16 отбора,
-- виж §5 в task spec-а). player_capacity колоната на tournaments вече
-- нямаше числен CHECK (само > 0, виж migration 20260730_001) — не се
-- налага промяна там. Тук се разширяват само трите constraints, които
-- бяха твърдо фиксирани за точно 4-отборен bracket:
--   - tournament_teams.seed_slot: 1-4 -> 1-16
--   - tournament_rounds.round_type: ('semifinal','final') -> +'round_of_16','quarterfinal'
--   - tournament_rounds.round_index: (1,2) -> 1-8 (осминафинал за 16 отбора
--     има 8 паралелни мача = 8 round_index стойности)
--
-- SQLite не поддържа ALTER на CHECK constraint директно — table rebuild
-- по същия pattern като migration 20260730_008 (CREATE _stageN, INSERT
-- SELECT непроменени данни, DROP старата, RENAME). Съществуващите 4-отборни
-- турнири остават с точно същите редове/стойности — само constraint-ът
-- се разширява, не се пипат данни.
PRAGMA foreign_keys = OFF;

CREATE TABLE tournament_teams_stage20260801 (
  team_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'forming' CHECK (
    status IN ('forming', 'complete', 'locked', 'eliminated', 'finalist', 'champion')
  ),
  seed_slot INTEGER NULL CHECK (
    seed_slot IS NULL OR (seed_slot >= 1 AND seed_slot <= 16)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE
);

INSERT INTO tournament_teams_stage20260801 (
  team_id, tournament_id, status, seed_slot, created_at, updated_at
)
SELECT team_id, tournament_id, status, seed_slot, created_at, updated_at
FROM tournament_teams;

DROP TABLE tournament_teams;
ALTER TABLE tournament_teams_stage20260801 RENAME TO tournament_teams;

CREATE INDEX IF NOT EXISTS idx_tournament_teams_tournament
  ON tournament_teams(tournament_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_teams_seed_slot_unique
  ON tournament_teams(tournament_id, seed_slot)
  WHERE seed_slot IS NOT NULL;

CREATE TABLE tournament_rounds_stage20260801 (
  round_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  round_type TEXT NOT NULL CHECK (
    round_type IN ('round_of_16', 'quarterfinal', 'semifinal', 'final')
  ),
  round_index INTEGER NOT NULL CHECK (
    round_index >= 1 AND round_index <= 8
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (round_type = 'final' AND round_index = 1)
    OR (round_type = 'semifinal' AND round_index IN (1, 2))
    OR (round_type = 'quarterfinal' AND round_index BETWEEN 1 AND 4)
    OR (round_type = 'round_of_16' AND round_index BETWEEN 1 AND 8)
  ),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  UNIQUE (tournament_id, round_type, round_index)
);

INSERT INTO tournament_rounds_stage20260801 (
  round_id, tournament_id, round_type, round_index, created_at
)
SELECT round_id, tournament_id, round_type, round_index, created_at
FROM tournament_rounds;

DROP TABLE tournament_rounds;
ALTER TABLE tournament_rounds_stage20260801 RENAME TO tournament_rounds;

PRAGMA foreign_keys = ON;
