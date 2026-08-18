PRAGMA foreign_keys = ON;

-- Lafche 200-post hard retention hotfix (production root-cause audit-а:
-- unbounded scroll-triggered "load older" доведе до 900+ Lafche root nodes
-- в client DOM) изисква source Lafche root постове да могат да бъдат
-- HARD-deleted веднага щом излязат извън canonical newest-200 прозореца —
-- дори когато служат за section-wide mute evidence.
--
-- topic_mute_evidence.source_body_snapshot/source_created_at/etc. (виж
-- 20260817_003_create_topic_mute_evidence.sql) вече правят TEXT evidence
-- изцяло self-contained (source_message_id е ON DELETE SET NULL, не CASCADE)
-- — за тях НЕ е нужна нова колона.
--
-- source_attachment_storage_filename обаче досега директно реферира СЪЩИЯ
-- физически файл, който normal Lafche attachment cleanup flow-ът (виж
-- topic_message_attachment_deletions/enqueueAttachmentDeletion) също
-- enqueue-ва за физическо изтриване при source message delete — evidence
-- image става orphan/broken reference, ако не бъде копиран отделно В
-- PROTECTED moderation-only storage, ПРЕДИ retention delete-а.
--
-- Тази колона различава:
--   0 (default) — legacy/normal поведение: source_attachment_storage_filename
--     все още сочи към СПОДЕЛЕНИЯ normal topic-attachment storage (viewer-a
--     на evidence-а минава през нормалния /api/topics/:topicId/attachments/
--     route, точно както днес) — валидно, докато source post-ът е все още
--     жив (в рамките на newest-200 прозореца).
--   1 — Lafche retention вече е копирал файла в dedicated protected evidence
--     storage (server/uploads/topic-mute-evidence-attachments/), ПРЕДИ да
--     hard-delete-не source поста — само тогава evidence viewer-ът трябва да
--     резолвва през новия moderation-only evidence endpoint, не normal
--     topic-attachment route-а (source topic_message_attachments редът вече
--     не съществува дотогава).
--
-- Чисто additive — default 0 запазва съществуващите redove напълно
-- непроменени/backward-compatible (те продължават да сочат normal storage,
-- докато explicit backfill/retention стъпка не ги премести).
ALTER TABLE topic_mute_evidence
  ADD COLUMN source_attachment_is_evidence_copy INTEGER NOT NULL DEFAULT 0;
