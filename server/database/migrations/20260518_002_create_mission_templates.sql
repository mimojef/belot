PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mission_templates (
  mission_id TEXT PRIMARY KEY,
  mission_type TEXT NOT NULL CHECK (
    mission_type IN (
      'win_games',
      'win_capot_games',
      'win_contra_games',
      'play_games',
      'announce_tersa',
      'announce_50',
      'announce_100',
      'announce_kare',
      'announce_belot'
    )
  ),
  title TEXT NOT NULL CHECK (trim(title) <> ''),
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  reward_yellow_coins INTEGER NOT NULL CHECK (reward_yellow_coins > 0),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mission_templates_active
  ON mission_templates(is_active, sort_order);
