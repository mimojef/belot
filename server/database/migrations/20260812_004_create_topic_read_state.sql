PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topic_read_state (
  profile_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  PRIMARY KEY (profile_id, topic_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS topic_sender_seen_state (
  profile_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  sender_profile_id TEXT NOT NULL,
  seen_through_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  PRIMARY KEY (profile_id, topic_id, sender_profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_messages_sender_topic_seq
  ON topic_messages(sender_profile_id, topic_id, seq);
