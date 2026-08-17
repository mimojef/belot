PRAGMA foreign_keys = ON;

-- Append-only evidence/audit история за section-wide Topics mute (виж
-- topic_section_mutes/muteProfileInTopics в topicModerationStore.ts) — ЕДИН
-- ред за ВСЯКА наложена санкция, никога UPDATE-нат освен unmute/status
-- полетата (status/unmuted_at/unmuted_by_account_id/original_message_deleted_at
-- — виж §2 по-долу). topic_moderation_audit_log (20260811_003) вече пази
-- action-level audit (кой/кога/защо/expiry), но НЕ пази source post
-- snapshot — тази таблица допълва, не замества audit log-а (log_id FK-нат
-- за cross-reference, не duplicated fields там).
--
-- ЗАЩО ОТДЕЛНА ТАБЛИЦА (не разширение на topic_moderation_audit_log):
-- audit log-ът е споделен между 5 различни action types (lock/unlock/mute/
-- unmute/delete) с еднообразна тясна shape — добавяне на post-snapshot
-- полета там би замърсило редовете за lock/unlock/delete, които никога не
-- носят source post. Отделна таблица пази audit log-а непроменен (нулев
-- diff риск за съществуващата lock/delete логика) и е query-нат директно
-- по profile_id за user-facing "моята история" изгледа.
--
-- ЗАЩО SNAPSHOT, НЕ САМО message_id REFERENCE: topic_messages поддържа
-- hard-purge 180 дни след soft-delete (purgeDeletedTopicMessagesBefore) —
-- source_message_id самостоятелно не гарантира съдържанието да е четимо
-- по-късно. source_message_id/source_topic_id остават като reference (за
-- cross-check с все още live съобщения), но source_body_snapshot е
-- authoritative "какво е било санкционирано" завинаги.
--
-- ЗАЩО ON DELETE SET NULL (не CASCADE) към topic_messages: hard-purge на
-- оригиналния ред НЕ трябва да трие evidence реда — само FK reference-ът
-- отпада, snapshot полетата остават непокътнати (задачата, §4: "Изтриването
-- ... НЕ трябва да изтрие snapshot текста").
CREATE TABLE IF NOT EXISTS topic_mute_evidence (
  mute_history_id TEXT PRIMARY KEY,
  -- Cross-reference към action-level audit реда (muteProfileInTopics вече
  -- append-ва там в СЪЩАТА транзакция, виж topicModerationStore.ts) — НЕ FK
  -- (audit log-ът няма UNIQUE/PK constraint, годен за referencing извън
  -- log_id-то си, а log_id вече Е PRIMARY KEY там) — TEXT reference само.
  mute_audit_log_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  source_topic_id TEXT NOT NULL,
  source_message_id TEXT REFERENCES topic_messages(message_id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('lafche_post', 'topic_root', 'topic_reply', 'unspecified')),
  source_body_snapshot TEXT NOT NULL DEFAULT '',
  source_attachment_storage_filename TEXT,
  source_attachment_width INTEGER,
  source_attachment_height INTEGER,
  source_created_at TEXT,
  -- Ако source съобщението вече е било soft-deleted В МОМЕНТА на mute-а
  -- (moderator-ът трие поста, после мутва автора) — snapshot-ът пак се взима
  -- от последното известно съдържание в DB (deleted_at не празни body/
  -- attachment колоните, само ги маркира скрити от normal fetch пътищата).
  original_message_deleted_at TEXT,
  muted_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  muted_by_role TEXT NOT NULL CHECK (muted_by_role IN ('admin', 'subadmin', 'pika_team', 'top_chat_admin')),
  reason_text TEXT,
  reason_category TEXT CHECK (
    reason_category IS NULL OR reason_category IN (
      'insults', 'provocation', 'spam', 'inappropriate_content', 'other'
    )
  ),
  duration_ms INTEGER NOT NULL,
  muted_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'manually_unmuted')),
  unmuted_at TEXT,
  unmuted_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User-facing "моята история" (§6/§8: "само собствените си records") —
-- hot path заявка по profile_id, най-нови първо.
CREATE INDEX IF NOT EXISTS idx_topic_mute_evidence_profile
  ON topic_mute_evidence(profile_id, created_at);

-- Admin repeat-offender lookup (§7: "предишните mute history records на
-- същия profile") — покрито от индекса по-горе (profile_id префикс), няма
-- нужда от отделен.

CREATE INDEX IF NOT EXISTS idx_topic_mute_evidence_status
  ON topic_mute_evidence(status);
