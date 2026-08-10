PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vip_status (
  profile_id TEXT PRIMARY KEY,
  active_until TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- Самостоятелен append-only ledger за Етап 0 — НЕ реферира coin_purchase_ledger
-- или друг payment/purchase source. Платеният VIP (Stripe checkout, package
-- каталог, provider session id и т.н.) е отделен бъдещ етап; когато се
-- проектира, ще получи собствена migration (напр. vip_purchase_ledger +
-- payment reference поле тук), вместо да coupling-ва фундамента сега.
CREATE TABLE IF NOT EXISTS vip_grants (
  grant_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('launch_gift', 'purchase', 'admin_grant')
  ),
  -- Периодът се пази като калeндарна единица + брой, НЕ като преизчислени
  -- дни — "1/6/12 месеца" трябва да остане "1/6/12 календарни месеца"
  -- (subscription-style clamp, виж vipStore.ts addCalendarInterval), не
  -- фиксирано приближение "180 дни".
  interval_unit TEXT NOT NULL CHECK (
    interval_unit IN ('days', 'months', 'years')
  ),
  interval_amount INTEGER NOT NULL CHECK (
    interval_amount > 0
  ),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vip_grants_profile
  ON vip_grants(profile_id, granted_at);

-- Гарантира, че launch_gift се раздава най-много веднъж на profile,
-- дори при concurrent/double-click заявки (INSERT конфликтът се хваща в кода).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_launch_gift_once
  ON vip_grants(profile_id)
  WHERE reason = 'launch_gift';
