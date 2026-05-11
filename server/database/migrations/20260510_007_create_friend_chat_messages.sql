PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS friend_chat_messages (
  message_id TEXT PRIMARY KEY,
  friendship_id TEXT NOT NULL,
  sender_profile_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (
    trim(body) <> ''
    AND length(body) <= 1000
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT NULL,
  FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_friend_chat_messages_friendship
  ON friend_chat_messages(friendship_id, created_at);

CREATE INDEX IF NOT EXISTS idx_friend_chat_messages_sender
  ON friend_chat_messages(sender_profile_id, created_at);
