/**
 * checkCampaignAdminStore.ts
 *
 * Фаза 4 на системата "Кампании" — функционални проверки на
 * server/src/campaigns/campaignAdminStore.ts: конфигуриране на кампания
 * (earn rules/package earn rules/reward tiers), валидация (allowed stakes,
 * съществуващи пакети/подарък артикули, marketing подател, дублирани
 * правила/прагове), заключване след активиране, смяна на marketing
 * подателя, validateCampaignReady, и интеграция с campaignsStore's
 * лайфсайкъл (schedule/activate/stop/clone). Изолирана temp SQLite база,
 * реални миграции (вкл. реално seed-натите coin_packages/match_rooms).
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignAdminStore, type CampaignAdminStore, type CampaignAdminSaveInput } from '../src/campaigns/campaignAdminStore.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed += 1
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed += 1
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${message}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckCampaignAdminStore')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-admin-store-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  const fileNames = await loadRealMigrationFileNames()
  for (const filename of fileNames) {
    await cp(join(sourceMigrationsDirectoryPath, filename), join(migrationsDirectoryPath, filename))
  }
  const result = await ensureServerDatabaseReady({ serverRootOverride: root })
  return {
    databaseFilePath: result.databaseFilePath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

const { databaseFilePath, cleanup } = await createReadyTempDatabasePath()

async function openRawDb() {
  const sqliteModule = await import('node:sqlite')
  const db = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

async function seedProfile(displayName: string, opts: { accountRole?: string } = {}): Promise<string> {
  const db = await openRawDb()
  try {
    const profileId = randomUUID()
    let accountId: string | null = null
    if (opts.accountRole !== undefined) {
      accountId = randomUUID()
      db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES (?, ?, 'x', ?);`).run(
        accountId,
        `${accountId}@example.test`,
        opts.accountRole,
      )
    }
    db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, ?, ?);`).run(
      profileId,
      accountId,
      displayName,
      displayName.toLowerCase(),
    )
    return profileId
  } finally {
    db.close()
  }
}

async function seedGiftItem(name: string, opts: { isActive?: boolean } = {}): Promise<string> {
  const db = await openRawDb()
  try {
    const giftItemId = randomUUID()
    db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active) VALUES (?, ?, '/img.webp', 100, ?);`).run(
      giftItemId,
      name,
      opts.isActive === false ? 0 : 1,
    )
    return giftItemId
  } finally {
    db.close()
  }
}

async function firstAllowedStake(): Promise<number> {
  const db = await openRawDb()
  try {
    const row = db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount ASC LIMIT 1;`).get() as
      | { stake_amount: number }
      | undefined
    if (row === undefined) throw new Error('firstAllowedStake: no enabled match_rooms seeded')
    return row.stake_amount
  } finally {
    db.close()
  }
}

async function firstActivePackageKey(): Promise<string> {
  const db = await openRawDb()
  try {
    const row = db.prepare(`SELECT package_key FROM coin_packages WHERE status = 'active' ORDER BY sort_order ASC LIMIT 1;`).get() as
      | { package_key: string }
      | undefined
    if (row === undefined) throw new Error('firstActivePackageKey: no active coin_packages seeded')
    return row.package_key
  } finally {
    db.close()
  }
}

const ADMIN_ACTOR_PROFILE_ID = await seedProfile('Campaign Admin Tester', { accountRole: 'admin' })
const ADMIN_ACTOR = { type: 'admin' as const, profileId: ADMIN_ACTOR_PROFILE_ID }
const ALLOWED_STAKE = await firstAllowedStake()
const ACTIVE_PACKAGE_KEY = await firstActivePackageKey()

function minimalSaveInput(overrides: Partial<CampaignAdminSaveInput> = {}): CampaignAdminSaveInput {
  return {
    campaignId: null,
    name: `Test Campaign ${randomUUID()}`,
    startsAt: hoursFromNow(1),
    endsAt: hoursFromNow(200),
    unitNameSingular: 'тиква',
    unitNamePlural: 'тикви',
    giftSenderProfileId: null,
    earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 10 }],
    packageEarnRules: [],
    rewardTiers: [{ tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'yellow_coins', amount: 5000 }] }],
    ...overrides,
  }
}

let campaignsStore!: CampaignsStore
let adminStore!: CampaignAdminStore

try {
  campaignsStore = await createCampaignsStore(databaseFilePath)
  adminStore = await createCampaignAdminStore(databaseFilePath)

  // ─── 1. Празен snapshot + референтни данни ───
  await check('[1] getSnapshot() на празна база: нулеви кампании, коректни референтни данни', () => {
    const snapshot = adminStore.getSnapshot()
    assert(snapshot.campaigns.length === 0, 'очаква се празен списък кампании')
    assert(snapshot.referenceData.allowedStakes.belot.includes(ALLOWED_STAKE), 'allowedStakes.belot трябва да включва seed-натата ставка')
    assert(snapshot.referenceData.allowedStakes.ludo.includes(ALLOWED_STAKE), 'allowedStakes.ludo трябва да е същия списък (match_rooms е общ)')
    assert(snapshot.referenceData.purchasePackages.some((pack) => pack.packageKey === ACTIVE_PACKAGE_KEY), 'purchasePackages трябва да включва seed-натия coin package')
  })

  // ─── 2. Създаване на нова кампания ───
  let campaignId1!: string
  await check('[2] saveCampaignConfiguration (campaignId:null) създава draft кампания с пълна конфигурация', () => {
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput(), ADMIN_ACTOR)
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
    if (!result.ok) return
    campaignId1 = result.value.campaignId
    assert(result.value.status === 'draft', 'нова кампания трябва да е draft')
    assert(result.value.earnRules.length === 1 && result.value.earnRules[0]!.stakeAmount === ALLOWED_STAKE, 'earn rule трябва да е записано')
    assert(result.value.rewardTiers.length === 1 && result.value.rewardTiers[0]!.thresholdUnits === 100, 'reward tier трябва да е записан')
    assert(result.value.rewardTiers[0]!.rewards.length === 1 && result.value.rewardTiers[0]!.rewards[0]!.rewardType === 'yellow_coins', 'reward трябва да е записана')
  })

  await check('[3] getSnapshot() показва новосъздадената кампания', () => {
    const snapshot = adminStore.getSnapshot()
    assert(snapshot.campaigns.some((campaign) => campaign.campaignId === campaignId1), 'новата кампания трябва да е в списъка')
  })

  // ─── 3. Редакция на съществуваща draft кампания (замяна на конфигурацията) ───
  await check('[4] saveCampaignConfiguration (campaignId: existing) замества earn/package/tier конфигурацията', () => {
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        campaignId: campaignId1,
        name: 'Renamed Campaign',
        earnRules: [{ gameKind: 'ludo', stakeAmount: ALLOWED_STAKE, unitsPerWin: 25 }],
        rewardTiers: [{ tierId: null, thresholdUnits: 50, rewards: [{ rewardType: 'yellow_coins', amount: 2000 }] }],
      }),
      ADMIN_ACTOR,
    )
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.value.name === 'Renamed Campaign', 'името трябва да е обновено')
    assert(result.value.earnRules.length === 1 && result.value.earnRules[0]!.gameKind === 'ludo', 'старото belot rule трябва да е заменено с ludo')
    assert(result.value.rewardTiers.length === 1 && result.value.rewardTiers[0]!.thresholdUnits === 50, 'старият праг (100) трябва да е заменен с нов (50)')
  })

  // ─── 4. Валидации ───
  await check('[5] Невалидно име (<2 символа) -> invalid_name', () => {
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ name: 'A' }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'invalid_name', `expected invalid_name, got ${JSON.stringify(result)}`)
  })

  await check('[6] Невалиден период (endsAt <= startsAt) -> invalid_period', () => {
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ startsAt: hoursFromNow(10), endsAt: hoursFromNow(5) }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'invalid_period', `expected invalid_period, got ${JSON.stringify(result)}`)
  })

  await check('[7] Залог, който не съществува в allowedStakes -> invalid_stake', () => {
    const bogusStake = ALLOWED_STAKE + 1
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({ earnRules: [{ gameKind: 'belot', stakeAmount: bogusStake, unitsPerWin: 10 }] }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'invalid_stake', `expected invalid_stake, got ${JSON.stringify(result)}`)
  })

  await check('[8] Дублирано earn rule (същата игра+залог) -> duplicate_earn_rule', () => {
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        earnRules: [
          { gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 10 },
          { gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 20 },
        ],
      }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'duplicate_earn_rule', `expected duplicate_earn_rule, got ${JSON.stringify(result)}`)
  })

  await check('[9] Несъществуващ package key -> invalid_package_key', () => {
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({ packageEarnRules: [{ packageKey: 'does-not-exist', unitsPerPurchase: 5 }] }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'invalid_package_key', `expected invalid_package_key, got ${JSON.stringify(result)}`)
  })

  await check('[10] Дублирано package rule -> duplicate_package_rule', () => {
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        packageEarnRules: [
          { packageKey: ACTIVE_PACKAGE_KEY, unitsPerPurchase: 5 },
          { packageKey: ACTIVE_PACKAGE_KEY, unitsPerPurchase: 10 },
        ],
      }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'duplicate_package_rule', `expected duplicate_package_rule, got ${JSON.stringify(result)}`)
  })

  await check('[11] Дублиран reward tier праг -> duplicate_tier_threshold', () => {
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        rewardTiers: [
          { tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] },
          { tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'yellow_coins', amount: 2 }] },
        ],
      }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'duplicate_tier_threshold', `expected duplicate_tier_threshold, got ${JSON.stringify(result)}`)
  })

  await check('[12] Нулеви earn+package rules -> empty_earn_rules', () => {
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ earnRules: [], packageEarnRules: [] }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'empty_earn_rules', `expected empty_earn_rules, got ${JSON.stringify(result)}`)
  })

  await check('[13] Нулеви reward tiers -> empty_reward_tiers', () => {
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ rewardTiers: [] }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'empty_reward_tiers', `expected empty_reward_tiers, got ${JSON.stringify(result)}`)
  })

  await check('[14] gift_item награда (с реално съществуващ активен артикул) без marketing подател -> missing_gift_sender', async () => {
    // Gift item-ът трябва да бъде РЕАЛЕН и активен — invalid_gift_item проверката
    // в normalizeInput()'s reward-tier loop се изпълнява ПРЕДИ missing_gift_sender
    // проверката (която гледа целия вече построен rewardTiers масив), затова
    // несъществуващ giftItemId би хванал invalid_gift_item първо, не това.
    const giftItemId = await seedGiftItem('Gift For Missing Sender Test')
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({ rewardTiers: [{ tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'gift_item', giftItemId }] }] }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'missing_gift_sender', `expected missing_gift_sender, got ${JSON.stringify(result)}`)
  })

  await check('[15] Невалиден (неактивен) gift item с marketing подател -> invalid_gift_item', async () => {
    const marketingProfileId = await seedProfile('Marketing Sender 1', { accountRole: 'marketing' })
    const inactiveGiftItemId = await seedGiftItem('Inactive Gift', { isActive: false })
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        giftSenderProfileId: marketingProfileId,
        rewardTiers: [{ tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'gift_item', giftItemId: inactiveGiftItemId }] }],
      }),
      ADMIN_ACTOR,
    )
    assert(!result.ok && result.reason === 'invalid_gift_item', `expected invalid_gift_item, got ${JSON.stringify(result)}`)
  })

  await check('[16] Невалиден marketing подател (не е marketing роля) -> invalid_marketing_profile', async () => {
    const nonMarketingProfileId = await seedProfile('Not Marketing')
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ giftSenderProfileId: nonMarketingProfileId }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'invalid_marketing_profile', `expected invalid_marketing_profile, got ${JSON.stringify(result)}`)
  })

  // ─── 5. Успешна gift_item награда с валиден marketing подател ───
  let campaignWithGiftId!: string
  let marketingSenderId!: string
  let activeGiftItemId!: string
  await check('[17] Успешно saveCampaignConfiguration с gift_item награда + валиден marketing подател', async () => {
    marketingSenderId = await seedProfile('Marketing Sender 2', { accountRole: 'marketing' })
    activeGiftItemId = await seedGiftItem('Active Gift')
    const result = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        giftSenderProfileId: marketingSenderId,
        rewardTiers: [
          { tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'gift_item', giftItemId: activeGiftItemId }, { rewardType: 'vip_days', days: 7 }] },
        ],
      }),
      ADMIN_ACTOR,
    )
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
    if (!result.ok) return
    campaignWithGiftId = result.value.campaignId
    assert(result.value.giftSenderProfileId === marketingSenderId, 'giftSenderProfileId трябва да е записан')
    assert(result.value.rewardTiers[0]!.rewards.length === 2, 'и двете награди (gift_item + vip_days) трябва да са записани')
  })

  // ─── 6. Заключване след активиране ───
  await check('[18] Активирана кампания: saveCampaignConfiguration -> not_editable', async () => {
    const scheduled = campaignsStore.scheduleCampaign(campaignWithGiftId, ADMIN_ACTOR)
    assert(scheduled.ok, `setup schedule failed: ${JSON.stringify(scheduled)}`)
    const activated = campaignsStore.activateCampaign(campaignWithGiftId, new Date(), ADMIN_ACTOR)
    assert(activated.ok, `setup activate failed: ${JSON.stringify(activated)}`)

    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ campaignId: campaignWithGiftId }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'not_editable', `expected not_editable, got ${JSON.stringify(result)}`)
  })

  // ─── 7. Marketing подател — смяна по отделен path ───
  await check('[19] updateMarketingSender на активна кампания: позволено, валиден нов подател се записва', async () => {
    const newSenderId = await seedProfile('Marketing Sender 3', { accountRole: 'marketing' })
    const result = adminStore.updateMarketingSender(campaignWithGiftId, newSenderId, ADMIN_ACTOR)
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.value.giftSenderProfileId === newSenderId, 'новият подател трябва да е записан')
  })

  await check('[20] updateMarketingSender с невалиден (неmarketing) подател -> invalid_marketing_profile', async () => {
    const nonMarketingProfileId = await seedProfile('Not Marketing 2')
    const result = adminStore.updateMarketingSender(campaignWithGiftId, nonMarketingProfileId, ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'invalid_marketing_profile', `expected invalid_marketing_profile, got ${JSON.stringify(result)}`)
  })

  await check('[21] updateMarketingSender на несъществуваща кампания -> campaign_not_found', () => {
    const result = adminStore.updateMarketingSender(randomUUID(), null, ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'campaign_not_found', `expected campaign_not_found, got ${JSON.stringify(result)}`)
  })

  await check('[22] updateMarketingSender на finished кампания -> not_editable', async () => {
    const stopped = campaignsStore.stopCampaign(campaignWithGiftId, ADMIN_ACTOR)
    assert(stopped.ok, `setup stop failed: ${JSON.stringify(stopped)}`)
    const result = adminStore.updateMarketingSender(campaignWithGiftId, null, ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'not_editable', `expected not_editable (stopped), got ${JSON.stringify(result)}`)
  })

  // ─── 8. validateCampaignReady ───
  let readyCampaignId!: string
  await check('[23] validateCampaignReady на коректна draft кампания -> ok', () => {
    const created = adminStore.saveCampaignConfiguration(minimalSaveInput(), ADMIN_ACTOR)
    assert(created.ok, `setup create failed: ${JSON.stringify(created)}`)
    if (!created.ok) return
    readyCampaignId = created.value.campaignId
    const result = adminStore.validateCampaignReady(readyCampaignId)
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
  })

  await check('[24] validateCampaignReady на несъществуваща кампания -> campaign_not_found', () => {
    const result = adminStore.validateCampaignReady(randomUUID())
    assert(!result.ok && result.reason === 'campaign_not_found', `expected campaign_not_found, got ${JSON.stringify(result)}`)
  })

  await check('[25] validateCampaignReady след деактивиране на референциран gift item -> invalid_gift_item (re-validation at activation time)', async () => {
    const marketingSenderId2 = await seedProfile('Marketing Sender 4', { accountRole: 'marketing' })
    const giftItemId2 = await seedGiftItem('Gift To Deactivate')
    const created = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        giftSenderProfileId: marketingSenderId2,
        rewardTiers: [{ tierId: null, thresholdUnits: 100, rewards: [{ rewardType: 'gift_item', giftItemId: giftItemId2 }] }],
      }),
      ADMIN_ACTOR,
    )
    assert(created.ok, `setup create failed: ${JSON.stringify(created)}`)
    if (!created.ok) return

    const db = await openRawDb()
    try {
      db.prepare(`UPDATE gift_items SET is_active = 0 WHERE gift_item_id = ?;`).run(giftItemId2)
    } finally {
      db.close()
    }

    const result = adminStore.validateCampaignReady(created.value.campaignId)
    assert(!result.ok && result.reason === 'invalid_gift_item', `expected invalid_gift_item, got ${JSON.stringify(result)}`)
  })

  // ─── 9. Clone интеграция (campaignsStore.cloneCampaign копира конфигурацията) ───
  await check('[26] cloneCampaign копира earn/package/tier конфигурацията в новата кампания', async () => {
    const source = adminStore.saveCampaignConfiguration(
      minimalSaveInput({
        packageEarnRules: [{ packageKey: ACTIVE_PACKAGE_KEY, unitsPerPurchase: 15 }],
        rewardTiers: [
          { tierId: null, thresholdUnits: 50, rewards: [{ rewardType: 'yellow_coins', amount: 1000 }] },
          { tierId: null, thresholdUnits: 200, rewards: [{ rewardType: 'vip_days', days: 3 }] },
        ],
      }),
      ADMIN_ACTOR,
    )
    assert(source.ok, `setup create failed: ${JSON.stringify(source)}`)
    if (!source.ok) return

    const cloned = campaignsStore.cloneCampaign(source.value.campaignId, ADMIN_ACTOR)
    assert(cloned.ok, `clone failed: ${JSON.stringify(cloned)}`)
    if (!cloned.ok) return

    const clonedSnapshot = adminStore.getSnapshot().campaigns.find((campaign) => campaign.campaignId === cloned.campaign.campaignId)
    assert(clonedSnapshot !== undefined, 'клонираната кампания трябва да е в snapshot-а')
    assert(clonedSnapshot!.earnRules.length === source.value.earnRules.length, 'earn rules трябва да са копирани')
    assert(clonedSnapshot!.packageEarnRules.length === 1 && clonedSnapshot!.packageEarnRules[0]!.packageKey === ACTIVE_PACKAGE_KEY, 'package earn rule трябва да е копирано')
    assert(clonedSnapshot!.rewardTiers.length === 2, 'и двата reward tier-а трябва да са копирани')
    const clonedTier200 = clonedSnapshot!.rewardTiers.find((tier) => tier.thresholdUnits === 200)
    assert(clonedTier200 !== undefined && clonedTier200.rewards[0]!.rewardType === 'vip_days', 'tier-ът с 200 праг и vip_days награда трябва да е копиран коректно')
    assert(clonedTier200!.tierId !== null && clonedTier200!.tierId !== source.value.rewardTiers.find((t) => t.thresholdUnits === 200)?.tierId, 'клонираният tier трябва да има НОВ tier_id, не същия като оригинала')
  })

  // ─── 10. Soft-delete на draft кампания и влияние върху snapshot/редакция ───
  await check('[27] saveCampaignConfiguration на soft-deleted кампания -> campaign_deleted', async () => {
    const created = adminStore.saveCampaignConfiguration(minimalSaveInput(), ADMIN_ACTOR)
    assert(created.ok, `setup create failed: ${JSON.stringify(created)}`)
    if (!created.ok) return
    const deleted = campaignsStore.softDeleteCampaign(created.value.campaignId, ADMIN_ACTOR)
    assert(deleted.ok, `setup delete failed: ${JSON.stringify(deleted)}`)
    const result = adminStore.saveCampaignConfiguration(minimalSaveInput({ campaignId: created.value.campaignId }), ADMIN_ACTOR)
    assert(!result.ok && result.reason === 'campaign_deleted', `expected campaign_deleted, got ${JSON.stringify(result)}`)
  })

} finally {
  adminStore?.close()
  campaignsStore?.close()
  await cleanup()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
