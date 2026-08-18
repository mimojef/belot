PRAGMA foreign_keys = ON;

-- VIP оферти (Магазин -> VIP tab) — цени в EUR цента, admin-editable от
-- Админ панел -> Настройки (виж adminSettingsStore.ts). Продължителностите
-- (30/180/365 дни) НЕ се пазят тук — те са server-side code constants
-- (VIP_PACKAGE_CATALOG в index.ts/vipPurchaseStore.ts), само цената е
-- configurable. Idempotent seed по established admin_settings pattern
-- (ON CONFLICT DO NOTHING) — restart-safe, не презаписва вече зададена от
-- admin стойност при повторно изпълнение на migration runner-а.
--
-- Начални стойности (одобрени, не измислени тук):
--   VIP 30 дни  = 7,89 €  = 789 цента
--   VIP 180 дни = 39,89 € = 3989 цента
--   VIP 365 дни = 69,89 € = 6989 цента
INSERT INTO admin_settings (setting_key, setting_value) VALUES
  ('vip_price_30_days_cents', '789'),
  ('vip_price_180_days_cents', '3989'),
  ('vip_price_365_days_cents', '6989')
ON CONFLICT(setting_key) DO NOTHING;
