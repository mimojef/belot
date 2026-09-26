PRAGMA foreign_keys = ON;

-- Configurable registration mode (Admin -> Настройки -> "Метод за
-- регистрация", виж adminSettingsStore.ts registrationVerificationMode) —
-- admin-editable от Админ панел -> Настройки, SERVER-AUTHORITATIVE (виж
-- authStore.ts's register()/registerDirect() doc коментари). Idempotent
-- seed по established admin_settings pattern (ON CONFLICT DO NOTHING) —
-- restart-safe, mirror на 20260825_001_seed_pika_team_daily_gift_limit.sql.
--
-- 'email_code' (СЪЩИЯТ, напълно непроменен pending-first email verification
-- flow) е ЗАДЪЛЖИТЕЛНАТА default стойност — backward compatibility (виж
-- task-а §12): production поведението остава 100% непроменено веднага след
-- deploy. 'direct' mode се включва само чрез explicit admin превключване от
-- панела, никога автоматично.
INSERT INTO admin_settings (setting_key, setting_value) VALUES
  ('registration_verification_mode', 'email_code')
ON CONFLICT(setting_key) DO NOTHING;
