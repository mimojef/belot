PRAGMA foreign_keys = ON;

-- Дневен лимит (календарен ден, Europe/Sofia) за подаряване на жълтици от
-- профили с роля pika_team ("Екип Pika.bg") — admin-editable от Админ панел
-- -> Настройки (виж adminSettingsStore.ts). Отделен, независим механизъм от
-- съществуващия rolling-24h DAILY_GIFT_LIMIT в yellowCoinGiftStore.ts.
-- Idempotent seed по established admin_settings pattern (ON CONFLICT DO
-- NOTHING) — restart-safe.
--
-- Начална стойност: 200 000 жълтици/ден на pika_team профил — умишлено
-- РАВНА на legacy sender rolling-24h DAILY_GIFT_LIMIT (200 000), НЕ по-
-- висока. pika_team вече bypass-ва legacy rolling-24h лимита изцяло (виж
-- yellowCoinGiftStore.ts §4 skip коментара) и разчита само на тази
-- configurable стойност — deploy-ът на тази функционалност не трябва сам по
-- себе си да увеличава ефективния economy лимит спрямо статуквото преди
-- корекцията. Admin може веднага след deploy да го вдигне от панела.
INSERT INTO admin_settings (setting_key, setting_value) VALUES
  ('pika_team_daily_gift_limit', '200000')
ON CONFLICT(setting_key) DO NOTHING;
