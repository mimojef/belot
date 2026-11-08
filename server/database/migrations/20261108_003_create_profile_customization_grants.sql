-- "Персонализация на профила" — безплатно предоставяне от пълен admin.
--
-- Всеки ред е ЕДНО предоставено право (вид + артикул + дни) и едновременно
-- административният одит: кой admin, на кой профил, кога, какво, колко дни,
-- новата крайна дата и дали е нов артикул или удължаване. Редовете от едно
-- "Приложи безплатно" споделят batch_id (прилагат се в една транзакция).
--
-- НЕ е финансов запис и НЕ е Stripe покупка: не участва в "Плащания" и в
-- оборота. Срокът на притежавания вариант (profile_customization_owned_items)
-- е обща верига: chain_started_at + сума(дни на платените редове) +
-- сума(дни на предоставянията) със същия chain_id. Така refund на платена
-- част отнема само платените дни, а предоставените остават — и обратно.
--
-- Изтриване на профил: редът остава като одит (profile_id -> NULL,
-- псевдонимният UUID в deleted_profile_id_snapshot, имената се заменят с
-- неутрален етикет — виж profileDeletionExecutor.ts).

CREATE TABLE IF NOT EXISTS profile_customization_grants (
  grant_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  profile_id TEXT NULL,
  deleted_profile_id_snapshot TEXT NULL,
  target_display_name_snapshot TEXT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('nickname_color', 'message_color', 'emoji_before', 'emoji_after')
  ),
  item_id TEXT NOT NULL,
  item_value_snapshot TEXT NOT NULL CHECK (upper(item_value_snapshot) <> '#F72585'),
  item_label_snapshot TEXT NULL,
  days INTEGER NOT NULL CHECK (days IN (30, 60, 90, 120, 150, 180)),
  grant_effect TEXT NOT NULL CHECK (grant_effect IN ('new', 'extend')),
  chain_id TEXT NOT NULL,
  granted_until_snapshot TEXT NOT NULL,
  granted_by_profile_id TEXT NULL,
  granted_by_display_name_snapshot TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
  FOREIGN KEY (granted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_customization_grants_chain
  ON profile_customization_grants(chain_id);

CREATE INDEX IF NOT EXISTS idx_profile_customization_grants_profile
  ON profile_customization_grants(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_profile_customization_grants_created
  ON profile_customization_grants(created_at);

CREATE INDEX IF NOT EXISTS idx_profile_customization_grants_batch
  ON profile_customization_grants(batch_id);

CREATE INDEX IF NOT EXISTS idx_profile_customization_grants_deleted_profile_snapshot
  ON profile_customization_grants(deleted_profile_id_snapshot)
  WHERE deleted_profile_id_snapshot IS NOT NULL;
