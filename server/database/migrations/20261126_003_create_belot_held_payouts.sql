-- Етап 3Б.2: устойчив регистър на задържаните изплащания в Белот.
--
-- payoutMatchWinners задържа изплащането, когато room.config.financialTerms
-- е налично, но невалидно/несъответстващо (Етап 3Б). Досега случаят оставаше
-- само в лога. Тази таблица го пази устойчиво — след премахване на масата
-- и след рестарт — за последваща проверка и ръчно уреждане.
--
-- Един ред на МАЧ: match_scope = `${roomId}:v${stateVersion}` — СЪЩИЯТ ключ,
-- под който payoutMatchWinners пише winner_payout в match_economy_ledger.
-- Повторно регистриране само увеличава hold_count (никога ново задължение).
--
-- Уреждането (matchEconomyStore.settleHeldPayout) минава през същите
-- profile_wallets + match_economy_ledger (winner_payout / stake_refund) и
-- сменя статуса В СЪЩАТА транзакция, само от 'pending_review'.
--
-- Защита от загуба (виж index.ts): незаписан случай остава в RAM за повторен
-- опит, snapshot-ът на масата НЕ се трие, докато случаят не е записан, а при
-- старт belot_match_completion_ledger (записан ПРЕДИ изплащането) служи за
-- диагностика на мачове без изплащане и без ред тук.
--
-- Статуси:
--   pending_review   — чака проверка (единственият неуреден статус);
--   settled_payout   — изплатено след ръчна проверка на наградата;
--   settled_refund   — върнати входовете на участниците;
--   closed_no_action — затворено без движение на жълтици (напр. уредено
--                      извън системата или няма кой да получи) — изисква
--                      бележка.
--
-- Без FK към profiles: финансовата история се пази и при изтрит профил.
CREATE TABLE IF NOT EXISTS belot_held_payouts (
  match_scope TEXT PRIMARY KEY CHECK (trim(match_scope) <> ''),
  room_id TEXT NOT NULL CHECK (trim(room_id) <> ''),
  stake_amount INTEGER NOT NULL CHECK (stake_amount > 0),
  -- rulesVersion от наличните условия, ако е четим; NULL при повредени.
  rules_version TEXT NULL,
  -- 'invalid' / 'stake-mismatch' — задържано от payoutMatchWinners;
  -- 'payout-missing' — открито при старт: завършен платен мач (по
  -- belot_match_completion_ledger) без winner_payout и без ред тук.
  hold_reason TEXT NOT NULL CHECK (hold_reason IN ('invalid', 'stake-mismatch', 'payout-missing')),
  -- Суровите налични financialTerms (JSON) — доказателство, не източник на сума.
  financial_terms_json TEXT NOT NULL,
  winner_team TEXT NOT NULL CHECK (winner_team IN ('A', 'B')),
  -- [{seat, team, kind, profileId, stakeLedgerScope, isWinner}]
  participants_json TEXT NOT NULL,
  -- Профилите, които payoutMatchWinners би изплатил: [{seat, profileId}]
  winners_json TEXT NOT NULL,
  -- Входовете на ТОЗИ мач за възможно възстановяване: [{scope, profileId, amount}]
  stake_debits_json TEXT NOT NULL,
  -- Допълнителни данни за проверка (isPrivateTableOrigin, voiceTableId и т.н.).
  context_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (
    status IN ('pending_review', 'settled_payout', 'settled_refund', 'closed_no_action')
  ),
  hold_count INTEGER NOT NULL DEFAULT 1 CHECK (hold_count >= 1),
  held_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_held_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT NULL,
  resolved_by TEXT NULL,
  resolution_note TEXT NULL,
  resolution_prize_per_winner INTEGER NULL CHECK (resolution_prize_per_winner IS NULL OR resolution_prize_per_winner > 0),
  resolution_evidence TEXT NULL,
  CHECK (
    (status = 'pending_review' AND resolved_at IS NULL)
    OR (
      status <> 'pending_review'
      AND resolved_at IS NOT NULL
      AND resolved_by IS NOT NULL AND trim(resolved_by) <> ''
      AND resolution_note IS NOT NULL AND trim(resolution_note) <> ''
    )
  ),
  CHECK (status <> 'settled_payout' OR resolution_prize_per_winner IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_belot_held_payouts_status
  ON belot_held_payouts(status, held_at);

CREATE INDEX IF NOT EXISTS idx_belot_held_payouts_room
  ON belot_held_payouts(room_id);
