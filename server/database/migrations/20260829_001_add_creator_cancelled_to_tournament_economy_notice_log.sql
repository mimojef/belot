-- MANUAL_TRANSACTION_MIGRATION
-- Widen tournament_economy_notice_log.reason to also accept 'creator_cancelled'
-- (§"REFUND POPUP СЕ ПОКАЗВА СЛЕД LOGOUT" bugfix). Until now this durable
-- delivery log only covered scheduler-driven auto-cancel reasons
-- (fill_expired/scheduled_underfilled, see 20260808_001) — a creator-initiated
-- cancel (cancelOpenTournamentAndRefundAtomically) had NO durable notice at
-- all, only the online-only sendToOpenProfileConnections push. An offline (or
-- stale-connection) recipient of a creator cancel therefore lost the refund
-- notification permanently instead of seeing it on next login. SQLite cannot
-- alter CHECK constraints in place, so this follows the established
-- table-rebuild pattern from 20260812_005.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE tournament_economy_notice_log_new (
  notice_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('fill_expired', 'scheduled_underfilled', 'creator_cancelled')
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
  VALUES ('20260829_001_add_creator_cancelled_to_tournament_economy_notice_log.sql');

COMMIT;

PRAGMA foreign_keys = ON;
