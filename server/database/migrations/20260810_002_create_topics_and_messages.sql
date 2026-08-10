PRAGMA foreign_keys = ON;

-- created_by_profile_id е NULLABLE изрично — системният "Общ чат" не е
-- създаден от никой потребител (нито от PIKABG профил, само за да
-- удовлетвори NOT NULL). status/sort_order/locked/removed metadata е сведено
-- до минимума, нужен за Етап 1 (list active topics); пълните moderation
-- полета (locked_by, removed_by и т.н.) остават за Етап 4, когато реално
-- ще се пишат от lock/remove handlers.
CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  is_general INTEGER NOT NULL DEFAULT 0,
  created_by_profile_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'locked', 'removed')
  ) DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_active_order
  ON topics(status, sort_order, created_at);

-- Точно един системен "Общ чат" — idempotent seed, restart-safe. ON CONFLICT
-- на slug (не на topic_id, който е случаен UUID) е ключово: рестарт на
-- сървъра генерира нов UUID при всяко изпълнение на migration файла, но
-- slug='general' е фиксиран литерал, така че конфликтът винаги ще уцели
-- същия ред и NO-OP-не вместо да вкара втори "Общ чат".
INSERT INTO topics (
  topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order
) VALUES (
  'topic-general', 'general', 'Общ чат', 'Общо пространство за разговори.', 1, NULL, 'active', 0
) ON CONFLICT(slug) DO NOTHING;

-- seq е глобален monotonic cursor (не per-topic) — history pagination минава
-- през seq < oldestLoadedSeq WHERE topic_id = ?, без OFFSET, по модел на
-- lobby_chat_messages. message_id е отделен UUID за stable client-side
-- keying (React/DOM diffing), seq е само за курсор аритметика.
CREATE TABLE IF NOT EXISTS topic_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  topic_id TEXT NOT NULL,
  parent_message_id TEXT,
  sender_profile_id TEXT NOT NULL,
  sender_display_name TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK (
    sender_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'subadmin', 'admin')
  ),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_messages_topic_seq
  ON topic_messages(topic_id, seq);

CREATE INDEX IF NOT EXISTS idx_topic_messages_parent
  ON topic_messages(parent_message_id)
  WHERE parent_message_id IS NOT NULL;
