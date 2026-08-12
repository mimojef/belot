PRAGMA foreign_keys = ON;

-- Lightweight self-deletion audit — авторът сам изтрива собствено root
-- съобщение/reply (различно от moderator delete, виж
-- 20260812_001_create_topic_message_moderation.sql). Отделна, dedicated
-- таблица: topic_message_deletion_audit_log е moderator-specific
-- (actor_role CHECK не включва 'player') — reuse-ването ѝ за self-delete би
-- изисквало промяна на съществуващ CHECK constraint, нежелателно. Тук няма
-- actor_role изобщо — self-delete е по дефиниция авторът, действащ върху
-- собственото си съдържание.
--
-- FK CASCADE към topic_messages(message_id): soft-delete (UPDATE deleted_at)
-- НЕ тригерва CASCADE, значи audit редът остава четим през целия 180-дневен
-- individual-message retention прозорец (own-delete-own-content-brifa §6/§9/
-- §16), докато самият topic_messages ред все още физически съществува. При
-- финалния hard purge (purgeDeletedTopicMessagesBefore, вече established,
-- reuse-нат без промяна тук) DELETE FROM topic_messages автоматично
-- CASCADE-трие audit реда — не пазим self-delete история безсрочно.
CREATE TABLE IF NOT EXISTS topic_message_self_deletion_audit_log (
  log_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_message_id TEXT,
  sender_profile_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  FOREIGN KEY (message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_message_self_deletion_audit_log_topic
  ON topic_message_self_deletion_audit_log(topic_id, created_at);
