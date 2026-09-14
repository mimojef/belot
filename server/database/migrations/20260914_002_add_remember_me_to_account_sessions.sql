PRAGMA foreign_keys = ON;

-- Remember-me семантика (viz production report-а "REMEMBER ME — SERVER
-- SEMANTICS"): remember_me=1 -> persistent auth cookie (Max-Age=90 дни,
-- rolling renewal, виж authStore.ts's touchSession()); remember_me=0 ->
-- browser session-only cookie (без Max-Age/Expires), докато server-side
-- expires_at/revocation механизмът остава напълно непроменен и за двата
-- типа (виж createSessionCookieHeader() doc коментара за защо cookie shape-ът,
-- не server-side TTL логиката, е единствената реална разлика).
--
-- DEFAULT 1 за НОВИ редове И за СЪЩЕСТВУВАЩИТЕ production сесии (SQLite
-- ADD COLUMN ... DEFAULT прилага константата към всички съществуващи редове
-- без table rewrite) — запазва точно досегашното persistent поведение за
-- вече логнати потребители, без нужда от email_verified_at или друга
-- ретроактивна класификация (production report-а "ВАЖНО ЗА EXISTING
-- ACCOUNTS": legacy сесиите просто продължават да са "remembered").
ALTER TABLE account_sessions ADD COLUMN remember_me INTEGER NOT NULL DEFAULT 1;
