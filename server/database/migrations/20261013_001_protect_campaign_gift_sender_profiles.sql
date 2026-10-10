PRAGMA foreign_keys = ON;

-- Фаза 2.1 от системата "Кампании" — защита срещу окончателно изтриване на
-- профил, който фигурира като подател на поне един реално предоставен
-- кампаниен подарък (gift_item_transactions.context = 'campaign_reward').
-- Намерен проблем: gift_item_transactions.sender_profile_id/recipient_
-- profile_id са ON DELETE CASCADE към profiles(profile_id) — hard delete на
-- подателя би каскадно изтрил цялата история на вече предоставените
-- кампанийни награди (виж 20260909_001_create_gift_item_catalog.sql).
--
-- DB-level backstop (§5 от задачата) — application-level guard в
-- profileHardDeleteService.ts::hardDeleteProfile е ПЪРВИЧНАТА защита
-- (ясен error code, нормален UX); този trigger е ВТОРИ, независим слой,
-- който пречи ДИРЕКТЕН SQL DELETE FROM profiles (или бъдещ код path, който
-- не минава през hardDeleteProfile) да заобиколи правилото случайно.
--
-- Защитава по ИСТОРИЧЕСКО участие като подател, НЕ по текущата роля на
-- профила (§2 от задачата: "Важно е историческото му участие като
-- подател, а не текущата му роля") — проверката е чисто по
-- gift_item_transactions.sender_profile_id + context, без JOIN към
-- profiles/accounts.role.
--
-- Fire-per-row (SQLite trigger семантика) — защитава и bulk DELETE
-- statements (напр. playerProgressStore.ts's "DELETE FROM profiles WHERE
-- is_temporary = 1" cleanup, localTournamentTestService.ts's test-account
-- cleanup): всеки ред, опитващ се да бъде изтрит, минава през same WHEN
-- проверка индивидуално. Темп/тестови профили никога не фигурират като
-- campaign_reward sender на практика (admin UI ще позволява избор само на
-- реални marketing-role профили) — нулев практически overhead, индексиран
-- EXISTS lookup (idx_gift_item_transactions_sender, виж 20260909_001).
--
-- RAISE(ABORT, ...) (не ROLLBACK/FAIL) — спира само текущия DELETE
-- statement; profileHardDeleteService.hardDeleteProfile() вече catch-ва
-- хвърлената грешка в своя try/catch и explicit прави ROLLBACK на ЦЯЛАТА
-- обвиваща транзакция (виж кода там) — не се разчита на SQLite's собствена
-- transaction-level ABORT семантика за това.
CREATE TRIGGER IF NOT EXISTS trg_protect_campaign_gift_sender_profiles
BEFORE DELETE ON profiles
WHEN EXISTS (
  SELECT 1 FROM gift_item_transactions
  WHERE sender_profile_id = OLD.profile_id
    AND context = 'campaign_reward'
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_gift_sender_protected');
END;
