PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coin_packages (
  package_id TEXT PRIMARY KEY,
  package_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  yellow_coins_amount INTEGER NOT NULL CHECK (
    yellow_coins_amount > 0
  ),
  price_cents INTEGER NOT NULL CHECK (
    price_cents >= 0
  ),
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'inactive')
  ),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_coin_packages_public
  ON coin_packages(status, sort_order, yellow_coins_amount);

INSERT INTO coin_packages (
  package_id,
  package_key,
  title,
  description,
  yellow_coins_amount,
  price_cents,
  currency,
  status,
  sort_order
) VALUES
  (
    'coin-package-starter',
    'starter',
    'Starter',
    'Първи пакет за зареждане на баланса.',
    100000,
    499,
    'EUR',
    'active',
    10
  ),
  (
    'coin-package-standard',
    'standard',
    'Standard',
    'Най-практичният пакет за редовна игра.',
    250000,
    999,
    'EUR',
    'active',
    20
  ),
  (
    'coin-package-premium',
    'premium',
    'Premium',
    'Повече жълтици за по-високи маси.',
    600000,
    1999,
    'EUR',
    'active',
    30
  ),
  (
    'coin-package-elite',
    'elite',
    'Elite',
    'Голям пакет за дълги сесии.',
    1500000,
    4999,
    'EUR',
    'active',
    40
  )
ON CONFLICT(package_key) DO NOTHING;
