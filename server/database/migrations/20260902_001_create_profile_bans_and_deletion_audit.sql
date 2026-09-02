-- Admin moderation: BAN/UNBAN история, отделна от accounts.status/role (спрямо
-- established конвенцията "всяко permission/state си има собствен модел" —
-- виж authStore.ts коментарите за отделните isXSession predicate-и). Активен
-- бан = последният (по created_at) ред за profile_id с lifted_at IS NULL И
-- banned_until > CURRENT_TIMESTAMP — изчислено at query time (виж
-- profileBanStore.ts getActiveBan), няма нужда от cron job за изтичане.
-- Историята НИКОГА не се overwrite-ва/трие — UNBAN пълни lifted_at/
-- lifted_by_profile_id на СЪЩИЯ ред, нов BAN след UNBAN/expiry вмъква НОВ ред.
CREATE TABLE IF NOT EXISTS profile_bans (
  ban_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  banned_until TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    trim(reason) <> ''
  ),
  banned_by_profile_id TEXT NULL,
  lifted_at TEXT NULL,
  lifted_by_profile_id TEXT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (banned_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (lifted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

-- "Активен бан за този профил" lookup (login gate + profile popup) — вика се
-- при всеки login опит, затова индексиран по profile_id + lifted_at, за да
-- остане O(log n) дори с дълга история от изтекли/вдигнати банове.
CREATE INDEX IF NOT EXISTS idx_profile_bans_profile_active
  ON profile_bans(profile_id, lifted_at, banned_until);

-- Admin hard-delete audit trail (spec §9) — ЕДИНСТВЕНИЯТ forensic trail,
-- който преживява физическото изтриване на profiles/accounts redовете.
-- username_snapshot е ЧИСТО за одит/четимост в лога — НЕ пази normalized
-- вариант, НЕ участва в никой UNIQUE constraint, затова старото
-- username/display name остава свободно за нова регистрация веднага след
-- delete-а (spec §9 "audit snapshot НЕ трябва да резервира username").
-- Умишлено БЕЗ email snapshot (spec §9 "не е необходимо да пазиш email").
-- deleted_profile_id/deleted_account_id нямат FK (профилът/акаунтът вече не
-- съществуват след delete-а в СЪЩАТА транзакция) — mirror на
-- topic_moderation_audit_log.topic_id (виж topicHardDeleteService.ts
-- коментара: "audit трябва да преживее soft/hard-delete стъпката").
CREATE TABLE IF NOT EXISTS admin_profile_deletions (
  log_id TEXT PRIMARY KEY,
  deleted_profile_id TEXT NOT NULL,
  deleted_account_id TEXT NULL,
  username_snapshot TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_by_profile_id TEXT NULL,
  reason TEXT NOT NULL CHECK (
    trim(reason) <> ''
  ),
  FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_profile_deletions_deleted_profile
  ON admin_profile_deletions(deleted_profile_id);
