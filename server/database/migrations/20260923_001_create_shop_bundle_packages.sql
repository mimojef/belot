PRAGMA foreign_keys = ON;

-- Shop -> "Пакети" (Магазин Пакети брифа) — комбиниран продукт (X жълтици +
-- X дни VIP = X евро), admin-configurable брой пакети (за разлика от
-- VIP_PACKAGE_CATALOG-а, който е code-level constant с фиксирани 3 записа —
-- виж server/src/db/vipPurchaseStore.ts). Mirror на coin_packages
-- (20260510_013_create_coin_packages.sql) структурно, plus vip_days колона.
-- НЕ разширява coin_packages директно (то би направило vip_days NULL за
-- всички съществуващи coin-only редове и объркало съществуващия
-- coinPackageStore/coinPurchaseStore contract) — отделна таблица е additive,
-- нулев риск за съществуващите coin/VIP покупки.
CREATE TABLE IF NOT EXISTS shop_bundle_packages (
  package_id TEXT PRIMARY KEY,
  package_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  yellow_coins_amount INTEGER NOT NULL CHECK (
    yellow_coins_amount > 0
  ),
  vip_days INTEGER NOT NULL CHECK (
    vip_days > 0
  ),
  price_cents INTEGER NOT NULL CHECK (
    price_cents >= 0
  ),
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'inactive')
  ),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shop_bundle_packages_public
  ON shop_bundle_packages(status, sort_order, yellow_coins_amount);

-- Покупка ledger — mirror структурно на coin_purchase_ledger
-- (20260510_014) И vip_purchase_ledger (20260818_007) едновременно: пази
-- ПЪЛЕН snapshot (title/coins/vip_days/price) в момента на checkout-а, НЕ
-- жива reference само към package_id — по-късна admin редакция на пакета
-- никога не променя вече направена покупка/история (брифа §10/§11).
-- package_id е nullable FK (ON DELETE SET NULL) — best-effort reference,
-- НЕ source of truth (същия pattern като coin_purchase_ledger.package_id).
CREATE TABLE IF NOT EXISTS bundle_purchase_ledger (
  purchase_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  package_id TEXT,
  package_key_snapshot TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  yellow_coins_amount INTEGER NOT NULL CHECK (
    yellow_coins_amount > 0
  ),
  vip_days_snapshot INTEGER NOT NULL CHECK (
    vip_days_snapshot > 0
  ),
  price_cents INTEGER NOT NULL CHECK (
    price_cents >= 0
  ),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'canceled', 'failed')
  ),
  credited_at TEXT,
  vip_grant_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  payment_method_type TEXT,
  wallet_type TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_country TEXT,
  hidden_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES shop_bundle_packages(package_id) ON DELETE SET NULL,
  FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_profile
  ON bundle_purchase_ledger(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_status
  ON bundle_purchase_ledger(status, created_at);

-- Един pending checkout на package/профил наведнъж — mirror на
-- idx_coin_purchase_ledger_pending_package / idx_vip_purchase_ledger_pending_package.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_pending_package
  ON bundle_purchase_ledger(profile_id, package_id, status)
  WHERE status = 'pending';

-- DB-level гаранция срещу дублиран VIP grant за една и съща платена bundle
-- покупка — mirror на idx_vip_grants_purchase_id_once
-- (20260818_009_add_vip_grants_purchase_unique_index.sql). Bundle-generated
-- grants reuse-ват vip_grants.reason='purchase' (същата семантика като
-- директна VIP покупка — "платена покупка", не нов reason enum член),
-- purchase_id тук сочи bundle_purchase_ledger.purchase_id (различен UUID
-- namespace от vip_purchase_ledger, randomUUID() гарантира без collision).
-- Партиалният индекс на vip_grants(purchase_id) вече покрива И двата
-- source-а заедно (VIP-direct и bundle) — 1 grant на purchase_id, независимо
-- от кой ledger идва purchase_id-то.
