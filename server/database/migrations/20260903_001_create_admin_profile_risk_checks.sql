-- Bounded cache за "risk detector" фийчъра (admin-only) — засича профили,
-- които споделят anonymous_visitor_id в site_visit_events (напр. multi-
-- account злоупотреба). НЕ дублира/копира site_visit_events данни — само
-- ЕДИН малък summary ред на профил: последен резултат от проверката.
--
-- Умишлено НЕ е forensic history таблица — при повторна проверка редът се
-- презаписва (UPSERT), няма history/audit trail тук. checked_at показва
-- само кога последно е computed резултатът.
--
-- profile_id е PRIMARY KEY (не отделен surrogate id — не ни трябва повече
-- от 1 ред на профил). ON DELETE CASCADE — при hard delete на профил
-- (виж profileHardDeleteService) cache редът автоматично изчезва, не остава
-- orphan.
CREATE TABLE IF NOT EXISTS admin_profile_risk_checks (
  profile_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  risk_detected INTEGER NOT NULL DEFAULT 0 CHECK (risk_detected IN (0, 1)),
  linked_profiles_count INTEGER NOT NULL DEFAULT 0 CHECK (linked_profiles_count >= 0),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
