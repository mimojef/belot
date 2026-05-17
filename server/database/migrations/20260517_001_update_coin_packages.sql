PRAGMA foreign_keys = ON;

-- Изтриваме старите пакети и вмъкваме новите 6
DELETE FROM coin_packages;

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
    'coin-package-mini',
    'mini',
    'Мини',
    'Малко жълтици за пробване.',
    50000,
    199,
    'EUR',
    'active',
    10
  ),
  (
    'coin-package-starter',
    'starter',
    'Стартер',
    'Добър старт за нови играчи.',
    120000,
    399,
    'EUR',
    'active',
    20
  ),
  (
    'coin-package-standard',
    'standard',
    'Стандарт',
    'Най-практичният пакет за редовна игра.',
    280000,
    799,
    'EUR',
    'active',
    30
  ),
  (
    'coin-package-premium',
    'premium',
    'Премиум',
    'Повече жълтици за по-високи маси.',
    650000,
    1499,
    'EUR',
    'active',
    40
  ),
  (
    'coin-package-elite',
    'elite',
    'Елит',
    'Голям пакет за дълги сесии.',
    1500000,
    1999,
    'EUR',
    'active',
    50
  ),
  (
    'coin-package-legenda',
    'legenda',
    'Легенда',
    'Максималният пакет за сериозни играчи.',
    3500000,
    5999,
    'EUR',
    'active',
    60
  );
