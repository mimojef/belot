-- Runtime корекция (round 4 брифа): BAN/HARD DELETE не трябва да прекъсват
-- текуща активна игра на target профила. "Active game" = profile е реален
-- (kind='human', permanentlyLeftAt IS NULL) участник в ServerRoom със
-- status='playing' (виж isProfileInActiveGame в index.ts) — matchmaking
-- queue и waiting private room НЕ броят.
--
-- profile_bans редът се записва ВЕДНАГА (както преди) — банът е валиден от
-- момента на admin действието и блокира нов login/reconnect. Само LIVE
-- socket disconnect-ът на текущата играеща connection се отлага. Затова за
-- BAN тук пазим само лек "pending enforcement" маркер — action='ban' + вече
-- съществуващия profile_bans.ban_id, БЕЗ да дублираме reason/banned_until
-- (единствен source of truth за тях си остава profile_bans).
--
-- HARD DELETE е коренно различно: физическото DELETE FROM profiles се
-- ОТЛАГА изцяло (не само socket disconnect-а) — затова action='delete' ред
-- пази target_profile_id/requested_by_profile_id/reason/requested_at, за
-- да може profileHardDeleteService.hardDeleteProfile() да се извика по-късно
-- с точно същите параметри, все едно admin-ът тъкмо е натиснал бутона.
--
-- Restart-safe по дизайн — обикновен persisted ред, не in-memory Map.
-- При server restart pending редовете просто изчакват следващия път, в
-- който target-ният room/game стигне terminal lifecycle (виж
-- shouldRunMatchCompletionSideEffects hook-а в index.ts) — не е нужен cron/
-- polling, самият game loop е "следващата безопасна lifecycle точка".
--
-- target_profile_id FK е ON DELETE CASCADE — ако профилът бъде физически
-- изтрит по друг път (напр. pending 'ban' ред за профил, който после все
-- пак минава hard delete през тази СЪЩА pending машинария), pending редът
-- логично изчезва заедно с профила, който вече не съществува.
-- ban_id FK е ON DELETE SET NULL (mirror на profile_bans-related audit
-- redовете другаде) — ban история никога не се трие.
--
-- UNIQUE(target_profile_id) — само ЕДНО pending enforcement на профил в
-- даден момент; повторен admin BAN/DELETE опит върху target с вече pending
-- ред трябва да бъде третиран idempotent-но на application ниво (виж
-- profileBanStore/profileHardDeleteService), не да създава дублирани редове.
CREATE TABLE IF NOT EXISTS pending_profile_moderation (
  pending_id TEXT PRIMARY KEY,
  target_profile_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('ban', 'delete')
  ),
  -- Само за action='ban' — reference към вече записания profile_bans ред
  -- (source of truth за reason/banned_until/remainingDays остава там).
  ban_id TEXT NULL,
  -- Само за action='delete' — нужните параметри за отложеното извикване на
  -- profileHardDeleteService.hardDeleteProfile(). За action='ban' тези две
  -- полета не се ползват от enforcement логиката (banned_by вече е в
  -- profile_bans.banned_by_profile_id), но се пазят все пак за консистентен
  -- audit trail на кой admin е инициирал pending действието.
  requested_by_profile_id TEXT NOT NULL,
  requested_by_account_id TEXT NULL,
  reason TEXT NOT NULL CHECK (
    trim(reason) <> ''
  ),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_profile_id),
  FOREIGN KEY (target_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (ban_id) REFERENCES profile_bans(ban_id) ON DELETE SET NULL
);

-- "Има ли target профил pending enforcement" lookup — hot path за
-- join_matchmaking/join_private_room/tournament join guard-овете (spec §9
-- "блокирай нов login/reconnect/new game"), затова индексиран.
CREATE INDEX IF NOT EXISTS idx_pending_profile_moderation_target
  ON pending_profile_moderation(target_profile_id);
