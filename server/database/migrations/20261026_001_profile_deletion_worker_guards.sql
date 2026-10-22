-- MANUAL_TRANSACTION_MIGRATION
-- Самоизтриване на профили — Етап 4: защити за автоматичното окончателно
-- изтриване. Допълваща миграция — 20261024_001 и 20261025_001 остават
-- непроменени.
--
-- Собствена транзакция (MANUAL_TRANSACTION_MIGRATION), защото т. 5 пресъздава
-- gift_item_transactions, а PRAGMA foreign_keys не може да се изключи вътре в
-- отворена транзакция (виж ensureServerDatabaseReady.ts и established pattern-а
-- в 20260923_004).
--
-- 1. profile_deletion_requests.db_deleted_at — ясна граница между "данните в
--    базата са изтрити" и "заявката е окончателно завършена" (файловете може
--    още да чакат в опашката). Задава се веднъж, само от executing.
-- 2. След изтриване в базата заявката не може да се върне към pending/blocked
--    (т.е. да стане отново отменяема или "скрит, но жив" профил).
-- 3. completed е възможен само при db_deleted_at и само когато всички файлови
--    операции на заявката са done или skipped_shared (поправка на установения
--    в Етап 3 пропуск: базата позволяваше completed с необработени файлове).
-- 4. Редовете в profile_deletion_file_queue не могат да бъдат изтривани —
--    файл, записан в опашката, не може да "изчезне" преди обработка.
-- 5. gift_item_transactions: изпращачът/получателят стават NULL при изтриване
--    на профил (ON DELETE SET NULL) вместо каскадно изтриване на целия ред —
--    получените от други потребители подаръци и записът на чуждите разходи
--    оцеляват, без идентичността на изтрития участник (НЕ се пази snapshot).
-- 6. tournament_entries: профил с активна заявка за изтриване не може да
--    получи НОВО активно турнирно участие (общ SQLite guard срещу race между
--    процесите при подаване на заявка и записване в турнир). Съществуващи
--    участия и преходите между активните статуси НЕ се засягат.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- ─── 1. db_deleted_at ───────────────────────────────────────────────────────
ALTER TABLE profile_deletion_requests ADD COLUMN db_deleted_at TEXT NULL CHECK (
  db_deleted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', db_deleted_at) IS db_deleted_at
);

CREATE TRIGGER trg_profile_deletion_requests_db_deleted_guard
BEFORE UPDATE OF db_deleted_at ON profile_deletion_requests
WHEN NEW.db_deleted_at IS NOT OLD.db_deleted_at
BEGIN
  SELECT CASE
    WHEN OLD.db_deleted_at IS NOT NULL
      THEN RAISE(ABORT, 'profile_deletion_db_deleted_immutable')
    WHEN OLD.status IS NOT 'executing'
      THEN RAISE(ABORT, 'profile_deletion_db_deleted_requires_executing')
  END;
END;

-- ─── 2. Без връщане назад след изтриване в базата ──────────────────────────
-- Само легалните преходи executing -> pending/blocked се ограничават тук
-- (нелегалните вече се отхвърлят от trg_profile_deletion_requests_status_transition).
CREATE TRIGGER trg_profile_deletion_requests_after_db_deleted
BEFORE UPDATE OF status ON profile_deletion_requests
WHEN OLD.db_deleted_at IS NOT NULL
  AND OLD.status = 'executing'
  AND NEW.status IN ('pending', 'blocked')
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_db_already_deleted');
END;

-- ─── 3. completed само при завършени файлови операции ─────────────────────
CREATE TRIGGER trg_profile_deletion_requests_completion_guard
BEFORE UPDATE OF status ON profile_deletion_requests
WHEN OLD.status = 'executing' AND NEW.status = 'completed'
BEGIN
  SELECT CASE
    WHEN NEW.db_deleted_at IS NULL
      THEN RAISE(ABORT, 'profile_deletion_completion_requires_db_deleted')
    WHEN EXISTS (
      SELECT 1 FROM profile_deletion_file_queue q
      WHERE q.request_id = OLD.request_id
        AND q.status NOT IN ('done', 'skipped_shared')
    )
      THEN RAISE(ABORT, 'profile_deletion_completion_files_pending')
  END;
END;

-- ─── 4. Опашката е append-only по редове ───────────────────────────────────
CREATE TRIGGER trg_profile_deletion_file_queue_no_delete
BEFORE DELETE ON profile_deletion_file_queue
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_file_queue_no_delete');
END;

-- ─── 5. gift_item_transactions: SET NULL вместо CASCADE ────────────────────
-- Точно копие на live schema-та (20260909_001_create_gift_item_catalog.sql),
-- с изменения САМО по sender_profile_id/recipient_profile_id:
--   NOT NULL -> NULL, FK ON DELETE CASCADE -> ON DELETE SET NULL.
-- CHECK (sender_profile_id <> recipient_profile_id) остава — при NULL той не
-- е нарушен. gift_item_delivery_log реферира таблицата по име
-- (transaction_id ON DELETE CASCADE) и продължава да сочи новата таблица.
-- Тригерът trg_protect_campaign_gift_sender_profiles (20261013_001) е върху
-- profiles, но чете gift_item_transactions — SQLite отказва RENAME, докато
-- тригер сочи несъществуваща таблица, затова той се премахва временно и се
-- пресъздава ДОСЛОВНО след RENAME, в същата транзакция.
DROP TRIGGER trg_protect_campaign_gift_sender_profiles;

CREATE TABLE gift_item_transactions_new (
  transaction_id TEXT PRIMARY KEY,
  gift_item_id TEXT NOT NULL,
  sender_profile_id TEXT NULL,
  recipient_profile_id TEXT NULL,
  charged_price INTEGER NOT NULL CHECK (charged_price > 0),
  context TEXT NOT NULL DEFAULT 'profile',
  room_id TEXT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (sender_profile_id <> recipient_profile_id),
  FOREIGN KEY (gift_item_id) REFERENCES gift_items(gift_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO gift_item_transactions_new (
  transaction_id, gift_item_id, sender_profile_id, recipient_profile_id,
  charged_price, context, room_id, request_id, created_at
)
SELECT
  transaction_id, gift_item_id, sender_profile_id, recipient_profile_id,
  charged_price, context, room_id, request_id, created_at
FROM gift_item_transactions;

DROP TABLE gift_item_transactions;
ALTER TABLE gift_item_transactions_new RENAME TO gift_item_transactions;

CREATE INDEX idx_gift_item_transactions_sender
  ON gift_item_transactions(sender_profile_id, created_at);

CREATE INDEX idx_gift_item_transactions_recipient
  ON gift_item_transactions(recipient_profile_id, created_at);

CREATE TRIGGER trg_protect_campaign_gift_sender_profiles
BEFORE DELETE ON profiles
WHEN EXISTS (
  SELECT 1 FROM gift_item_transactions
  WHERE sender_profile_id = OLD.profile_id
    AND context = 'campaign_reward'
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_gift_sender_protected');
END;

-- ─── 6. Турнирен admission guard ───────────────────────────────────────────
CREATE TRIGGER trg_tournament_entries_profile_deletion_admission_insert
BEFORE INSERT ON tournament_entries
WHEN NEW.profile_id IS NOT NULL
  AND NEW.status IN ('confirmed', 'finalist')
  AND EXISTS (
    SELECT 1 FROM profile_deletion_requests r
    WHERE r.profile_id = NEW.profile_id
      AND r.status IN ('pending', 'executing', 'blocked', 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_pending_tournament_admission');
END;

CREATE TRIGGER trg_tournament_entries_profile_deletion_admission_update
BEFORE UPDATE OF status, profile_id ON tournament_entries
WHEN NEW.profile_id IS NOT NULL
  AND NEW.status IN ('confirmed', 'finalist')
  AND (OLD.status NOT IN ('confirmed', 'finalist') OR NEW.profile_id IS NOT OLD.profile_id)
  AND EXISTS (
    SELECT 1 FROM profile_deletion_requests r
    WHERE r.profile_id = NEW.profile_id
      AND r.status IN ('pending', 'executing', 'blocked', 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_deletion_pending_tournament_admission');
END;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261026_001_profile_deletion_worker_guards.sql');

COMMIT;

PRAGMA foreign_keys = ON;
