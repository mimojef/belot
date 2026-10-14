PRAGMA foreign_keys = ON;

-- Остарели неплатени VIP поръчки (mirror на coin/bundle hidden_at,
-- 20260626_001/002 и 20260923_002). Когато админ смени VIP цената, а профилът
-- има стар pending ред за същия пакет+получател, нов „Купи“ трябва да създаде
-- ред с актуалните условия. Старият ред се скрива (hidden_at), НЕ се
-- cancel-ва — ако за него още има отворена Stripe сесия и тя бъде платена,
-- webhook-ът го кредитира по условията, с които е стартирано плащането.
--
-- Безопасност спрямо съществуващите данни: колоната е nullable без default
-- (всички текущи редове остават видими), а новият unique индекс е СЪЩИЯТ
-- като стария плюс `AND hidden_at IS NULL` — по-тесен predicate, значи всяко
-- множество редове, валидно за стария индекс, е валидно и за новия.
ALTER TABLE vip_purchase_ledger ADD COLUMN hidden_at TEXT;

DROP INDEX IF EXISTS idx_vip_purchase_ledger_pending_package;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_purchase_ledger_pending_package
  ON vip_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
  WHERE status = 'pending' AND hidden_at IS NULL;
