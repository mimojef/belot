PRAGMA foreign_keys = ON;

-- Shop -> "Пакети" Premium Visual System (audit §3) — persistent, stable
-- visual identifier за bundle package картите в Shop-а. Чисто additive
-- ALTER TABLE ADD COLUMN (mirror на established pattern, виж
-- 20260923_002_add_gift_recipient_to_purchase_ledgers.sql) — не изисква
-- MANUAL_TRANSACTION_MIGRATION/table rebuild.
--
-- НАРОЧНО БЕЗ DB CHECK enum constraint: каталогът от валидни keys (виж
-- server/src/shared/bundlePackageVisualKeys.ts, ЕДИНСТВЕНИЯТ source of
-- truth, споделен между сървър и frontend) ще расте с бъдещи код промени
-- (нови визии) — CHECK IN (...) constraint би изисквал нова migration при
-- всяка добавена визия, точно триенето, което искаме да избегнем.
-- Валидацията е application-level (shopBundlePackageStore.ts upsertPackage:
-- null разрешено, познат key разрешено, непознат key -> reject с validation
-- error), НЕ DB-level.
--
-- Legacy редове (visual_key IS NULL — всички съществуващи пакети преди тази
-- migration) остават валидни завинаги — Shop render-ът има deterministic
-- read-time fallback (DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY = 'coins-medium'),
-- никога crash/празен render заради липсваща визия.
ALTER TABLE shop_bundle_packages ADD COLUMN visual_key TEXT NULL;
