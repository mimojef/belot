PRAGMA foreign_keys = ON;

-- Registration anti-evasion: hard-delete evasion fix, mute case (четвърти
-- follow-up brief §1). profile_bans вече преживява hard delete чрез
-- deleted_profile_id_snapshot (20260902_002/003), но topic_section_mutes/
-- topic_mute_evidence са ON DELETE CASCADE БЕЗ snapshot колона — активен
-- Topics/Лафче mute изчезва напълно при hard delete, което позволяваше
-- същото устройство/IP да се регистрира отново веднага (потвърден bypass).
--
-- Умишлено НОВА, малка, dedicated таблица — НЕ ALTER на topic_section_mutes/
-- topic_mute_evidence (нулев diff риск за самата mute apply/remove логика,
-- нула промяна в mute semantics/FK-та им, точно както изисква брифа: "Не
-- променяй semantics на самата mute система"). Mirror на established
-- admin_profile_deletion_visitor_snapshots pattern-а (20260902_003) —
-- forensic snapshot, populated ЕДИНСТВЕНО в момента на hard delete
-- (profileHardDeleteService.ts), никога FK-driven cascade/trigger.
--
-- PRIMARY KEY(deleted_profile_id) — най-много ЕДИН ред на изтрит профил
-- (снапва се само IF профилът реално е имал активен mute в момента на
-- delete-а; clean/вече-неактивен mute не създава ред тук изобщо — hard
-- delete на clean-откъм-Topics профил продължава легитимно да освобождава
-- device/IP-то, непроменена продуктова логика). active_topics_mute_until
-- пази ТОЧНО оригиналната muted_until стойност от topic_section_mutes в
-- момента на снапването — registration guard-ът я сравнява срещу
-- CURRENT_TIMESTAMP at read time (същия pattern като getActiveBan/
-- isProfileMutedInTopicsSection), затова restriction-ът автоматично спира
-- да важи СЛЕД оригиналния muted_until — не се превръща в permanent block.
CREATE TABLE IF NOT EXISTS admin_profile_deletion_moderation_snapshots (
  deleted_profile_id TEXT PRIMARY KEY,
  active_topics_mute_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
