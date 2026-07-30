PRAGMA foreign_keys = ON;

-- DB-ниво гаранция за "максимум 1 активен създаден турнир на profile"
-- (продуктово изискване от втория persistence етап). Partial UNIQUE index
-- вместо application-level SELECT-count-then-INSERT — предпазва от race
-- condition при две едновременни POST заявки от същия creator, защото
-- SQLite сериализира INSERT операциите и вторият INSERT в конфликтния
-- прозорец просто fail-ва с constraint violation (виж createTournament()
-- try/catch в tournamentStore.ts, огледално на insertPartnerRatingStatement
-- pattern-а в playerProgressStore.ts).
--
-- "Активен" = open | starting | semifinal_in_progress | final_in_progress.
-- finished/cancelled/admin_cancelled/auto_cancelled/failed НЕ блокират нов
-- турнир от същия creator.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tournaments_one_active_per_creator
  ON tournaments(creator_profile_id)
  WHERE status IN ('open', 'starting', 'semifinal_in_progress', 'final_in_progress');
