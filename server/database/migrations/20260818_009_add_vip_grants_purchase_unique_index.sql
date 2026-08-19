PRAGMA foreign_keys = ON;

-- DB-level гаранция срещу дублиран VIP grant за една и съща платена покупка
-- (в допълнение на application-level CAS pending->paid guard-а в
-- vipPurchaseStore.fulfillByInternalRow). purchase_id е NULL за
-- launch_gift/admin_grant grants — partial index го игнорира за тях, само
-- reason='purchase' редовете са ограничени до 1 grant на purchase_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_purchase_id_once
  ON vip_grants(purchase_id)
  WHERE reason = 'purchase' AND purchase_id IS NOT NULL;
