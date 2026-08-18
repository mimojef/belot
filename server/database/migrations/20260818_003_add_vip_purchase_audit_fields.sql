PRAGMA foreign_keys = ON;

-- Платен VIP grant (reason='purchase') audit trail — mirror на
-- granted_by_profile_id/resulting_active_until паттерна от 20260815_001.
-- purchase_id реферира vip_purchase_ledger (source of truth за checkout/
-- payment детайлите), amount_paid_cents/currency са snapshot тук за бърз
-- read без JOIN, а и за резилианс ако ledger редът някога бъде purge-нат
-- (не се прави сега, но пази grant-а самодостатъчен за audit нужди).
-- NULL за launch_gift/admin_grant — само reason='purchase' ги попълва.
ALTER TABLE vip_grants ADD COLUMN purchase_id TEXT NULL
  REFERENCES vip_purchase_ledger(purchase_id) ON DELETE SET NULL;
ALTER TABLE vip_grants ADD COLUMN amount_paid_cents INTEGER NULL;
ALTER TABLE vip_grants ADD COLUMN currency TEXT NULL;
