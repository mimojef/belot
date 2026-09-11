PRAGMA foreign_keys = ON;

-- Еднократен безплатен VIP при първи опит за писане в "Теми" (launch gift,
-- виж vipStore.ts claimLaunchGift) — брой дни вече admin-editable от Админ
-- панел -> Настройки (виж adminSettingsStore.ts), вместо hardcoded константа
-- в index.ts. Idempotent seed по established admin_settings pattern (ON
-- CONFLICT DO NOTHING) — restart-safe, не презаписва вече зададена от admin
-- стойност при повторно изпълнение на migration runner-а.
--
-- Начална стойност: 30 дни — умишлено РАВНА на предишната hardcoded
-- VIP_LAUNCH_GIFT_INTERVAL константа, за да запази статуквото след deploy
-- (0 = изключва безплатния VIP, насочва към VIP офертите в магазина).
INSERT INTO admin_settings (setting_key, setting_value) VALUES
  ('free_topics_vip_days', '30')
ON CONFLICT(setting_key) DO NOTHING;
