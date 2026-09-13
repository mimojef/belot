PRAGMA foreign_keys = ON;

-- Registration anti-evasion: IP + ACTIVE moderation secondary signal
-- (production security fix follow-up briefовете §1/§2, финализирано в петия
-- follow-up brief с 48h recency изискване). Query pattern (виж
-- findFirstActivelyModeratedProfileIdForIp в siteVisitStore.ts, ползвана от
-- checkRegistrationModerationRestriction в index.ts):
--
--   SELECT DISTINCT sve.profile_id
--   FROM site_visit_events sve
--   WHERE sve.ip_address = ?
--     AND sve.profile_id IS NOT NULL
--     AND sve.occurred_at >= datetime('now', '-48 hours')
--     AND (EXISTS (active ban за sve.profile_id) OR EXISTS (active mute за sve.profile_id))
--   LIMIT 1;
--
-- Колонен ред (ip_address, occurred_at, profile_id) — НЕ (ip_address,
-- profile_id), защото заявката вече филтрира и по occurred_at (48h recency
-- прозорец, пети follow-up brief) — SQLite може да seek-не directno до
-- ip_address префикса, после да сканира само диапазона occurred_at >=
-- cutoff (типично малка "опашка" от най-новите редове на този IP, не
-- цялата история), и да прочете profile_id directно от index-а (covering,
-- без table lookback). Стар ред (occurred_at по-стар от 48h) никога не се
-- разглежда — самият range seek го изключва, не application-level филтър.
--
-- Mirror на established idx_site_visit_events_visitor_time (anonymous_
-- visitor_id, occurred_at) pattern-а от 20260625_002_create_site_visits.sql
-- — same rationale (equality колона first, после range/covering).
--
-- Тази миграция (20260913_002) е редактирана in-place вместо да се добавя
-- нова — файлът никога не е бил commit-нат/deploy-нат production, затова
-- няма нужда от отделна "alter index" стъпка.
CREATE INDEX IF NOT EXISTS idx_site_visit_events_ip_profile
  ON site_visit_events(ip_address, occurred_at, profile_id);
