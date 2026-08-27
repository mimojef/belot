-- Durable delivery log за "партньорът ти се отписа" известието (auto-release
-- след partner leave). Огледален pattern на gift_notification_log
-- (yellowCoinGiftStore.ts) — realtime WS push (sendToOpenProfileConnections)
-- стига само до online connections; ако получателят е offline в момента на
-- committed dissolution, известието трябва да оцелее до следващия
-- login/reconnect. Един ред per auto-release event (notice_id е детерминиран
-- от entry_id-то на освободения член — виж tournamentEconomyStore.ts), delivered_at
-- маркира момента на реална доставка (WS push ИЛИ login flush), а не момента
-- на insert-ване.
CREATE TABLE IF NOT EXISTS tournament_partner_left_notice_log (
  notice_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  refunded_amount INTEGER NOT NULL,
  delivered_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tpl_notice_pending_recipient
  ON tournament_partner_left_notice_log(recipient_profile_id, created_at)
  WHERE delivered_at IS NULL;
