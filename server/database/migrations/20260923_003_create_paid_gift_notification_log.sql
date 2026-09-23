PRAGMA foreign_keys = ON;

-- "Подари авоари" (Paid Gift Shop) — durable recipient notification log за
-- успешно fulfilled gift покупки (coin/VIP/bundle). Mirror на established
-- yellow_coin_gift_ledger.gift_notification_log pattern (proста таблица,
-- natural PK за idempotency, read_at за ACK semantics) — reuse-ва СЪЩИЯ
-- архитектурен подход, НЕ нова паралелна notification система.
--
-- КРИТИЧНА разлика от established gift_notification_log/
-- gift_item_delivery_log: ТУК INSERT-ът трябва да се случи ВЪТРЕ в
-- fulfillment транзакцията на съответния purchase store (coin/VIP/bundle
-- fulfillByInternalRow, BEGIN...COMMIT), не extern след COMMIT — за да
-- гарантира invariant-а "reward committed <=> notification created"
-- (review Round 3 §5). Затова таблицата живее в СПОДЕЛЕНИЯ physical DB
-- файл (всички покупателни store-ове сочат към ЕДИН databaseFilePath,
-- отделни connections), дефинирана ЕДНАЖ чрез migration тук — mirror на
-- vip_grants/vip_status established pattern (shared schema, множество
-- store connections към същия файл), не дублирана CREATE TABLE в три
-- отделни store файла.
--
-- purchase_id + purchase_type композитен natural PK — идентична idempotency
-- гаранция като established gift_notification_log.gift_id PK: duplicate
-- INSERT (втори webhook опит за СЪЩАТА покупка) е INSERT OR IGNORE no-op,
-- никога втори notification ред.
--
-- Всички display полета са IMMUTABLE SNAPSHOT-и, записани в МОМЕНТА на
-- fulfillment — по-късна промяна на recipient/sender display name, Shop
-- package title, или каталожна конфигурация НЕ променя историческото
-- съобщение (review §4 explicit изискване). body_text е ПЪЛНИЯТ,
-- server-composed краен текст (не отделни полета за coins/days/title,
-- сглобявани client-side) — избягва дублиране на pluralization/formatting
-- логика между сървър и клиент, и прави съобщението архитектурно
-- future-proof за нови продукти (bundle-и с различна композиция).
CREATE TABLE IF NOT EXISTS paid_gift_notification_log (
  purchase_id TEXT NOT NULL,
  purchase_type TEXT NOT NULL CHECK (purchase_type IN ('coin', 'vip', 'bundle')),
  recipient_profile_id TEXT NOT NULL,
  sender_display_name_snapshot TEXT NOT NULL,
  body_text TEXT NOT NULL,
  read_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (purchase_id, purchase_type)
);

-- Recipient bootstrap fetch (WS connect/reconnect, mirror на established
-- selectPendingGiftNotificationsStatement/selectPendingDeliveriesStatement
-- pattern) — unread-only, FIFO по created_at, rowid tie-break за
-- deterministic ред при identичен secondна-прецизност timestamp (mirror на
-- established gift_item_delivery_log коментар за same сценарий).
CREATE INDEX IF NOT EXISTS idx_paid_gift_notification_log_recipient_unread
  ON paid_gift_notification_log(recipient_profile_id, read_at, created_at);
