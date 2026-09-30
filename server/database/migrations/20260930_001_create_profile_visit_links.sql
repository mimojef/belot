PRAGMA foreign_keys = ON;

-- Компактна дългосрочна история profile <-> anonymous visitor и
-- profile <-> IP (Фаза 1 на site_visit_events retention оптимизацията).
-- По един ред на уникална връзка вместо по един ред на page view — позволява
-- по-късно (Фаза 2) site_visit_events да се пази кратко, без да губим
-- историческите връзки за „Свързани профили“, shared visitor_id/IP и
-- hard-delete forensic проверките.
--
-- Попълване:
--   * dual-write за всеки НОВ site_visit_events ред с non-null profile_id
--     (profileVisitLinks.ts — споделен от siteVisitStore.recordPageView и
--     authStore регистрацията, в СЪЩАТА транзакция като raw event-а);
--   * контролиран, идемпотентен backfill от текущата raw история
--     (scripts/backfillProfileVisitLinks.ts) — НЕ тук: миграцията създава
--     само schema/indexes, за да остане евтина при deploy (без full scan на
--     ~780k raw реда в migration транзакцията).
--
-- УМИШЛЕНО БЕЗ FOREIGN KEY:
--   * profile_id -> profiles: hard delete (profileHardDeleteService) трие реда
--     в profiles; ON DELETE CASCADE би унищожил forensic историята, а
--     ON DELETE SET NULL би я направил безполезна (връзката е самата
--     стойност на profile_id). Profile ids са UUID-и и не се преизползват, а
--     readers, които искат само CURRENT профили, JOIN-ват към profiles
--     (mirror на adminProfileRiskStore.getDetailedLinkedProfiles).
--   * anonymous_visitor_id -> site_visitors: site_visitors се чисти от
--     retention cleanup-а (orphan visitors, siteVisitStore.purgeOlderThanDays);
--     FK с CASCADE би изтрил дългосрочната история заедно с тях.
--
-- Timestamps са в същия формат като site_visit_events.occurred_at
-- (CURRENT_TIMESTAMP, 'YYYY-MM-DD HH:MM:SS' UTC) — копират се от самия raw
-- ред, не от отделен clock.

CREATE TABLE IF NOT EXISTS profile_visitor_links (
  profile_id TEXT NOT NULL,
  anonymous_visitor_id TEXT NOT NULL CHECK (length(anonymous_visitor_id) > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  PRIMARY KEY (profile_id, anonymous_visitor_id)
) WITHOUT ROWID;

-- PK (profile_id, anonymous_visitor_id) покрива lookup по profile_id.
-- Reverse lookup visitor -> profiles (linked profiles, latest evidence);
-- last_seen_at е включен, за да е covering за latest-evidence заявката.
CREATE INDEX IF NOT EXISTS idx_profile_visitor_links_visitor
  ON profile_visitor_links(anonymous_visitor_id, profile_id, last_seen_at);

CREATE TABLE IF NOT EXISTS profile_ip_links (
  profile_id TEXT NOT NULL,
  ip_address TEXT NOT NULL CHECK (length(trim(ip_address)) > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  PRIMARY KEY (profile_id, ip_address)
) WITHOUT ROWID;

-- PK покрива lookup по profile_id. Reverse lookup IP -> profiles.
CREATE INDEX IF NOT EXISTS idx_profile_ip_links_ip
  ON profile_ip_links(ip_address, profile_id);

-- За бъдещ (Фаза 2) retention на compact IP links по давност.
CREATE INDEX IF NOT EXISTS idx_profile_ip_links_last_seen_at
  ON profile_ip_links(last_seen_at);
