ALTER TABLE daily_reward_tiers ADD COLUMN is_staged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_reward_tiers ADD COLUMN promote_on_date TEXT;
