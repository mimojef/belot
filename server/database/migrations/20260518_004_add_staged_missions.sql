ALTER TABLE mission_templates ADD COLUMN is_staged INTEGER NOT NULL DEFAULT 0 CHECK (is_staged IN (0, 1));

INSERT OR IGNORE INTO admin_settings (setting_key, setting_value) VALUES ('last_mission_reset_date', '');
