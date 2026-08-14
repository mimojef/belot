PRAGMA foreign_keys = ON;

-- Global Topics-section mute (заменя enforcement source of truth-а за
-- "заглушен ли е потребителят да пише в Теми" — виж брифа "GLOBAL TOPICS
-- MUTE"). Активен mute вече блокира ВСИЧКО писане в секция "Теми": create
-- topic, root post, reply, vip_dm (first message + existing conversation
-- send). Старата topic_mutes (per-topic) НЕ се променя/трие — остава чисто
-- исторически данни и продължава да захранва topic_moderation_audit_log
-- context-а, но вече не е enforcement source.
--
-- PRIMARY KEY(profile_id) — максимум 1 активен global mute на потребител
-- (mirror на topic_mutes.PRIMARY KEY(topic_id, profile_id) established
-- convention: composite/single-column PK е и implicit unique index, нов
-- mute UPSERT-ва, не трупа редове; пълна история си остава в
-- topic_moderation_audit_log). muted_until е source of truth за "активен
-- ли е mute-ът" (computed at READ time, точно като topic_mutes.muted_until
-- и vip_status.active_until) — ръчен unmute трие реда directno (не
-- overwrite с минала дата), за същата причина като старата таблица: семпъл
-- lookup (PRIMARY KEY presence = potentially active) без нужда от
-- допълнителен is_active флаг.
--
-- Без FK към конкретна тема (за разлика от topic_mutes.topic_id) — мутът
-- вече не е обвързан с нито една конкретна тема, "topicId", подаден от
-- moderator UI при mute action, остава само audit/source context (виж
-- topic_moderation_audit_log.topic_id за тази цел), НЕ enforcement scope.
CREATE TABLE IF NOT EXISTS topic_section_mutes (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  muted_until TEXT NOT NULL,
  muted_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
);

-- Active-mute lookup е hot path (проверява се на ВСЕКИ Topics write:
-- create_topic/send_topic_message/send_topic_reply/vip_dm start и send) —
-- PRIMARY KEY(profile_id) вече го покрива directno (implicit UNIQUE index),
-- затова няма нужда от допълнителен index тук (mirror на topic_mutes
-- коментара).

-- ─── Promote existing ACTIVE legacy topic_mutes → topic_section_mutes ──────
--
-- Upgrade rationale (продуктово решение, брифа §3): enforcement scope-ът
-- става global веднага след тази migration — потребител, който В МОМЕНТА
-- на upgrade-а е активно заглушен в ПОНЕ една тема, не трябва внезапно да
-- бъде освободен само защото старата scoping механика е сменена. Затова
-- всеки profile_id с поне един РЕАЛНО активен (muted_until > текущия UTC
-- момент на migration-а) legacy ред получава промотиран global mute ред.
--
-- Detrministic избор при няколко активни legacy mute-а на един profile_id:
-- избираме реда с НАЙ-КЪСЕН (най-далечен в бъдещето) muted_until — "longest
-- remaining sanction wins", точно както изисква брифа. Tie-break (еднакъв
-- muted_until до секундата, теоретично възможно при mute-ове, направени в
-- една и съща секунда с еднаква duration) е по topic_id ASC — единственият
-- допълнителен детерминистичен ключ, наличен в реда, без да разчитаме на
-- недетерминистичен rowid/insertion order.
--
-- Expired legacy редове (muted_until <= now) НЕ се промотират изобщо —
-- изтекла санкция не трябва да "възкръсне" като нов активен global mute.
--
-- Idempotency (rerun safety, mirint migration runner semantics — виж
-- ensureServerDatabaseReady.ts, всяка migration файл се прилага точно
-- веднъж, tracked в server_migrations): INSERT OR IGNORE гарантира, че
-- ако migration runner-ът по някаква причина изпълни файла повторно върху
-- база, където topic_section_mutes вече съдържа redovete от предишно
-- изпълнение, повторното изпълнение е no-op (не презаписва вече наличен
-- ред, не хвърля грешка) — по-безопасно от INSERT ... ON CONFLICT DO
-- UPDATE тук, защото след първоначалната promotion РЕАЛНИ нови global
-- mute-ове (направени от модератор след upgrade-а) не трябва да бъдат
-- презаписани от повторно migration изпълнение с остарели legacy данни.
INSERT OR IGNORE INTO topic_section_mutes (profile_id, muted_until, muted_by_account_id, reason, created_at)
SELECT
  tm.profile_id,
  tm.muted_until,
  tm.muted_by_account_id,
  tm.reason,
  CURRENT_TIMESTAMP
FROM topic_mutes tm
WHERE tm.muted_until > strftime('%Y-%m-%d %H:%M:%S', 'now')
  AND tm.rowid = (
    -- "rowid на печелившия ред за този profile_id" — longest muted_until
    -- wins, tie-break по topic_id ASC за детерминизъм.
    SELECT tm2.rowid
    FROM topic_mutes tm2
    WHERE tm2.profile_id = tm.profile_id
      AND tm2.muted_until > strftime('%Y-%m-%d %H:%M:%S', 'now')
    ORDER BY tm2.muted_until DESC, tm2.topic_id ASC
    LIMIT 1
  );
