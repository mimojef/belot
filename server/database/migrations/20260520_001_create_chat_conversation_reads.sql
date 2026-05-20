CREATE TABLE IF NOT EXISTS chat_conversation_reads (
  profile_id TEXT NOT NULL,
  friendship_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, friendship_id)
);
