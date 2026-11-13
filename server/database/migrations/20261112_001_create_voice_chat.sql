-- Гласов чат в частните маси на Белот — Етап 2а (само добавяща миграция).
--
-- Нищо тук не включва функцията: без записи в voice_chat_admin_changes
-- режимът е 'off' (виж voiceChatStore.ts). Миграция/deploy/рестарт НЕ могат
-- да направят гласовия чат активен. Няма аудио, съдържание на разговори,
-- имена или IP адреси — само технически идентификатори и одит.

PRAGMA foreign_keys = ON;

-- ─── Одит на административните настройки (режим и лимит) ─────────────────
-- Текущата стойност на всяка настройка е последният ѝ запис; без записи:
-- mode='off', max_tables=10. Без snapshot на имена — админ UI-ят резолвва
-- името live от profiles (при изтрит профил changed_by_profile_id става
-- NULL от FK, без лични данни в одита).
CREATE TABLE IF NOT EXISTS voice_chat_admin_changes (
  change_id TEXT PRIMARY KEY,
  setting TEXT NOT NULL CHECK (setting IN ('mode', 'max_tables')),
  new_value TEXT NOT NULL,
  previous_value TEXT NOT NULL,
  changed_by_profile_id TEXT NULL,
  changed_at TEXT NOT NULL,
  CHECK (
    setting <> 'mode'
    OR (new_value IN ('off', 'admin_only', 'public') AND previous_value IN ('off', 'admin_only', 'public'))
  ),
  CHECK (
    setting <> 'max_tables'
    OR (
      new_value GLOB '[0-9]*' AND new_value NOT GLOB '*[^0-9]*'
      AND previous_value GLOB '[0-9]*' AND previous_value NOT GLOB '*[^0-9]*'
    )
  ),
  FOREIGN KEY (changed_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_chat_admin_changes_setting_changed_at
  ON voice_chat_admin_changes(setting, changed_at);

-- ─── Гласова маса = точно един слот от лимита ─────────────────────────────
-- status='active' заема слот през ЦЕЛИЯ живот на масата (чакалня, мач, край
-- на мача, повторни игри, периоди без свързани участници) — phase само
-- описва къде е масата и НИКОГА не е второ резервиране: преходът
-- waiting -> in_game е UPDATE на същия ред. Слотът не зависи от наличието на
-- LiveKit стая. status='released' е крайно — освободеният ред никога не се
-- активира отново (повторно включване = нов voice_table_id).
CREATE TABLE IF NOT EXISTS voice_tables (
  voice_table_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  phase TEXT NOT NULL CHECK (phase IN ('waiting', 'in_game')),
  private_room_id TEXT NULL,
  server_room_id TEXT NULL,
  -- Сегмент на правото за говорене (match-scoped speaking grace):
  -- 1 = чакалнята + първият мач; всяко "Преиграй" -> +1.
  match_seq INTEGER NOT NULL DEFAULT 1 CHECK (match_seq >= 1),
  created_at TEXT NOT NULL,
  in_game_at TEXT NULL,
  released_at TEXT NULL,
  release_reason TEXT NULL,
  CHECK ((status = 'active' AND released_at IS NULL AND release_reason IS NULL)
      OR (status = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)),
  CHECK (phase = 'waiting' OR (server_room_id IS NOT NULL AND in_game_at IS NOT NULL))
);

-- COUNT за атомарния лимит обхожда само активните редове.
CREATE INDEX IF NOT EXISTS idx_voice_tables_active
  ON voice_tables(status) WHERE status = 'active';

-- Една частна маса / една игрова стая -> най-много една активна гласова маса
-- (защита срещу двойно резервиране и двойно обвързване при старт).
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_tables_active_private_room
  ON voice_tables(private_room_id) WHERE status = 'active' AND private_room_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_tables_active_server_room
  ON voice_tables(server_room_id) WHERE status = 'active' AND server_room_id IS NOT NULL;

-- ─── Генерации на LiveKit стаята ─────────────────────────────────────────
-- Името се записва ПРЕДИ каквато и да е LiveKit операция (Етап 2б), така че
-- забавен/timeout-нат CreateRoom винаги се отнася до известно име. Оттеглено
-- име (delete_pending/deleted) НИКОГА не се създава и за него НИКОГА не се
-- издава токен. delete_pending редовете са опашката за DeleteRoom — тя е в
-- базата, а не в паметта, и не се губи при препълнена опашка, circuit
-- breaker или рестарт. Отделно от слотовете: освободена маса може още да има
-- стаи, чакащи прекратяване.
CREATE TABLE IF NOT EXISTS voice_room_generations (
  livekit_room_name TEXT PRIMARY KEY,
  voice_table_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL CHECK (status IN ('live', 'delete_pending', 'deleted')),
  created_at TEXT NOT NULL,
  retire_requested_at TEXT NULL,
  retire_reason TEXT NULL,
  delete_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  next_delete_attempt_at TEXT NULL,
  last_delete_error TEXT NULL,
  deleted_confirmed_at TEXT NULL,
  UNIQUE (voice_table_id, generation),
  CHECK ((status = 'live' AND retire_requested_at IS NULL AND deleted_confirmed_at IS NULL)
      OR (status = 'delete_pending' AND retire_requested_at IS NOT NULL AND deleted_confirmed_at IS NULL)
      OR (status = 'deleted' AND retire_requested_at IS NOT NULL AND deleted_confirmed_at IS NOT NULL)),
  FOREIGN KEY (voice_table_id) REFERENCES voice_tables(voice_table_id) ON DELETE CASCADE
);

-- Най-много една жива генерация на маса.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_room_generations_one_live
  ON voice_room_generations(voice_table_id) WHERE status = 'live';

CREATE INDEX IF NOT EXISTS idx_voice_room_generations_pending
  ON voice_room_generations(next_delete_attempt_at) WHERE status = 'delete_pending';

-- ─── Ограничено право за завършване на мача с глас ──────────────────────
-- НЕ е втори VIP статус: записът казва само "този профил е имал право да
-- говори в този сегмент (match_seq) на тази гласова маса" и важи само докато
-- voice_tables.match_seq е същият. Изтрит профил -> CASCADE.
CREATE TABLE IF NOT EXISTS voice_speaking_grants (
  voice_table_id TEXT NOT NULL,
  match_seq INTEGER NOT NULL CHECK (match_seq >= 1),
  profile_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (voice_table_id, match_seq, profile_id),
  FOREIGN KEY (voice_table_id) REFERENCES voice_tables(voice_table_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
