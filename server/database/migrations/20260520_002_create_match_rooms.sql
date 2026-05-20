CREATE TABLE IF NOT EXISTS match_rooms (
  stake_amount INTEGER PRIMARY KEY,
  min_level    INTEGER NOT NULL DEFAULT 1,
  prize_amount INTEGER NOT NULL,
  is_enabled   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled) VALUES
  (5000,  1, 8000,  1),
  (8000,  1, 12000, 1),
  (10000, 1, 15000, 1),
  (15000, 1, 22000, 1),
  (20000, 1, 30000, 1);
