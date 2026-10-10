import { randomUUID } from 'node:crypto'
import type { CampaignActionActor, CampaignRecord, CampaignStatus } from './campaignsStore.js'
import { VIP_PACKAGE_CATALOG, VIP_PACKAGE_IDS } from '../db/vipPurchaseStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CampaignAdminGameKind = 'belot' | 'ludo'
export type CampaignAdminRewardType = 'yellow_coins' | 'vip_days' | 'gift_item'

export type CampaignAdminEarnRule = {
  gameKind: CampaignAdminGameKind
  stakeAmount: number
  unitsPerWin: number
}

export type CampaignAdminPackageEarnRule = {
  packageKey: string
  unitsPerPurchase: number
}

export type CampaignAdminTierReward =
  | { rewardType: 'yellow_coins'; amount: number }
  | { rewardType: 'vip_days'; days: number }
  | { rewardType: 'gift_item'; giftItemId: string }

export type CampaignAdminRewardTier = {
  tierId: string | null
  thresholdUnits: number
  rewards: CampaignAdminTierReward[]
}

export type CampaignAdminCampaignSnapshot = CampaignRecord & {
  earnRules: CampaignAdminEarnRule[]
  packageEarnRules: CampaignAdminPackageEarnRule[]
  rewardTiers: CampaignAdminRewardTier[]
}

export type CampaignAdminMarketingProfile = {
  profileId: string
  displayName: string
}

export type CampaignAdminPurchasePackage = {
  packageKey: string
  title: string
  kind: 'coins' | 'bundle' | 'vip'
  yellowCoinsAmount: number
  vipDays: number | null
  status: 'active' | 'inactive'
}

export type CampaignAdminGiftItem = {
  giftItemId: string
  name: string
  imageUrl: string
  price: number
  isActive: boolean
}

export type CampaignAdminReferenceData = {
  allowedStakes: {
    belot: number[]
    ludo: number[]
  }
  purchasePackages: CampaignAdminPurchasePackage[]
  giftItems: CampaignAdminGiftItem[]
  marketingProfiles: CampaignAdminMarketingProfile[]
}

export type CampaignAdminSnapshot = {
  campaigns: CampaignAdminCampaignSnapshot[]
  referenceData: CampaignAdminReferenceData
}

export type CampaignAdminSaveInput = {
  campaignId?: string | null
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  giftSenderProfileId?: string | null
  earnRules: CampaignAdminEarnRule[]
  packageEarnRules: CampaignAdminPackageEarnRule[]
  rewardTiers: CampaignAdminRewardTier[]
}

export type CampaignAdminStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; reason?: string }

export type CampaignAdminStore = {
  getSnapshot: () => CampaignAdminSnapshot
  saveCampaignConfiguration: (
    input: CampaignAdminSaveInput,
    actor: CampaignActionActor,
  ) => CampaignAdminStoreResult<CampaignAdminCampaignSnapshot>
  updateMarketingSender: (
    campaignId: string,
    giftSenderProfileId: string | null,
    actor: CampaignActionActor,
  ) => CampaignAdminStoreResult<CampaignAdminCampaignSnapshot>
  validateCampaignReady: (campaignId: string) => CampaignAdminStoreResult<CampaignAdminCampaignSnapshot>
  close: () => void
}

type CampaignRow = {
  campaign_id: string
  name: string
  status: string
  starts_at: string
  ends_at: string
  unit_name_singular: string
  unit_name_plural: string
  unit_icon_url: string | null
  table_bg_desktop_url: string | null
  table_bg_mobile_url: string | null
  card_back_url: string | null
  gift_sender_profile_id: string | null
  archived_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type CampaignEarnRuleRow = {
  campaign_id: string
  game_kind: CampaignAdminGameKind
  stake_amount: number
  units_per_win: number
}

type CampaignPackageEarnRuleRow = {
  campaign_id: string
  package_key: string
  units_per_purchase: number
}

type CampaignRewardTierRow = {
  tier_id: string
  campaign_id: string
  threshold_units: number
}

type CampaignTierRewardRow = {
  tier_id: string
  reward_type: CampaignAdminRewardType
  reward_payload_json: string
}

type NormalizedCampaignInput = {
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  giftSenderProfileId: string | null
  earnRules: CampaignAdminEarnRule[]
  packageEarnRules: CampaignAdminPackageEarnRule[]
  rewardTiers: CampaignAdminRewardTier[]
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  const text = normalizeText(value, maxLength)
  return text.length > 0 ? text : null
}

function normalizePositiveInteger(value: unknown, max: number): number | null {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > max) return null
  return numberValue
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function isValidPeriod(startsAtIso: string, endsAtIso: string): boolean {
  return Date.parse(endsAtIso) > Date.parse(startsAtIso)
}

function rowToCampaignRecord(row: CampaignRow): CampaignRecord {
  return {
    campaignId: row.campaign_id,
    name: row.name,
    status: row.status as CampaignStatus,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    unitNameSingular: row.unit_name_singular,
    unitNamePlural: row.unit_name_plural,
    unitIconUrl: row.unit_icon_url,
    tableBgDesktopUrl: row.table_bg_desktop_url,
    tableBgMobileUrl: row.table_bg_mobile_url,
    cardBackUrl: row.card_back_url,
    giftSenderProfileId: row.gift_sender_profile_id,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function resultError(message: string, reason?: string): { ok: false; message: string; reason?: string } {
  return reason === undefined ? { ok: false, message } : { ok: false, message, reason }
}

function parseRewardPayload(row: CampaignTierRewardRow): CampaignAdminTierReward | null {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.reward_payload_json) as Record<string, unknown>
  } catch {
    return null
  }

  if (row.reward_type === 'yellow_coins') {
    const amount = normalizePositiveInteger(payload.amount, 100_000_000)
    return amount === null ? null : { rewardType: 'yellow_coins', amount }
  }

  if (row.reward_type === 'vip_days') {
    const days = normalizePositiveInteger(payload.amount, 3650)
    return days === null ? null : { rewardType: 'vip_days', days }
  }

  const giftItemId = normalizeOptionalText(payload.giftItemId, 96)
  return giftItemId === null ? null : { rewardType: 'gift_item', giftItemId }
}

export async function createCampaignAdminStore(databaseFilePath: string): Promise<CampaignAdminStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const SELECT_CAMPAIGN_COLUMNS = `
    campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural,
    unit_icon_url, table_bg_desktop_url, table_bg_mobile_url, card_back_url,
    gift_sender_profile_id, archived_at, deleted_at, created_at, updated_at
  `

  const selectCampaignByIdStatement = database.prepare(`
    SELECT ${SELECT_CAMPAIGN_COLUMNS}
    FROM campaigns
    WHERE campaign_id = ?
    LIMIT 1;
  `)

  const selectCampaignsStatement = database.prepare(`
    SELECT ${SELECT_CAMPAIGN_COLUMNS}
    FROM campaigns
    ORDER BY created_at DESC;
  `)

  const insertCampaignStatement = database.prepare(`
    INSERT INTO campaigns (
      campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural, gift_sender_profile_id
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?);
  `)

  const updateCampaignStatement = database.prepare(`
    UPDATE campaigns
    SET
      name = ?,
      starts_at = ?,
      ends_at = ?,
      unit_name_singular = ?,
      unit_name_plural = ?,
      gift_sender_profile_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ?;
  `)

  const updateMarketingSenderStatement = database.prepare(`
    UPDATE campaigns
    SET gift_sender_profile_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ?;
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO campaign_events (event_id, campaign_id, event_type, actor_profile_id, payload_json)
    VALUES (?, ?, ?, ?, ?);
  `)

  const insertEarnRuleStatement = database.prepare(`
    INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win)
    VALUES (?, ?, ?, ?);
  `)

  const insertPackageEarnRuleStatement = database.prepare(`
    INSERT INTO campaign_package_earn_rules (campaign_id, package_key, units_per_purchase)
    VALUES (?, ?, ?);
  `)

  const insertRewardTierStatement = database.prepare(`
    INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units)
    VALUES (?, ?, ?);
  `)

  const insertTierRewardStatement = database.prepare(`
    INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json)
    VALUES (?, ?, ?, ?);
  `)

  const countOverlappingCampaignsStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM campaigns
    WHERE deleted_at IS NULL
      AND status IN ('scheduled', 'active')
      AND campaign_id != ?
      AND starts_at < ?
      AND ends_at > ?;
  `)

  const selectMarketingProfileStatement = database.prepare(`
    SELECT p.profile_id
    FROM profiles p
    JOIN accounts a ON a.account_id = p.account_id
    WHERE p.profile_id = ?
      AND p.status = 'active'
      AND a.status = 'active'
      AND a.role = 'marketing'
    LIMIT 1;
  `)

  const selectMarketingProfilesStatement = database.prepare(`
    SELECT p.profile_id, p.display_name
    FROM profiles p
    JOIN accounts a ON a.account_id = p.account_id
    WHERE p.status = 'active'
      AND a.status = 'active'
      AND a.role = 'marketing'
    ORDER BY p.display_name COLLATE NOCASE ASC;
  `)

  const selectAllowedStakesStatement = database.prepare(`
    SELECT stake_amount
    FROM match_rooms
    WHERE is_enabled = 1
    ORDER BY stake_amount ASC;
  `)

  const selectCoinPackagesStatement = database.prepare(`
    SELECT package_key, title, yellow_coins_amount, status
    FROM coin_packages
    ORDER BY sort_order ASC, yellow_coins_amount ASC;
  `)

  const selectBundlePackagesStatement = database.prepare(`
    SELECT package_key, title, yellow_coins_amount, vip_days, status
    FROM shop_bundle_packages
    ORDER BY sort_order ASC, yellow_coins_amount ASC;
  `)

  const selectGiftItemsStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active
    FROM gift_items
    WHERE deleted_at IS NULL
    ORDER BY sort_order ASC, price ASC;
  `)

  const selectActiveGiftItemStatement = database.prepare(`
    SELECT gift_item_id
    FROM gift_items
    WHERE gift_item_id = ? AND is_active = 1 AND deleted_at IS NULL
    LIMIT 1;
  `)

  function rollback(): void {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // ignore rollback failure after an already-known error
    }
  }

  function insertEvent(
    campaignId: string,
    eventType: string,
    actor: CampaignActionActor,
    payload: Record<string, unknown>,
  ): void {
    insertEventStatement.run(
      randomUUID(),
      campaignId,
      eventType,
      actor.type === 'admin' ? actor.profileId : null,
      JSON.stringify({ ...payload, actorType: actor.type }),
    )
  }

  function getCampaignRecord(campaignId: string): CampaignRecord | null {
    const row = selectCampaignByIdStatement.get(campaignId) as CampaignRow | undefined
    return row === undefined ? null : rowToCampaignRecord(row)
  }

  function listAllowedStakes(): number[] {
    const rows = selectAllowedStakesStatement.all() as Array<{ stake_amount: number }>
    return rows.map((row) => row.stake_amount)
  }

  function listPurchasePackages(): CampaignAdminPurchasePackage[] {
    const coins = (selectCoinPackagesStatement.all() as Array<{
      package_key: string
      title: string
      yellow_coins_amount: number
      status: 'active' | 'inactive'
    }>).map((row) => ({
      packageKey: row.package_key,
      title: row.title,
      kind: 'coins' as const,
      yellowCoinsAmount: row.yellow_coins_amount,
      vipDays: null,
      status: row.status,
    }))

    const bundles = (selectBundlePackagesStatement.all() as Array<{
      package_key: string
      title: string
      yellow_coins_amount: number
      vip_days: number
      status: 'active' | 'inactive'
    }>).map((row) => ({
      packageKey: row.package_key,
      title: row.title,
      kind: 'bundle' as const,
      yellowCoinsAmount: row.yellow_coins_amount,
      vipDays: row.vip_days,
      status: row.status,
    }))

    // VIP пакети — code-level catalog (vipPurchaseStore.VIP_PACKAGE_CATALOG),
    // НЕ DB таблица (цените са admin-configurable, но самите 3 packageId-та
    // са фиксирани server-side константи, виж doc коментара там). Винагu
    // "active" — няма admin UI за деактивиране на VIP пакет. Добавено във
    // Фаза 5, за да могат admin-ите реално да конфигурират earn rule за
    // чисти VIP покупки (не само coin/bundle) — package_key стойностите
    // ('vip_30'/'vip_180'/'vip_365') са РЕАЛНИТЕ VipPackageId константи,
    // не измислени — виж campaignPurchaseHooks.ts за crediting страната.
    const vipPackages = VIP_PACKAGE_IDS.map((packageId) => ({
      packageKey: packageId,
      title: VIP_PACKAGE_CATALOG[packageId].title,
      kind: 'vip' as const,
      yellowCoinsAmount: 0,
      vipDays: VIP_PACKAGE_CATALOG[packageId].days,
      status: 'active' as const,
    }))

    return [...coins, ...bundles, ...vipPackages]
  }

  function listGiftItems(): CampaignAdminGiftItem[] {
    return (selectGiftItemsStatement.all() as Array<{
      gift_item_id: string
      name: string
      image_url: string
      price: number
      is_active: number
    }>).map((row) => ({
      giftItemId: row.gift_item_id,
      name: row.name,
      imageUrl: row.image_url,
      price: row.price,
      isActive: row.is_active !== 0,
    }))
  }

  function listMarketingProfiles(): CampaignAdminMarketingProfile[] {
    return (selectMarketingProfilesStatement.all() as Array<{ profile_id: string; display_name: string }>).map((row) => ({
      profileId: row.profile_id,
      displayName: row.display_name,
    }))
  }

  function getReferenceData(): CampaignAdminReferenceData {
    const allowedStakes = listAllowedStakes()
    return {
      allowedStakes: {
        belot: allowedStakes,
        ludo: allowedStakes,
      },
      purchasePackages: listPurchasePackages(),
      giftItems: listGiftItems(),
      marketingProfiles: listMarketingProfiles(),
    }
  }

  function validateMarketingProfile(profileId: string | null): boolean {
    if (profileId === null) return true
    return selectMarketingProfileStatement.get(profileId) !== undefined
  }

  function normalizeInput(input: CampaignAdminSaveInput): CampaignAdminStoreResult<NormalizedCampaignInput> {
    const name = normalizeText(input.name, 120)
    const startsAt = normalizeIsoDate(input.startsAt)
    const endsAt = normalizeIsoDate(input.endsAt)
    const unitNameSingular = normalizeText(input.unitNameSingular, 40)
    const unitNamePlural = normalizeText(input.unitNamePlural, 40)
    const giftSenderProfileId = normalizeOptionalText(input.giftSenderProfileId, 96)

    if (name.length < 2) return resultError('Името на кампанията трябва да е поне 2 символа.', 'invalid_name')
    if (startsAt === null || endsAt === null || !isValidPeriod(startsAt, endsAt)) {
      return resultError('Периодът на кампанията е невалиден.', 'invalid_period')
    }
    if (unitNameSingular.length === 0 || unitNamePlural.length === 0) {
      return resultError('Имената на единицата са задължителни.', 'invalid_unit_names')
    }
    if (!validateMarketingProfile(giftSenderProfileId)) {
      return resultError('Подателят трябва да е активен профил с роля „marketing“.', 'invalid_marketing_profile')
    }

    const allowedStakes = new Set(listAllowedStakes())
    const purchasePackageKeys = new Set(listPurchasePackages().map((pack) => pack.packageKey))
    const activeGiftItemIds = new Set(listGiftItems().filter((item) => item.isActive).map((item) => item.giftItemId))

    const earnRules: CampaignAdminEarnRule[] = []
    const earnKeys = new Set<string>()
    if (!Array.isArray(input.earnRules)) return resultError('Правилата за игри са невалидни.', 'invalid_earn_rules')
    for (const rawRule of input.earnRules) {
      const gameKind = rawRule?.gameKind
      if (gameKind !== 'belot' && gameKind !== 'ludo') {
        return resultError('Невалиден тип игра в правило за начисляване.', 'invalid_game_kind')
      }
      const stakeAmount = normalizePositiveInteger(rawRule.stakeAmount, 1_000_000_000)
      const unitsPerWin = normalizePositiveInteger(rawRule.unitsPerWin, 1_000_000)
      if (stakeAmount === null || unitsPerWin === null) {
        return resultError('Залогът и единиците за победа трябва да са положителни цели числа.', 'invalid_earn_rule_numbers')
      }
      if (!allowedStakes.has(stakeAmount)) {
        return resultError('Избран е залог, който не съществува като включена стая.', 'invalid_stake')
      }
      const key = `${gameKind}:${stakeAmount}`
      if (earnKeys.has(key)) {
        return resultError('Има повторено правило за една и съща игра и залог.', 'duplicate_earn_rule')
      }
      earnKeys.add(key)
      earnRules.push({ gameKind, stakeAmount, unitsPerWin })
    }

    const packageEarnRules: CampaignAdminPackageEarnRule[] = []
    const packageKeys = new Set<string>()
    if (!Array.isArray(input.packageEarnRules)) return resultError('Правилата за покупки са невалидни.', 'invalid_package_rules')
    for (const rawRule of input.packageEarnRules) {
      const packageKey = normalizeText(rawRule?.packageKey, 120)
      const unitsPerPurchase = normalizePositiveInteger(rawRule?.unitsPerPurchase, 1_000_000)
      if (packageKey.length === 0 || unitsPerPurchase === null) {
        return resultError('Пакетът и единиците за покупка са задължителни.', 'invalid_package_rule')
      }
      if (!purchasePackageKeys.has(packageKey)) {
        return resultError('Избран е пакет, който не съществува в магазина.', 'invalid_package_key')
      }
      if (packageKeys.has(packageKey)) {
        return resultError('Има повторено правило за един и същ пакет.', 'duplicate_package_rule')
      }
      packageKeys.add(packageKey)
      packageEarnRules.push({ packageKey, unitsPerPurchase })
    }

    const rewardTiers: CampaignAdminRewardTier[] = []
    const tierThresholds = new Set<number>()
    if (!Array.isArray(input.rewardTiers)) return resultError('Наградните прагове са невалидни.', 'invalid_reward_tiers')
    for (const rawTier of input.rewardTiers) {
      const thresholdUnits = normalizePositiveInteger(rawTier?.thresholdUnits, 1_000_000_000)
      if (thresholdUnits === null) return resultError('Прагът трябва да е положително цяло число.', 'invalid_tier_threshold')
      if (tierThresholds.has(thresholdUnits)) return resultError('Има повторен награден праг.', 'duplicate_tier_threshold')
      if (!Array.isArray(rawTier.rewards) || rawTier.rewards.length === 0) {
        return resultError('Всеки праг трябва да има поне една награда.', 'empty_tier_rewards')
      }

      const rewards: CampaignAdminTierReward[] = []
      for (const rawReward of rawTier.rewards) {
        if (rawReward.rewardType === 'yellow_coins') {
          const amount = normalizePositiveInteger(rawReward.amount, 100_000_000)
          if (amount === null) return resultError('Наградата жълтици трябва да е положително цяло число.', 'invalid_yellow_coin_reward')
          rewards.push({ rewardType: 'yellow_coins', amount })
          continue
        }

        if (rawReward.rewardType === 'vip_days') {
          const days = normalizePositiveInteger(rawReward.days, 3650)
          if (days === null) return resultError('VIP дните трябва да са положително цяло число.', 'invalid_vip_reward')
          rewards.push({ rewardType: 'vip_days', days })
          continue
        }

        if (rawReward.rewardType === 'gift_item') {
          const giftItemId = normalizeText(rawReward.giftItemId, 96)
          if (!activeGiftItemIds.has(giftItemId) || selectActiveGiftItemStatement.get(giftItemId) === undefined) {
            return resultError('Подарък-наградата трябва да е активен артикул от каталога.', 'invalid_gift_item')
          }
          rewards.push({ rewardType: 'gift_item', giftItemId })
          continue
        }

        return resultError('Невалиден тип награда.', 'invalid_reward_type')
      }

      tierThresholds.add(thresholdUnits)
      rewardTiers.push({ tierId: null, thresholdUnits, rewards })
    }

    if (earnRules.length + packageEarnRules.length === 0) {
      return resultError('Кампанията трябва да има поне едно правило за начисляване.', 'empty_earn_rules')
    }
    if (rewardTiers.length === 0) {
      return resultError('Кампанията трябва да има поне един награден праг.', 'empty_reward_tiers')
    }
    if (rewardTiers.some((tier) => tier.rewards.some((reward) => reward.rewardType === 'gift_item')) && giftSenderProfileId === null) {
      return resultError('Подарък-наградите изискват marketing подател.', 'missing_gift_sender')
    }

    return {
      ok: true,
      value: {
        name,
        startsAt,
        endsAt,
        unitNameSingular,
        unitNamePlural,
        giftSenderProfileId,
        earnRules,
        packageEarnRules,
        rewardTiers,
      },
    }
  }

  function hasOverlap(campaignId: string, startsAt: string, endsAt: string): boolean {
    const row = countOverlappingCampaignsStatement.get(campaignId, endsAt, startsAt) as { count: number }
    return row.count > 0
  }

  function deleteConfiguration(campaignId: string): void {
    database.prepare(`DELETE FROM campaign_tier_rewards WHERE tier_id IN (SELECT tier_id FROM campaign_reward_tiers WHERE campaign_id = ?);`).run(campaignId)
    database.prepare(`DELETE FROM campaign_reward_tiers WHERE campaign_id = ?;`).run(campaignId)
    database.prepare(`DELETE FROM campaign_package_earn_rules WHERE campaign_id = ?;`).run(campaignId)
    database.prepare(`DELETE FROM campaign_earn_rules WHERE campaign_id = ?;`).run(campaignId)
  }

  function insertConfiguration(campaignId: string, input: NormalizedCampaignInput): void {
    for (const rule of input.earnRules) {
      insertEarnRuleStatement.run(campaignId, rule.gameKind, rule.stakeAmount, rule.unitsPerWin)
    }

    for (const rule of input.packageEarnRules) {
      insertPackageEarnRuleStatement.run(campaignId, rule.packageKey, rule.unitsPerPurchase)
    }

    for (const tier of input.rewardTiers) {
      const tierId = randomUUID()
      insertRewardTierStatement.run(tierId, campaignId, tier.thresholdUnits)
      for (const reward of tier.rewards) {
        if (reward.rewardType === 'yellow_coins') {
          insertTierRewardStatement.run(randomUUID(), tierId, 'yellow_coins', JSON.stringify({ amount: reward.amount }))
        } else if (reward.rewardType === 'vip_days') {
          // "days" (мн.ч.) — трябва да съвпада ТОЧНО с vip_grants.interval_unit
          // CHECK constraint-а ('days'|'months'|'years', виж
          // 20260810_001_create_vip_status_and_grants.sql) и с
          // campaignCreditStore.ts::grantVipDaysInline, който го препредава
          // директно без нормализация. Открито и коригирано във Фаза 5
          // (§2 задължителна Фаза 4 проверка) — старата 'day' (ед.ч.) стойност
          // никога не беше exercised от Фаза 4's собствени тестове (само
          // конфигурация/валидация, никога реално прекосяване на праг).
          insertTierRewardStatement.run(randomUUID(), tierId, 'vip_days', JSON.stringify({ unit: 'days', amount: reward.days }))
        } else {
          insertTierRewardStatement.run(randomUUID(), tierId, 'gift_item', JSON.stringify({ giftItemId: reward.giftItemId }))
        }
      }
    }
  }

  function attachConfiguration(campaigns: CampaignRecord[]): CampaignAdminCampaignSnapshot[] {
    if (campaigns.length === 0) return []
    const ids = campaigns.map((campaign) => campaign.campaignId)
    const placeholders = ids.map(() => '?').join(', ')

    const earnRows = database.prepare(`
      SELECT campaign_id, game_kind, stake_amount, units_per_win
      FROM campaign_earn_rules
      WHERE campaign_id IN (${placeholders})
      ORDER BY game_kind ASC, stake_amount ASC;
    `).all(...ids) as CampaignEarnRuleRow[]

    const packageRows = database.prepare(`
      SELECT campaign_id, package_key, units_per_purchase
      FROM campaign_package_earn_rules
      WHERE campaign_id IN (${placeholders})
      ORDER BY package_key ASC;
    `).all(...ids) as CampaignPackageEarnRuleRow[]

    const tierRows = database.prepare(`
      SELECT tier_id, campaign_id, threshold_units
      FROM campaign_reward_tiers
      WHERE campaign_id IN (${placeholders})
      ORDER BY threshold_units ASC;
    `).all(...ids) as CampaignRewardTierRow[]

    const tierIds = tierRows.map((tier) => tier.tier_id)
    const tierRewardsByTierId = new Map<string, CampaignAdminTierReward[]>()
    if (tierIds.length > 0) {
      const tierPlaceholders = tierIds.map(() => '?').join(', ')
      const rewardRows = database.prepare(`
        SELECT tier_id, reward_type, reward_payload_json
        FROM campaign_tier_rewards
        WHERE tier_id IN (${tierPlaceholders})
        ORDER BY rowid ASC;
      `).all(...tierIds) as CampaignTierRewardRow[]
      for (const row of rewardRows) {
        const reward = parseRewardPayload(row)
        if (reward === null) continue
        const existing = tierRewardsByTierId.get(row.tier_id) ?? []
        existing.push(reward)
        tierRewardsByTierId.set(row.tier_id, existing)
      }
    }

    const earnByCampaignId = new Map<string, CampaignAdminEarnRule[]>()
    for (const row of earnRows) {
      const existing = earnByCampaignId.get(row.campaign_id) ?? []
      existing.push({ gameKind: row.game_kind, stakeAmount: row.stake_amount, unitsPerWin: row.units_per_win })
      earnByCampaignId.set(row.campaign_id, existing)
    }

    const packageByCampaignId = new Map<string, CampaignAdminPackageEarnRule[]>()
    for (const row of packageRows) {
      const existing = packageByCampaignId.get(row.campaign_id) ?? []
      existing.push({ packageKey: row.package_key, unitsPerPurchase: row.units_per_purchase })
      packageByCampaignId.set(row.campaign_id, existing)
    }

    const tiersByCampaignId = new Map<string, CampaignAdminRewardTier[]>()
    for (const row of tierRows) {
      const existing = tiersByCampaignId.get(row.campaign_id) ?? []
      existing.push({
        tierId: row.tier_id,
        thresholdUnits: row.threshold_units,
        rewards: tierRewardsByTierId.get(row.tier_id) ?? [],
      })
      tiersByCampaignId.set(row.campaign_id, existing)
    }

    return campaigns.map((campaign) => ({
      ...campaign,
      earnRules: earnByCampaignId.get(campaign.campaignId) ?? [],
      packageEarnRules: packageByCampaignId.get(campaign.campaignId) ?? [],
      rewardTiers: tiersByCampaignId.get(campaign.campaignId) ?? [],
    }))
  }

  function getCampaignSnapshot(campaignId: string): CampaignAdminCampaignSnapshot | null {
    const campaign = getCampaignRecord(campaignId)
    if (campaign === null) return null
    return attachConfiguration([campaign])[0] ?? null
  }

  function getSnapshot(): CampaignAdminSnapshot {
    const rows = selectCampaignsStatement.all() as CampaignRow[]
    return {
      campaigns: attachConfiguration(rows.map(rowToCampaignRecord)),
      referenceData: getReferenceData(),
    }
  }

  function saveCampaignConfiguration(
    input: CampaignAdminSaveInput,
    actor: CampaignActionActor,
  ): CampaignAdminStoreResult<CampaignAdminCampaignSnapshot> {
    const requestedCampaignId = normalizeOptionalText(input.campaignId, 96)
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = requestedCampaignId === null ? null : getCampaignRecord(requestedCampaignId)
      if (requestedCampaignId !== null && existing === null) {
        rollback()
        return resultError('Кампанията не беше намерена.', 'campaign_not_found')
      }
      if (existing !== null && existing.deletedAt !== null) {
        rollback()
        return resultError('Изтрита кампания не може да се редактира.', 'campaign_deleted')
      }
      if (existing !== null && existing.status !== 'draft' && existing.status !== 'scheduled') {
        rollback()
        return resultError('Настройките са заключени след активиране на кампанията.', 'not_editable')
      }

      const normalized = normalizeInput(input)
      if (!normalized.ok) {
        rollback()
        return normalized
      }

      const next = normalized.value
      const campaignId = existing?.campaignId ?? randomUUID()
      if (existing !== null && existing.status === 'scheduled' && hasOverlap(campaignId, next.startsAt, next.endsAt)) {
        rollback()
        return resultError('Периодът се застъпва с друга планирана или активна кампания.', 'overlaps_existing_campaign')
      }

      if (existing === null) {
        insertCampaignStatement.run(
          campaignId,
          next.name,
          next.startsAt,
          next.endsAt,
          next.unitNameSingular,
          next.unitNamePlural,
          next.giftSenderProfileId,
        )
      } else {
        updateCampaignStatement.run(
          next.name,
          next.startsAt,
          next.endsAt,
          next.unitNameSingular,
          next.unitNamePlural,
          next.giftSenderProfileId,
          campaignId,
        )
        deleteConfiguration(campaignId)
      }

      insertConfiguration(campaignId, next)
      insertEvent(campaignId, existing === null ? 'campaign_admin_created' : 'campaign_admin_config_updated', actor, {
        earnRules: next.earnRules.length,
        packageEarnRules: next.packageEarnRules.length,
        rewardTiers: next.rewardTiers.length,
      })
      database.exec('COMMIT;')

      const snapshot = getCampaignSnapshot(campaignId)
      if (snapshot === null) return resultError('Кампанията беше записана, но не беше прочетена обратно.', 'reload_failed')
      return { ok: true, value: snapshot }
    } catch (error) {
      rollback()
      throw error
    }
  }

  function validateCampaignReady(campaignId: string): CampaignAdminStoreResult<CampaignAdminCampaignSnapshot> {
    const snapshot = getCampaignSnapshot(campaignId)
    if (snapshot === null || snapshot.deletedAt !== null) {
      return resultError('Кампанията не беше намерена.', 'campaign_not_found')
    }

    const validation = normalizeInput({
      campaignId,
      name: snapshot.name,
      startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt,
      unitNameSingular: snapshot.unitNameSingular,
      unitNamePlural: snapshot.unitNamePlural,
      giftSenderProfileId: snapshot.giftSenderProfileId,
      earnRules: snapshot.earnRules,
      packageEarnRules: snapshot.packageEarnRules,
      rewardTiers: snapshot.rewardTiers,
    })

    if (!validation.ok) return validation
    return { ok: true, value: snapshot }
  }

  function updateMarketingSender(
    campaignIdInput: string,
    giftSenderProfileIdInput: string | null,
    actor: CampaignActionActor,
  ): CampaignAdminStoreResult<CampaignAdminCampaignSnapshot> {
    const campaignId = normalizeText(campaignIdInput, 96)
    const giftSenderProfileId = normalizeOptionalText(giftSenderProfileIdInput, 96)
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignRecord(campaignId)
      if (existing === null || existing.deletedAt !== null) {
        rollback()
        return resultError('Кампанията не беше намерена.', 'campaign_not_found')
      }
      if (existing.status !== 'draft' && existing.status !== 'scheduled' && existing.status !== 'active') {
        rollback()
        return resultError('Подателят може да се сменя само за draft, scheduled или active кампания.', 'not_editable')
      }
      if (!validateMarketingProfile(giftSenderProfileId)) {
        rollback()
        return resultError('Подателят трябва да е активен профил с роля „marketing“.', 'invalid_marketing_profile')
      }

      updateMarketingSenderStatement.run(giftSenderProfileId, campaignId)
      insertEvent(campaignId, 'campaign_gift_sender_updated', actor, { giftSenderProfileId })
      database.exec('COMMIT;')

      const snapshot = getCampaignSnapshot(campaignId)
      if (snapshot === null) return resultError('Кампанията беше записана, но не беше прочетена обратно.', 'reload_failed')
      return { ok: true, value: snapshot }
    } catch (error) {
      rollback()
      throw error
    }
  }

  return {
    getSnapshot,
    saveCampaignConfiguration,
    updateMarketingSender,
    validateCampaignReady,
    close: () => database.close(),
  }
}
