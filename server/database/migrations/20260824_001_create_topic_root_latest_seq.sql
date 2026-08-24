PRAGMA foreign_keys = ON;

-- Materialized "latest live seq per thread" — 1 row per LIVE root message.
-- Maintained incrementally at message-write time (O(1) per post/reply/delete,
-- not per subscriber, not per broadcast). Lets General ("Общи") unread
-- computation skip roots that cannot possibly contain anything new for a
-- given batch of viewers, without scanning the full topic_messages history.
--
-- last_seen_seq semantics mirror topic_messages.seq: latest_seq is the
-- highest seq among the root itself and all of its still-live replies. A row
-- is removed when the root is soft-deleted (see application-side delete path
-- — deleteMessage/deleteOwnMessage keep this table in sync transactionally).
CREATE TABLE IF NOT EXISTS topic_root_latest_seq (
  root_message_id TEXT NOT NULL PRIMARY KEY,
  topic_id TEXT NOT NULL,
  latest_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  FOREIGN KEY (root_message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

-- Primary access pattern: "roots in this topic with latest_seq above some
-- viewer-batch threshold" — range SEARCH on (topic_id, latest_seq), bounded
-- by how many threads have recent activity, not by total topic history.
CREATE INDEX IF NOT EXISTS idx_topic_root_latest_seq_topic_seq
  ON topic_root_latest_seq(topic_id, latest_seq);

-- One-time backfill from canonical topic_messages — runs once at migration
-- time (restart-safe: migration runner tracks applied filenames, this file
-- only ever executes once per database). Only LIVE roots get a row; roots
-- with zero live messages (root itself deleted) are intentionally absent.
INSERT INTO topic_root_latest_seq (root_message_id, topic_id, latest_seq, updated_at)
SELECT
  root.message_id,
  root.topic_id,
  (
    SELECT MAX(m.seq)
    FROM topic_messages m
    WHERE (m.message_id = root.message_id OR m.parent_message_id = root.message_id)
      AND m.deleted_at IS NULL
  ) AS latest_seq,
  strftime('%Y-%m-%dT%H:%M:%f', 'now')
FROM topic_messages root
WHERE root.parent_message_id IS NULL
  AND root.deleted_at IS NULL;
