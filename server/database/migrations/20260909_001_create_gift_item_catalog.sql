PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gift_items (
  gift_item_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gift_items_active_sort
  ON gift_items(is_active, sort_order);

CREATE TABLE IF NOT EXISTS gift_item_transactions (
  transaction_id TEXT PRIMARY KEY,
  gift_item_id TEXT NOT NULL,
  sender_profile_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  charged_price INTEGER NOT NULL CHECK (charged_price > 0),
  context TEXT NOT NULL DEFAULT 'profile',
  room_id TEXT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (sender_profile_id <> recipient_profile_id),
  FOREIGN KEY (gift_item_id) REFERENCES gift_items(gift_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gift_item_transactions_sender
  ON gift_item_transactions(sender_profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gift_item_transactions_recipient
  ON gift_item_transactions(recipient_profile_id, created_at);

CREATE TABLE IF NOT EXISTS gift_item_delivery_log (
  transaction_id TEXT PRIMARY KEY,
  recipient_profile_id TEXT NOT NULL,
  gift_item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  from_display_name TEXT NOT NULL,
  shown_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES gift_item_transactions(transaction_id) ON DELETE CASCADE,
  FOREIGN KEY (gift_item_id) REFERENCES gift_items(gift_item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gift_item_delivery_log_pending
  ON gift_item_delivery_log(recipient_profile_id, shown_at);
