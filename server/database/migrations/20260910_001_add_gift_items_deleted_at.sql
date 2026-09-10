PRAGMA foreign_keys = ON;

-- Logical delete/tombstone за gift_items (виж CLAUDE.md брифа "Delete
-- semantics change" — Admin трябва да може да изтрие подарък НЕЗАВИСИМО от
-- transaction history). gift_item_transactions.gift_item_id FK е
-- ON DELETE RESTRICT (виж 20260909_001) — истински hard DELETE на ред с
-- история винаги ще хвърли constraint violation. deleted_at позволява на
-- реда да остане като tombstone (историята сочи към валиден gift_item_id
-- завинаги), докато catalog/selector листванията го изключват веднага.
-- NULL = не е изтрит (нормално състояние); non-NULL timestamp = logically
-- deleted, никога повече купуваем, никога не се показва в admin/public
-- listвания — но продължава да съществува за FK/historical snapshot цели.
ALTER TABLE gift_items ADD COLUMN deleted_at TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_gift_items_deleted_at
  ON gift_items(deleted_at);
