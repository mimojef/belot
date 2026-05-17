PRAGMA foreign_keys = ON;

-- Заменяме пакетите с финалните 10
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
    40000,
    199,
    'EUR',
    'active',
    10
  ),
  (
    'coin-package-djob',
    'djob',
    'Джоб',
    'Бърза зарядка за следващата партия.',
    75000,
    349,
    'EUR',
    'active',
    20
  ),
  (
    'coin-package-standard',
    'standard',
    'Стандарт',
    'Добър старт за нови играчи.',
    120000,
    499,
    'EUR',
    'active',
    30
  ),
  (
    'coin-package-plus',
    'plus',
    'Плюс',
    'Малко повече за по-дълга игра.',
    200000,
    749,
    'EUR',
    'active',
    40
  ),
  (
    'coin-package-comfort',
    'comfort',
    'Комфорт',
    'Комфортен запас за редовни игри.',
    300000,
    999,
    'EUR',
    'active',
    50
  ),
  (
    'coin-package-golyam',
    'golyam',
    'Голям',
    'Голям запас за сериозни сесии.',
    600000,
    1499,
    'EUR',
    'active',
    60
  ),
  (
    'coin-package-elite',
    'elite',
    'Елит',
    'Най-изгодният пакет — любимият избор.',
    1500000,
    1999,
    'EUR',
    'active',
    70
  ),
  (
    'coin-package-pro',
    'pro',
    'Про',
    'За играчи, които искат повече.',
    2200000,
    2749,
    'EUR',
    'active',
    80
  ),
  (
    'coin-package-premium',
    'premium',
    'Премиум',
    'Премиум запас за интензивни играчи.',
    3200000,
    3499,
    'EUR',
    'active',
    90
  ),
  (
    'coin-package-ultra',
    'ultra',
    'Ултра',
    'Максималният пакет в играта.',
    4500000,
    4499,
    'EUR',
    'active',
    100
  );
