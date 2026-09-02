-- Fix за production QA bug: profile Y, открит само като indirect linked
-- partner при анализа на target X, се upsert-ваше с грубо/частично
-- linked_profiles_count (виж computeAndUpsert в adminProfileRiskStore.ts).
-- Понеже редът вече съществуваше, list-view memoization-ът (getCachedChecks)
-- го третираше като "вече проверен" и никога не му правеше собствен full
-- analysis — Y оставаше завинаги с частичен count.
--
-- check_complete прави разликата explicit в persistence модела:
--   1 = директен/пълен анализ (target на computeAndUpsert) — точен
--       linked_profiles_count, memoize-ва се нормално.
--   0 = само indirect partner upsert — risk_detected е сигурен, но
--       linked_profiles_count НЕ е точен и такъв ред трябва да бъде
--       третиран като "unchecked" при следващ list fetch (за да получи
--       собствен full analysis).
ALTER TABLE admin_profile_risk_checks
  ADD COLUMN check_complete INTEGER NOT NULL DEFAULT 1 CHECK (check_complete IN (0, 1));

-- Production вече съдържа стари cache rows от ПРЕДИ тази колона съществуваше
-- (вкл. partial indirect counts). ADD COLUMN сам по себе си би ги маркирал
-- check_complete=1 (DEFAULT), което би ги считало за точни завинаги — те
-- никога няма да self-heal-нат. Затова еднократно invalidate-ваме ВСИЧКИ
-- съществуващи редове тук — НЕ прави global recomputation в migration-а
-- самия, само маркира incomplete. Съществуващият lazy list flow
-- (computeAndCacheRiskForProfiles) after this recompute-ва всеки ред
-- единствено когато реално попадне в Днес/Вчера/текущата страница от
-- Всички — bounded behavior-ът се запазва непроменен.
UPDATE admin_profile_risk_checks SET check_complete = 0;
