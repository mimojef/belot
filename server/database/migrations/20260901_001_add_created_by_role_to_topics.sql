PRAGMA foreign_keys = ON;

-- Immutable snapshot на автора-ролята В МОМЕНТА НА СЪЗДАВАНЕ на нормална
-- "Тема" — mirror на established `topic_messages.sender_role` конвенцията
-- (captured веднъж, при insert, никога derived от текуща роля при read).
-- Ползва се ИЗКЛЮЧИТЕЛНО за 72-часовия auto-delete exemption guard
-- (findInactivityCandidates в topicHardDeleteService.ts) — теми, създадени
-- от admin/subadmin/chat_admin/top_chat_admin/pika_team в момента на
-- създаването, никога не влизат в inactivity victim set-а, дори ако
-- авторът по-късно бъде демотиран; обратно, promoted-later автор на стара
-- 'player' тема НЕ прави темата ретроактивно exempt — стойността се пише
-- само веднъж, при INSERT, никога UPDATE-ва се.
--
-- NULLABLE, без backfill за съществуващи редове (по конструкция — ролята
-- към момента на историческо създаване не е persisted никъде другаде в
-- схемата, значи не може да бъде доказано reconstruct-ната; backfill от
-- ТЕКУЩАТА роля на автора би нарушил точно семантиката "роля-в-момента-на-
-- създаване", която целим). NULL се третира от exemption предиката
-- (isTopicAutoDeleteExemptByAuthorRole) като "не е доказано privileged" ⇒
-- НЕ exempt — най-консервативният детерминистичен избор: legacy теми
-- продължават да следват точно същото 72h поведение, каквото са имали
-- преди тази миграция. topic-general/topic-lafche са seed-нати directno в
-- SQL (created_by_profile_id=NULL) и никога не минават през нормалния
-- create-topic path — остават NULL тук, без ефект (вече са изключени от
-- cleanup query-то по is_general/topic_id литерал, независимо от тази
-- колона).
ALTER TABLE topics ADD COLUMN created_by_role TEXT NULL
  CHECK (
    created_by_role IS NULL
    OR created_by_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'subadmin', 'admin')
  );
