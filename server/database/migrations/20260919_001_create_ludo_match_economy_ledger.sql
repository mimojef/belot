PRAGMA foreign_keys = ON;

-- Отделна ledger таблица за Ludo economy — огледало на match_economy_ledger
-- (Белот), но НЕ споделена с него: match_economy_ledger.entry_type CHECK
-- constraint-ът е фиксиран enum ('stake_debit', 'stake_refund',
-- 'winner_payout') за вече приложена миграция, която не пипаме. Отделна
-- таблица с Ludo-specific entry_type имена прави ledger записите
-- недвусмислено различими по игра (виж task spec §6), без cross-game
-- ambiguity между Белот room_id и Ludo match_id (и двата UUID, неразличими
-- по формат).
--
-- Идемпотентност: UNIQUE(match_id, profile_id, entry_type), same shape като
-- match_economy_ledger — един profile не може да бъде debit-нат/payout-нат
-- два пъти за един и същ Ludo match (INSERT ... ON CONFLICT DO NOTHING в
-- ludoEconomyStore.ts + explicit pre-check преди debit/credit).
CREATE TABLE IF NOT EXISTS ludo_match_economy_ledger (
  ledger_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('ludo_stake_debit', 'ludo_winner_payout')
  ),
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  UNIQUE (match_id, profile_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_ludo_match_economy_ledger_profile_id
  ON ludo_match_economy_ledger(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ludo_match_economy_ledger_match_id
  ON ludo_match_economy_ledger(match_id, created_at);
