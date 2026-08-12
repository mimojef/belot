PRAGMA foreign_keys = ON;

-- Individual message/reply moderation (moderator delete на ОТДЕЛНО root
-- съобщение или reply в Topics — за разлика от whole-topic delete, който
-- вече съществува в 20260811_003_create_topic_moderation.sql).
--
-- Двете нови таблици тук mirror-ват established lobby_chat_deletion_events/
-- lobby_chat_deletion_audit_log pattern (20260728_001_create_lobby_chat_messages.sql),
-- но за разлика от lobby chat версията, тук FK CASCADE-ваме към
-- topic_messages(message_id) нарочно — soft-delete (UPDATE deleted_at) НЕ
-- тригерва FK CASCADE (само hard DELETE го прави), значи и двете таблици
-- остават валидни/четими през целия 180-дневен individual-message retention
-- прозорец, докато самият topic_messages ред все още физически съществува
-- (само soft-deleted). При финалния individual-message hard purge
-- (purgeDeletedTopicMessagesBefore, извън тази migration) DELETE FROM
-- topic_messages автоматично CASCADE-трие и двата event/audit реда — нулева
-- нужда от отделна purge логика за тях (брифа §8/§9/§25: "не пази
-- deletion event/audit безсрочно").
--
-- НЕ пипаме съществуващия topic_moderation_audit_log — неговите action/
-- actor_role CHECK constraints не покриват message/reply delete action
-- нито chat_admin actor (виж analysis report). Тези две нови таблици са
-- add-only инфраструктура, изцяло независима от него.

-- Транзиентен "fanout log" САМО за cross-instance известяване на individual
-- message/reply moderation delete (mirror на lobby_chat_deletion_events
-- rationale) — отделен монотонен event_seq от topic_messages.seq/
-- topic_message_attachment_deletions.event_seq (различни fanout streams).
--
-- parent_message_id е SNAPSHOT (не functional FK) — записва target типа
-- към момента на изтриване: NULL = target-ът е бил root, non-NULL = target-ът
-- е бил reply. Клиентът ползва точно тази стойност, за да реши дали да
-- махне цял thread или само 1 reply (виж TopicMessageDeletedMessage payload
-- в messageTypes.ts) — затова НЕ носи FK/CASCADE (root delete CASCADE-трие
-- replies-те, но техните ЛИПСВАЩИ отделни deletion events не са проблем,
-- тъй като целият thread се маха с ЕДИН event за root-а, виж брифа §11:
-- "Не създавай отделен audit row за всеки collateral reply").
CREATE TABLE IF NOT EXISTS topic_message_deletion_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  FOREIGN KEY (message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_message_deletion_events_topic
  ON topic_message_deletion_events(topic_id, event_seq);

-- Dedicated одит на individual message/reply moderator delete — ОТДЕЛНА
-- таблица от topic_moderation_audit_log (виж коментара най-горе). Actor
-- role CHECK тук покрива точно петте individual-message-moderation роли
-- (различен, по-широк set от topic_moderation_audit_log's action CHECK,
-- който няма chat_admin — Топикс individual-message moderation брифа §4).
--
-- FK CASCADE към topic_messages(message_id): audit редът за конкретния
-- moderation-delete акт "умира" заедно с крайния hard purge на target
-- съобщението (root или reply) — точно 180-дневния review прозорец, без
-- безсрочно пазене (брифа §9/§25).
CREATE TABLE IF NOT EXISTS topic_message_deletion_audit_log (
  log_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_message_id TEXT,
  sender_profile_id TEXT,
  actor_account_id TEXT,
  actor_role TEXT NOT NULL CHECK (
    actor_role IN ('admin', 'subadmin', 'top_chat_admin', 'pika_team', 'chat_admin')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  FOREIGN KEY (message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_message_deletion_audit_log_topic
  ON topic_message_deletion_audit_log(topic_id, created_at);
