PRAGMA foreign_keys = ON;

-- Платен VIP purchase ledger — самостоятелна таблица, mirror на
-- coin_purchase_ledger (20260510_014), НЕ разширение на vip_grants директно
-- (vip_grants си остава чист append-only "какво е приложено", ledger-ът е
-- "какво е платено/в процес на плащане"). Точно това е бъдещият етап,
-- предвиден в коментара на vip_grants migration-а (20260810_001):
-- "Платеният VIP ... ще получи собствена migration (напр.
-- vip_purchase_ledger + payment reference поле в vip_grants)".
--
-- package_id снапшот-ва СЕРВЪРНАТА package identity ('vip_30'/'vip_180'/
-- 'vip_365', code constant, НЕ DB row/FK) — days_snapshot и price_cents_snapshot
-- пазят точните дни/цена В МОМЕНТА НА CHECKOUT-А, независимо от по-късна
-- admin price промяна (VIP price-change брифа §10: "checkout сесия, създадена
-- ПРЕДИ admin price change, остава валидна на snapshot-натата цена").
CREATE TABLE IF NOT EXISTS vip_purchase_ledger (
  purchase_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  package_id TEXT NOT NULL CHECK (
    package_id IN ('vip_30', 'vip_180', 'vip_365')
  ),
  days_snapshot INTEGER NOT NULL CHECK (
    days_snapshot > 0
  ),
  price_cents_snapshot INTEGER NOT NULL CHECK (
    price_cents_snapshot >= 0
  ),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'canceled', 'failed')
  ),
  credited_at TEXT,
  vip_grant_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vip_purchase_ledger_profile
  ON vip_purchase_ledger(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_vip_purchase_ledger_status
  ON vip_purchase_ledger(status, created_at);

-- Един pending checkout на package/профил наведнъж — mirror на
-- idx_coin_purchase_ledger_pending_package (без hidden_at concept тук, VIP
-- покупки нямат "hide from history" feature засега).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_purchase_ledger_pending_package
  ON vip_purchase_ledger(profile_id, package_id, status)
  WHERE status = 'pending';
