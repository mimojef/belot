-- "Персонализация на профила" — обща поръчка за няколко екстри (1 до 4) с
-- ЕДНО Stripe Checkout плащане.
--
-- Досега всеки ред в profile_customization_purchases беше отделно плащане
-- (собствена Stripe сесия). Сега плащането е на ниво поръчка:
--   * profile_customization_orders — една Stripe сесия/плащане: обща сума,
--     статус, payment intent, начин на плащане, refund и админ преглед;
--   * profile_customization_purchases — отделните платени права (по едно на
--     вид), всяко със собствен срок, ефект (new/extend/replace) и верига;
--     свързани с поръчката чрез order_id.
--
-- Кредитирането е САМО от webhook-а за цялата поръчка в една транзакция
-- (CAS pending->paid на поръчката и на всеки ред). Пълен refund отменя
-- всички права от поръчката (по веригата им — по-новите валидни покупки се
-- запазват); частичен refund не може да се отнесе еднозначно към конкретна
-- екстра -> правата остават, поръчката чака администраторски преглед.
--
-- Финансов запис: при изтриване на профил поръчката остава (profile_id ->
-- NULL, псевдонимният UUID в deleted_profile_id_snapshot — виж
-- profileDeletionExecutor.ts).

CREATE TABLE IF NOT EXISTS profile_customization_orders (
  order_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 4),
  -- Сумата на редовете (всеки = база × дни/30) в цели центове.
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'canceled', 'failed', 'refunded')
  ),
  paid_at TEXT NULL,
  -- Кумулативната възстановена сума от Stripe (charge.amount_refunded).
  refunded_at TEXT NULL,
  refunded_amount_cents INTEGER NULL CHECK (refunded_amount_cents IS NULL OR refunded_amount_cents >= 0),
  refund_stripe_event_id TEXT NULL,
  -- 'partial_refund' (частично — правата остават) или 'refund_failed'
  -- (неуспешен/отменен refund след анулиране — нищо не се връща автоматично).
  refund_review_status TEXT NULL CHECK (refund_review_status IS NULL OR refund_review_status IN ('pending', 'reviewed')),
  refund_review_reason TEXT NULL CHECK (refund_review_reason IS NULL OR refund_review_reason IN ('partial_refund', 'refund_failed')),
  refund_reviewed_at TEXT NULL,
  refund_reviewed_by_profile_id TEXT NULL,
  refund_reviewed_by_display_name_snapshot TEXT NULL,
  refund_failed_refund_id TEXT NULL,
  refund_failed_at TEXT NULL,
  stripe_payment_intent_id TEXT NULL,
  stripe_charge_id TEXT NULL,
  payment_method_type TEXT NULL,
  wallet_type TEXT NULL,
  card_brand TEXT NULL,
  card_last4 TEXT NULL,
  card_country TEXT NULL,
  -- Заменена (неплатена) поръчка: отворената ѝ Stripe сесия може още да
  -- бъде платена — webhook-ът я намира по session id и я кредитира.
  hidden_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (refund_reviewed_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

ALTER TABLE profile_customization_purchases
  ADD COLUMN order_id TEXT NULL REFERENCES profile_customization_orders(order_id);

-- Съществуващи отделни покупки (ако има) -> поръчка с един ред и същото id.
-- Неплатените стари поръчки се скриват (сесията им пак се намира по id).
INSERT INTO profile_customization_orders (
  order_id, profile_id, deleted_profile_id_snapshot, item_count, total_cents, currency, provider,
  provider_checkout_session_id, status, paid_at, refunded_at, refunded_amount_cents, refund_stripe_event_id,
  refund_review_status, refund_review_reason, refund_reviewed_at, refund_reviewed_by_profile_id,
  refund_reviewed_by_display_name_snapshot, refund_failed_refund_id, refund_failed_at,
  stripe_payment_intent_id, stripe_charge_id, payment_method_type, wallet_type, card_brand, card_last4, card_country,
  hidden_at, created_at, updated_at
)
SELECT
  purchase_id, profile_id, deleted_profile_id_snapshot, 1, price_cents_snapshot, currency, provider,
  provider_checkout_session_id, status,
  CASE WHEN status = 'paid' THEN COALESCE(credited_at, updated_at) ELSE credited_at END,
  refunded_at, refunded_amount_cents, refund_stripe_event_id,
  refund_review_status, refund_review_reason, refund_reviewed_at, refund_reviewed_by_profile_id,
  refund_reviewed_by_display_name_snapshot, refund_failed_refund_id, refund_failed_at,
  stripe_payment_intent_id, stripe_charge_id, payment_method_type, wallet_type, card_brand, card_last4, card_country,
  CASE WHEN status = 'pending' THEN COALESCE(hidden_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE hidden_at END,
  created_at, updated_at
FROM profile_customization_purchases
WHERE order_id IS NULL;

UPDATE profile_customization_purchases
SET order_id = purchase_id,
    hidden_at = CASE WHEN status = 'pending' THEN COALESCE(hidden_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE hidden_at END
WHERE order_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_profile_customization_purchases_order
  ON profile_customization_purchases(order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_customization_orders_profile
  ON profile_customization_orders(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_profile_customization_orders_status
  ON profile_customization_orders(status, created_at);

CREATE INDEX IF NOT EXISTS idx_profile_customization_orders_payment_intent
  ON profile_customization_orders(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_customization_orders_refund_review
  ON profile_customization_orders(refund_review_status)
  WHERE refund_review_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_profile_customization_orders_deleted_profile_snapshot
  ON profile_customization_orders(deleted_profile_id_snapshot)
  WHERE deleted_profile_id_snapshot IS NOT NULL;

-- Най-много една видима неплатена поръчка на профил (новата скрива старата).
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_customization_orders_visible_pending
  ON profile_customization_orders(profile_id)
  WHERE status = 'pending' AND hidden_at IS NULL;
