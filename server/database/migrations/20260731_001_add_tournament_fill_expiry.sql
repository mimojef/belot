PRAGMA foreign_keys = ON;

-- Fill-mode турнирите трябва да имат фиксиран 1-час прозорец от създаването
-- си: ако не се запълнят до fill_expires_at, scheduler-ът ги auto-cancel-ва
-- (виж autoCancelScheduledTournamentAtomically в tournamentEconomyStore.ts,
-- вече reason-parameterized и преизползван тук с reason 'fill_mode_expired').
--
-- Не може да се съхрани в scheduled_start_at — съществуващият CHECK на
-- tournaments изисква (start_mode='fill' AND scheduled_start_at IS NULL).
-- Затова нова nullable колона, огледална на scheduled_start_at по формат
-- (TEXT, UTC ISO без 'Z', виж dbDateToUtc). Cross-column invariant-ът
-- (fill → NOT NULL, scheduled → NULL) се пази на application ниво (виж
-- createTournament) и в admin integrity analyzer-а, огледално на cancel_reason
-- (също free-form TEXT без CHECK) — SQLite ADD COLUMN тук държим single-column,
-- за консистентност с останалите migrations в тази поредица.
ALTER TABLE tournaments ADD COLUMN fill_expires_at TEXT NULL;

-- Backfill за съществуващи open fill турнири без expiry (локална тестова
-- база отпреди тази функционалност) — детерминистично created_at + 1 час,
-- никога client-подадена стойност. Started/finished/cancelled/scheduled
-- редове не се пипат. Ако вече е изтекъл спрямо текущия момент, следващият
-- scheduler tick ще го auto-cancel-не безопасно (atomic refund flow).
UPDATE tournaments
SET fill_expires_at = datetime(created_at, '+1 hours')
WHERE start_mode = 'fill' AND status = 'open' AND fill_expires_at IS NULL;

-- Due-queue индекс за scheduler-а: намира отворени fill турнири с изтекъл срок.
CREATE INDEX IF NOT EXISTS idx_tournaments_fill_expiry_due
  ON tournaments(fill_expires_at)
  WHERE status = 'open' AND start_mode = 'fill';
