CREATE TABLE IF NOT EXISTS support_messages (
  message_id   TEXT NOT NULL PRIMARY KEY,
  profile_id   TEXT NOT NULL,
  body         TEXT NOT NULL,
  is_from_admin INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  read_by_user  INTEGER NOT NULL DEFAULT 0,
  read_by_admin INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_support_messages_profile_id ON support_messages (profile_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON support_messages (created_at);
