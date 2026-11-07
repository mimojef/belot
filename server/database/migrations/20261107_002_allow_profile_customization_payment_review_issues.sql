PRAGMA foreign_keys = ON;

-- "Персонализация на профила", Етап 2 — webhook-ът записва потвърдени, но
-- некредитирани Stripe плащания за персонализация (несъответствие на сума/
-- валута, непозната сесия, изтрит купувач, временна грешка) в същата
-- payment_review_issues таблица като жълтиците/VIP/пакетите. CHECK-ът на
-- purchase_type (20261020_001) допуска само 'coin'/'vip'/'bundle' — без това
-- записът би се провалил и webhook-ът би връщал 500 безкрайно.
--
-- SQLite не може да промени CHECK — таблицата се преизгражда. Няма FK към
-- нея и от нея (по дизайн, виж 20261020_001), така че не са нужни
-- PRAGMA foreign_keys промени. Всички редове и колони (вкл. is_transient от
-- 20261021_001) се копират без промяна.

CREATE TABLE payment_review_issues_new (
  issue_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'stripe',
  checkout_session_id TEXT NOT NULL,
  stripe_event_id TEXT,
  stripe_payment_intent_id TEXT,
  purchase_type TEXT NOT NULL CHECK (
    purchase_type IN ('coin', 'vip', 'bundle', 'profile_customization')
  ),
  purchase_id TEXT,
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
  is_transient INTEGER NOT NULL DEFAULT 0 CHECK (is_transient IN (0, 1)),
  UNIQUE (checkout_session_id, issue_kind)
);

INSERT INTO payment_review_issues_new (
  issue_id, provider, checkout_session_id, stripe_event_id, stripe_payment_intent_id,
  purchase_type, purchase_id, metadata_purchase_id, payer_profile_id, issue_kind,
  detail, stripe_amount_total, stripe_currency, expected_amount, expected_currency,
  status, occurrences, first_seen_at, last_seen_at, resolved_at, resolution_note, is_transient
)
SELECT
  issue_id, provider, checkout_session_id, stripe_event_id, stripe_payment_intent_id,
  purchase_type, purchase_id, metadata_purchase_id, payer_profile_id, issue_kind,
  detail, stripe_amount_total, stripe_currency, expected_amount, expected_currency,
  status, occurrences, first_seen_at, last_seen_at, resolved_at, resolution_note, is_transient
FROM payment_review_issues;

DROP TABLE payment_review_issues;

ALTER TABLE payment_review_issues_new RENAME TO payment_review_issues;

CREATE INDEX IF NOT EXISTS idx_payment_review_issues_status
  ON payment_review_issues(status, first_seen_at);
