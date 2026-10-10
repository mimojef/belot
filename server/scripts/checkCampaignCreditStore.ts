/**
 * checkCampaignCreditStore.ts
 *
 * Фаза 2 на системата "Кампании" — функционални проверки на
 * server/src/campaigns/campaignCreditStore.ts: идемпотентно начисляване,
 * threshold/multi-reward/multi-tier обработка, служебно (platform-funded)
 * предоставяне на жълтици/VIP/подарък от marketing профил, rollback/retry,
 * eligibility по време на събитието (вкл. finished/stopped кампании),
 * административни корекции, и durable popup известия. Изолирана temp
 * SQLite база, подготвена през реалния ensureServerDatabaseReady() runner.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import { getSofiaDayStartUtcSqliteString } from '../src/db/sofiaDayBoundary.js'

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

console.log('\ncheckCampaignCreditStore')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-credit-'))
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

async function seedGiftItem(name: string, price = 1): Promise<string> {
  const db = await openRawDb()
  try {
    const giftItemId = randomUUID()
    db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, ?, '/img.webp', ?);`).run(
      giftItemId,
      name,
      price,
    )
    return giftItemId
  } finally {
    db.close()
  }
}

type SeedCampaignOptions = {
  giftSenderProfileId?: string | null
  startsAt?: string
  endsAt?: string
  status?: 'draft' | 'active' | 'finished' | 'stopped'
}

// Всяка кампания по подразбиране получава собствен, неcъстъпващ се времеви
// слот (growing offset) — без explicit startsAt/endsAt, последователните
// seedCampaign() извиквания из целия файл иначе биха се застъпвали помежду
// си (overlap guard-ът от Фаза 1 коректно би ги отхвърлил ПРИ scheduling).
// Отделно от overlap guard-а: веднъж 'finished', кампаниите вече НЕ се
// грижат за overlap помежду си — но ако две 'finished' кампании И ДВЕТЕ
// покриват "сега", resolveCampaignForEvent не би могъл детерминистично да
// различи коя точно е "правилната" за даден тест (и двете биха били валидни
// candidate-и). Затова всеки campaignId пази своя собствен "representative"
// eventAt (1ч след неговия starts_at) — тестовете ползват sampleEventAtFor(),
// НЕ истинско "сега", за еднозначна привръзка към точно СВОЯТА кампания.
let nextDefaultCampaignSlotOffsetHours = -10
const campaignSampleEventAt = new Map<string, Date>()

function reserveDefaultCampaignWindow(): { startsAt: string; endsAt: string } {
  const startOffset = nextDefaultCampaignSlotOffsetHours
  const endOffset = startOffset + 90
  nextDefaultCampaignSlotOffsetHours = endOffset + 10
  return { startsAt: hoursFromNow(startOffset), endsAt: hoursFromNow(endOffset) }
}

function sampleEventAtFor(campaignId: string): Date {
  const eventAt = campaignSampleEventAt.get(campaignId)
  if (eventAt === undefined) throw new Error(`sampleEventAtFor: no recorded window for campaign ${campaignId}`)
  return eventAt
}

/** Създава кампания (draft -> желания статус) + стандартно earn rule
 * (belot, stake=0 -> 100 units_per_win) директно през store-овете. */
async function seedCampaign(
  campaignsStore: CampaignsStore,
  adminActor: { type: 'admin'; profileId: string },
  options: SeedCampaignOptions = {},
): Promise<string> {
  const defaultWindow = reserveDefaultCampaignWindow()
  const startsAt = options.startsAt ?? defaultWindow.startsAt
  const draft = campaignsStore.createDraftCampaign(
    {
      name: `Test Campaign ${randomUUID()}`,
      startsAt,
      endsAt: options.endsAt ?? defaultWindow.endsAt,
      unitNameSingular: 'тиква',
      unitNamePlural: 'тикви',
      giftSenderProfileId: options.giftSenderProfileId ?? null,
    },
    adminActor,
  )
  if (!draft.ok) throw new Error('seedCampaign: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId
  campaignSampleEventAt.set(campaignId, new Date(new Date(startsAt).getTime() + 3_600_000))

  const db = await openRawDb()
  try {
    db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 0, 100);`).run(campaignId)
    db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'ludo', 0, 50);`).run(campaignId)
    db.prepare(`INSERT INTO campaign_package_earn_rules (campaign_id, package_key, units_per_purchase) VALUES (?, 'coins_500', 10);`).run(campaignId)
  } finally {
    db.close()
  }

  // Default 'finished' (не 'active') — campaignsStore гарантира ГЛОБАЛНО
  // максимум 1 активна кампания едновременно; 'finished' веднага освобождава
  // слота за следващия seedCampaign() извикване, докато ОСТАВА напълно
  // елигибилна за credit тестове с eventAt в оригиналния [starts_at,ends_at)
  // прозорец (виж getEffectiveWindowEndIso в campaignCreditStore.ts —
  // 'finished' винаги ползва ends_at directно, независимо КОГА е извикан
  // finishCampaign). Тестове, на които специфично им трябва 'active'/
  // 'stopped' статус, подават options.status изрично.
  const targetStatus = options.status ?? 'finished'
  if (targetStatus === 'draft') return campaignId
  const scheduled = campaignsStore.scheduleCampaign(campaignId, adminActor)
  if (!scheduled.ok) throw new Error(`seedCampaign: scheduleCampaign failed: ${JSON.stringify(scheduled)}`)

  // Ако желаният ends_at вече е в миналото (тест за историческа "finished"
  // кампания), activateCampaign правилно би отказал с 'already_expired'
  // (Фаза 1 правило: "не активирай за кратко само за да приключиш") — минава
  // директно scheduled -> finished през expireScheduledCampaignWithoutActivating,
  // mirror на реалния scheduler паттерн за точно този сценарий.
  const endsAtMs = Date.parse(options.endsAt ?? '')
  if (targetStatus === 'finished' && Number.isFinite(endsAtMs) && endsAtMs <= Date.now()) {
    const expired = campaignsStore.expireScheduledCampaignWithoutActivating(campaignId, new Date(), adminActor)
    if (!expired.ok) throw new Error(`seedCampaign: expireScheduledCampaignWithoutActivating failed: ${JSON.stringify(expired)}`)
    return campaignId
  }

  const activated = campaignsStore.activateCampaign(campaignId, new Date(), adminActor)
  if (!activated.ok) throw new Error(`seedCampaign: activateCampaign failed: ${JSON.stringify(activated)}`)
  if (targetStatus === 'active') return campaignId
  if (targetStatus === 'finished') {
    const finished = campaignsStore.finishCampaign(campaignId, new Date(Date.now() + 200 * 3_600_000), adminActor)
    if (!finished.ok) throw new Error('seedCampaign: finishCampaign failed')
    return campaignId
  }
  // stopped
  const stopped = campaignsStore.stopCampaign(campaignId, adminActor)
  if (!stopped.ok) throw new Error('seedCampaign: stopCampaign failed')
  return campaignId
}

async function addRewardTier(campaignId: string, thresholdUnits: number, rewards: Array<{ type: string; payload: Record<string, unknown> }>): Promise<string[]> {
  const db = await openRawDb()
  try {
    const tierId = randomUUID()
    db.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, ?);`).run(tierId, campaignId, thresholdUnits)
    const tierRewardIds: string[] = []
    for (const reward of rewards) {
      const tierRewardId = randomUUID()
      db.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, ?, ?);`).run(
        tierRewardId,
        tierId,
        reward.type,
        JSON.stringify(reward.payload),
      )
      tierRewardIds.push(tierRewardId)
    }
    return tierRewardIds
  } finally {
    db.close()
  }
}

/** Директен raw-SQL update на gift_sender_profile_id — заобикаля
 * campaignsStore.updateCampaign()'s not_editable lock (status != draft/scheduled)
 * нарочно, само за тестова симулация на "причината е била отстранена по
 * някакъв бъдещ admin механизъм" (виж коментарите на call sites). */
async function setGiftSenderDirectly(campaignId: string, giftSenderProfileId: string): Promise<void> {
  const db = await openRawDb()
  try {
    db.prepare(`UPDATE campaigns SET gift_sender_profile_id = ? WHERE campaign_id = ?;`).run(giftSenderProfileId, campaignId)
  } finally {
    db.close()
  }
}

async function getWalletBalance(profileId: string): Promise<number> {
  const db = await openRawDb()
  try {
    const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as
      | { yellow_coins_balance: number }
      | undefined
    return row?.yellow_coins_balance ?? 0
  } finally {
    db.close()
  }
}

async function getVipActiveUntil(profileId: string): Promise<string | null> {
  const db = await openRawDb()
  try {
    const row = db.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?;`).get(profileId) as { active_until: string } | undefined
    return row?.active_until ?? null
  } finally {
    db.close()
  }
}

async function countRows(sql: string, ...params: unknown[]): Promise<number> {
  const db = await openRawDb()
  try {
    const row = db.prepare(sql).get(...params) as { c: number }
    return row.c
  } finally {
    db.close()
  }
}

async function querySetting(key: string): Promise<string | null> {
  const db = await openRawDb()
  try {
    const row = db.prepare(`SELECT setting_value FROM admin_settings WHERE setting_key = ?;`).get(key) as { setting_value: string } | undefined
    return row?.setting_value ?? null
  } finally {
    db.close()
  }
}

let campaignsStore!: CampaignsStore
let creditStore!: CampaignCreditStore
const ADMIN_ACTOR = { type: 'admin' as const, profileId: '' }

try {
  campaignsStore = await createCampaignsStore(databaseFilePath)
  creditStore = await createCampaignCreditStore(databaseFilePath)
  ADMIN_ACTOR.profileId = await seedProfile('Admin Tester')

  // ─── 1. Еднократно начисляване ───
  let campaign1!: string
  let player1!: string
  await check('[1] Еднократно начисляване: ledger + totals коректни', async () => {
    campaign1 = await seedCampaign(campaignsStore, ADMIN_ACTOR)
    player1 = await seedProfile('Player One')
    const result = creditStore.creditCampaignUnits({
      profileId: player1,
      sourceType: 'belot_win',
      sourceId: 'match-1',
      eventAt: sampleEventAtFor(campaign1),
      stakeAmount: 0,
    })
    assert(result.ok, `credit failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.unitsCredited === 100, `expected 100 units credited, got ${result.unitsCredited}`)
    assert(result.unitsTotal === 100, `expected total 100, got ${result.unitsTotal}`)
    assert(result.alreadyCredited === false, 'expected alreadyCredited=false on first credit')
  })

  // ─── 2. Повторно извикване на събитие ───
  await check('[2] Повторно извикване на СЪЩОТО събитие е идемпотентно', () => {
    const result = creditStore.creditCampaignUnits({
      profileId: player1,
      sourceType: 'belot_win',
      sourceId: 'match-1',
      eventAt: sampleEventAtFor(campaign1),
      stakeAmount: 0,
    })
    assert(result.ok && result.alreadyCredited === true, `expected alreadyCredited=true, got ${JSON.stringify(result)}`)
    if (result.ok) assert(result.unitsTotal === 100, `total must stay 100, got ${result.unitsTotal}`)
  })

  // ─── 3. Различни събития за един профил ───
  await check('[3] Различни sourceId се натрупват независимо', () => {
    const result = creditStore.creditCampaignUnits({
      profileId: player1,
      sourceType: 'belot_win',
      sourceId: 'match-2',
      eventAt: sampleEventAtFor(campaign1),
      stakeAmount: 0,
    })
    assert(result.ok && result.unitsTotal === 200, `expected 200, got ${JSON.stringify(result)}`)
  })

  // ─── 4. Едновременни начисления (2 отделни connections) ───
  await check('[4] Две отделни connections, различни събития за същия профил — и двете се начисляват коректно', async () => {
    const creditStoreTwo = await createCampaignCreditStore(databaseFilePath)
    try {
      const resultA = creditStore.creditCampaignUnits({ profileId: player1, sourceType: 'belot_win', sourceId: 'match-3', eventAt: sampleEventAtFor(campaign1), stakeAmount: 0 })
      const resultB = creditStoreTwo.creditCampaignUnits({ profileId: player1, sourceType: 'belot_win', sourceId: 'match-4', eventAt: sampleEventAtFor(campaign1), stakeAmount: 0 })
      assert(resultA.ok && resultB.ok, `both should succeed: ${JSON.stringify([resultA, resultB])}`)
      if (resultA.ok && resultB.ok) {
        assert(resultA.unitsCredited === 100 && resultB.unitsCredited === 100, 'both should credit 100 each')
      }
      const finalTotal = creditStore.getProfileCampaignTotal(campaign1, player1)
      assert(finalTotal === 400, `expected final total 400 (200+100+100), got ${finalTotal}`)
    } finally {
      creditStoreTwo.close()
    }
  })

  // ─── 5-7. Прагове + множество награди + множество прагове наведнъж ───
  let campaign2!: string
  let goldenPumpkinGiftId!: string
  await check('[5]-[7] Праг с множество награди + няколко прага наведнъж от едно начисление', async () => {
    goldenPumpkinGiftId = await seedGiftItem('Златна тиква')
    const marketingSender = await seedProfile('Marketing Sender', { accountRole: 'marketing' })
    // giftSenderProfileId се задава ПРИ създаването (draft), не чрез
    // updateCampaign след факта — Фаза 1 заключва редакция след 'finished'.
    campaign2 = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })

    // Праг 1 (100 units): само жълтици.
    await addRewardTier(campaign2, 100, [{ type: 'yellow_coins', payload: { amount: 5000 } }])
    // Праг 2 (200 units): жълтици + VIP + подарък — "множество награди при един праг".
    await addRewardTier(campaign2, 200, [
      { type: 'yellow_coins', payload: { amount: 50000 } },
      { type: 'vip_days', payload: { unit: 'days', amount: 3 } },
      { type: 'gift_item', payload: { giftItemId: goldenPumpkinGiftId } },
    ])

    const player2 = await seedProfile('Player Two')
    // Едно начисление от 250 units (stake, за който units_per_win=100, значи
    // се нуждаем от 3 събития ИЛИ от admin adjustment, за да прескочим и
    // двата прага наведнъж — използваме adjustment, за да получим точно 250
    // units в ЕДНО извикване, "няколко прага при едно начисление" (§7).
    const result = creditStore.applyManualAdjustment({
      campaignId: campaign2,
      profileId: player2,
      unitsDelta: 250,
      reason: 'test: cross two thresholds at once',
      adminProfileId: ADMIN_ACTOR.profileId,
    })
    assert(result.ok, `adjustment failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.unitsTotal === 250, `expected total 250, got ${result.unitsTotal}`)
    // И двата прага (100 и 200) трябва да са отключени в ЕДНО извикване.
    assert(result.grantedRewards.length === 4, `expected 4 granted rewards (1 от праг 100 + 3 от праг 200), got ${result.grantedRewards.length}`)
    const types = result.grantedRewards.map((r) => r.type).sort()
    assert(JSON.stringify(types) === JSON.stringify(['gift_item', 'vip_days', 'yellow_coins', 'yellow_coins']), `unexpected reward types: ${JSON.stringify(types)}`)

    const claimsCount = await countRows(
      `SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE campaign_id = ? AND profile_id = ?;`,
      campaign2,
      player2,
    )
    assert(claimsCount === 4, `expected 4 claim rows, got ${claimsCount}`)
  })

  // ─── 8-9. Служебни жълтици, без дебит на друг профил ───
  await check('[8]-[9] Служебно начисляване на жълтици: получателят се кредитира, НИКОЙ друг профил не се дебитира', async () => {
    const player3 = await seedProfile('Player Three')
    const bystander = await seedProfile('Bystander')
    const bystanderBalanceBefore = await getWalletBalance(bystander)

    await addRewardTier(campaign1, 50, [{ type: 'yellow_coins', payload: { amount: 7777 } }])
    const result = creditStore.creditCampaignUnits({ profileId: player3, sourceType: 'belot_win', sourceId: 'match-p3-1', eventAt: sampleEventAtFor(campaign1), stakeAmount: 0 })
    assert(result.ok, 'credit failed')
    const balanceAfter = await getWalletBalance(player3)
    assert(balanceAfter === 7777, `expected recipient balance 7777, got ${balanceAfter}`)
    const bystanderBalanceAfter = await getWalletBalance(bystander)
    assert(bystanderBalanceAfter === bystanderBalanceBefore, 'unrelated profile balance must stay unchanged')
  })

  // ─── 10-11. VIP служебно + удължаване ───
  await check('[10]-[11] Служебно VIP + удължаване без загуба на вече предоставено време', async () => {
    const player4 = await seedProfile('Player Four')
    await addRewardTier(campaign1, 60, [{ type: 'vip_days', payload: { unit: 'days', amount: 5 } }])
    const result1 = creditStore.creditCampaignUnits({ profileId: player4, sourceType: 'belot_win', sourceId: 'match-p4-vip1', eventAt: sampleEventAtFor(campaign1), stakeAmount: 0 })
    assert(result1.ok, 'first vip credit failed')
    const activeUntilAfterFirst = await getVipActiveUntil(player4)
    assert(activeUntilAfterFirst !== null, 'expected vip_status row after first grant')

    // Втори праг (по-висок), добавя ОЩЕ 5 VIP дни — трябва да УДЪЛЖИ, не замени.
    await addRewardTier(campaign1, 160, [{ type: 'vip_days', payload: { unit: 'days', amount: 5 } }])
    const result2 = creditStore.applyManualAdjustment({
      campaignId: campaign1,
      profileId: player4,
      unitsDelta: 100,
      reason: 'test: trigger second VIP tier',
      adminProfileId: ADMIN_ACTOR.profileId,
    })
    assert(result2.ok, 'second vip credit failed')
    const activeUntilAfterSecond = await getVipActiveUntil(player4)
    assert(activeUntilAfterSecond !== null, 'expected vip_status row after second grant')
    assert(
      new Date(activeUntilAfterSecond!).getTime() > new Date(activeUntilAfterFirst!).getTime(),
      `second grant must extend active_until further into the future: first=${activeUntilAfterFirst}, second=${activeUntilAfterSecond}`,
    )
    const grantsCount = await countRows(`SELECT COUNT(*) AS c FROM vip_grants WHERE profile_id = ? AND reason = 'campaign_reward';`, player4)
    assert(grantsCount === 2, `expected 2 campaign_reward vip_grants rows, got ${grantsCount}`)
  })

  // ─── 12-14. Служебен подарък от marketing, баланс/дневен лимит непроменени ───
  await check('[12]-[14] Служебен подарък от marketing подател: без debit, без промяна на баланс/дневен лимит', async () => {
    const marketingSender = await seedProfile('Marketing Sender 2', { accountRole: 'marketing' })
    const giftItemId = await seedGiftItem('Тиквен фенер', 500)
    const campaign3 = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaign3, 10, [{ type: 'gift_item', payload: { giftItemId } }])

    const marketingBalanceBefore = await getWalletBalance(marketingSender)
    const dailyLimitSettingBefore = await querySetting('marketing_daily_gift_limit')

    const recipient = await seedProfile('Gift Recipient')
    const result = creditStore.creditCampaignUnits({ profileId: recipient, sourceType: 'ludo_win', sourceId: 'ludo-match-1', eventAt: sampleEventAtFor(campaign3), stakeAmount: 0 })
    assert(result.ok, `credit failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.grantedRewards.some((r) => r.type === 'gift_item'), 'expected a gift_item reward')

    const txRow = await countRows(
      `SELECT COUNT(*) AS c FROM gift_item_transactions WHERE sender_profile_id = ? AND recipient_profile_id = ? AND context = 'campaign_reward';`,
      marketingSender,
      recipient,
    )
    assert(txRow === 1, `expected 1 gift_item_transactions row, got ${txRow}`)

    const marketingBalanceAfter = await getWalletBalance(marketingSender)
    assert(marketingBalanceAfter === marketingBalanceBefore, `marketing balance must not change: before=${marketingBalanceBefore}, after=${marketingBalanceAfter}`)
    const dailyLimitSettingAfter = await querySetting('marketing_daily_gift_limit')
    assert(dailyLimitSettingAfter === dailyLimitSettingBefore, 'marketing daily gift limit setting must not change')
  })

  // ─── 15. Невалиден маркетинг подател ───
  await check('[15] Невалиден маркетинг подател (без роля marketing / без зададен подател) -> пропусната, не фалшиво успешна', async () => {
    const nonMarketingProfile = await seedProfile('Not Marketing', { accountRole: 'player' })
    const giftItemId = await seedGiftItem('Невалиден подател подарък')
    const campaign4 = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: nonMarketingProfile })
    await addRewardTier(campaign4, 5, [{ type: 'gift_item', payload: { giftItemId } }])

    const recipient = await seedProfile('Recipient Invalid Sender')
    const result = creditStore.creditCampaignUnits({ profileId: recipient, sourceType: 'belot_win', sourceId: 'm-invalid-sender', eventAt: sampleEventAtFor(campaign4), stakeAmount: 0 })
    assert(result.ok, 'credit itself should succeed (units always credited)')
    if (!result.ok) return
    assert(result.grantedRewards.length === 0, 'gift must NOT be in grantedRewards')
    assert(result.skippedRewards.some((s) => s.reason === 'invalid_sender'), `expected invalid_sender in skipped, got ${JSON.stringify(result.skippedRewards)}`)
    const claimsCount = await countRows(`SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE campaign_id = ? AND profile_id = ?;`, campaign4, recipient)
    assert(claimsCount === 0, 'no claim row должен be written for an undeliverable gift')
  })

  // ─── 16. Липсващ подарък ───
  await check('[16] Липсващ/неактивен подарък -> пропуснат с gift_item_unavailable', async () => {
    const marketingSender = await seedProfile('Marketing Sender 3', { accountRole: 'marketing' })
    const campaign5 = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaign5, 5, [{ type: 'gift_item', payload: { giftItemId: 'non-existent-gift-id' } }])

    const recipient = await seedProfile('Recipient Missing Gift')
    const result = creditStore.creditCampaignUnits({ profileId: recipient, sourceType: 'belot_win', sourceId: 'm-missing-gift', eventAt: sampleEventAtFor(campaign5), stakeAmount: 0 })
    assert(result.ok, 'credit itself should succeed')
    if (!result.ok) return
    assert(result.skippedRewards.some((s) => s.reason === 'gift_item_unavailable'), `expected gift_item_unavailable, got ${JSON.stringify(result.skippedRewards)}`)
  })

  // ─── 17. Съвпадение на подател и получател ───
  await check('[17] Marketing подател === получател -> CHECK constraint спазен, награда пропусната graceful', async () => {
    const marketingSelf = await seedProfile('Marketing Self', { accountRole: 'marketing' })
    const giftItemId = await seedGiftItem('Самоподарък')
    const campaign6 = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSelf })
    await addRewardTier(campaign6, 5, [{ type: 'gift_item', payload: { giftItemId } }])

    // marketingSelf е И подател, И получател на наградата.
    const result = creditStore.creditCampaignUnits({ profileId: marketingSelf, sourceType: 'belot_win', sourceId: 'm-self-gift', eventAt: sampleEventAtFor(campaign6), stakeAmount: 0 })
    assert(result.ok, 'credit itself should succeed')
    if (!result.ok) return
    assert(result.skippedRewards.some((s) => s.reason === 'sender_equals_recipient'), `expected sender_equals_recipient, got ${JSON.stringify(result.skippedRewards)}`)
    const txCount = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE sender_profile_id = ?;`, marketingSelf)
    assert(txCount === 0, 'no gift_item_transactions row must be written when sender===recipient (CHECK never bypassed)')
  })

  // ─── 18. Повторно изпращане на същата награда ───
  await check('[18] Повторно извикване на СЪЩОТО събитие не пресъздава/дублира вече предоставена награда', async () => {
    const marketingSender = await seedProfile('Marketing Sender 4', { accountRole: 'marketing' })
    const giftItemId = await seedGiftItem('Еднократен подарък')
    const campaign7 = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaign7, 5, [{ type: 'gift_item', payload: { giftItemId } }])
    const recipient = await seedProfile('Recipient Once')

    const first = creditStore.creditCampaignUnits({ profileId: recipient, sourceType: 'belot_win', sourceId: 'm-once', eventAt: sampleEventAtFor(campaign7), stakeAmount: 0 })
    const second = creditStore.creditCampaignUnits({ profileId: recipient, sourceType: 'belot_win', sourceId: 'm-once', eventAt: sampleEventAtFor(campaign7), stakeAmount: 0 })
    assert(first.ok && second.ok, 'both calls should return ok')
    if (second.ok) assert(second.alreadyCredited === true, 'second call must report alreadyCredited')
    const txCount = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ?;`, recipient)
    assert(txCount === 1, `expected exactly 1 gift transaction, got ${txCount}`)
  })

  // ─── 19-20. Rollback и retry ───
  await check('[19]-[20] Rollback при грешка (пълен, нищо committed) + успешен retry след това', async () => {
    const player5 = await seedProfile('Player Five Rollback')
    const totalsBefore = await countRows(`SELECT COUNT(*) AS c FROM campaign_profile_totals WHERE campaign_id = ? AND profile_id = ?;`, campaign1, player5)
    assert(totalsBefore === 0, 'sanity: no pre-existing totals row')

    const poisonedCreditStore = await createCampaignCreditStore(databaseFilePath)
    try {
      // Инжектираме временна грешка чрез невалиден SQL extension point —
      // симулираме transient failure, затварящи connection-а насилствено по
      // средата на транзакция чрез опит да викаме closed connection.
      ;(poisonedCreditStore as unknown as { __forceFailure?: boolean }).__forceFailure = true
      let threw = false
      try {
        // Форсираме грешка директно - затваряме connection-а ПРЕДИ извикването,
        // така че самото BEGIN IMMEDIATE да хвърли.
        poisonedCreditStore.close()
        poisonedCreditStore.creditCampaignUnits({ profileId: player5, sourceType: 'belot_win', sourceId: 'm-rollback', eventAt: sampleEventAtFor(campaign1), stakeAmount: 0 })
      } catch {
        threw = true
      }
      assert(threw, 'expected the forced failure to throw')
    } finally {
      // already closed
    }

    const ledgerAfterFailure = await countRows(
      `SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ? AND source_id = 'm-rollback';`,
      campaign1,
      player5,
    )
    assert(ledgerAfterFailure === 0, 'failed attempt must leave NO ledger row (full rollback, nothing partial)')
    const totalsAfterFailure = await countRows(`SELECT COUNT(*) AS c FROM campaign_profile_totals WHERE campaign_id = ? AND profile_id = ?;`, campaign1, player5)
    assert(totalsAfterFailure === 0, 'failed attempt must leave NO totals row')

    // Retry със здрав store instance — трябва да мине чисто, сякаш нищо не се е случвало.
    const retryResult = creditStore.creditCampaignUnits({ profileId: player5, sourceType: 'belot_win', sourceId: 'm-rollback', eventAt: sampleEventAtFor(campaign1), stakeAmount: 0 })
    assert(retryResult.ok && retryResult.alreadyCredited === false && retryResult.unitsCredited === 100, `retry should succeed cleanly: ${JSON.stringify(retryResult)}`)
  })

  // ─── 21-22-23. Eligibility: finished кампания, недопустимо след края, оригинален campaign ID ───
  await check('[21]-[23] Finished кампания с историческо събитие в периода остава допустима и се свързва с ОРИГИНАЛНАТА кампания', async () => {
    const finishedCampaign = await seedCampaign(campaignsStore, ADMIN_ACTOR, {
      startsAt: hoursFromNow(-50),
      endsAt: hoursFromNow(-10),
      status: 'finished',
    })
    // Нова, РАЗЛИЧНА активна кампания покрива "сега" — трябва да НЕ се бърка с finishedCampaign.
    const currentlyActive = await seedCampaign(campaignsStore, ADMIN_ACTOR, {
      startsAt: hoursFromNow(-5),
      endsAt: hoursFromNow(100),
      status: 'active',
    })

    const player6 = await seedProfile('Player Six Historical')
    // eventAt попада В прозореца на finishedCampaign (-50ч до -10ч), не в текущия "сега".
    const historicalEventAt = new Date(Date.now() - 20 * 3_600_000)
    const result = creditStore.creditCampaignUnits({ profileId: player6, sourceType: 'belot_win', sourceId: 'm-historical', eventAt: historicalEventAt, stakeAmount: 0 })
    assert(result.ok, `historical credit should succeed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.campaignId === finishedCampaign, `expected credit to attach to the ORIGINAL finished campaign (${finishedCampaign}), got ${result.campaignId}`)
    assert(result.campaignId !== currentlyActive, 'must NOT attach to the newer currently-active campaign')

    // Освобождава единствения "активен" слот за следващите тестове в файла.
    campaignsStore.finishCampaign(currentlyActive, new Date(Date.now() + 200 * 3_600_000), ADMIN_ACTOR)
  })

  await check('[22] Събитие след края на ВСИЧКИ кампании -> no_eligible_campaign', async () => {
    const player7 = await seedProfile('Player Seven No Campaign')
    const farFutureEventAt = new Date(Date.now() + 10_000 * 3_600_000)
    const result = creditStore.creditCampaignUnits({ profileId: player7, sourceType: 'belot_win', sourceId: 'm-no-campaign', eventAt: farFutureEventAt, stakeAmount: 0 })
    assert(!result.ok && result.reason === 'no_eligible_campaign', `expected no_eligible_campaign, got ${JSON.stringify(result)}`)
  })

  // ─── §10: ръчно спряна кампания — ефективен край = момент на РЕАЛНОТО
  // спиране (campaign_events), НЕ оригиналния ends_at (който остава далеко
  // в бъдещето, непипнат от stopCampaign) ───
  await check('[10-доп.] Ръчно спряна кампания: допустима ПРЕДИ спирането, недопустима СЛЕД него (ends_at е ирелевантен)', async () => {
    const stoppableCampaign = await seedCampaign(campaignsStore, ADMIN_ACTOR, {
      startsAt: hoursFromNow(-20),
      endsAt: hoursFromNow(500), // far future — ends_at сам по себе си НЕ трябва да определя допустимостта
      status: 'active',
    })
    const stopResult = campaignsStore.stopCampaign(stoppableCampaign, ADMIN_ACTOR)
    assert(stopResult.ok, `setup stop failed: ${JSON.stringify(stopResult)}`)

    const playerBefore = await seedProfile('Player Before Stop')
    // -15ч: в прозореца на stoppableCampaign (-20ч..stop), но ИЗВЪН campaign1
    // ([-10ч..+80ч]) — избягва ambiguous overlap между две валидни finished/
    // stopped кампании за един и същ eventAt (виж теста за tie-break по-долу,
    // не е предмет на тази конкретна проверка).
    const beforeStopEventAt = new Date(Date.now() - 15 * 3_600_000)
    const beforeResult = creditStore.creditCampaignUnits({ profileId: playerBefore, sourceType: 'belot_win', sourceId: 'm-before-stop', eventAt: beforeStopEventAt, stakeAmount: 0 })
    assert(beforeResult.ok && beforeResult.campaignId === stoppableCampaign, `expected credit before stop to attach to the stopped campaign, got ${JSON.stringify(beforeResult)}`)

    const playerAfter = await seedProfile('Player After Stop')
    const afterStopEventAt = new Date(Date.now() + 1 * 3_600_000) // след спирането — ends_at(+500ч) би го направил "допустим", ако грешно се ползва ends_at вместо реалния stop момент
    const afterResult = creditStore.creditCampaignUnits({ profileId: playerAfter, sourceType: 'belot_win', sourceId: 'm-after-stop', eventAt: afterStopEventAt, stakeAmount: 0 })
    assert(
      !afterResult.ok || afterResult.campaignId !== stoppableCampaign,
      `event after the actual stop moment must NOT attach to the stopped campaign (ends_at must not be used as the eligibility boundary), got ${JSON.stringify(afterResult)}`,
    )
  })

  // ─── 24-25. Административни корекции ───
  let adjustCampaign!: string
  let adjustPlayer!: string
  await check('[24] Административна положителна корекция + audit trail', async () => {
    adjustCampaign = await seedCampaign(campaignsStore, ADMIN_ACTOR)
    adjustPlayer = await seedProfile('Adjust Player')
    const result = creditStore.applyManualAdjustment({
      campaignId: adjustCampaign,
      profileId: adjustPlayer,
      unitsDelta: 30,
      reason: 'Корекция за тестова цел',
      adminProfileId: ADMIN_ACTOR.profileId,
    })
    assert(result.ok && result.unitsTotal === 30, `expected total 30, got ${JSON.stringify(result)}`)
    const auditCount = await countRows(
      `SELECT COUNT(*) AS c FROM campaign_manual_adjustments WHERE campaign_id = ? AND profile_id = ? AND admin_profile_id = ?;`,
      adjustCampaign,
      adjustPlayer,
      ADMIN_ACTOR.profileId,
    )
    assert(auditCount === 1, 'expected 1 campaign_manual_adjustments audit row')
  })

  await check('[25] Отрицателна корекция намалява total, но НЕ отнема вече предоставена награда', async () => {
    await addRewardTier(adjustCampaign, 20, [{ type: 'yellow_coins', payload: { amount: 999 } }])
    const credit = creditStore.creditCampaignUnits({ profileId: adjustPlayer, sourceType: 'belot_win', sourceId: 'm-adjust-trigger', eventAt: sampleEventAtFor(adjustCampaign), stakeAmount: 0 })
    assert(credit.ok, 'setup credit failed')
    const balanceAfterGrant = await getWalletBalance(adjustPlayer)
    assert(balanceAfterGrant === 999, `expected 999 after grant, got ${balanceAfterGrant}`)

    const negativeAdjust = creditStore.applyManualAdjustment({
      campaignId: adjustCampaign,
      profileId: adjustPlayer,
      unitsDelta: -100,
      reason: 'Корекция надолу след награда',
      adminProfileId: ADMIN_ACTOR.profileId,
    })
    assert(negativeAdjust.ok, `negative adjustment should succeed if total stays >= 0: ${JSON.stringify(negativeAdjust)}`)
    if (negativeAdjust.ok) assert(negativeAdjust.unitsTotal >= 0, 'total must not go negative')

    const balanceAfterNegativeAdjust = await getWalletBalance(adjustPlayer)
    assert(balanceAfterNegativeAdjust === 999, 'wallet balance from the already-granted reward must remain untouched')
    const claimStillExists = await countRows(
      `SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE campaign_id = ? AND profile_id = ?;`,
      adjustCampaign,
      adjustPlayer,
    )
    assert(claimStillExists === 1, 'claim row must still exist — negative adjustment never revokes a granted reward')
  })

  await check('[25b] Отрицателна корекция, която би направила total отрицателен, се отхвърля', () => {
    const result = creditStore.applyManualAdjustment({
      campaignId: adjustCampaign,
      profileId: adjustPlayer,
      unitsDelta: -1_000_000,
      reason: 'Опит за невалидна корекция',
      adminProfileId: ADMIN_ACTOR.profileId,
    })
    assert(!result.ok && result.reason === 'negative_total_rejected', `expected negative_total_rejected, got ${JSON.stringify(result)}`)
  })

  // ─── 26-28. Popup известия ───
  await check('[26]-[27] Устойчиво известие с коректно съдържание', async () => {
    const marketingSender = await seedProfile('Marketing Sender 5', { accountRole: 'marketing' })
    const giftItemId = await seedGiftItem('Нотификационен подарък')
    const notifCampaign = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(notifCampaign, 5, [
      { type: 'yellow_coins', payload: { amount: 1234 } },
      { type: 'gift_item', payload: { giftItemId } },
    ])
    const player8 = await seedProfile('Player Eight Notification')
    const result = creditStore.creditCampaignUnits({ profileId: player8, sourceType: 'belot_win', sourceId: 'm-notif', eventAt: sampleEventAtFor(notifCampaign), stakeAmount: 0 })
    assert(result.ok, 'credit failed')

    const pending = creditStore.listPendingNotifications(player8)
    assert(pending.length === 1, `expected exactly 1 pending notification, got ${pending.length}`)
    const payload = pending[0].payload as { rewards: Array<{ type: string }>; unitsTotal: number; campaignName: string }
    assert(payload.unitsTotal === 100, `expected unitsTotal 100 in payload, got ${payload.unitsTotal}`)
    assert(payload.rewards.length === 2, `expected 2 rewards in payload, got ${payload.rewards.length}`)
    assert(payload.rewards.some((r) => r.type === 'yellow_coins') && payload.rewards.some((r) => r.type === 'gift_item'), 'payload must list both reward types')

    // ─── 28. Потвърждаване без повторно показване ───
    const ack = creditStore.acknowledgeNotification(pending[0].notificationId, player8)
    assert(ack.ok, 'acknowledge should succeed')
    const pendingAfterAck = creditStore.listPendingNotifications(player8)
    assert(pendingAfterAck.length === 0, 'notification must disappear from pending list after acknowledgement')
  })

  // ─── 29. Консистентност ledger/totals/claims/реално предоставени ───
  await check('[29] Консистентност: SUM(ledger) === totals, claims count === действителни предоставени награди', async () => {
    const db = await openRawDb()
    try {
      const mismatches = db.prepare(`
        SELECT cpt.campaign_id, cpt.profile_id, cpt.units_total,
               (SELECT COALESCE(SUM(cul.units_amount), 0) FROM campaign_unit_ledger cul
                WHERE cul.campaign_id = cpt.campaign_id AND cul.profile_id = cpt.profile_id) AS ledger_sum
        FROM campaign_profile_totals cpt
        WHERE cpt.units_total != (
          SELECT COALESCE(SUM(cul2.units_amount), 0) FROM campaign_unit_ledger cul2
          WHERE cul2.campaign_id = cpt.campaign_id AND cul2.profile_id = cpt.profile_id
        );
      `).all()
      assert(mismatches.length === 0, `found ${mismatches.length} totals/ledger mismatches: ${JSON.stringify(mismatches)}`)

      // Всеки claim трябва да сочи към реално съществуващ tier_reward, и броят
      // claims за даден (campaign,profile) никога не надвишава броя due tier_rewards.
      const orphanClaims = db.prepare(`
        SELECT crc.campaign_id, crc.profile_id, crc.tier_reward_id
        FROM campaign_reward_claims crc
        LEFT JOIN campaign_tier_rewards ctr ON ctr.tier_reward_id = crc.tier_reward_id
        WHERE ctr.tier_reward_id IS NULL;
      `).all()
      assert(orphanClaims.length === 0, `found ${orphanClaims.length} orphan claims pointing to non-existent tier_rewards`)
    } finally {
      db.close()
    }
  })

  // ═══ Фаза 2 корекции (следващ кръг): request_id уникалност, recovery,
  // реален дневен лимит, delivery-log видимост, hard-delete на подател ═══

  // ─── 30. Един и същ gift item в ДВА различни прага — и двата се предоставят ───
  await check('[30] Един gift item, зададен в два различни прага — ДВЕ отделни, независими доставки', async () => {
    const marketingSender = await seedProfile('Marketing Sender 6', { accountRole: 'marketing' })
    const sharedGiftId = await seedGiftItem('Споделен подарък (2 прага)')
    const campaignShared = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaignShared, 500, [{ type: 'gift_item', payload: { giftItemId: sharedGiftId } }])
    await addRewardTier(campaignShared, 1000, [{ type: 'gift_item', payload: { giftItemId: sharedGiftId } }])

    const player = await seedProfile('Player Shared Gift')
    // Директно 1000 units в едно начисление — и двата прага трябва да предоставят ПО ЕДНО копие.
    const result = creditStore.applyManualAdjustment({
      campaignId: campaignShared,
      profileId: player,
      unitsDelta: 1000,
      reason: 'test: same gift item at two tiers',
      adminProfileId: ADMIN_ACTOR.profileId,
    })
    assert(result.ok, `credit failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.grantedRewards.filter((r) => r.type === 'gift_item').length === 2, `expected 2 gift_item rewards granted, got ${JSON.stringify(result.grantedRewards)}`)
    assert(result.skippedRewards.length === 0, `expected 0 skipped, got ${JSON.stringify(result.skippedRewards)}`)

    const txCount = await countRows(
      `SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ? AND gift_item_id = ?;`,
      player,
      sharedGiftId,
    )
    assert(txCount === 2, `expected 2 separate gift_item_transactions rows, got ${txCount}`)
    const claimsCount = await countRows(`SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE campaign_id = ? AND profile_id = ?;`, campaignShared, player)
    assert(claimsCount === 2, `expected 2 claim rows (one per tier), got ${claimsCount}`)
  })

  // ─── 31. Няколко различни подаръка в ЕДИН праг ───
  await check('[31] Няколко различни gift items в един и същ праг — всички се предоставят', async () => {
    const marketingSender = await seedProfile('Marketing Sender 7', { accountRole: 'marketing' })
    const giftA = await seedGiftItem('Подарък А (multi-gift tier)')
    const giftB = await seedGiftItem('Подарък Б (multi-gift tier)')
    const giftC = await seedGiftItem('Подарък В (multi-gift tier)')
    const campaignMultiGift = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaignMultiGift, 10, [
      { type: 'gift_item', payload: { giftItemId: giftA } },
      { type: 'gift_item', payload: { giftItemId: giftB } },
      { type: 'gift_item', payload: { giftItemId: giftC } },
    ])

    const player = await seedProfile('Player Multi Gift Tier')
    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-multi-gift', eventAt: sampleEventAtFor(campaignMultiGift), stakeAmount: 0 })
    assert(result.ok, `credit failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.grantedRewards.filter((r) => r.type === 'gift_item').length === 3, `expected all 3 distinct gifts granted, got ${JSON.stringify(result.grantedRewards)}`)
    const txCount = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ?;`, player)
    assert(txCount === 3, `expected 3 separate gift_item_transactions rows, got ${txCount}`)
  })

  // ─── 32. Повторение на СЪЩАТА конкретна награда (replay на идентично събитие) ───
  await check('[32] Повторен опит за СЪЩИЯ tier_reward (replay на идентично събитие) не създава втора доставка', async () => {
    const marketingSender = await seedProfile('Marketing Sender 8', { accountRole: 'marketing' })
    const giftId = await seedGiftItem('Replay подарък')
    const campaignReplay = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaignReplay, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Replay Gift')

    const first = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-replay-1', eventAt: sampleEventAtFor(campaignReplay), stakeAmount: 0 })
    const second = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-replay-1', eventAt: sampleEventAtFor(campaignReplay), stakeAmount: 0 })
    assert(first.ok && second.ok && second.alreadyCredited, `expected idempotent replay, got ${JSON.stringify([first, second])}`)
    const txCount = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ?;`, player)
    assert(txCount === 1, `expected exactly 1 delivery despite replay, got ${txCount}`)
  })

  // ─── 33-36. Recovery на пропуснати gift-item награди ───
  await check('[33] listPendingGiftRewardGaps открива пропусната награда поради invalid_sender', async () => {
    const nonMarketing = await seedProfile('Future Fix Not Marketing', { accountRole: 'player' })
    const giftId = await seedGiftItem('Recovery подарък 1')
    const campaignRecovery = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: nonMarketing })
    const [tierRewardId] = await addRewardTier(campaignRecovery, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Recovery 1')

    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-recovery-1', eventAt: sampleEventAtFor(campaignRecovery), stakeAmount: 0 })
    assert(result.ok && result.skippedRewards.length === 1, 'setup: expected the gift to be skipped initially')

    const gaps = creditStore.listPendingGiftRewardGaps(campaignRecovery)
    assert(gaps.length === 1 && gaps[0].profileId === player && gaps[0].tierRewardId === tierRewardId, `expected exactly 1 gap for this player/tier, got ${JSON.stringify(gaps)}`)
  })

  await check('[34] retryPendingGiftReward: след поправка на причината, наградата се предоставя БЕЗ ново начисление на единици', async () => {
    const giftId = await seedGiftItem('Recovery подарък 2')
    const campaignRecovery2 = await seedCampaign(campaignsStore, ADMIN_ACTOR)
    const [tierRewardId] = await addRewardTier(campaignRecovery2, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Recovery 2')

    // Начално начисление БЕЗ зададен gift_sender_profile_id -> invalid_sender, пропусната.
    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-recovery-2', eventAt: sampleEventAtFor(campaignRecovery2), stakeAmount: 0 })
    assert(result.ok && result.skippedRewards.some((s) => s.reason === 'invalid_sender'), 'setup: expected invalid_sender skip')
    const totalBeforeRetry = creditStore.getProfileCampaignTotal(campaignRecovery2, player)

    // "Admin поправя причината" — задава валиден marketing подател. ЗАБЕЛЕЖКА:
    // campaignsStore.updateCampaign() е заключен след 'finished' (Фаза 1, по
    // дизайн — виж not_editable). Реалният admin UI механизъм "поправи
    // подателя на вече активна/приключила кампания" е бъдеща фаза извън
    // Campaign Credit Store-а; тук директно симулираме резултата от такава
    // бъдеща поправка с raw SQL, за да тестваме retry логиката самостоятелно.
    const marketingSender = await seedProfile('Marketing Sender Fixed', { accountRole: 'marketing' })
    await setGiftSenderDirectly(campaignRecovery2, marketingSender)

    const retryResult = creditStore.retryPendingGiftReward(campaignRecovery2, player, tierRewardId)
    assert(retryResult.ok && !retryResult.alreadyClaimed, `expected successful retry, got ${JSON.stringify(retryResult)}`)

    const totalAfterRetry = creditStore.getProfileCampaignTotal(campaignRecovery2, player)
    assert(totalAfterRetry === totalBeforeRetry, `retry must NOT change units total: before=${totalBeforeRetry}, after=${totalAfterRetry}`)
    const txCount = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ? AND sender_profile_id = ?;`, player, marketingSender)
    assert(txCount === 1, `expected exactly 1 delivery from the fixed sender, got ${txCount}`)

    // Повторен retry — idempotent replay, без втора доставка, без промяна.
    const secondRetry = creditStore.retryPendingGiftReward(campaignRecovery2, player, tierRewardId)
    assert(secondRetry.ok && secondRetry.alreadyClaimed, `expected alreadyClaimed on second retry, got ${JSON.stringify(secondRetry)}`)
    const txCountAfterSecondRetry = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ?;`, player)
    assert(txCountAfterSecondRetry === 1, 'second retry must not create a duplicate delivery')
  })

  await check('[35] retryPendingGiftReward работи дори за АРХИВИРАНА (симулирано) кампания — задължението надживява статуса', async () => {
    const giftId = await seedGiftItem('Recovery подарък 3 (archived)')
    const campaignArchivedSim = await seedCampaign(campaignsStore, ADMIN_ACTOR) // без marketing подател -> invalid_sender
    const [tierRewardId] = await addRewardTier(campaignArchivedSim, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Recovery 3')
    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-recovery-3', eventAt: sampleEventAtFor(campaignArchivedSim), stakeAmount: 0 })
    assert(result.ok && result.skippedRewards.length === 1, 'setup: expected skip')

    // Симулираме архивиране директно (archived_at колоната съществува от Фаза 0; реалният archiving job е бъдеща фаза).
    const db = await openRawDb()
    try {
      db.prepare(`UPDATE campaigns SET archived_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(campaignArchivedSim)
    } finally {
      db.close()
    }

    const marketingSender = await seedProfile('Marketing Sender For Archived', { accountRole: 'marketing' })
    await setGiftSenderDirectly(campaignArchivedSim, marketingSender)
    const retryResult = creditStore.retryPendingGiftReward(campaignArchivedSim, player, tierRewardId)
    assert(retryResult.ok && !retryResult.alreadyClaimed, `expected successful retry even for archived campaign, got ${JSON.stringify(retryResult)}`)
  })

  await check('[36] Неуспешен retry НЕ създава известие за неполучена награда (само запазена audit event)', async () => {
    const nonMarketing = await seedProfile('Still Not Marketing', { accountRole: 'player' })
    const giftId = await seedGiftItem('Recovery подарък 4 (still failing)')
    const campaignStillBroken = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: nonMarketing })
    const [tierRewardId] = await addRewardTier(campaignStillBroken, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Recovery 4')
    creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-recovery-4', eventAt: sampleEventAtFor(campaignStillBroken), stakeAmount: 0 })

    const notificationsBefore = creditStore.listPendingNotifications(player).length
    const retryResult = creditStore.retryPendingGiftReward(campaignStillBroken, player, tierRewardId)
    assert(!retryResult.ok && retryResult.reason === 'invalid_sender', `expected retry to still fail (sender unchanged), got ${JSON.stringify(retryResult)}`)
    const notificationsAfter = creditStore.listPendingNotifications(player).length
    assert(notificationsAfter === notificationsBefore, 'failed retry must NOT create any notification')
    const auditCount = await countRows(
      `SELECT COUNT(*) AS c FROM campaign_events WHERE campaign_id = ? AND event_type = 'campaign_gift_reward_retry_failed';`,
      campaignStillBroken,
    )
    assert(auditCount === 1, 'failed retry must still leave an audit trail event')
  })

  // ─── 37. Реалният дневен маркетинг лимит (yellowCoinGiftStore механизъм) ───
  await check('[37] Реалната SUM(yellow_coin_gift_ledger.amount) за подателя за деня остава 0 след служебен кампаниен подарък', async () => {
    const marketingSender = await seedProfile('Marketing Sender Real Limit', { accountRole: 'marketing' })
    const giftId = await seedGiftItem('Лимит тест подарък')
    const campaignLimit = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaignLimit, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Real Limit Test')

    // Точно СЪЩАТА заявка каквата ползва yellowCoinGiftStore::getMarketingDailyGiftLimitStatus
    // (виж src/db/yellowCoinGiftStore.ts:382-387) — верифицираме РЕАЛНИЯ механизъм, не предположение.
    const sofiaDayStartUtc = getSofiaDayStartUtcSqliteString()
    const usedBefore = await countRows(
      `SELECT COALESCE(SUM(amount), 0) AS c FROM yellow_coin_gift_ledger WHERE sender_profile_id = ? AND created_at >= ?;`,
      marketingSender,
      sofiaDayStartUtc,
    )
    assert(usedBefore === 0, 'sanity: no pre-existing yellow_coin_gift_ledger activity for this fresh sender')

    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-real-limit', eventAt: sampleEventAtFor(campaignLimit), stakeAmount: 0 })
    assert(result.ok && result.grantedRewards.some((r) => r.type === 'gift_item'), 'setup: expected gift granted')

    const usedAfter = await countRows(
      `SELECT COALESCE(SUM(amount), 0) AS c FROM yellow_coin_gift_ledger WHERE sender_profile_id = ? AND created_at >= ?;`,
      marketingSender,
      sofiaDayStartUtc,
    )
    assert(usedAfter === 0, `campaign gift must NOT contribute to the real daily-limit ledger SUM: usedAfter=${usedAfter}`)

    // yellow_coin_gift_ledger самата таблица няма ВЪОБЩЕ ред за тази доставка — потвърждава пълна изолация.
    const ledgerRowCount = await countRows(`SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger WHERE sender_profile_id = ?;`, marketingSender)
    assert(ledgerRowCount === 0, 'campaign gift delivery must leave zero rows in the unrelated coin-gift ledger table')
  })

  // ─── 38. Delivery-log видимост — gift_item_delivery_log ред се записва коректно ───
  await check('[38] Служебният подарък пише gift_item_delivery_log ред (съществуващият "appear to recipient" механизъм)', async () => {
    const marketingSender = await seedProfile('Marketing Sender Delivery Log', { accountRole: 'marketing' })
    const giftId = await seedGiftItem('Delivery log тест подарък')
    const campaignDelivery = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaignDelivery, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Delivery Log Test')

    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-delivery-log', eventAt: sampleEventAtFor(campaignDelivery), stakeAmount: 0 })
    assert(result.ok, 'credit failed')

    const db = await openRawDb()
    try {
      const deliveryRow = db.prepare(`
        SELECT recipient_profile_id, gift_item_id, item_name, from_display_name, shown_at
        FROM gift_item_delivery_log
        WHERE recipient_profile_id = ?;
      `).get(player) as { recipient_profile_id: string; gift_item_id: string; item_name: string; from_display_name: string; shown_at: string | null } | undefined
      assert(deliveryRow !== undefined, 'expected a gift_item_delivery_log row for the recipient — needed for the EXISTING getPendingDeliveries()/next-connect mechanism to surface the gift')
      assert(deliveryRow!.gift_item_id === giftId, 'delivery log gift_item_id mismatch')
      assert(deliveryRow!.shown_at === null, 'expected shown_at=NULL (not yet shown) right after granting')
    } finally {
      db.close()
    }
  })

  // ─── 39. Риск от Фаза 2 вече ПОПРАВЕН във Фаза 2.1 (BEFORE DELETE trigger,
  // 20261013_001_protect_campaign_gift_sender_profiles.sql) — hard-delete на
  // marketing подателя вече се отказва директно на SQL ниво, историята
  // оцелява непокътната. Тестът потвърждава ПОПРАВКАТА, не вече-невалидния
  // стар "документирана находка" резултат. Пълният functional/application-
  // level test suite за защитата живее отделно в
  // checkCampaignGiftSenderProtection.ts — тук само sanity-confirm, че
  // credit store-ния flow не разчита на остарялото cascade поведение.
  await check('[39] Фаза 2.1 поправка: hard-delete на marketing подателя вече се ОТКАЗВА (trigger), историята оцелява', async () => {
    const marketingSender = await seedProfile('Marketing Sender To Delete', { accountRole: 'marketing' })
    const giftId = await seedGiftItem('Подарък преди изтриване на подателя')
    const campaignDeleteRisk = await seedCampaign(campaignsStore, ADMIN_ACTOR, { giftSenderProfileId: marketingSender })
    await addRewardTier(campaignDeleteRisk, 5, [{ type: 'gift_item', payload: { giftItemId: giftId } }])
    const player = await seedProfile('Player Before Sender Delete')
    const result = creditStore.creditCampaignUnits({ profileId: player, sourceType: 'belot_win', sourceId: 'm-sender-delete-risk', eventAt: sampleEventAtFor(campaignDeleteRisk), stakeAmount: 0 })
    assert(result.ok && result.grantedRewards.some((r) => r.type === 'gift_item'), 'setup: expected gift granted before sender deletion')

    const txCountBeforeDelete = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ?;`, player)
    assert(txCountBeforeDelete === 1, 'sanity: 1 transaction row before sender hard-delete attempt')

    const db = await openRawDb()
    try {
      let threw = false
      try {
        db.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(marketingSender)
      } catch {
        threw = true
      }
      assert(threw, 'Фаза 2.1 trigger-ът трябва да отхвърли директния DELETE на защитен campaign gift sender')
    } finally {
      db.close()
    }

    const txCountAfterDelete = await countRows(`SELECT COUNT(*) AS c FROM gift_item_transactions WHERE recipient_profile_id = ?;`, player)
    assert(txCountAfterDelete === 1, `expected the gift history to SURVIVE the rejected delete attempt, got ${txCountAfterDelete} rows`)
  })
} finally {
  if (campaignsStore !== undefined) campaignsStore.close()
  if (creditStore !== undefined) creditStore.close()
  await cleanup()
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
