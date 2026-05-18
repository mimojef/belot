import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type DailyRewardTierSnapshot = {
  tierId: string
  sortOrder: number
  yellowCoinsAmount: number
}

export type DailyRewardTierWithClaimStatus = DailyRewardTierSnapshot & {
  claimedToday: boolean
}

export type DailyRewardsStore = {
  listActiveTiers: () => DailyRewardTierSnapshot[]
  listStagedTiers: () => DailyRewardTierSnapshot[]
  addStagedTier: (yellowCoinsAmount: number) => { ok: true; tier: DailyRewardTierSnapshot } | { ok: false; message: string }
  removeStagedTier: (tierId: string) => { ok: true } | { ok: false; message: string }
  listTiersWithClaimStatus: (profileId: string) => DailyRewardTierWithClaimStatus[]
  claimReward: (profileId: string, tierId: string) => { ok: true; yellowCoinsAwarded: number } | { ok: false; message: string }
  close: () => void
}

type TierRow = {
  tier_id: string
  sort_order: number
  yellow_coins_amount: number
  is_staged: number
  promote_on_date: string | null
}

function rowToSnapshot(row: TierRow): DailyRewardTierSnapshot {
  return {
    tierId: row.tier_id,
    sortOrder: row.sort_order,
    yellowCoinsAmount: row.yellow_coins_amount,
  }
}

const SOFIA_TZ = 'Europe/Sofia'

function sofiaDateString(offsetMs = 0): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: SOFIA_TZ }).format(new Date(Date.now() + offsetMs))
}

function todayDateString(): string {
  return sofiaDateString()
}

function tomorrowDateString(): string {
  return sofiaDateString(24 * 60 * 60 * 1000)
}

export async function createDailyRewardsStore(
  databaseFilePath: string,
): Promise<DailyRewardsStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectActiveTiersStatement = database.prepare(`
    SELECT tier_id, sort_order, yellow_coins_amount, is_staged, promote_on_date
    FROM daily_reward_tiers
    WHERE is_staged = 0
    ORDER BY sort_order ASC;
  `)

  const selectStagedTiersStatement = database.prepare(`
    SELECT tier_id, sort_order, yellow_coins_amount, is_staged, promote_on_date
    FROM daily_reward_tiers
    WHERE is_staged = 1
    ORDER BY sort_order ASC;
  `)

  const selectReadyStagedCountStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM daily_reward_tiers
    WHERE is_staged = 1 AND promote_on_date <= ?;
  `)

  const deleteActiveTiersStatement = database.prepare(`
    DELETE FROM daily_reward_tiers WHERE is_staged = 0;
  `)

  const promoteAllStagedStatement = database.prepare(`
    UPDATE daily_reward_tiers SET is_staged = 0, promote_on_date = NULL WHERE is_staged = 1;
  `)

  const selectMaxActiveSortOrderStatement = database.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM daily_reward_tiers WHERE is_staged = 0;
  `)

  const selectMaxStagedSortOrderStatement = database.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM daily_reward_tiers WHERE is_staged = 1;
  `)

  const insertTierStatement = database.prepare(`
    INSERT INTO daily_reward_tiers (tier_id, sort_order, yellow_coins_amount, is_staged, promote_on_date)
    VALUES (?, ?, ?, ?, ?);
  `)

  const deleteStagedTierStatement = database.prepare(`
    DELETE FROM daily_reward_tiers WHERE tier_id = ? AND is_staged = 1;
  `)

  const selectTierByIdStatement = database.prepare(`
    SELECT tier_id, sort_order, yellow_coins_amount, is_staged, promote_on_date
    FROM daily_reward_tiers WHERE tier_id = ?;
  `)

  const selectClaimedTodayStatement = database.prepare(`
    SELECT tier_id FROM player_daily_reward_claims
    WHERE profile_id = ? AND claim_date = ?;
  `)

  const insertClaimStatement = database.prepare(`
    INSERT INTO player_daily_reward_claims (claim_id, profile_id, tier_id, claim_date)
    VALUES (?, ?, ?, ?);
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 0)
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  // Promote staged → active if any staged tier's promote_on_date has passed.
  // If staged tiers exist and are ready: delete old active, make staged active.
  // If no staged tiers exist: active tiers repeat unchanged (claims reset by date).
  function promoteIfNeeded(): void {
    const today = todayDateString()
    const readyRow = selectReadyStagedCountStatement.get(today) as { cnt: number }
    if (readyRow.cnt === 0) return

    database.exec('BEGIN;')
    try {
      deleteActiveTiersStatement.run()
      promoteAllStagedStatement.run()
      database.exec('COMMIT;')
    } catch {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
    }
  }

  function listActiveTiers(): DailyRewardTierSnapshot[] {
    return (selectActiveTiersStatement.all() as TierRow[]).map(rowToSnapshot)
  }

  function listStagedTiers(): DailyRewardTierSnapshot[] {
    return (selectStagedTiersStatement.all() as TierRow[]).map(rowToSnapshot)
  }

  function addStagedTier(yellowCoinsAmount: number): { ok: true; tier: DailyRewardTierSnapshot } | { ok: false; message: string } {
    if (!Number.isInteger(yellowCoinsAmount) || yellowCoinsAmount <= 0 || yellowCoinsAmount > 100_000_000) {
      return { ok: false, message: 'Сумата трябва да е цяло число между 1 и 100 000 000.' }
    }

    const maxRow = selectMaxStagedSortOrderStatement.get() as { max_order: number }
    const nextOrder = maxRow.max_order + 1
    const tierId = randomUUID()
    const promoteOn = tomorrowDateString()

    insertTierStatement.run(tierId, nextOrder, yellowCoinsAmount, 1, promoteOn)

    const tier = selectTierByIdStatement.get(tierId) as TierRow | undefined
    if (!tier) return { ok: false, message: 'Наградата не беше записана.' }

    return { ok: true, tier: rowToSnapshot(tier) }
  }

  function removeStagedTier(tierId: string): { ok: true } | { ok: false; message: string } {
    const existing = selectTierByIdStatement.get(tierId) as TierRow | undefined
    if (!existing) return { ok: false, message: 'Наградата не съществува.' }
    if (existing.is_staged !== 1) return { ok: false, message: 'Може да се премахват само награди за утре.' }

    deleteStagedTierStatement.run(tierId)
    return { ok: true }
  }

  function listTiersWithClaimStatus(profileId: string): DailyRewardTierWithClaimStatus[] {
    promoteIfNeeded()

    const tiers = listActiveTiers()
    const today = todayDateString()
    const claimedRows = selectClaimedTodayStatement.all(profileId, today) as { tier_id: string }[]
    const claimedIds = new Set(claimedRows.map((r) => r.tier_id))

    return tiers.map((t) => ({
      ...t,
      claimedToday: claimedIds.has(t.tierId),
    }))
  }

  function claimReward(profileId: string, tierId: string): { ok: true; yellowCoinsAwarded: number } | { ok: false; message: string } {
    const today = todayDateString()

    const tier = selectTierByIdStatement.get(tierId) as TierRow | undefined
    if (!tier || tier.is_staged === 1) return { ok: false, message: 'Тази награда не съществува.' }

    const alreadyClaimed = selectClaimedTodayStatement.all(profileId, today) as { tier_id: string }[]
    if (alreadyClaimed.some((r) => r.tier_id === tierId)) {
      return { ok: false, message: 'Вече си взел тази награда днес.' }
    }

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(profileId)
      creditWalletStatement.run(tier.yellow_coins_amount, profileId)
      insertClaimStatement.run(randomUUID(), profileId, tierId, today)
      database.exec('COMMIT;')
    } catch (err) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      return { ok: false, message: err instanceof Error ? err.message : 'Грешка при вземане на наградата.' }
    }

    return { ok: true, yellowCoinsAwarded: tier.yellow_coins_amount }
  }

  function close(): void {
    database.close()
  }

  return {
    listActiveTiers,
    listStagedTiers,
    addStagedTier,
    removeStagedTier,
    listTiersWithClaimStatus,
    claimReward,
    close,
  }
}
