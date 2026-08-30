-- MANUAL_TRANSACTION_MIGRATION
-- Widen tournament_economy_notice_log.reason to also accept
-- 'force_removed_by_creator' / 'force_removed_by_admin' (creator/admin
-- force-remove moderation feature — team/entry moderation removal from an
-- OPEN tournament). Two distinct reasons (not one generic
-- 'force_removed') so the client can render the exact required copy
-- ("Създателят ви отписа..." vs "Администратор ви отписа...") from the
-- reason alone, same lookup-table pattern as the existing
-- fill_expired/scheduled_underfilled/creator_cancelled reasons — no new
-- column needed. SQLite cannot alter CHECK constraints in place, so this
-- follows the established table-rebuild pattern from 20260829_001.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE tournament_economy_notice_log_new (
  notice_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'fill_expired',
      'scheduled_underfilled',
      'creator_cancelled',
      'force_removed_by_creator',
      'force_removed_by_admin'
    )
  ),
  refunded_amount INTEGER NOT NULL,
  delivered_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

INSERT INTO tournament_economy_notice_log_new (
  notice_id, tournament_id, recipient_profile_id, reason, refunded_amount, delivered_at, created_at
)
SELECT
  notice_id, tournament_id, recipient_profile_id, reason, refunded_amount, delivered_at, created_at
FROM tournament_economy_notice_log;

DROP TABLE tournament_economy_notice_log;

ALTER TABLE tournament_economy_notice_log_new RENAME TO tournament_economy_notice_log;

CREATE INDEX IF NOT EXISTS idx_ten_notice_pending_recipient
  ON tournament_economy_notice_log(recipient_profile_id, created_at)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260830_002_add_force_removed_to_tournament_economy_notice_log.sql');

COMMIT;

PRAGMA foreign_keys = ON;
