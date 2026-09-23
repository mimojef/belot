PRAGMA foreign_keys = ON;

-- PRE-DEPLOY BLOCKER fix (открит по време на 20260923_004 payer hard-delete
-- audit-а, потвърден read-only срещу production 185.203.117.14):
-- vip_grants.purchase_id е FK СТРИКТНО към vip_purchase_ledger(purchase_id)
-- (добавен 20260818_008_add_vip_purchase_audit_fields.sql, ПРЕДИ bundle
-- feature изобщо да съществува). bundlePurchaseStore.ts обаче reuse-ва
-- reason='purchase' за bundle-generated grants и пишеше
-- bundle_purchase_ledger.purchase_id В ТАЗИ СЪЩА колона — с PRAGMA
-- foreign_keys=ON (реално активен в bundlePurchaseStore.ts connection-а),
-- този INSERT би fail-нал с "FOREIGN KEY constraint failed" при ВСЯКА
-- платена bundle покупка (bundle purchase_id никога не съществува в
-- vip_purchase_ledger). Production verification (read-only, 2026-09-23):
-- production HEAD все още е ПРЕДИ bundle feature-a (няма
-- bundle_purchase_ledger таблица изобщо) — нулев текущ impact, но е
-- стриктен blocker за първия deploy на bundle/paid-gift работата.
--
-- Fix (минимална, чиста промяна — НЕ pipe-ва purchase_id semantics):
-- отделна nullable bundle_purchase_id колона, mirror на established
-- purchase_id pattern, но сочеща towards bundle_purchase_ledger. vip_grants.
-- purchase_id продължава да означава ИЗКЛЮЧИТЕЛНО
-- vip_purchase_ledger.purchase_id — standalone VIP purchase flow/съществуващи
-- данни остават напълно непроменени (F инвариант в брифа). Companion fix в
-- server/src/db/bundlePurchaseStore.ts (insertVipGrantStatement вече пише
-- bundle_purchase_id, НЕ purchase_id, за bundle-generated grants).
--
-- Partial UNIQUE index — mirror byte-for-byte на established
-- idx_vip_grants_purchase_id_once (20260818_009) pattern, само за новата
-- колона — DB-level "exactly once grant per bundle purchase" гаранция,
-- defense-in-depth заедно с bundle_purchase_ledger CAS-а
-- (markPaidByPurchaseIdStatement pending->paid, changes=0 detection).
--
-- Bidirectional връзка (НЕ проблематична circular FK): bundle_purchase_ledger.
-- vip_grant_id (established, 20260923_001) е forward lookup покупка -> неин
-- грант; тази нова vip_grants.bundle_purchase_id е reverse lookup грант ->
-- покупката, която го е родила, plus idempotency guard-а по-горе — точно
-- СЪЩАТА established bidirectional двойка, която VIP-direct вече има
-- (vip_purchase_ledger.vip_grant_id <-> vip_grants.purchase_id). И двете
-- колони са nullable и се попълват в established, вече-съществуващ ред:
-- bundle_purchase_ledger редът вече съществува (създаден при checkout) ПРЕДИ
-- vip_grants INSERT-а по време на fulfillment; vip_grant_id обратно се
-- UPDATE-ва СЛЕД като грантът вече съществува. Никакъв insert-order
-- dependency/deadlock проблем — двете FK цели винаги вече съществуват в
-- момента на всеки от двата write-а.
ALTER TABLE vip_grants ADD COLUMN bundle_purchase_id TEXT NULL
  REFERENCES bundle_purchase_ledger(purchase_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_bundle_purchase_id_once
  ON vip_grants(bundle_purchase_id)
  WHERE reason = 'purchase' AND bundle_purchase_id IS NOT NULL;
