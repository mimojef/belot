PRAGMA foreign_keys = ON;

-- Nullable payment method snapshot columns captured from Stripe at VIP
-- fulfillment time — mirror на 20260703_001 (coin_purchase_ledger), за да
-- може Admin -> Плащания да показва Метод/Карта за VIP покупки по СЪЩИЯ
-- начин като coin покупки (виж production gap: VIP редовете показваха
-- "Метод: Неизвестен" / "Карта: —", защото vip_purchase_ledger нямаше тия
-- колони изобщо). Всички колони са nullable: съществуващи paid VIP редове
-- (включително вече платеното €1.00 VIP плащане) остават с NULL, докато не
-- получат отделен backfill — тази migration само добавя storage за тях,
-- не backfill-ва данни. Enrichment failure никога не блокира VIP credit-а
-- (виж webhook Step 2 логиката в server/src/index.ts).
ALTER TABLE vip_purchase_ledger ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE vip_purchase_ledger ADD COLUMN stripe_charge_id TEXT;
ALTER TABLE vip_purchase_ledger ADD COLUMN payment_method_type TEXT;
ALTER TABLE vip_purchase_ledger ADD COLUMN wallet_type TEXT;
ALTER TABLE vip_purchase_ledger ADD COLUMN card_brand TEXT;
ALTER TABLE vip_purchase_ledger ADD COLUMN card_last4 TEXT;
ALTER TABLE vip_purchase_ledger ADD COLUMN card_country TEXT;
