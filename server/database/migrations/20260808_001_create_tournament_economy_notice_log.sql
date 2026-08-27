-- Durable delivery log за server-initiated tournament economy известия,
-- започвайки с auto-cancel refund-и поради недостатъчен брой участници
-- (fill-mode timeout / scheduled-start underfilled) — виж
-- tournamentScheduler.ts autoCancelScheduledTournamentAtomically call
-- sites. Огледален pattern на tournament_partner_left_notice_log (и transitively
-- gift_notification_log в yellowCoinGiftStore.ts): realtime WS push
-- (sendToOpenProfileConnections) стига само до online connections; ако
-- получателят е offline в момента на committed auto-cancel, известието
-- трябва да оцелее до следващия login/reconnect.
--
-- Генерична (не partner-left-специфична) таблица, за разлика от
-- tournament_partner_left_notice_log — reason колоната позволява reuse за
-- всеки бъдещ server-initiated economy notice тип (fill_expired,
-- scheduled_underfilled, и т.н.), без нова таблица per reason. Един ред per
-- (tournament_id, recipient_profile_id) auto-cancel event — notice_id е
-- детерминиран от tournament_id+profile_id комбинацията (виж
-- tournamentEconomyStore.ts), гарантирайки exactly-once persistence дори
-- при повторен/паралелен scheduler tick. delivered_at маркира реалната
-- доставка (online push ИЛИ login flush), не insert момента.
CREATE TABLE IF NOT EXISTS tournament_economy_notice_log (
  notice_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  recipient_profile_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('fill_expired', 'scheduled_underfilled')
  ),
  refunded_amount INTEGER NOT NULL,
  delivered_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ten_notice_pending_recipient
  ON tournament_economy_notice_log(recipient_profile_id, created_at)
  WHERE delivered_at IS NULL;
