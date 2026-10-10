-- Universal theme-campaign system ("Кампании", напр. "Хелоуин 2026" с
-- тематични единици "тикви"). Фаза 0 от одобрения технически план: само
-- схема, нулева бизнес логика — feature остава изцяло изключен чрез
-- CAMPAIGNS_FEATURE_ENABLED (server/src/campaigns/campaignsFeatureFlag.ts),
-- независимо от тази миграция. Всички 13 таблици по-долу са изцяло нови и
-- изолирани — нито една съществуваща таблица не се пипа.
--
-- Дизайн решения (виж одобрения план за пълна обосновка):
--  - Само ЕДНА активна кампания: партиален UNIQUE индекс върху
--    campaigns(status) WHERE status='active' — DB-level гаранция, race-proof
--    дори при конкурентни admin заявки.
--  - Белот и Ludo имат НЕЗАВИСИМИ earn-rules таблици (campaign_earn_rules,
--    дискриминирани по game_kind), ключирани по stake_amount (0 = турнир,
--    без залог) — не споделят redове дори при еднакъв залог.
--  - Праг (campaign_reward_tiers) е отделен от конкретните награди
--    (campaign_tier_rewards) — един праг може да носи N награди
--    (жълтици + VIP + подарък едновременно), и claim-ите
--    (campaign_reward_claims) са на ниво ОТДЕЛНА награда, не ниво праг —
--    частичен провал (2 от 3 награди предоставени) е представим точно,
--    системата никога не може да маркира всички като успешни, ако една е
--    пропусната.
--  - campaign_unit_ledger.event_at (authoritative момент на мача/покупката,
--    отделно от created_at = момент на INSERT) поддържа закъсняло
--    reconciliation начисление да се свърже с ОРИГИНАЛНАТА кампания чрез
--    time-window lookup (event_at BETWEEN starts_at AND ends_at), не с
--    евентуална по-нова "текущо активна" кампания.
--  - campaign_reward_notifications е durable pending/acknowledged ред (не
--    in-memory) — играч offline при момента на награда вижда popup-а на
--    следващото влизане; payload_json е ЗАМРАЗЕН snapshot на точните
--    предоставени награди към момента на създаване.
--  - Профилни FK в historical/ledger-подобни таблици използват
--    ON DELETE SET NULL (не CASCADE) — профилна hard-delete не трябва тихо
--    да заличава кампанийна финансова история, mirror на класификацията от
--    20260902_002_preserve_financial_and_ban_history_on_profile_delete.sql
--    (клас "Historical/financial state — ТРЯБВА да преживее delete").
--    campaign_archive_top10 допълнително пази display_name_at_archive
--    snapshot — архивът остава напълно читаем дори след профилно изтриване.
--  - Всички FK към campaigns(campaign_id) са ON DELETE RESTRICT — физическо
--    изтриване на кампания е архитектурно невъзможно; UI предлага само
--    soft-delete (campaigns.deleted_at), историята оцелява винаги.
--  - Tie-break за Топ 10 (units_total DESC, profile_id ASC при равенство) е
--    чисто query-level решение в бъдещата archiving логика — не изисква
--    допълнителна колона тук.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'scheduled', 'active', 'finished', 'stopped')
  ),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL CHECK (ends_at > starts_at),
  unit_name_singular TEXT NOT NULL CHECK (trim(unit_name_singular) <> ''),
  unit_name_plural TEXT NOT NULL CHECK (trim(unit_name_plural) <> ''),
  unit_icon_url TEXT NULL,
  table_bg_desktop_url TEXT NULL,
  table_bg_mobile_url TEXT NULL,
  card_back_url TEXT NULL,
  -- Избран marketing-профил, подател на автоматичните подарък-награди (виж
  -- §2 от продуктовите решения). Валидацията "профилът ВСЕ ОЩЕ има роля
  -- marketing" е приложна логика в бъдеща фаза (reward-granting), не DB
  -- CHECK (SQLite CHECK не може да реферира друга таблица) — document-нато
  -- тук като контракт за следваща фаза, не забравен detail.
  gift_sender_profile_id TEXT NULL,
  archived_at TEXT NULL,
  deleted_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (gift_sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

-- DB-level гаранция "максимум 1 активна кампания" — независима от всякаква
-- application-level проверка, устойчива на конкурентни admin заявки.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_single_active
  ON campaigns(status) WHERE status = 'active';

-- Поддържа бъдещия "коя кампания покрива event_at" time-window lookup
-- (reconciliation/late-credit resolution, виж коментара по-горе) и overlap
-- validation при create/schedule.
CREATE INDEX IF NOT EXISTS idx_campaigns_window
  ON campaigns(starts_at, ends_at);

-- Поддържа boot-recovery scan "finished/stopped кампании, чакащи archiving".
CREATE INDEX IF NOT EXISTS idx_campaigns_status_archived
  ON campaigns(status, archived_at);

-- Поддържа admin списъка "активни (не-изтрити) кампании по статус".
CREATE INDEX IF NOT EXISTS idx_campaigns_active_list
  ON campaigns(deleted_at, status);

-- === Правила за начисляване: Белот и Ludo НЕЗАВИСИМИ, ключирани по залог ===
CREATE TABLE IF NOT EXISTS campaign_earn_rules (
  campaign_id TEXT NOT NULL,
  game_kind TEXT NOT NULL CHECK (game_kind IN ('belot', 'ludo')),
  stake_amount INTEGER NOT NULL CHECK (stake_amount >= 0),
  units_per_win INTEGER NOT NULL CHECK (units_per_win >= 0),
  PRIMARY KEY (campaign_id, game_kind, stake_amount),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
);

-- === Правила за начисляване: покупки — explicit allowlist по package_key ===
CREATE TABLE IF NOT EXISTS campaign_package_earn_rules (
  campaign_id TEXT NOT NULL,
  package_key TEXT NOT NULL CHECK (trim(package_key) <> ''),
  units_per_purchase INTEGER NOT NULL CHECK (units_per_purchase >= 0),
  PRIMARY KEY (campaign_id, package_key),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
);

-- === Наградни прагове (самò threshold identity) ===
CREATE TABLE IF NOT EXISTS campaign_reward_tiers (
  tier_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  threshold_units INTEGER NOT NULL CHECK (threshold_units > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  UNIQUE (campaign_id, threshold_units)
);

CREATE INDEX IF NOT EXISTS idx_campaign_reward_tiers_campaign_threshold
  ON campaign_reward_tiers(campaign_id, threshold_units);

-- === Отделни награди към един праг (множество награди на праг, т.4) ===
CREATE TABLE IF NOT EXISTS campaign_tier_rewards (
  tier_reward_id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL,
  reward_type TEXT NOT NULL CHECK (
    reward_type IN ('yellow_coins', 'vip_days', 'gift_item')
  ),
  reward_payload_json TEXT NOT NULL CHECK (json_valid(reward_payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tier_id) REFERENCES campaign_reward_tiers(tier_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_campaign_tier_rewards_tier
  ON campaign_tier_rewards(tier_id);

-- === Идемпотентен ledger за начисления (1 ред = 1 начисление) ===
CREATE TABLE IF NOT EXISTS campaign_unit_ledger (
  campaign_id TEXT NOT NULL,
  profile_id TEXT NULL,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('belot_win', 'ludo_win', 'package_purchase', 'admin_adjustment')
  ),
  source_id TEXT NOT NULL CHECK (trim(source_id) <> ''),
  units_amount INTEGER NOT NULL,
  -- Authoritative момент на самото събитие (match-ended / purchase fulfillment),
  -- ОТДЕЛНО от created_at (момент на INSERT, може да е по-късен при
  -- reconciliation backfill) — виж коментара най-отгоре.
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, profile_id, source_type, source_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_unit_ledger_profile
  ON campaign_unit_ledger(profile_id, campaign_id);

CREATE INDEX IF NOT EXISTS idx_campaign_unit_ledger_event_at
  ON campaign_unit_ledger(campaign_id, event_at);

-- === Натрупани тематични единици по профил (lifetime total, т.9 — v1 не се
-- харчи, но полето е именувано като cumulative total, не "spendable balance") ===
CREATE TABLE IF NOT EXISTS campaign_profile_totals (
  campaign_id TEXT NOT NULL,
  profile_id TEXT NULL,
  units_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, profile_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

-- Поддържа Топ 10 заявката (units_total DESC) и бъдещото "активна кампания
-- под Ранг" lookup по профил.
CREATE INDEX IF NOT EXISTS idx_campaign_profile_totals_campaign_units
  ON campaign_profile_totals(campaign_id, units_total DESC);

-- === Предоставени награди — PK на ниво ОТДЕЛНА награда, не ниво праг ===
CREATE TABLE IF NOT EXISTS campaign_reward_claims (
  campaign_id TEXT NOT NULL,
  profile_id TEXT NULL,
  tier_reward_id TEXT NOT NULL,
  -- Свободен reference към реда, създаден от самото предоставяне (бъдеща
  -- фаза) — напр. gift_item_transactions.transaction_id / vip_grants.grant_id.
  -- Не FK (трите възможни target таблици имат различна форма) — чисто
  -- информативно поле за admin trace-ване.
  granted_reward_ref TEXT NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, profile_id, tier_reward_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (tier_reward_id) REFERENCES campaign_tier_rewards(tier_reward_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_campaign_reward_claims_profile
  ON campaign_reward_claims(profile_id, campaign_id);

-- === Durable известия за получена награда (popup pending/acknowledged, т.3) ===
CREATE TABLE IF NOT EXISTS campaign_reward_notifications (
  notification_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  profile_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged')),
  -- Замразен snapshot на точните предоставени награди (суми/имена/изображения/
  -- marketing подател) към момента на предоставяне — popup-ът при следващо
  -- влизане показва точно това, независимо от по-късни промени в каталога.
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TEXT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_reward_notifications_profile_status
  ON campaign_reward_notifications(profile_id, status, created_at);

-- === Административни корекции (audit, т.9 от предходния план) ===
CREATE TABLE IF NOT EXISTS campaign_manual_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  profile_id TEXT NULL,
  units_delta INTEGER NOT NULL CHECK (units_delta <> 0),
  reason TEXT NOT NULL CHECK (trim(reason) <> ''),
  admin_profile_id TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (admin_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_manual_adjustments_profile
  ON campaign_manual_adjustments(campaign_id, profile_id);

-- === Audit trail (domain-scoped event log, mirror на tournament_events) ===
CREATE TABLE IF NOT EXISTS campaign_events (
  event_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (trim(event_type) <> ''),
  actor_profile_id TEXT NULL,
  payload_json TEXT NULL CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign
  ON campaign_events(campaign_id, created_at);

-- === Архив: обобщена статистика (замразена, не се преизчислява) ===
CREATE TABLE IF NOT EXISTS campaign_archive_summary (
  campaign_id TEXT PRIMARY KEY,
  ended_reason TEXT NOT NULL CHECK (ended_reason IN ('expired', 'stopped')),
  participants_count INTEGER NOT NULL CHECK (participants_count >= 0),
  total_units INTEGER NOT NULL,
  units_from_belot INTEGER NOT NULL,
  units_from_ludo INTEGER NOT NULL,
  units_from_purchases INTEGER NOT NULL,
  units_from_admin_adjustments INTEGER NOT NULL,
  rewards_granted_count INTEGER NOT NULL CHECK (rewards_granted_count >= 0),
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
);

-- === Архив: Топ 10 (замразено име + резултат, PK = класиране) ===
CREATE TABLE IF NOT EXISTS campaign_archive_top10 (
  campaign_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  profile_id TEXT NULL,
  -- Замразено показвано име към момента на архивирането — НЕ live JOIN към
  -- profiles.display_name (последващо преименуване не променя архива).
  display_name_at_archive TEXT NOT NULL CHECK (trim(display_name_at_archive) <> ''),
  units_total INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, rank),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_archive_top10_profile
  ON campaign_archive_top10(profile_id);
