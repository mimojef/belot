PRAGMA foreign_keys = ON;

-- "Само при победа" checkbox за earn rules (Белот/Ludo). DEFAULT
-- 'winner_only' запазва ТОЧНОТО досегашно поведение за всички вече
-- съществуващи правила/кампании — никаква промяна в начисляването без
-- изричен избор от admin-а. 'all_participants' означава: всички допустими
-- реални участници в успешно завършен мач получават тиквите, не само
-- победителят — resolveUnitsAmountForEvent (campaignCreditStore.ts) прочита
-- тая колона в реално време при всяко начисление (бъдещи мачове), никога
-- не презаписва/преизчислява вече записани campaign_unit_ledger редове.
ALTER TABLE campaign_earn_rules
  ADD COLUMN credit_mode TEXT NOT NULL DEFAULT 'winner_only'
  CHECK (credit_mode IN ('winner_only', 'all_participants'));
