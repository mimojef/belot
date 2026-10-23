-- MANUAL_TRANSACTION_MIGRATION
-- Самоизтриване на профили — Етап 4E6B (одит 4E6A, одобрени правила):
-- модераторски записи, които не бива да изчезват само защото техният
-- автор е изтрил профила си.
--
-- Собствена транзакция (MANUAL_TRANSACTION_MIGRATION), защото таблиците се
-- пресъздават, а PRAGMA foreign_keys не може да се изключи вътре в отворена
-- транзакция (established pattern: 20261027_001 / 20261028_001).
--
-- topic_reports (20260811_003):
--   * reporter_profile_id: NOT NULL + ON DELETE CASCADE -> NULL + ON DELETE
--     SET NULL. Неразгледан сигнал срещу чуждо съдържание остава (тема,
--     причина, статус, дата), без връзка към изтрития подател. Кои сигнали
--     остават решава executor-ът (вече разгледаните се изтриват изрично —
--     досегашното поведение); административното изтриване също ги изтрива
--     изрично (непроменено поведение).
--   * topic_id FK, CHECK-овете, двата индекса — непроменени.
--   * Тригери: нов сигнал без подател се отказва; подателят на сигнал не
--     може да бъде сменен или присвоен (разрешено е само NULL от каскадата).
--
-- tournament_participation_blocks (20260830_001):
--   * actor_profile_id: NOT NULL + ON DELETE CASCADE -> NULL + ON DELETE
--     SET NULL. Блокировка, наложена от изтрития, остава в сила за
--     блокирания (турнир, блокиран, роля, причина, дата).
--   * blocked_profile_id — непроменено (CASCADE): блокировката на самия
--     изтрит профил изчезва с него.
--   * UNIQUE (tournament_id, blocked_profile_id), CHECK, FK — непроменени.
--   * Тригери: нова блокировка без автор се отказва; авторът не може да
--     бъде сменен или присвоен (разрешено е само NULL от каскадата).
-- Всички колони и съществуващи стойности са запазени.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE topic_reports_new (
  report_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  reporter_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (trim(reason) <> ''),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'reviewed', 'dismissed')
  ),
  reviewed_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO topic_reports_new (
  report_id, topic_id, reporter_profile_id, reason, status, reviewed_by_account_id, reviewed_at, created_at
)
SELECT
  report_id, topic_id, reporter_profile_id, reason, status, reviewed_by_account_id, reviewed_at, created_at
FROM topic_reports;

DROP TABLE topic_reports;
ALTER TABLE topic_reports_new RENAME TO topic_reports;

CREATE INDEX idx_topic_reports_status_created
  ON topic_reports(status, created_at);

CREATE INDEX idx_topic_reports_reporter_topic
  ON topic_reports(reporter_profile_id, topic_id, created_at);

CREATE TRIGGER trg_topic_reports_reporter_required
BEFORE INSERT ON topic_reports
WHEN NEW.reporter_profile_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'topic_report_reporter_required');
END;

CREATE TRIGGER trg_topic_reports_reporter_immutable
BEFORE UPDATE OF reporter_profile_id ON topic_reports
WHEN NEW.reporter_profile_id IS NOT NULL AND NEW.reporter_profile_id IS NOT OLD.reporter_profile_id
BEGIN
  SELECT RAISE(ABORT, 'topic_report_reporter_immutable');
END;

CREATE TABLE tournament_participation_blocks_new (
  block_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  blocked_profile_id TEXT NOT NULL,
  actor_profile_id TEXT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('player', 'admin')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tournament_id, blocked_profile_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO tournament_participation_blocks_new (
  block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason, created_at
)
SELECT
  block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason, created_at
FROM tournament_participation_blocks;

DROP TABLE tournament_participation_blocks;
ALTER TABLE tournament_participation_blocks_new RENAME TO tournament_participation_blocks;

CREATE TRIGGER trg_tournament_participation_blocks_actor_required
BEFORE INSERT ON tournament_participation_blocks
WHEN NEW.actor_profile_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'tournament_participation_block_actor_required');
END;

CREATE TRIGGER trg_tournament_participation_blocks_actor_immutable
BEFORE UPDATE OF actor_profile_id ON tournament_participation_blocks
WHEN NEW.actor_profile_id IS NOT NULL AND NEW.actor_profile_id IS NOT OLD.actor_profile_id
BEGIN
  SELECT RAISE(ABORT, 'tournament_participation_block_actor_immutable');
END;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20261029_001_preserve_anonymous_moderation_records.sql');

COMMIT;

PRAGMA foreign_keys = ON;
