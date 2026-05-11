PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coin_purchase_ledger (
  purchase_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  package_id TEXT,
  package_key_snapshot TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  yellow_coins_amount INTEGER NOT NULL CHECK (
    yellow_coins_amount > 0
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES coin_packages(package_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_coin_purchase_ledger_profile
  ON coin_purchase_ledger(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_coin_purchase_ledger_status
  ON coin_purchase_ledger(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_purchase_ledger_pending_package
  ON coin_purchase_ledger(profile_id, package_id, status)
  WHERE status = 'pending' AND package_id IS NOT NULL;
