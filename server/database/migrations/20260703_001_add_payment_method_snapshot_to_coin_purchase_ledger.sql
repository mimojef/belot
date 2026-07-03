PRAGMA foreign_keys = ON;

-- Nullable payment method snapshot columns captured from Stripe at fulfillment time.
-- All columns are nullable: existing paid records and records where Stripe enrichment
-- temporarily fails will have NULL values; the core credit transaction is not blocked.
ALTER TABLE coin_purchase_ledger ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE coin_purchase_ledger ADD COLUMN stripe_charge_id TEXT;
ALTER TABLE coin_purchase_ledger ADD COLUMN payment_method_type TEXT;
ALTER TABLE coin_purchase_ledger ADD COLUMN wallet_type TEXT;
ALTER TABLE coin_purchase_ledger ADD COLUMN card_brand TEXT;
ALTER TABLE coin_purchase_ledger ADD COLUMN card_last4 TEXT;
ALTER TABLE coin_purchase_ledger ADD COLUMN card_country TEXT;
