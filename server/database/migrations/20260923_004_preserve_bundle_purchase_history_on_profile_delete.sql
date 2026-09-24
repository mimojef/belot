-- MANUAL_TRANSACTION_MIGRATION
-- Blocker fix (pre-existing financial-history риск, идентифициран при Paid
-- Gift Shop pre-merge audit-а): bundle_purchase_ledger.profile_id (PAYER
-- колоната) е останала ON DELETE CASCADE, наследена от
-- 20260923_001_create_shop_bundle_packages.sql — таблицата е създадена
-- СЛЕД established 20260902_002_preserve_financial_and_ban_history_on_profile_delete.sql
-- fix-а (който конвертира coin_purchase_ledger/vip_purchase_ledger/etc. от
-- CASCADE към SET NULL точно по тази причина), но никога не е получила
-- същия третиране. SQLite не позволява ALTER на FK ON DELETE поведение
-- in-place — rebuild (DROP+RENAME), established pattern (20260902_002,
-- 20260630_001_fix_gift_ledger_cascade.sql).
--
-- Risk (преди тази миграция): ако PAYER е hard-deleted докато bundle
-- покупка (нормална ИЛИ "Подари авоари" gift) е все още 'pending' (Stripe
-- checkout създаден, webhook още не е пристигнал), DELETE FROM profiles
-- каскадно трие ЦЕЛИЯ bundle_purchase_ledger ред — закъснелият Stripe
-- webhook няма какво да fulfill-не (findByCheckoutSessionId връща null),
-- финансовият audit trail за тази покупка изчезва напълно, и — за gift
-- покупка — получателят никога не получава подарените coins+VIP, въпреки
-- успешно таксувания (вече изтрит) payer.
--
-- Тази CREATE TABLE _new е ТОЧНО verbatim копие на текущата live schema
-- (извлечена през sqlite_master.sql на реална мигрирана база, НЕ
-- reconstruct-вана на ръка от историята на 001/002 migration файловете —
-- 001 създаде базовата таблица с profile_id CASCADE, 002 добави recipient_*
-- колоните И COALESCE pending-package индекса ADDITIVELY върху нея; всяка
-- ръчна реконструкция само от 001 би тихо изгубила recipient_profile_id/
-- recipient_display_name_snapshot/deleted_recipient_profile_id_snapshot и
-- би регресирала COALESCE index fix-а от 002), с изменения:
--   - profile_id: NOT NULL -> NULL, FK ON DELETE CASCADE -> ON DELETE SET NULL
--   - нова deleted_profile_id_snapshot колона (БЕЗ FK) за immutable PAYER
--     attribution — mirror ТОЧНО на established coin_purchase_ledger/
--     vip_purchase_ledger deleted_profile_id_snapshot pattern (§ round 2
--     корекция в 20260902_002: "row survives" не е достатъчно без "и знаем
--     чий беше редът"). recipient_profile_id/recipient_display_name_snapshot/
--     deleted_recipient_profile_id_snapshot (Paid Gift Shop, 20260923_002)
--     остават НЕПИПНАТИ — вече коректно SET NULL / snapshot от самото
--     начало, отделен FK/атрибуция от payer-а.
-- Всички други колони/CHECK/UNIQUE/index-и (вкл. COALESCE pending-package
-- partial index-а, package_id/vip_grant_id FK-та) са запазени byte-for-byte.
--
-- Application-level companion fix (server/src/db/bundlePurchaseStore.ts,
-- server/src/db/profileHardDeleteService.ts — виж коментарите там):
-- fulfillByInternalRow вече explicit safe-fail-ва нормална (non-gift)
-- покупка, чийто PAYER е NULL при fulfillment time (mirror на established
-- gift-recipient-missing safe-fail) — без тази проверка
-- ensureWalletStatement/insertVipGrantStatement/upsertVipStatusStatement
-- биха приели profile_id=NULL мълчаливо (FK ON DELETE SET NULL прави NULL
-- валидна FK стойност, никакво constraint violation), създавайки orphan
-- wallet/vip_status редове докато наградата тихо изчезва. profileHardDeleteService.ts
-- вече snapshot-ва deleted_profile_id_snapshot ПРЕДИ DELETE FROM profiles,
-- mirror на coin/vip statement-ите.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE bundle_purchase_ledger_new (
  purchase_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
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
  recipient_profile_id TEXT NULL,
  recipient_display_name_snapshot TEXT NULL,
  deleted_recipient_profile_id_snapshot TEXT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (package_id) REFERENCES shop_bundle_packages(package_id) ON DELETE SET NULL,
  FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO bundle_purchase_ledger_new (
  purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
  yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider,
  provider_checkout_session_id, status, credited_at, vip_grant_id,
  stripe_payment_intent_id, stripe_charge_id, payment_method_type,
  wallet_type, card_brand, card_last4, card_country, hidden_at,
  created_at, updated_at, recipient_profile_id, recipient_display_name_snapshot,
  deleted_recipient_profile_id_snapshot
)
SELECT
  purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
  yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider,
  provider_checkout_session_id, status, credited_at, vip_grant_id,
  stripe_payment_intent_id, stripe_charge_id, payment_method_type,
  wallet_type, card_brand, card_last4, card_country, hidden_at,
  created_at, updated_at, recipient_profile_id, recipient_display_name_snapshot,
  deleted_recipient_profile_id_snapshot
FROM bundle_purchase_ledger;

DROP TABLE bundle_purchase_ledger;
ALTER TABLE bundle_purchase_ledger_new RENAME TO bundle_purchase_ledger;

CREATE INDEX idx_bundle_purchase_ledger_profile
  ON bundle_purchase_ledger(profile_id, created_at);

CREATE INDEX idx_bundle_purchase_ledger_status
  ON bundle_purchase_ledger(status, created_at);

CREATE INDEX idx_bundle_purchase_ledger_recipient
  ON bundle_purchase_ledger(recipient_profile_id, created_at);

-- Established "един pending checkout на package/профил наведнъж" гаранция —
-- COALESCE(recipient_profile_id, profile_id) normalizира NULL recipient към
-- PAYER-а (normal purchase == payer е "своя собствен recipient"), идентичен
-- на fix-натия definition-а от 20260923_002 (виж коментара там за пълния
-- NULL-semantics rationale и hidden_at production incident post-mortem-а).
-- hidden_at IS NULL е ЗАДЪЛЖИТЕЛЕН тук — иначе този rebuild би презаписал
-- 20260923_002-ия fix обратно към счупената (pre-fix) index дефиниция, тъй
-- като този файл се прилага СЛЕД _002 в migration веригата.
CREATE UNIQUE INDEX idx_bundle_purchase_ledger_pending_package
  ON bundle_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
  WHERE status = 'pending' AND hidden_at IS NULL;

-- Mirror на established idx_coin_purchase_ledger_deleted_profile_snapshot/
-- idx_vip_purchase_ledger_deleted_profile_snapshot (20260902_002) — forensic
-- lookup "кои bundle покупки е имал deleted profile X".
CREATE INDEX idx_bundle_purchase_ledger_deleted_profile_snapshot
  ON bundle_purchase_ledger(deleted_profile_id_snapshot);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260923_004_preserve_bundle_purchase_history_on_profile_delete.sql');

COMMIT;

PRAGMA foreign_keys = ON;
