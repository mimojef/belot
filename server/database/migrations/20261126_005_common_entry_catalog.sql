-- Етап 4В: единен каталог на входовете за всички игри (match_rooms).
--
-- 1) Всеки съществуващ вход получава начална обща комисиона 20%. Входове,
--    вече с зададена комисиона, не се пипат. Наградите на всички игри се
--    изчисляват от сървъра по общата формула (prizeFormula.ts) от входа,
--    реалния фонд, комисионата и схемата на играта. Ръчната prize_amount
--    вече НЕ е финансово правило (сървърът я поддържа само като изчислено
--    копие на наградата за Белот). Започнали мачове пазят фиксираните си
--    условия (Белот — room.config.financialTerms; „Свара“ — svara_match_finance).
UPDATE match_rooms SET site_commission_bps = 2000 WHERE site_commission_bps IS NULL;

-- 2) „Не се сърди човече“: фиксираните условия на мача — записват се в
--    СЪЩАТА транзакция, в която се удържат входовете (при старта). Мач без
--    ред тук е започнал преди Етап 4В → изплаща се по досегашното правило.
CREATE TABLE IF NOT EXISTS ludo_match_financial_terms (
  match_id TEXT PRIMARY KEY,
  rules_version TEXT NOT NULL CHECK (rules_version = 'ludo-formula-v1'),
  entry_fee INTEGER NOT NULL CHECK (typeof(entry_fee) = 'integer' AND entry_fee > 0),
  site_commission_bps INTEGER NOT NULL CHECK (typeof(site_commission_bps) = 'integer' AND site_commission_bps BETWEEN 1000 AND 5000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
