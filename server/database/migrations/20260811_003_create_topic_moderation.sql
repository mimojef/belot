PRAGMA foreign_keys = ON;

-- Topics moderation (Етап 4) — temporary lock/mute, delete, reports, audit
-- log. Reuse-ва established конвенции от admin_role_audit_log/
-- lobby_chat_deletion_audit_log (actor = accounts.account_id, target =
-- profiles.profile_id, ON DELETE SET NULL за да не се губи history) и от
-- vip_status (expiry = TEXT timestamp, isActive computed at READ time,
-- никога persisted boolean — виж vipStore.ts toStatusSnapshot).
--
-- topics.status вече поддържа 'active'|'locked'|'removed' (виж
-- 20260810_002 коментара: "пълните moderation полета остават за Етап 4") —
-- тук добавяме current-lock-state колоните директно на topics (overwritten
-- при нов lock/unlock, огледално на vip_status.active_until), докато
-- ПЪЛНАТА история (кой/кога/защо/expiry за ВСЯКО действие, включително
-- ръчен unlock като отделен запис) живее в topic_moderation_audit_log
-- (append-only, никога UPDATE-нат).

ALTER TABLE topics ADD COLUMN locked_until TEXT;
ALTER TABLE topics ADD COLUMN locked_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN locked_reason TEXT;
ALTER TABLE topics ADD COLUMN removed_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN removed_reason TEXT;
ALTER TABLE topics ADD COLUMN removed_at TEXT;

-- Topic-specific mute — (profile_id, topic_id) двойка, НЕ global account
-- mute (брифа т.4). PRIMARY KEY върху двойката гарантира максимум 1 active
-- mute row/потребител/тема — нов mute презаписва (UPSERT), не трупа
-- редове; пълната история пак е в audit log-а, не тук. muted_until е
-- source of truth за "активен ли е mute-ът" (computed at read time, точно
-- като vip_status.active_until) — ръчен unmute трие реда direktно (не
-- overwrite с минала дата), за да пази lookup заявката (WHERE muted_until >
-- now) семпла и индексируема без нужда от допълнителен "is_active" флаг.
CREATE TABLE IF NOT EXISTS topic_mutes (
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  muted_until TEXT NOT NULL,
  muted_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (topic_id, profile_id)
);

-- Active-mute lookup е hot path (проверява се на ВСЕКИ send_topic_message/
-- send_topic_reply) — PRIMARY KEY(topic_id, profile_id) вече го покрива
-- директно (composite PK е неявен UNIQUE index), затова няма нужда от
-- допълнителен index тук.

-- Report/докладване на тема от обикновен регистриран потребител. reporter
-- identity идва ИЗКЛЮЧИТЕЛНО от authenticated session server-side (никога
-- client-provided) — виж handleTopicReportRequest в index.ts.
-- status lifecycle позволява реален moderation queue (не само "insert и
-- забрави") — admin маркира като 'reviewed'/'dismissed' след преглед.
CREATE TABLE IF NOT EXISTS topic_reports (
  report_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  reporter_profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (trim(reason) <> ''),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'reviewed', 'dismissed')
  ),
  reviewed_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_topic_reports_status_created
  ON topic_reports(status, created_at);

-- Duplicate/spam guard заявка (reporter_profile_id, topic_id, скорошен
-- created_at) минава по този индекс — виж createTopicReport
-- duplicate-window проверката в topicModerationStore.ts.
CREATE INDEX IF NOT EXISTS idx_topic_reports_reporter_topic
  ON topic_reports(reporter_profile_id, topic_id, created_at);

-- Append-only moderation audit log — ЕДИН ред на ВСЯКО moderation действие
-- (lock/unlock/mute/unmute/delete), никога UPDATE-нат. Ръчен unlock/unmute
-- е САМОСТОЯТЕЛЕН audit ред (не редакция на стария lock/mute ред) — виж
-- брифа т.7: "историята да не се загуби". target_profile_id е NULL за
-- topic-level действия (lock/unlock/delete), попълнено само за mute/unmute.
CREATE TABLE IF NOT EXISTS topic_moderation_audit_log (
  log_id TEXT PRIMARY KEY,
  actor_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL CHECK (
    actor_role IN ('admin', 'subadmin', 'pika_team', 'top_chat_admin')
  ),
  action TEXT NOT NULL CHECK (
    action IN ('topic_lock', 'topic_unlock', 'topic_mute', 'topic_unmute', 'topic_delete')
  ),
  topic_id TEXT NOT NULL,
  target_profile_id TEXT REFERENCES profiles(profile_id) ON DELETE SET NULL,
  reason TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- topic_id НЕ носи FK/CASCADE към topics — auditログ трябва да преживее
-- topic_delete действието самото (темата вече не съществува в topics след
-- delete, но audit редът за самото изтриване, plus всички предишни lock/
-- mute действия върху нея, трябва да остане четим).
CREATE INDEX IF NOT EXISTS idx_topic_moderation_audit_log_topic
  ON topic_moderation_audit_log(topic_id, created_at);

CREATE INDEX IF NOT EXISTS idx_topic_moderation_audit_log_actor
  ON topic_moderation_audit_log(actor_account_id, created_at);
