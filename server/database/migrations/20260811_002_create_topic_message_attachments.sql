-- Adds protected image attachments for "Теми" (Topics) root messages and
-- replies — same shape as friend_chat_attachments/support_message_attachments
-- (server/database/migrations/20260729_001_.../20260803_001_...): metadata
-- lives in a separate table so topic_messages keeps its existing message_id
-- primary key and text-only rows stay compatible.
--
-- message_id PRIMARY KEY (not a separate id + UNIQUE) is itself the "max 1
-- attachment per message" DB constraint — a second INSERT with the same
-- message_id violates the primary key directly, no extra CHECK needed.
--
-- Image-only messages (empty body + attachment) are enforced at application
-- level, same as support_messages — topic_messages.body is NOT NULL but has
-- no CHECK(trim(body) <> '') constraint in 20260810_002, so no table rebuild
-- is needed here, unlike the friend_chat_messages migration.
--
-- The deletion queue records physical-file deletion intent — a background
-- worker (mirroring runChatAttachmentCleanup/runSupportAttachmentCleanup)
-- deletes files only after the DB reference is gone, plus a defensive orphan
-- scan for file-write-success / DB-insert-failure leftovers.

CREATE TABLE IF NOT EXISTS topic_message_attachments (
  message_id TEXT PRIMARY KEY,
  storage_filename TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL DEFAULT 'image/webp',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES topic_messages(message_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_message_attachments_filename
  ON topic_message_attachments(storage_filename);

CREATE TABLE IF NOT EXISTS topic_message_attachment_deletions (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    cleanup_status IN ('pending', 'done', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_topic_message_attachment_deletions_status
  ON topic_message_attachment_deletions(cleanup_status);
