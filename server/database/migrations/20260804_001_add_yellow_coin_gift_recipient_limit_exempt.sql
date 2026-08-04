ALTER TABLE yellow_coin_gift_ledger
  ADD COLUMN recipient_limit_exempt INTEGER NOT NULL DEFAULT 0 CHECK (
    recipient_limit_exempt IN (0, 1)
  );
