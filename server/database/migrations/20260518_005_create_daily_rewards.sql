CREATE TABLE IF NOT EXISTS daily_reward_tiers (
  tier_id     TEXT    PRIMARY KEY,
  sort_order  INTEGER NOT NULL,
  yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
  created_at  TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS player_daily_reward_claims (
  claim_id    TEXT    PRIMARY KEY,
  profile_id  TEXT    NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  tier_id     TEXT    NOT NULL REFERENCES daily_reward_tiers(tier_id) ON DELETE CASCADE,
  claim_date  TEXT    NOT NULL,
  claimed_at  TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (profile_id, tier_id, claim_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_claims_profile_date
  ON player_daily_reward_claims (profile_id, claim_date);
