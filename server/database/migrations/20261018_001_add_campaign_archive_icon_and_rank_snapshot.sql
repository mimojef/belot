PRAGMA foreign_keys = ON;

-- Фаза 11 — минимална адитивна миграция, 2 нови nullable колони, без schema
-- rebuild (прост ADD COLUMN, разрешено от SQLite без пипане на CHECK
-- clause-ове на двете таблици).
--
-- campaign_archive_summary.unit_icon_url_at_archive — Фаза 10 позволява
-- подмяна/премахване на campaigns.unit_icon_url ВИНАГИ (дори след
-- finished/stopped, виж campaignAdminStore.ts::updateThemeAsset), затова
-- жив JOIN към campaigns за архивния изглед НЕ гарантира непроменена
-- историческа визия (задачата §8). Съхранява URL към ОТДЕЛНО, неизменяемо
-- физическо копие на иконата (campaign-themes/<campaignId>/archive/,
-- копирано ЕДНОКРАТНО в момента на archiveCampaign(), виж
-- campaignArchiveStore.ts) — Фаза 10's delete-on-replace логика никога не
-- пипа тоя path (само трие URL-а, който тя самата презаписва в
-- campaigns.unit_icon_url, никога архивното копие). NULL = кампанията
-- никога не е имала иконка към момента на архивиране — безопасен fallback
-- (не показва нищо), не грешка.
ALTER TABLE campaign_archive_summary ADD COLUMN unit_icon_url_at_archive TEXT NULL;

-- campaign_archive_top10.rank_title_at_archive — замразен snapshot на
-- profiles.rank_title към момента на archiveCampaign(), mirror на
-- вече съществуващия display_name_at_archive прецедент в тая таблица
-- (задачата §6: "Замразен ранг на играча, ако е наличен и предвиден в
-- схемата" — profiles.rank_title вече съществува, виж
-- 20260423_001_create_profiles_bot_runtime_tables.sql). НИКОГА live JOIN
-- след архивиране — последваща промяна на реалния ранг на играча не
-- трябва да променя вече замразената класация. NULL = профилът няма
-- зададен rank_title към момента на архивиране (валидно, не грешка).
ALTER TABLE campaign_archive_top10 ADD COLUMN rank_title_at_archive TEXT NULL;
