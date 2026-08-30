-- Durable, tournament-scoped rejoin ban за играч, когото създателят или
-- администратор принудително е отписал (force-remove на цял complete team
-- или единичен forming/waiting solo participant) от OPEN турнир — виж
-- forceRemoveTeamAtomically/forceRemoveEntryAtomically в
-- tournamentEconomyStore.ts. Отделна таблица от нормалния voluntary
-- leave/refund path (tournament_entries.status='refunded' САМО показва, че
-- входът е върнат — не носи "не може да се запише пак" семантика; тази
-- забрана е explicit и persistent, restart-safe, независимо от entry
-- status/lifecycle).
--
-- Съхранена е profile-scoped (blocked_profile_id, огледално на
-- tournament_entries.profile_id), но enforcement-ът на забраната
-- (selectParticipationBlockStatement в tournamentEconomyStore.ts) е
-- account-aware: join/invite/accept guard-ите join-ват live към
-- profiles.account_id на blocked_profile_id, за да не може блокираният
-- играч да заобиколи забраната чрез друг профил на СЪЩИЯ акаунт — огледално
-- на вече съществуващия selectActiveEntryForAccountStatement guard
-- ("already_participating_elsewhere").
--
-- UNIQUE(tournament_id, blocked_profile_id) прави insert-а idempotent
-- (INSERT OR IGNORE) — retry на force-remove операцията никога не създава
-- дублиран block ред.
CREATE TABLE IF NOT EXISTS tournament_participation_blocks (
  block_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  blocked_profile_id TEXT NOT NULL,
  actor_profile_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('player', 'admin')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tournament_id, blocked_profile_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
