-- Support chat evidence preservation при hard delete на профил (admin
-- moderation, "Връзка с екипа" feature request): support_messages/
-- support_archived/support_message_attachments нямат FK към profiles ВЪОБЩЕ
-- (проверено — нито CASCADE, нито SET NULL), затова DELETE FROM profiles
-- не ги трие, но и не ги маркира по никакъв начин — разговорът остава
-- orphaned, показва се в admin inbox-а като "Неизвестен" БЕЗ индикация, че
-- профилът вече е изтрит, и admin може технически да отговори в мъртъв
-- разговор (sendAdminReply само проверява, че съществува support_messages
-- ред за profileId, НЕ проверява profiles).
--
-- Тази миграция НЕ пипа FK-та на support_messages/support_archived/
-- support_message_attachments (няма какво да се "фиксира" — вече няма FK,
-- значи няма CASCADE проблем и няма счупени references след DELETE FROM
-- profiles). Вместо това добавя explicit immutable marker/audit ред,
-- записван от profileHardDeleteService В СЪЩАТА транзакция като
-- DELETE FROM profiles (mirror на admin_profile_deletions pattern-а).
--
-- EXPLICIT ATTRIBUTION ONLY (round 2 корекция — виж §"Коригираме support
-- deletion archive feature-а ПРЕДИ commit"): редът тук се създава ЕДИНСТВЕНО
-- когато admin изрично е избрал конкретно user-authored support съобщение
-- ("Изтрий профила по тази заявка" бутон в support chat UI-я) като причина
-- за hard delete-а — НЕ автоматично "последното user съобщение в разговора"
-- (предишният design, отхвърлен: несвързан стар support разговор би могъл
-- подвеждащо да изглежда като "доказателство", че потребителят сам е
-- поискал изтриване, дори когато admin-ът трие профила по съвсем друга
-- причина, напр. нарушение/измама). Затова:
--   - request_message_id/requested_at са NOT NULL — редът съществува само
--     когато атрибуцията е доказана (сървърът е валидирал вътре в
--     hard-delete транзакцията, че съобщението реално съществува,
--     принадлежи на target profile_id и е is_from_admin=0 — виж
--     profileHardDeleteService.ts's supportRequestMessageId validation).
--   - username/display_name snapshot — четимост в архивния UI дори след
--     като profiles реда изчезне (mirror на admin_profile_deletions.
--     username_snapshot).
--   - deleted_by_profile_id — admin actor (SET NULL ако admin профилът
--     самият по-късно бъде изтрит — audit редът трябва да преживее и това).
--
-- Нарочно БЕЗ FK към profiles/support_messages за profile_id/request_message_id
-- колоните — target профилът/съобщенията вече не могат да гарантират
-- referential integrity forever (support_messages може по-късно да бъде
-- изчистена от cleanupInactiveConversations за НЕархивирани разговори —
-- архивираните са изрично изключени от този job, виж supportStore.ts).
-- Архивната таблица тук е just the forensic marker+snapshot, не copy на
-- пълното съдържание (spec §E "минимален архив").
CREATE TABLE IF NOT EXISTS support_deletion_archives (
  archive_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  username_snapshot TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  request_message_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_by_profile_id TEXT NULL,
  reason TEXT NOT NULL DEFAULT 'user_request' CHECK (trim(reason) <> ''),
  FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

-- Един архивен ред на изтрит профил (idempotent lookup при рендер на
-- archived conversation banner-а) — UNIQUE вместо plain index, за да не може
-- случаен двоен insert (напр. retry) да създаде дублирани marker-и за
-- същия profile_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_deletion_archives_profile
  ON support_deletion_archives(profile_id);

-- Deferred hard-delete carry-through (round 3 корекция — "active-game
-- deferred HARD DELETE губи supportRequestMessageId"): pending_profile_moderation
-- (20260902_004, вече deployed — НЕ пипаме тази таблица's оригинална
-- миграция, само ALTER тук, докато 20260903_003 самата все още е local-only)
-- пази отложените hard-delete-и за target профили в момента играеща се игра
-- (виж applyPendingModerationForRoom в index.ts). Explicit-attribution
-- support request context (виж по-горе support_deletion_archives) трябва да
-- преживее и този deferred път — без тази колона, "Изтрий профила по тази
-- заявка" върху target в active game би загубил кой message id е бил
-- избран до момента на terminal completion.
--
-- Nullable, БЕЗ FK (mirror на support_deletion_archives.request_message_id
-- по-горе — message редът трябва да остане validate-руем authoritative от
-- profileHardDeleteService при terminal execution, не референциран тук).
-- NULL за нормален admin delete без support context (mirror на "ако
-- supportRequestMessageId НЕ е подаден, НЕ insert-вай support_deletion_archives").
ALTER TABLE pending_profile_moderation
  ADD COLUMN support_request_message_id TEXT NULL;
