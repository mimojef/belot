PRAGMA foreign_keys = ON;

-- "Лафче" — постоянен system поток вътре в Topics (Вариант A от inspection
-- брифа: reuse на съществуващата topics/topic_messages инфраструктура,
-- НЕ нова таблица). Idempotent seed, mirror на topic-general seed-а в
-- 20260810_002_create_topics_and_messages.sql (fixed topic_id, ON
-- CONFLICT(slug) DO NOTHING — restart-safe, не генерира дубликат).
--
-- is_general = 0 нарочно — is_general носи специфична unread/seen
-- семантика (General thread-total computation, exempt от нормалното
-- markTopicSeenForActiveProfile при subscribe, виж index.ts), която НЕ
-- бива да наследи "Лафче". "Лафче" се идентифицира по slug='lafche' /
-- fixed topic_id='topic-lafche' навсякъде в кода, не по нов boolean флаг.
INSERT INTO topics (
  topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order
) VALUES (
  'topic-lafche', 'lafche', 'Лафче', 'Свободен realtime поток за VIP потребители.', 0, NULL, 'active', -1
) ON CONFLICT(slug) DO NOTHING;
