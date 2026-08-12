PRAGMA foreign_keys = ON;

ALTER TABLE topic_messages
  ADD COLUMN edited_at TEXT;

CREATE TABLE IF NOT EXISTS topic_message_edit_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  FOREIGN KEY (message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_message_edit_events_topic
  ON topic_message_edit_events(topic_id, event_seq);
