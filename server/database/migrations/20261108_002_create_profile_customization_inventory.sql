-- "Персонализация на профила" — инвентар "Моите персонализации" и само 5
-- цвята в продажба.
--
-- Досега profile_customization_active пазеше ЕДНА екстра на вид: покупка на
-- различен вариант я заменяше и оставащите ѝ дни се губеха. Сега:
--   * profile_customization_owned_items — всеки притежаван вариант
--     (профил + вид + артикул) със СОБСТВЕН срок. Сроковете текат календарно,
--     независимо дали артикулът се използва. chain_id групира
--     непрекъснатите покупки на същия вариант (удълженията) — refund
--     преизчислява срока като chain_started_at + сума(дни на платените
--     редове във веригата), без да засяга другите валидни периоди.
--   * profile_customization_equipped — кой притежаван вариант СЕ ИЗПОЛЗВА
--     (най-много един на вид). "Използвай"/"Премахни" пипат само този ред:
--     правата и сроковете не се променят, refund не се прави. Изтекъл
--     използван артикул просто не се показва (join по active_until > now);
--     друг вариант НЕ се активира автоматично.
-- Не са финансови записи — изтриват се с профила (CASCADE). Финансовата
-- история остава в profile_customization_orders/purchases.
--
-- profile_customization_active остава (съвместимост), но вече не се пише.

CREATE TABLE IF NOT EXISTS profile_customization_owned_items (
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('nickname_color', 'message_color', 'emoji_before', 'emoji_after')
  ),
  item_id TEXT NOT NULL,
  item_value_snapshot TEXT NOT NULL CHECK (upper(item_value_snapshot) <> '#F72585'),
  item_label_snapshot TEXT NULL,
  chain_id TEXT NOT NULL,
  chain_started_at TEXT NOT NULL,
  active_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (profile_id, kind, item_id),
  CHECK (active_until >= chain_started_at),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_profile_customization_owned_items_until
  ON profile_customization_owned_items(profile_id, active_until);

CREATE INDEX IF NOT EXISTS idx_profile_customization_owned_items_chain
  ON profile_customization_owned_items(chain_id);

CREATE TABLE IF NOT EXISTS profile_customization_equipped (
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('nickname_color', 'message_color', 'emoji_before', 'emoji_after')
  ),
  item_id TEXT NOT NULL,
  equipped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (profile_id, kind),
  -- Само притежаван вариант може да се използва; ако правото бъде
  -- отменено (пълен refund), използването изчезва заедно с него.
  FOREIGN KEY (profile_id, kind, item_id)
    REFERENCES profile_customization_owned_items(profile_id, kind, item_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Текущите екстри (старият модел) -> притежавани и използвани.
INSERT OR IGNORE INTO profile_customization_owned_items (
  profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
  chain_id, chain_started_at, active_until, created_at, updated_at
)
SELECT profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
       chain_id, chain_started_at, active_until, chain_started_at, updated_at
FROM profile_customization_active;

INSERT OR IGNORE INTO profile_customization_equipped (profile_id, kind, item_id, equipped_at)
SELECT profile_id, kind, item_id, updated_at
FROM profile_customization_active;

-- ─── Само 5 цвята за нови покупки ─────────────────────────────────────────
-- Останалите 16 НЕ се изтриват (история/snapshot-и, админът може да ги
-- върне) — само се спират от продажба. Притежателите им запазват правото до
-- изтичане и могат да ги удължават (правилото за скрит артикул).
UPDATE profile_customization_colors
SET is_active = CASE WHEN hex IN ('#E81729', '#2B74D9', '#14891E', '#9B4BEA', '#976F08') THEN 1 ELSE 0 END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

UPDATE profile_customization_colors SET label = 'Червен', sort_order = 10 WHERE hex = '#E81729';
UPDATE profile_customization_colors SET label = 'Син', sort_order = 10 WHERE hex = '#2B74D9';
UPDATE profile_customization_colors SET label = 'Зелен', sort_order = 10 WHERE hex = '#14891E';
UPDATE profile_customization_colors SET label = 'Лилав', sort_order = 10 WHERE hex = '#9B4BEA';
UPDATE profile_customization_colors SET label = 'Златист', sort_order = 10 WHERE hex = '#976F08';
