PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO admin_settings (
  setting_key,
  setting_value
) VALUES
  ('signup_bonus_yellow_coins', '100000'),
  ('profile_name_change_price', '50000')
ON CONFLICT(setting_key) DO NOTHING;
