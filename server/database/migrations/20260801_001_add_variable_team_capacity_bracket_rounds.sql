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
-- по същия pattern като 20260727_002_extend_accounts_role_subadmin.sql /
-- 20260729_001_add_attachment_to_friend_chat_messages.sql (CREATE _stageN,
-- INSERT SELECT непроменени данни, DROP старата, RENAME). Съществуващите
-- 4-отборни турнири остават с точно същите редове/стойности — само
-- constraint-ът се разширява, не се пипат данни.
--
-- И двете rebuild-нати таблици (tournament_teams, tournament_rounds) са
-- FK parent на tournament_matches/tournament_entries/tournament_partner_invites
-- (доказано empирично: SQLite отказва DROP TABLE на parent с реални
-- referencing редове, докато foreign_keys=ON) — затова PRAGMA foreign_keys
-- трябва РЕАЛНО да е OFF по време на DROP/RENAME, не просто "изглежда
-- изключено": SQLite отказва да промени тази PRAGMA стойност вътре в
-- отворена транзакция (мълчаливо no-op), затова OFF/ON стоят ИЗВЪН
-- BEGIN/COMMIT, а самата schema промяна + ledger insert са в ЕДНА
-- атомарна транзакция (виж MANUAL_TRANSACTION_MARKER контракта в
-- ensureServerDatabaseReady.ts).
--
-- Restart/recovery safety:
--  - DROP TABLE IF EXISTS на двете _stage20260801 имена прави файла
--    безопасен за повторно изпълнение дори ако предишен (pre-fix) опит е
--    оставил stale artifact по средата.
--  - Row-count guard-овете (tmp_migration_guard_*) абортират цялата
--    транзакция чрез CHECK violation, ако INSERT...SELECT изгуби или
--    дублира редове — вместо тихо да продължат към DROP на оригинала.
--  - INSERT INTO server_migrations е ПОСЛЕДНАТА DML стъпка преди COMMIT —
--    ledger редът никога не се записва, ако rebuild-ът/guard-овете не са
--    минали успешно (атомарно с самата schema промяна, не отделна стъпка).
--  - Ако схемата вече е коректна (seed_slot до 16, round_of_16/quarterfinal
--    позволени) само ledger записът липсва, файлът е безопасен да се
--    изпълни отново: rebuild-ва отново от ТЕКУЩИТЕ (вече правилни) данни
--    в идентична схема — redundant, но не destructive — и накрая записва
--    липсващия ledger ред.
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

DROP TABLE IF EXISTS tournament_teams_stage20260801;

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

CREATE TEMP TABLE tmp_migration_guard_teams (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO tmp_migration_guard_teams (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM tournament_teams) = (SELECT COUNT(*) FROM tournament_teams_stage20260801)
  THEN 1 ELSE 0
END;
DROP TABLE tmp_migration_guard_teams;

DROP TABLE tournament_teams;
ALTER TABLE tournament_teams_stage20260801 RENAME TO tournament_teams;

CREATE INDEX IF NOT EXISTS idx_tournament_teams_tournament
  ON tournament_teams(tournament_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_teams_seed_slot_unique
  ON tournament_teams(tournament_id, seed_slot)
  WHERE seed_slot IS NOT NULL;

DROP TABLE IF EXISTS tournament_rounds_stage20260801;

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

CREATE TEMP TABLE tmp_migration_guard_rounds (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO tmp_migration_guard_rounds (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM tournament_rounds) = (SELECT COUNT(*) FROM tournament_rounds_stage20260801)
  THEN 1 ELSE 0
END;
DROP TABLE tmp_migration_guard_rounds;

DROP TABLE tournament_rounds;
ALTER TABLE tournament_rounds_stage20260801 RENAME TO tournament_rounds;

INSERT INTO server_migrations (filename)
  VALUES ('20260801_001_add_variable_team_capacity_bracket_rounds.sql');

COMMIT;

PRAGMA foreign_keys = ON;
