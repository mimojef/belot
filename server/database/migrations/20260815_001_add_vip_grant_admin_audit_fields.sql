PRAGMA foreign_keys = ON;

-- Админско "Дай VIP" в чужд профил (само role='admin') изисква audit trail:
-- кой admin е дал VIP + какъв active_until е произвел точно този grant.
-- granted_by_profile_id е NULL за launch_gift/purchase (self-service, няма
-- admin actor) — само admin_grant редовете го попълват.
ALTER TABLE vip_grants ADD COLUMN granted_by_profile_id TEXT NULL
  REFERENCES profiles(profile_id) ON DELETE SET NULL;

-- Резултатният active_until се пази директно на всеки grant ред, вместо да
-- се reconstruct-ва по-късно чрез replay на историята (крехко — vip_status
-- се презаписва при всеки следващ grant).
ALTER TABLE vip_grants ADD COLUMN resulting_active_until TEXT NULL;
