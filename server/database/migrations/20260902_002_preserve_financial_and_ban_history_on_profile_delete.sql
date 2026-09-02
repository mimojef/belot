-- MANUAL_TRANSACTION_MIGRATION
-- Blocker fix (admin hard-delete брифа §2): DELETE FROM profiles каскадно
-- заличаваше financial/ban history, която трябва да преживее hard delete
-- (spec: "financial/gift ledger/audit history... historical game/match
-- records... ban history"). SQLite не позволява ALTER на FK ON DELETE
-- поведение in-place — всяка таблица по-долу се rebuild-ва (DROP+RENAME),
-- established pattern (20260630_001_fix_gift_ledger_cascade.sql,
-- 20260802_002_add_top_chat_admin_role.sql).
--
-- Всяка CREATE TABLE _new по-долу е ТОЧНО verbatim копие на текущата live
-- schema (извлечена през sqlite_master.sql на реалната база, не
-- reconstruct-вана на ръка от историята на migration файловете — по-ранен
-- draft на този migration пропусна по-късно добавени колони като
-- is_guest_trial/recipient_limit_exempt/stripe_* и щеше тихо да ги
-- изгуби), с изменения: съответната profile_id(-подобна) колона минава от
-- NOT NULL → NULL и нейният FK от ON DELETE CASCADE → ON DELETE SET NULL,
-- ПЛЮС нова deleted_*_profile_id_snapshot колона БЕЗ FK за immutable
-- attribution (round 2 корекция — "row survives" не е достатъчно без "и
-- знаем чий беше редът", виж коментара при profile_bans/
-- admin_profile_deletions по-долу и profileHardDeleteService.ts). Всички
-- други колони/CHECK/UNIQUE/index-и са запазени byte-for-byte.
-- yellow_coin_gift_ledger получава ДВЕ snapshot колони (sender + recipient)
-- — target профилът може да бъде изтрит откъм всяка от двете страни на
-- подарък-транзакция, независимо една от друга.
--
-- Класификация (виж brief-а):
--   A) Live/operational profile-owned state — правилно е да cascade-не
--      (НЕ се пипа тук): profile_wallets, profile_progress, profile_gallery_images,
--      account_sessions, profile_friendships, friend_chat_messages,
--      lobby_chat_messages, vip_status, player_mission_progress,
--      player_daily_reward_claims, topics/topic_messages съдържание,
--      profile_partner_ratings, round_capot/contra_mission_ledger (чисти
--      idempotency guard-ове, не финансова/forensic история),
--      tournament_entries/tournaments.creator_profile_id (live tournament
--      machinery с NOT NULL composite UNIQUE constraints и extensive
--      бизнес логика, зависима от non-null profile_id — disproportionate
--      blast radius за rebuild в обхвата на тази задача; турнирната
--      ФИНАНСОВА история вече е защитена през tournament_economy_ledger/
--      tournament_events, които СА SET NULL от самото начало, виж
--      20260730_002).
--   B) Historical / financial / moderation / forensic state — ТРЯБВА да
--      преживее delete (пипнато тук): profile_bans, yellow_coin_gift_ledger,
--      match_economy_ledger, coin_purchase_ledger, profile_name_change_ledger,
--      vip_grants, vip_purchase_ledger, table_exit_penalties,
--      profile_match_results (историческите game резултати).
--
-- Вече коректно SET NULL, НЕ се пипат тук: site_visit_events.profile_id,
-- site_visitors.first/last_profile_id, admin_role_audit_log.*_account_id,
-- topic_moderation_audit_log.target_profile_id,
-- topic_message_deletion_audit_log.sender_profile_id,
-- topics.created_by_profile_id, tournament_economy_ledger.profile_id,
-- tournament_events.actor_profile_id, ad_campaign_*.* profile audit
-- полета, admin_profile_deletions (няма FK въобще).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- ─── profile_bans ────────────────────────────────────────────────────────
CREATE TABLE profile_bans_new (
  ban_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  banned_until TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    trim(reason) <> ''
  ),
  banned_by_profile_id TEXT NULL,
  lifted_at TEXT NULL,
  lifted_by_profile_id TEXT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (banned_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (lifted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO profile_bans_new SELECT * FROM profile_bans;

DROP TABLE profile_bans;
ALTER TABLE profile_bans_new RENAME TO profile_bans;

CREATE INDEX idx_profile_bans_profile_active
  ON profile_bans(profile_id, lifted_at, banned_until);

-- ─── yellow_coin_gift_ledger ─────────────────────────────────────────────
CREATE TABLE yellow_coin_gift_ledger_new (
  gift_id TEXT PRIMARY KEY,
  friendship_id TEXT NULL,
  sender_profile_id TEXT NULL,
  deleted_sender_profile_id_snapshot TEXT NULL,
  recipient_profile_id TEXT NULL,
  deleted_recipient_profile_id_snapshot TEXT NULL,
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  sender_balance_after INTEGER NOT NULL CHECK (
    sender_balance_after >= 0
  ),
  recipient_balance_after INTEGER NOT NULL CHECK (
    recipient_balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, recipient_limit_exempt INTEGER NOT NULL DEFAULT 0 CHECK (
    recipient_limit_exempt IN (0, 1)
  ),
  FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE SET NULL,
  FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO yellow_coin_gift_ledger_new (
  gift_id, friendship_id, sender_profile_id, recipient_profile_id,
  amount, sender_balance_after, recipient_balance_after, created_at,
  recipient_limit_exempt
)
SELECT
  gift_id, friendship_id, sender_profile_id, recipient_profile_id,
  amount, sender_balance_after, recipient_balance_after, created_at,
  recipient_limit_exempt
FROM yellow_coin_gift_ledger;

DROP TABLE yellow_coin_gift_ledger;
ALTER TABLE yellow_coin_gift_ledger_new RENAME TO yellow_coin_gift_ledger;

CREATE INDEX idx_yellow_coin_gift_ledger_sender
  ON yellow_coin_gift_ledger(sender_profile_id, created_at);
CREATE INDEX idx_yellow_coin_gift_ledger_recipient
  ON yellow_coin_gift_ledger(recipient_profile_id, created_at);
CREATE INDEX idx_yellow_coin_gift_ledger_friendship
  ON yellow_coin_gift_ledger(friendship_id, created_at);
CREATE INDEX idx_yellow_coin_gift_ledger_deleted_sender_snapshot
  ON yellow_coin_gift_ledger(deleted_sender_profile_id_snapshot);
CREATE INDEX idx_yellow_coin_gift_ledger_deleted_recipient_snapshot
  ON yellow_coin_gift_ledger(deleted_recipient_profile_id_snapshot);

-- ─── match_economy_ledger ────────────────────────────────────────────────
CREATE TABLE match_economy_ledger_new (
  ledger_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('stake_debit', 'stake_refund', 'winner_payout')
  ),
  amount INTEGER NOT NULL CHECK (
    amount > 0
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  UNIQUE (room_id, profile_id, entry_type)
);

INSERT INTO match_economy_ledger_new (
  ledger_id, room_id, profile_id, entry_type, amount, balance_after, created_at
)
SELECT
  ledger_id, room_id, profile_id, entry_type, amount, balance_after, created_at
FROM match_economy_ledger;

DROP TABLE match_economy_ledger;
ALTER TABLE match_economy_ledger_new RENAME TO match_economy_ledger;

CREATE INDEX idx_match_economy_ledger_profile_id
  ON match_economy_ledger(profile_id, created_at);
CREATE INDEX idx_match_economy_ledger_room_id
  ON match_economy_ledger(room_id, created_at);
CREATE INDEX idx_match_economy_ledger_deleted_profile_snapshot
  ON match_economy_ledger(deleted_profile_id_snapshot);

-- ─── coin_purchase_ledger ────────────────────────────────────────────────
CREATE TABLE coin_purchase_ledger_new (
  purchase_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  package_id TEXT,
  package_key_snapshot TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  yellow_coins_amount INTEGER NOT NULL CHECK (
    yellow_coins_amount > 0
  ),
  price_cents INTEGER NOT NULL CHECK (
    price_cents >= 0
  ),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'canceled', 'failed')
  ),
  credited_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, hidden_at TEXT, stripe_payment_intent_id TEXT, stripe_charge_id TEXT, payment_method_type TEXT, wallet_type TEXT, card_brand TEXT, card_last4 TEXT, card_country TEXT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (package_id) REFERENCES coin_packages(package_id) ON DELETE SET NULL
);

INSERT INTO coin_purchase_ledger_new (
  purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
  yellow_coins_amount, price_cents, currency, provider,
  provider_checkout_session_id, status, credited_at, created_at, updated_at,
  hidden_at, stripe_payment_intent_id, stripe_charge_id, payment_method_type,
  wallet_type, card_brand, card_last4, card_country
)
SELECT
  purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
  yellow_coins_amount, price_cents, currency, provider,
  provider_checkout_session_id, status, credited_at, created_at, updated_at,
  hidden_at, stripe_payment_intent_id, stripe_charge_id, payment_method_type,
  wallet_type, card_brand, card_last4, card_country
FROM coin_purchase_ledger;

DROP TABLE coin_purchase_ledger;
ALTER TABLE coin_purchase_ledger_new RENAME TO coin_purchase_ledger;

CREATE INDEX idx_coin_purchase_ledger_profile
  ON coin_purchase_ledger(profile_id, created_at);
CREATE INDEX idx_coin_purchase_ledger_status
  ON coin_purchase_ledger(status, created_at);
CREATE UNIQUE INDEX idx_coin_purchase_ledger_pending_package
  ON coin_purchase_ledger(profile_id, package_id, status)
  WHERE status = 'pending'
    AND package_id IS NOT NULL
    AND hidden_at IS NULL;
CREATE INDEX idx_coin_purchase_ledger_deleted_profile_snapshot
  ON coin_purchase_ledger(deleted_profile_id_snapshot);

-- ─── profile_name_change_ledger ──────────────────────────────────────────
CREATE TABLE profile_name_change_ledger_new (
  change_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  old_display_name TEXT NOT NULL,
  new_display_name TEXT NOT NULL,
  price_amount INTEGER NOT NULL CHECK (
    price_amount >= 0
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO profile_name_change_ledger_new (
  change_id, profile_id, old_display_name, new_display_name,
  price_amount, balance_after, created_at
)
SELECT
  change_id, profile_id, old_display_name, new_display_name,
  price_amount, balance_after, created_at
FROM profile_name_change_ledger;

DROP TABLE profile_name_change_ledger;
ALTER TABLE profile_name_change_ledger_new RENAME TO profile_name_change_ledger;

CREATE INDEX idx_profile_name_change_ledger_profile_id
  ON profile_name_change_ledger(profile_id, created_at);
CREATE INDEX idx_profile_name_change_ledger_deleted_profile_snapshot
  ON profile_name_change_ledger(deleted_profile_id_snapshot);

-- ─── vip_grants ───────────────────────────────────────────────────────────
CREATE TABLE vip_grants_new (
  grant_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('launch_gift', 'purchase', 'admin_grant')
  ),
  interval_unit TEXT NOT NULL CHECK (
    interval_unit IN ('days', 'months', 'years')
  ),
  interval_amount INTEGER NOT NULL CHECK (
    interval_amount > 0
  ),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, granted_by_profile_id TEXT NULL
  REFERENCES profiles(profile_id) ON DELETE SET NULL, resulting_active_until TEXT NULL, purchase_id TEXT NULL
  REFERENCES vip_purchase_ledger(purchase_id) ON DELETE SET NULL, amount_paid_cents INTEGER NULL, currency TEXT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO vip_grants_new (
  grant_id, profile_id, reason, interval_unit, interval_amount,
  granted_at, granted_by_profile_id, resulting_active_until, purchase_id,
  amount_paid_cents, currency
)
SELECT
  grant_id, profile_id, reason, interval_unit, interval_amount,
  granted_at, granted_by_profile_id, resulting_active_until, purchase_id,
  amount_paid_cents, currency
FROM vip_grants;

DROP TABLE vip_grants;
ALTER TABLE vip_grants_new RENAME TO vip_grants;

CREATE INDEX idx_vip_grants_profile
  ON vip_grants(profile_id, granted_at);
CREATE UNIQUE INDEX idx_vip_grants_launch_gift_once
  ON vip_grants(profile_id)
  WHERE reason = 'launch_gift';
CREATE UNIQUE INDEX idx_vip_grants_purchase_id_once
  ON vip_grants(purchase_id)
  WHERE reason = 'purchase' AND purchase_id IS NOT NULL;
CREATE INDEX idx_vip_grants_deleted_profile_snapshot
  ON vip_grants(deleted_profile_id_snapshot);

-- ─── vip_purchase_ledger ──────────────────────────────────────────────────
CREATE TABLE vip_purchase_ledger_new (
  purchase_id TEXT PRIMARY KEY,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  package_id TEXT NOT NULL CHECK (
    package_id IN ('vip_30', 'vip_180', 'vip_365')
  ),
  days_snapshot INTEGER NOT NULL CHECK (
    days_snapshot > 0
  ),
  price_cents_snapshot INTEGER NOT NULL CHECK (
    price_cents_snapshot >= 0
  ),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'canceled', 'failed')
  ),
  credited_at TEXT,
  vip_grant_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, stripe_payment_intent_id TEXT, stripe_charge_id TEXT, payment_method_type TEXT, wallet_type TEXT, card_brand TEXT, card_last4 TEXT, card_country TEXT,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL
);

INSERT INTO vip_purchase_ledger_new (
  purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot,
  currency, provider, provider_checkout_session_id, status, credited_at,
  vip_grant_id, created_at, updated_at, stripe_payment_intent_id,
  stripe_charge_id, payment_method_type, wallet_type, card_brand,
  card_last4, card_country
)
SELECT
  purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot,
  currency, provider, provider_checkout_session_id, status, credited_at,
  vip_grant_id, created_at, updated_at, stripe_payment_intent_id,
  stripe_charge_id, payment_method_type, wallet_type, card_brand,
  card_last4, card_country
FROM vip_purchase_ledger;

DROP TABLE vip_purchase_ledger;
ALTER TABLE vip_purchase_ledger_new RENAME TO vip_purchase_ledger;

CREATE INDEX idx_vip_purchase_ledger_profile
  ON vip_purchase_ledger(profile_id, created_at);
CREATE INDEX idx_vip_purchase_ledger_status
  ON vip_purchase_ledger(status, created_at);
CREATE UNIQUE INDEX idx_vip_purchase_ledger_pending_package
  ON vip_purchase_ledger(profile_id, package_id, status)
  WHERE status = 'pending';
CREATE INDEX idx_vip_purchase_ledger_deleted_profile_snapshot
  ON vip_purchase_ledger(deleted_profile_id_snapshot);

-- ─── table_exit_penalties ─────────────────────────────────────────────────
CREATE TABLE table_exit_penalties_new (
  penalty_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  stake_amount INTEGER NOT NULL CHECK (
    stake_amount > 0
  ),
  penalty_amount INTEGER NOT NULL CHECK (
    penalty_amount > 0
  ),
  charged_amount INTEGER NOT NULL CHECK (
    charged_amount >= 0
    AND charged_amount <= penalty_amount
  ),
  balance_after INTEGER NOT NULL CHECK (
    balance_after >= 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  UNIQUE (room_id, profile_id)
);

INSERT INTO table_exit_penalties_new (
  penalty_id, room_id, profile_id, stake_amount, penalty_amount,
  charged_amount, balance_after, created_at
)
SELECT
  penalty_id, room_id, profile_id, stake_amount, penalty_amount,
  charged_amount, balance_after, created_at
FROM table_exit_penalties;

DROP TABLE table_exit_penalties;
ALTER TABLE table_exit_penalties_new RENAME TO table_exit_penalties;

CREATE INDEX idx_table_exit_penalties_profile_id
  ON table_exit_penalties(profile_id, created_at);
CREATE INDEX idx_table_exit_penalties_room_id
  ON table_exit_penalties(room_id, created_at);
CREATE INDEX idx_table_exit_penalties_deleted_profile_snapshot
  ON table_exit_penalties(deleted_profile_id_snapshot);

-- ─── profile_match_results ────────────────────────────────────────────────
-- profile_id остава част от PRIMARY KEY (room_id, profile_id) — SQLite
-- третира NULL в PK колона по стандартна SQL NULL семантика (NULL никога не
-- се счита за дублиращ друг NULL при UNIQUE/PK проверка), затова множество
-- изтрити профили в различни (или дори СЪЩИТЕ) стаи не колидират.
CREATE TABLE profile_match_results_new (
  room_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  team TEXT NOT NULL CHECK (
    team IN ('A', 'B')
  ),
  did_win INTEGER NOT NULL CHECK (
    did_win IN (0, 1)
  ),
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_guest_trial INTEGER NOT NULL DEFAULT 0
  CHECK (is_guest_trial IN (0, 1)),
  PRIMARY KEY (room_id, profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

INSERT INTO profile_match_results_new (
  room_id, profile_id, team, did_win, completed_at, is_guest_trial
)
SELECT
  room_id, profile_id, team, did_win, completed_at, is_guest_trial
FROM profile_match_results;

DROP TABLE profile_match_results;
ALTER TABLE profile_match_results_new RENAME TO profile_match_results;

CREATE INDEX idx_profile_match_results_profile_id
  ON profile_match_results(profile_id, completed_at);
CREATE INDEX idx_profile_match_results_trial_completed_at
  ON profile_match_results(is_guest_trial, completed_at);
CREATE INDEX idx_profile_match_results_deleted_profile_snapshot
  ON profile_match_results(deleted_profile_id_snapshot);

CREATE TABLE IF NOT EXISTS server_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO server_migrations (filename)
  VALUES ('20260902_002_preserve_financial_and_ban_history_on_profile_delete.sql');

COMMIT;

PRAGMA foreign_keys = ON;
