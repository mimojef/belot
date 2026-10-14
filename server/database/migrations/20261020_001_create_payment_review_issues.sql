PRAGMA foreign_keys = ON;

-- Устойчив запис на ПОТВЪРДЕНИ Stripe плащания (payment_status = 'paid'),
-- които НЕ са били кредитирани автоматично: несъответствие на сума/валута,
-- непозната сесия, второ плащане за вече кредитирана поръчка, неуспешно
-- кредитиране и т.н. Записва се от webhook-а (paymentReviewIssueStore.ts).
--
-- Таблицата е само за административен преглед — НИЩО не се кредитира от нея.
-- Повторна доставка на същото Stripe събитие не създава нов ред:
-- UNIQUE(checkout_session_id, issue_kind) + occurrences/last_seen_at.
--
-- Без FK към ledger-ите/профилите: проблемът трябва да остане видим дори
-- поръчката да липсва (purchase_not_found) или профилът да бъде изтрит.
CREATE TABLE IF NOT EXISTS payment_review_issues (
  issue_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'stripe',
  checkout_session_id TEXT NOT NULL,
  stripe_event_id TEXT,
  stripe_payment_intent_id TEXT,
  purchase_type TEXT NOT NULL CHECK (
    purchase_type IN ('coin', 'vip', 'bundle')
  ),
  -- Намереният ledger ред (NULL при purchase_not_found).
  purchase_id TEXT,
  -- purchaseId от Stripe metadata — само за справка, НЕ е authoritative.
  metadata_purchase_id TEXT,
  payer_profile_id TEXT,
  issue_kind TEXT NOT NULL CHECK (
    issue_kind IN (
      'purchase_not_found',
      'purchase_id_mismatch',
      'currency_mismatch',
      'amount_mismatch',
      'duplicate_payment',
      'not_creditable',
      'credit_failed'
    )
  ),
  detail TEXT NOT NULL,
  stripe_amount_total INTEGER,
  stripe_currency TEXT,
  expected_amount INTEGER,
  expected_currency TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'resolved')
  ),
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_note TEXT,
  UNIQUE (checkout_session_id, issue_kind)
);

CREATE INDEX IF NOT EXISTS idx_payment_review_issues_status
  ON payment_review_issues(status, first_seen_at);
