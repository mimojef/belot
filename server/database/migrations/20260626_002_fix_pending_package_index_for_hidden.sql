PRAGMA foreign_keys = ON;

-- Старият индекс не включваше hidden_at IS NULL, което позволяваше
-- скрит pending ред да блокира ново натискане на „Купи" за същия пакет.
DROP INDEX IF EXISTS idx_coin_purchase_ledger_pending_package;

-- Новият индекс позволява множество скрити pending редове,
-- но само един видим pending ред за profile_id + package_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_purchase_ledger_pending_package
  ON coin_purchase_ledger(profile_id, package_id, status)
  WHERE status = 'pending'
    AND package_id IS NOT NULL
    AND hidden_at IS NULL;
