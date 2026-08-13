PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topic_thread_read_state (
  profile_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  PRIMARY KEY (profile_id, root_message_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (root_message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_thread_read_state_root
  ON topic_thread_read_state(root_message_id);

CREATE INDEX IF NOT EXISTS idx_topic_messages_topic_parent_seq
  ON topic_messages(topic_id, parent_message_id, seq);
