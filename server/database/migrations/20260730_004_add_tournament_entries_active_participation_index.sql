PRAGMA foreign_keys = ON;

-- DB-ниво гаранция за "1 profile — най-много 1 активно турнирно участие
-- глобално" (продуктово изискване от третия persistence етап). Различно от
-- вече съществуващия UNIQUE(tournament_id, profile_id) в tournament_entries
-- (migration 001), който гарантира само "не два пъти в СЪЩИЯ турнир" —
-- тук гарантираме "не участва едновременно в ДВА различни турнира".
--
-- "Активно" = confirmed | finalist (finalist е бъдещ статус за играч,
-- достигнал финала — schema вече го поддържа в TOURNAMENT_ENTRY_STATUSES,
-- затова е включен тук предварително, за да не се налага нова миграция
-- при бъдещия bracket етап). withdrawn/refunded/eliminated/champion НЕ
-- блокират ново участие (withdrawn/refunded са терминални доброволни
-- изходи; eliminated/champion са терминални резултати от бъдещ bracket).
--
-- Partial UNIQUE index вместо application-level SELECT-count-then-INSERT —
-- предпазва от race condition при две едновременни join заявки на един
-- profile към два различни турнира (виж idx_tournaments_one_active_per_creator,
-- migration 003, за огледален pattern).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_entries_one_active_per_profile
  ON tournament_entries(profile_id)
  WHERE status IN ('confirmed', 'finalist');

-- Supports the transaction-time account-level guard in tournamentEconomyStore.
-- SQLite partial unique indexes cannot reference another table, so the
-- account-level invariant is checked under BEGIN IMMEDIATE while this index
-- keeps the profile -> account lookup cheap.
CREATE INDEX IF NOT EXISTS idx_profiles_account_id
  ON profiles(account_id)
  WHERE account_id IS NOT NULL;
