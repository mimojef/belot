PRAGMA foreign_keys = ON;

-- Ludo wins -> profile progression. profile_completed_game_ledger (миграция
-- 20260927_001) досега пазеше само "тоя profile получи +1 completed game за
-- тоя scope". did_win добавя "и +1 won_games_count за същия scope" като
-- idempotency флаг — виж playerProgressStore.ts::recordCompletedGameForProfile:
--   - нов ред с did_win=1 -> completed +1 и won +1;
--   - съществуващ ред did_win=0 -> по-късно didWin=true -> UPDATE 0->1 и
--     само won +1 (completed не се пипа);
--   - did_win=1 -> no-op.
--
-- DEFAULT 0 за съществуващите редове: Ludo мачовете, отчетени от 007130f
-- насам, са записани без победа (didWin беше hardcoded false). Коригират се
-- от playerProgressStore.reconcileLudoMatchWins() (виж
-- scripts/reconcileLudoMatchWins.ts), само за редове, които вече съществуват
-- в ledger-а — Ludo мачове отпреди 007130f нямат ред тук и не се добавят.
ALTER TABLE profile_completed_game_ledger
  ADD COLUMN did_win INTEGER NOT NULL DEFAULT 0 CHECK (did_win IN (0, 1));
