CREATE TABLE IF NOT EXISTS guest_contact_messages (
  message_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_by_admin INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  archived_at TEXT,
  email_delivery_status TEXT NOT NULL DEFAULT 'pending',
  email_sent_at TEXT,
  email_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_guest_contact_messages_created_at ON guest_contact_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_guest_contact_messages_read_by_admin ON guest_contact_messages (read_by_admin);
CREATE INDEX IF NOT EXISTS idx_guest_contact_messages_archived_at ON guest_contact_messages (archived_at);
CREATE INDEX IF NOT EXISTS idx_guest_contact_messages_email_delivery_status ON guest_contact_messages (email_delivery_status);
