-- Добавя две неща, необходими за match waiting/round-transition UX flow-а
-- (виж §3/§9/§8/§12 в task spec-а):
--
--   1. deadline_kind — differentiate "първи мач на отбора" (3 минути
--      server-authoritative прозорец) от "round transition" (20 секунди,
--      след като и двата feeder мача от предния кръг са известни).
--      Coordinator-ът вече знае кой кръг е първият в ladder-а
--      (getTournamentRoundLadder(teamCapacity)[0]) — тази колона просто
--      persist-ва избора, за да е рестартируемо (§12: "State и restart
--      safety" — след server restart трябва да се възстанови кой режим на
--      прозорец важи, без да се предполага наново от round_type).
--
--   2. final_score_team_a / final_score_team_b — persisted краен резултат
--      на завършен мач. Нужен е за "Feeder match score се обновява
--      authoritative" (§8/§12) след завършек — room обектите са in-memory
--      (загубват се при server restart), а end-round екранът трябва да може
--      да покаже финалния резултат на feeder мача дори след restart/refresh
--      без да разчита на все още жив room snapshot.
--
-- И двете колони са NULLABLE, additive — съществуващите редове/данни не се
-- пипат. Не се налага table rebuild, защото не се добавя CHECK constraint
-- върху съществуваща колона (само нови nullable колони) — обикновен ALTER
-- TABLE ADD COLUMN е достатъчен и по-евтин от stage-rebuild.
--
-- ВАЖНО: тази миграция НЯМА MANUAL_TRANSACTION_MIGRATION маркер — не
-- toggle-ва PRAGMA foreign_keys и не прави table rebuild, затова няма нужда
-- сама да управлява собствена транзакция. Реалното изпълнение става чрез
-- SMART_MIGRATION_HANDLERS registry-то в ensureServerDatabaseReady.ts
-- (applyTournamentMatchDeadlineKindAndScoreMigration), защото SQLite няма
-- "ALTER TABLE ADD COLUMN IF NOT EXISTS" — handler-ът проверява всяка
-- колона поотделно чрез PRAGMA table_info и добавя само реално липсващите
-- (safe recovery, ако предишен опит е добавил част от тях преди да падне),
-- после потвърждава и трите postcondition-и (колона + тип), преди runner-ът
-- да запише ledger реда — атомарно, в една транзакция, притежавана от
-- runner-а. SQL-ът по-долу документира точната целева схема и остава
-- изпълним "както е" (unconditional) само срещу чиста база.
ALTER TABLE tournament_matches ADD COLUMN deadline_kind TEXT NULL CHECK (
  deadline_kind IS NULL OR deadline_kind IN ('first_match', 'round_transition')
);

ALTER TABLE tournament_matches ADD COLUMN final_score_team_a INTEGER NULL;
ALTER TABLE tournament_matches ADD COLUMN final_score_team_b INTEGER NULL;
