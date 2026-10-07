PRAGMA foreign_keys = ON;

-- Профили от екипа на Pika.bg (account role 'pika_team' и 'marketing') вече
-- не могат да бъдат блокирани. Authoritative guard-ът е в
-- blockStore.toggleBlock (role check + INSERT в една BEGIN IMMEDIATE
-- транзакция; predicate в core/protectedStaffProfiles.ts) — POST
-- /api/profiles/:id/block само превежда резултата в 403
-- PROTECTED_STAFF_PROFILE. Еднократно data cleanup на вече съществуващите
-- INCOMING blocks към такива профили.
--
-- САМО 'pika_team' и 'marketing'. Blocks към 'admin', 'subadmin',
-- 'chat_admin', 'top_chat_admin' и 'player' НЕ се пипат. Outgoing blocks на
-- самите staff профили също не се пипат. Без schema промяна; идемпотентно.
--
-- Бъдещо назначаване на защитена роля трие incoming blocks атомарно в
-- authStore.changeElevatedRole; отнемане на ролята НЕ възстановява редовете.
DELETE FROM player_blocks
WHERE blocked_profile_id IN (
  SELECT profiles.profile_id
  FROM profiles
  INNER JOIN accounts ON accounts.account_id = profiles.account_id
  WHERE accounts.role IN ('pika_team', 'marketing')
);
