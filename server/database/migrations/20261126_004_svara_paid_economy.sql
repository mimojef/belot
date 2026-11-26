-- Етап 3В.2: финансова основа на платената „Свара“ (ИЗКЛЮЧЕНА по
-- подразбиране — SVARA_PAID_MATCHES_ENABLED). Само добавящи таблици; не
-- пипа Белот / „Не се сърди човече“ / турнири.
--
-- 1) game_financial_configs — активната конфигурация на игра (база =
--    водещ източник). Началните стойности се създават от сървъра с
--    INSERT ... ON CONFLICT DO NOTHING — никога не презаписват по-късна
--    промяна. config_json се валидира при всяко четене
--    (economy/gameFinancialConfig.ts); невалиден → платените мачове отказват.
CREATE TABLE IF NOT EXISTS game_financial_configs (
  game_key TEXT PRIMARY KEY CHECK (game_key IN ('belot', 'ludo', 'svara')),
  config_json TEXT NOT NULL,
  config_version TEXT NOT NULL CHECK (trim(config_version) <> ''),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2) svara_match_finance — по един ред на платен мач. Създава се в СЪЩАТА
--    транзакция, в която се удържат всички входове (при действителния
--    старт). terms_json = неизменимите условия (game-match-terms-v1).
--    Статуси:
--      collected — входовете са удържани, мачът тече;
--      paid      — победителят е изплатен (точно terms.prizes[0]);
--      refunded  — мачът НЕ е започнал (техническа причина) — входовете върнати;
--      held      — без автоматично движение: няма победител / невалидни
--                  условия / победител извън участниците — за проверка.
--    attempt / ledger_scope: ако стартът се провали технически и входовете
--    бъдат върнати, следващ опит за старт на СЪЩАТА маса получава нов
--    ledger_scope (`<matchId>:a<attempt>`) — без конфликт с UNIQUE в ledger-а.
CREATE TABLE IF NOT EXISTS svara_match_finance (
  match_id TEXT PRIMARY KEY CHECK (trim(match_id) <> ''),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  ledger_scope TEXT NOT NULL CHECK (trim(ledger_scope) <> ''),
  status TEXT NOT NULL CHECK (status IN ('collected', 'paid', 'refunded', 'held')),
  terms_json TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  winner_profile_id TEXT NULL,
  held_reason TEXT NULL CHECK (held_reason IS NULL OR held_reason IN ('no-winner', 'invalid-terms', 'winner-not-participant', 'match-unrecoverable')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'held') = (held_reason IS NOT NULL)),
  CHECK (status <> 'paid' OR winner_profile_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_svara_match_finance_status
  ON svara_match_finance(status, created_at);

-- 3) svara_match_economy_ledger — отделен ledger (прецедент:
--    ludo_match_economy_ledger), без смесване с Белот. Портфейлите са
--    общите profile_wallets. UNIQUE(match, profile, type) → без двойно
--    удържане/изплащане/връщане. Без FK към profiles (историята се пази).
--    match_id тук = ledger_scope от svara_match_finance (`<matchId>:a<attempt>`).
CREATE TABLE IF NOT EXISTS svara_match_economy_ledger (
  ledger_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('svara_entry_debit', 'svara_entry_refund', 'svara_winner_payout')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (match_id, profile_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_svara_match_economy_ledger_profile
  ON svara_match_economy_ledger(profile_id, created_at);
