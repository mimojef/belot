PRAGMA foreign_keys = ON;

-- "Подари авоари" (Paid Gift Shop) — payer/recipient split за трите
-- purchase ledger-и (coin_purchase_ledger / vip_purchase_ledger /
-- bundle_purchase_ledger). Минимална ADDITIVE промяна: съществуващата
-- `profile_id` колона ВЕЧЕ семантично е "payer" (кой плаща/чиято Stripe
-- сесия е) — не се пипа, не се преименува, не се мигрира. Добавя се само
-- нова nullable `recipient_profile_id` колона:
--   - NULL  => normal purchase (payer == recipient), backward-compatible
--     mapping за ВСИЧКИ съществуващи/исторически редове (§17 в брифа:
--     "безопасен backward-compatible mapping" — recipient се resolve-ва
--     runtime като COALESCE(recipient_profile_id, profile_id), никога не се
--     backfill-ва physically тук).
--   - non-NULL => gift purchase, recipient_profile_id сочи towards
--     получателя (различен от profile_id/payer).
--
-- Recipient FK е СЪЩИЯТ SET NULL pattern като payer FK-та в coin/vip ledger
-- (survives recipient hard-delete, forensic snapshot колона по-долу пази
-- display-name-а за историята — виж §27/§31 в брифа). Никаква
-- destructive промяна, никакъв backfill, никакво DROP/RENAME на
-- съществуващи колони.

ALTER TABLE coin_purchase_ledger ADD COLUMN recipient_profile_id TEXT NULL
  REFERENCES profiles(profile_id) ON DELETE SET NULL;
ALTER TABLE coin_purchase_ledger ADD COLUMN recipient_display_name_snapshot TEXT NULL;
ALTER TABLE coin_purchase_ledger ADD COLUMN deleted_recipient_profile_id_snapshot TEXT NULL;

ALTER TABLE vip_purchase_ledger ADD COLUMN recipient_profile_id TEXT NULL
  REFERENCES profiles(profile_id) ON DELETE SET NULL;
ALTER TABLE vip_purchase_ledger ADD COLUMN recipient_display_name_snapshot TEXT NULL;
ALTER TABLE vip_purchase_ledger ADD COLUMN deleted_recipient_profile_id_snapshot TEXT NULL;

ALTER TABLE bundle_purchase_ledger ADD COLUMN recipient_profile_id TEXT NULL
  REFERENCES profiles(profile_id) ON DELETE SET NULL;
ALTER TABLE bundle_purchase_ledger ADD COLUMN recipient_display_name_snapshot TEXT NULL;
ALTER TABLE bundle_purchase_ledger ADD COLUMN deleted_recipient_profile_id_snapshot TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_coin_purchase_ledger_recipient
  ON coin_purchase_ledger(recipient_profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vip_purchase_ledger_recipient
  ON vip_purchase_ledger(recipient_profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_recipient
  ON bundle_purchase_ledger(recipient_profile_id, created_at);

-- Съществуващите "един pending checkout на package/профил наведнъж" UNIQUE
-- индекси (idx_*_pending_package) бяха дефинирани ПРЕДИ recipient_profile_id
-- да съществува — покриват само (profile_id, package_id, status='pending'),
-- БЕЗ recipient. Без тази поправка INSERT на gift pending checkout за пакет
-- X би се блъснал в UNIQUE constraint, ако СЪЩИЯТ payer вече има отделна
-- normal (non-gift) pending покупка за СЪЩИЯ пакет X — двете трябва да
-- могат да съществуват едновременно (различен recipient контекст).
--
-- КРИТИЧНО (review finding §2, потвърдено с
-- checkGiftPendingUniqueIndexNullSemantics.ts): plain-column индекс
-- `UNIQUE(profile_id, package_id, recipient_profile_id, status)` е
-- НЕДОСТАТЪЧЕН — SQLite third NULL != NULL за UNIQUE цели (SQL standard
-- поведение), значи ДВЕ нормални (recipient_profile_id IS NULL) pending
-- покупки за същия payer/package НЕ биха били хванати от такъв индекс на DB
-- ниво (единствената защита би останала application-level "reuse existing
-- pending" SELECT-преди-INSERT проверка в createPendingPurchase(), която е
-- TOCTOU race под конкурентен достъп, не hard DB guarantee).
--
-- Fix: EXPRESSION index върху COALESCE(recipient_profile_id, profile_id)
-- вместо plain recipient_profile_id колона. COALESCE нормализира NULL
-- recipient към PAYER-а самия (семантично точно: normal purchase == payer е
-- "своя собствен recipient"), затова композицията вече е ВИНАГИ non-NULL в
-- тази позиция и участва в UNIQUE comparison нормално — SQLite третира
-- материализирани expression-index стойности като обикновени стойности
-- (non-NULL == non-NULL се сравнява стандартно). Потвърдени сценарии:
--   - duplicate NORMAL pending (recipient NULL, same payer/package): ХВАНАТ
--   - duplicate SAME-RECIPIENT gift pending: ХВАНАТ
--   - gift към РАЗЛИЧНИ recipients (same payer/package): ПОЗВОЛЕНО
--   - NORMAL + GIFT за същия package (same payer): ПОЗВОЛЕНО
--
-- PRODUCTION INCIDENT fix (rollback-нат deploy, 2026-09-24): тази версия на
-- migration-а бе изпуснала established `hidden_at IS NULL` predicate-и за
-- coin/bundle при пресъздаването на индексите по-долу. coin индексът вече
-- имаше този predicate от 20260626_002_fix_pending_package_index_for_hidden.sql
-- ("скрит pending ред не бива да блокира ново купуване на същия пакет"),
-- byte-for-byte потвърден отново от 20260902_002 rebuild-а. bundle_purchase_ledger
-- носи същата hidden_at колона и същата hidePurchaseForUser() функционалност
-- (bundlePurchaseStore.ts) от самото си създаване (20260923_001) — mirror на
-- coin, значи същия predicate важи и там, дори индексът да го е пропуснал
-- при първоначалното дефиниране. VIP_purchase_ledger НЯМА hidden_at колона и
-- НЯМА hide-purchase feature (виж коментара в 20260818_007) — там predicate-ът
-- умишлено остава без hidden_at.
--
-- Без hidden_at IS NULL: payer с исторически СКРИТ pending ред за
-- package/(payer==recipient) комбинация не може да отвори нов active pending
-- checkout за същия пакет — INSERT се блъсва в UNIQUE constraint failed
-- (точно production инцидента, profile_id=55f576db-e308-4c61-b05d-9bea82e48796,
-- package_id=coin-package-mini, 2 pending реда, единия hidden).
--
-- SQLite няма ALTER INDEX — DROP + CREATE наново, additive/idempotent (IF
-- EXISTS / IF NOT EXISTS), никаква data промяна.
DROP INDEX IF EXISTS idx_coin_purchase_ledger_pending_package;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_purchase_ledger_pending_package
  ON coin_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
  WHERE status = 'pending' AND package_id IS NOT NULL AND hidden_at IS NULL;

DROP INDEX IF EXISTS idx_vip_purchase_ledger_pending_package;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_purchase_ledger_pending_package
  ON vip_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
  WHERE status = 'pending';

DROP INDEX IF EXISTS idx_bundle_purchase_ledger_pending_package;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_pending_package
  ON bundle_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
  WHERE status = 'pending' AND hidden_at IS NULL;
