PRAGMA foreign_keys = ON;

-- Durable cursor state for the Phase 3 campaign credit reconciliation job.
-- The job advances through authoritative game result tables in small batches
-- instead of scanning a fixed recent time window on every tick. If a row fails,
-- idempotent campaign_unit_ledger writes make retries safe when the cursor wraps.
CREATE TABLE IF NOT EXISTS campaign_credit_reconciliation_state (
  source_type TEXT PRIMARY KEY CHECK (source_type IN ('belot_win', 'ludo_win')),
  cursor_event_at TEXT NOT NULL DEFAULT '',
  cursor_source_id TEXT NOT NULL DEFAULT '',
  cursor_profile_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profile_match_results_campaign_reconciliation
  ON profile_match_results(is_guest_trial, did_win, completed_at, room_id, profile_id);

CREATE INDEX IF NOT EXISTS idx_ludo_room_matches_campaign_reconciliation
  ON ludo_room_matches(status, finished_at, match_id, winner_profile_id);
