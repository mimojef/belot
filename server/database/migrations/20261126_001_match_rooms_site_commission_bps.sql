-- Етап 3А на общата финансова основа: индивидуална комисиона на входно ниво.
--
-- Само добавяща миграция, без backfill: съществуващите нива остават NULL
-- („процентът не е конфигуриран“). 20% НЕ се записва автоматично.
-- prize_amount и действащите изплащания не се засягат.
--
-- Валидни зададени стойности: 1 000–5 000 базисни точки (10,00%–50,00%),
-- цяло число (точност 0,01%).
ALTER TABLE match_rooms ADD COLUMN site_commission_bps INTEGER NULL DEFAULT NULL
  CHECK (
    site_commission_bps IS NULL
    OR (typeof(site_commission_bps) = 'integer' AND site_commission_bps BETWEEN 1000 AND 5000)
  );
