-- „Поддръжка“: вътрешен автор (account_id) на admin съобщенията — основа за
-- изтриването на собствени съобщения от собственическия акаунт
-- (PIKA_OWNER_ACCOUNT_ID). ИЗЦЯЛО вътрешно поле: не се изпраща към
-- потребителския клиент (той вижда само „Екип Pika.bg“).
-- NULL = съобщение на потребителя ИЛИ admin съобщение отпреди тази миграция.
-- Старите admin съобщения се приписват при старт на сървъра
-- (supportStore.backfillLegacyAdminSenders) — само ако PIKA_OWNER_ACCOUNT_ID
-- е валиден admin акаунт, само за редове с NULL автор и само създадени преди
-- прилагането на тази миграция (applied_at в server_migrations).
ALTER TABLE support_messages ADD COLUMN sender_account_id TEXT NULL;
