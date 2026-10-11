PRAGMA foreign_keys = ON;

-- Фаза 6.2 — надеждно съхраняване/възстановяване на Белот мачове, вкл.
-- "Играй пак" replay в СЪЩАТА стая (виж Фаза 6.1's doc коментари в
-- campaignGameHooks.ts/matchEconomyStore.ts за пълния root cause на
-- replay-in-same-room проблема).
--
-- ЗАЩО нова таблица, не разширение на profile_match_results:
--   - profile_match_results's PRIMARY KEY (room_id, profile_id) е ROOM-
--     scoped, не MATCH-scoped — втори/трети мач в replay-ната стая е
--     INSERT OR IGNORE-нат (тихо пропуснат), затова reconciliation,
--     зависещ от нея, структурно не вижда повече от ПЪРВИЯ мач на стаята
--     (виж campaignGameHooks.ts Фаза 6.1 doc коментара). Промяна на тая
--     PRIMARY KEY би засегнала getUserGamesPlayedStats() (admin "изиграни
--     игри днес" статистика) — извън одобрения обхват на тая поправка.
--   - profile_completed_game_ledger (generic, вече съществува от Ludo
--     level/rank фазата) е match-scoped, но НЯМА stake_amount колона —
--     reconciliation-ът не може да resolve-ва earn rule-а без доказан
--     залог, а разширяването му би обвързало Ludo/Belot семантика, за
--     които таблицата изрично е проектирана да ги държи РАЗДЕЛНО.
--
-- ЗАЩО нова таблица, не reuse на match_economy_ledger:
--   - collectRoomStakes/collectBotStakes/payoutMatchWinners се викат само
--     когато stakeAmount > 0 — мачове с нулев залог нямат ТАМ никакъв ред
--     (нито stake_debit, нито winner_payout). Табличен "липсва финансов
--     запис" НЕ е доказателство за залог=0 (виж task spec §1/§2
--     предупреждението) — само доказателство, че платежният path не е
--     писал там, по каквато и да е причина.
--   - payoutMatchWinners може да срине МЕЖДУ BEGIN и COMMIT — тогава
--     match_economy_ledger няма winner_payout, въпреки реално приключил
--     мач с реален победител.
--
-- Дизайн — match_scope PRIMARY KEY компонент:
--   match_scope = matchEconomyStore.ts::getRoomStakeLedgerScope(room) =
--   `${room.id}:v${room.game.stateVersion}` — СЪЩИЯТ established формат,
--   вече доказан за real-money stake/payout ledger-а. room_id се пази
--   ОТДЕЛНО (денормализирано) само за удобство на бъдещи UI/admin заявки
--   по стая — NIKOгаш не се ползва за reconciliation uniqueness тук.
--
-- Атомарност (виж task spec §3 "не е достатъчно журнал непосредствено
-- преди кампанийния hook"): записва се в playerProgressStore.ts's
-- recordCompletedMatch() — ПЪРВАТА DB операция след
-- shouldRunMatchCompletionSideEffects guard-а в index.ts. Срив СЛЕД тая
-- стъпка (напр. по време на payoutMatchWinners или campaign hook-а)
-- оставя тая таблица вече durably committed — reconciliation remains
-- fully capable дори ако мачът никога не достигне campaign hook-а.
--
-- Whole-match atomicity (одит-поправка): ВСИЧКИ редове (по един на всеки
-- участник на мача) се пишат в ЕДНА SQLite транзакция — "всички seats
-- заедно или никой", НЕ per-seat (инжектирана грешка на 3-ти от 4
-- участника иначе би оставила ЧАСТИЧНО записан мач — 2 seats present, 2
-- missing — правейки евентуален победител от пропуснатите seats
-- невъзстановим: нито primary scan, нито legacy sweep вижда profile без
-- ред в ПОНЕ една от двете таблици). Умишлено ОТДЕЛНА транзакция от
-- profile_match_results's собствен (непроменен спрямо pre-Фаза-6.2) insert
-- loop — profile_match_results/ELO/completed-games остават 100%
-- незасегнати от тая промяна (виж recordCompletedMatch doc коментара).
--
-- stake_amount е АВТОРИТЕТЕН room.config.stakeAmount В МОМЕНТА на
-- приключване — НЕ извеждан от липса/наличие на ledger редове, точно
-- както задачата изисква.
-- profile_id е NULL-able + deleted_profile_id_snapshot, mirror на
-- profile_match_results's ON DELETE SET NULL категоризация (виж
-- 20260902_002_preserve_financial_and_ban_history_on_profile_delete.sql —
-- "historical game results" категория, преживява profile hard-delete с
-- запазена snapshot атрибуция; profileHardDeleteService.ts). PRIMARY KEY с
-- NULL-able profile_id е безопасно — SQLite никога не третира NULL като
-- дублиращ друг NULL при PK/UNIQUE проверка (виж коментара в
-- 20260902_002-ия мигратор за същия (room_id, profile_id) PK случай).
CREATE TABLE IF NOT EXISTS belot_match_completion_ledger (
  match_scope TEXT NOT NULL CHECK (trim(match_scope) <> ''),
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  room_id TEXT NOT NULL,
  team TEXT NOT NULL CHECK (team IN ('A', 'B')),
  did_win INTEGER NOT NULL CHECK (did_win IN (0, 1)),
  stake_amount INTEGER NOT NULL CHECK (stake_amount >= 0),
  ended_at TEXT NOT NULL,
  is_guest_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_guest_trial IN (0, 1)),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_scope, profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_belot_match_completion_ledger_room
  ON belot_match_completion_ledger(room_id);

CREATE INDEX IF NOT EXISTS idx_belot_match_completion_ledger_deleted_profile_snapshot
  ON belot_match_completion_ledger(deleted_profile_id_snapshot);

-- Поддържа reconciliation-ния durable-cursor pagination (ordered by
-- ended_at, match_scope, profile_id — mirror на profile_match_results's
-- (completed_at, room_id, profile_id) ordering convention в
-- campaignGameHooks.ts).
CREATE INDEX IF NOT EXISTS idx_belot_match_completion_ledger_ended_at
  ON belot_match_completion_ledger(did_win, is_guest_trial, ended_at, match_scope, profile_id);
