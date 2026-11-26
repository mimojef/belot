-- Етап 3Б.1: връзка „удържан вход от случайната опашка → създадена маса“.
--
-- Входът в случайната опашка се удържа под ledger scope `queue:<entryId>`
-- (match_economy_ledger), често ДОКАТО играчът още чака. Опашката живее
-- само в RAM, а изплащането на мача се пише под room scope
-- `<roomId>:v<n>` — между двата scope-а досега НЯМАШЕ устойчива връзка.
-- След рестарт не можеше да се различи вход на изчезнала опашка от вход,
-- вече използван в мач.
--
-- Редът се записва в момента, в който удържаните входове се свързват с
-- новосъздадена маса (преди стаята да се запише в active_room_snapshots).
-- При старт на сървъра:
--   - вход с връзка → използван в мач (никога не се връща автоматично);
--   - вход без връзка, без активна маса, удържан СЛЕД прилагането на тази
--     миграция → осиротял → връща се през съществуващия
--     refundParticipantScopedStake (атомарно, идемпотентно);
--   - вход отпреди тази миграция → само доклад за ръчна проверка.
--
-- Без FK към profiles: финансовата история се пази и при изтрит профил.
CREATE TABLE IF NOT EXISTS matchmaking_stake_bindings (
  queue_scope TEXT NOT NULL CHECK (queue_scope LIKE 'queue:_%'),
  profile_id TEXT NOT NULL CHECK (trim(profile_id) <> ''),
  room_id TEXT NOT NULL CHECK (trim(room_id) <> ''),
  bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (queue_scope, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_matchmaking_stake_bindings_room
  ON matchmaking_stake_bindings(room_id);
