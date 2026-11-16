-- „Забрана за съвместна игра“ (Етап 1) — административна двустранна забрана
-- между ДВА АКАУНТА: всички настоящи и бъдещи профили на единия акаунт не
-- могат да участват на една маса с профилите на другия. Само добавяща
-- миграция: нищо съществуващо не се променя.
--
-- Идентичност и уникалност — по accountId (account_low_id < account_high_id,
-- за да не зависи от реда на избраните профили). Избраните от администратора
-- профили се пазят само за историята (+ снимка на имената).
--
-- Без FK към accounts/profiles (както admin_profile_deletions): историята и
-- одитът оцеляват при изтриване на профил/акаунт.
--
-- Състояние (без cron/background job):
--   * активна    = ended_at IS NULL AND (expires_at IS NULL OR expires_at > сега);
--   * изтекла    = end_kind='expired' ИЛИ (ended_at IS NULL AND expires_at <= сега)
--                  — затваря се лениво (ended_at = expires_at) при ново налагане
--                  за същата двойка;
--   * отменена   = end_kind='lifted' (предсрочна отмяна от администратор).
-- Времената са ISO-8601 UTC с милисекунди (сравними като текст).
CREATE TABLE IF NOT EXISTS co_play_restrictions (
  restriction_id TEXT PRIMARY KEY,
  account_low_id TEXT NOT NULL,
  account_high_id TEXT NOT NULL,
  -- Бъдещо разширение: 'svara' / 'ludo' (CHECK-ът се разширява с миграция).
  game_scope TEXT NOT NULL DEFAULT 'belot' CHECK (game_scope IN ('belot')),
  -- Избраният от администратора профил за всеки от двата акаунта (история).
  selected_profile_low_id TEXT NOT NULL,
  selected_profile_high_id TEXT NOT NULL,
  selected_profile_low_name_snapshot TEXT NOT NULL,
  selected_profile_high_name_snapshot TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (trim(reason) <> '' AND length(reason) <= 500),
  -- NULL = безсрочна; иначе цяло число дни (1 ден = 24 часа от налагането).
  duration_days INTEGER NULL CHECK (duration_days IS NULL OR duration_days >= 1),
  created_at TEXT NOT NULL,
  created_by_profile_id TEXT NULL,
  expires_at TEXT NULL,
  ended_at TEXT NULL,
  end_kind TEXT NULL CHECK (end_kind IS NULL OR end_kind IN ('lifted', 'expired')),
  lifted_by_profile_id TEXT NULL,
  lift_reason TEXT NULL CHECK (lift_reason IS NULL OR length(lift_reason) <= 500),
  CHECK (account_low_id < account_high_id),
  CHECK ((duration_days IS NULL) = (expires_at IS NULL)),
  CHECK ((ended_at IS NULL) = (end_kind IS NULL))
);

-- Без дублирани незатворени забрани за една двойка акаунти (и игра).
CREATE UNIQUE INDEX IF NOT EXISTS ux_co_play_restrictions_open_pair
  ON co_play_restrictions(account_low_id, account_high_id, game_scope)
  WHERE ended_at IS NULL;

-- Зареждане на незатворените забрани при старт.
CREATE INDEX IF NOT EXISTS idx_co_play_restrictions_open
  ON co_play_restrictions(ended_at, expires_at);

-- Търсене по профил (акаунт) в административната история.
CREATE INDEX IF NOT EXISTS idx_co_play_restrictions_account_low
  ON co_play_restrictions(account_low_id, created_at);
CREATE INDEX IF NOT EXISTS idx_co_play_restrictions_account_high
  ON co_play_restrictions(account_high_id, created_at);
CREATE INDEX IF NOT EXISTS idx_co_play_restrictions_created
  ON co_play_restrictions(created_at);

-- Административен одит (само добавяне). restriction_id е NULL за промяна на
-- глобалната настройка. 'enforcement_removed' — системно действие по
-- прилагане (напр. премахване на по-късно влезлия от обща чакалня).
CREATE TABLE IF NOT EXISTS co_play_restriction_audit (
  audit_id TEXT PRIMARY KEY,
  restriction_id TEXT NULL,
  action TEXT NOT NULL CHECK (action IN ('impose', 'lift', 'close_expired', 'settings_update', 'enforcement_removed')),
  actor_profile_id TEXT NULL,
  created_at TEXT NOT NULL,
  details_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_co_play_restriction_audit_restriction
  ON co_play_restriction_audit(restriction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_co_play_restriction_audit_created
  ON co_play_restriction_audit(created_at);

-- Глобални настройки на системата. CO_PLAY_RESTRICTIONS_ENABLED — изключен
-- по подразбиране: проверките пропускат ограниченията, а записаните забрани и
-- историята им се запазват. Променя се от администратор без deploy/рестарт.
CREATE TABLE IF NOT EXISTS co_play_restriction_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_profile_id TEXT NULL
);

INSERT OR IGNORE INTO co_play_restriction_settings (setting_key, setting_value, updated_at, updated_by_profile_id)
VALUES ('co_play_restrictions_enabled', '0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);
