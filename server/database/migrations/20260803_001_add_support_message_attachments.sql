-- Adds protected image attachments for registered-user support conversations.
--
-- The attachment metadata lives in a separate table so support_messages keeps its existing
-- message_id primary key and text rows stay compatible. Image-only messages are enforced at
-- application level because SQLite CHECK constraints cannot inspect a second table.
--
-- The deletion queue records physical-file deletion intent in the same DB transaction that
-- removes support messages. A background worker deletes files only after the DB reference is
-- gone, and a defensive orphan scan handles file-write-success / DB-insert-failure leftovers.

CREATE TABLE IF NOT EXISTS support_message_attachments (
  message_id TEXT PRIMARY KEY,
  storage_filename TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL DEFAULT 'image/webp',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES support_messages(message_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_message_attachments_filename
  ON support_message_attachments(storage_filename);

CREATE TABLE IF NOT EXISTS support_message_attachment_deletions (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    cleanup_status IN ('pending', 'done', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_support_message_attachment_deletions_status
  ON support_message_attachment_deletions(cleanup_status);
