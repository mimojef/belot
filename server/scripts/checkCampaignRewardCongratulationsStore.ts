/**
 * checkCampaignRewardCongratulationsStore.ts
 *
 * Фаза 9 (поздравителен popup за действително предоставени кампанийни
 * награди) — проверки на:
 *  (1) campaignCreditStore.ts's НОВОТО `notification` поле в
 *      CreditCampaignUnitsResult/RetryPendingGiftRewardResult — трябва да е
 *      non-null ИСКЛЮЧИТЕЛНО когато е записан НОВ durable notification ред
 *      в ТАЗИ извикване (никога при alreadyCredited/alreadyClaimed replay,
 *      никога при 0 предоставени награди).
 *  (2) campaignGameHooks.ts/campaignPurchaseHooks.ts's НОВИЯ
 *      `onRewardNotification` callback — извикан ТОЧНО когато има реално
 *      предоставена награда, с коректния (profileId, notification), и
 *      НИКОГА при replay/no-reward/skip пътища.
 *  (3) listPendingNotifications/acknowledgeNotification ownership +
 *      идемпотентност (durable известие, §8).
 *
 * Изолирана temp SQLite база, подготвена през реалния
 * ensureServerDatabaseReady() runner — mirror на checkCampaignCreditStore.ts.
 */

// recordPurchaseForCampaign (за разлика от директния campaignCreditStore
// API) само gate-ва зад isCampaignsFeatureEnabled() — трябва явно включен
// за N7-N10 тестовете по-долу, mirror на checkCampaignPurchaseHooks.ts.
process.env.CAMPAIGNS_FEATURE_ENABLED = '1'

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import { recordPurchaseForCampaign } from '../src/campaigns/campaignPurchaseHooks.js'

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

console.log('\ncheckCampaignRewardCongratulationsStore')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-congrats-'))
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

async function seedProfile(displayName: string): Promise<string> {
  const db = await openRawDb()
  try {
    const profileId = randomUUID()
    db.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`).run(
      profileId,
      displayName,
      displayName.toLowerCase(),
    )
    return profileId
  } finally {
    db.close()
  }
}

async function seedGiftItem(name: string): Promise<string> {
  const db = await openRawDb()
  try {
    const giftItemId = randomUUID()
    db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, ?, '/img.webp', 1);`).run(giftItemId, name)
    return giftItemId
  } finally {
    db.close()
  }
}

async function seedMarketingProfile(displayName: string): Promise<string> {
  const db = await openRawDb()
  try {
    const accountId = randomUUID()
    const profileId = randomUUID()
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES (?, ?, 'x', 'marketing');`).run(
      accountId,
      `${accountId}@example.test`,
    )
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

// Винаги анкерирано около "сега" (за разлика от Фаза 8's ever-advancing
// slot offset) — тестовете тук викат creditCampaignUnits/recordPurchaseForCampaign
// с implicit eventAt=new Date(), затова всеки прозорец ТРЯБВА да покрива
// "сега", независимо от реда на създаване. Overlap guard-ът никога не се
// задейства тук, защото всеки предходен campaignId вече е 'stopped' (виж
// stopCampaign() извикванията между блоковете) преди следващия да бъде
// schedule-нат/активиран — застъпващите се времеви прозорци на
// 'stopped'/'finished' кампании са изрично разрешени.
function reserveWindow(): { startsAt: string; endsAt: string } {
  return { startsAt: hoursFromNow(-10), endsAt: hoursFromNow(8760) }
}

async function seedActiveCampaign(
  campaignsStore: CampaignsStore,
  adminActor: { type: 'admin'; profileId: string },
  giftSenderProfileId: string | null = null,
): Promise<string> {
  const window = reserveWindow()
  const draft = campaignsStore.createDraftCampaign(
    {
      name: `Congrats Test ${randomUUID()}`,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      unitNameSingular: 'тиква',
      unitNamePlural: 'тикви',
      giftSenderProfileId,
    },
    adminActor,
  )
  if (!draft.ok) throw new Error('seedActiveCampaign: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId
  const db = await openRawDb()
  try {
    db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 0, 100);`).run(campaignId)
    db.prepare(`INSERT INTO campaign_package_earn_rules (campaign_id, package_key, units_per_purchase) VALUES (?, 'coins_500', 500);`).run(campaignId)
  } finally {
    db.close()
  }
  const scheduled = campaignsStore.scheduleCampaign(campaignId, adminActor)
  if (!scheduled.ok) throw new Error('seedActiveCampaign: scheduleCampaign failed')
  const activated = campaignsStore.activateCampaign(campaignId, new Date(Date.parse(window.startsAt) + 1000), adminActor)
  if (!activated.ok) throw new Error('seedActiveCampaign: activateCampaign failed')
  return campaignId
}

async function addRewardTier(
  campaignId: string,
  thresholdUnits: number,
  rewards: Array<{ type: 'yellow_coins' | 'vip_days' | 'gift_item'; payload: Record<string, unknown> }>,
): Promise<void> {
  const db = await openRawDb()
  try {
    const tierId = randomUUID()
    db.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, ?);`).run(tierId, campaignId, thresholdUnits)
    for (const reward of rewards) {
      db.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, ?, ?);`).run(
        randomUUID(),
        tierId,
        reward.type,
        JSON.stringify(reward.payload),
      )
    }
  } finally {
    db.close()
  }
}

const campaignsStore = await createCampaignsStore(databaseFilePath)
const campaignCreditStore = await createCampaignCreditStore(databaseFilePath)
const adminActor = { type: 'admin' as const, profileId: await seedProfile('AdminActor') }

// ═══════════════════════════════════════════════════════════════════════
// [N1]-[N5] CreditCampaignUnitsResult.notification
// ═══════════════════════════════════════════════════════════════════════
{
  const campaignId = await seedActiveCampaign(campaignsStore, adminActor)
  await addRewardTier(campaignId, 100, [{ type: 'yellow_coins', payload: { amount: 10_000 } }])

  await check('[N1] Праг прекосен -> notification non-null, с коректен payload', async () => {
    const profileId = await seedProfile('N1 Player')
    const result = campaignCreditStore.creditCampaignUnits({
      profileId,
      sourceType: 'belot_win',
      sourceId: `room-${randomUUID()}:v1`,
      eventAt: new Date(),
      stakeAmount: 0,
    })
    assert(result.ok, 'expected ok')
    if (!result.ok) return
    assert(result.notification !== null, 'expected non-null notification')
    assert(result.notification!.campaignId === campaignId, 'expected matching campaignId')
    assert(result.notification!.payload.rewards.length === 1, 'expected exactly 1 granted reward in payload')
    assert(result.notification!.payload.rewards[0]!.type === 'yellow_coins', 'expected yellow_coins reward')
    assert(typeof result.notification!.notificationId === 'string' && result.notification!.notificationId.length > 0, 'expected a real notificationId')
  })

  await check('[N2] Под прага (0 предоставени награди) -> notification=null', async () => {
    const profileId = await seedProfile('N2 Player')
    const result = campaignCreditStore.creditCampaignUnits({
      profileId,
      sourceType: 'belot_win',
      sourceId: `room-${randomUUID()}:v1`,
      eventAt: new Date(),
      stakeAmount: 999, // no earn rule for this stake -> 0 units
    })
    assert(result.ok, 'expected ok')
    if (!result.ok) return
    assert(result.unitsCredited === 0, 'expected 0 units credited (no earn rule for this stake)')
    assert(result.notification === null, 'expected null notification when nothing was granted')
  })

  await check('[N3] Повторно (replay) извикване на СЪЩОТО събитие -> alreadyCredited:true, notification=null (без повторен push)', async () => {
    const profileId = await seedProfile('N3 Player')
    const sourceId = `room-${randomUUID()}:v1`
    const first = campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId, eventAt: new Date(), stakeAmount: 0 })
    assert(first.ok && first.notification !== null, 'expected first call to produce a notification')
    const replay = campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId, eventAt: new Date(), stakeAmount: 0 })
    assert(replay.ok, 'expected replay ok')
    if (!replay.ok) return
    assert(replay.alreadyCredited === true, 'expected alreadyCredited=true on replay')
    assert(replay.notification === null, 'expected null notification on replay (no duplicate push trigger)')
  })

  await check('[N4] Admin manual adjustment, кръстосал праг -> notification non-null (минава през СЪЩИЯ creditCore)', async () => {
    const profileId = await seedProfile('N4 Player')
    const result = campaignCreditStore.applyManualAdjustment({
      campaignId,
      profileId,
      unitsDelta: 150,
      reason: 'test',
      adminProfileId: adminActor.profileId,
    })
    assert(result.ok, 'expected ok')
    if (!result.ok) return
    assert(result.notification !== null, 'expected non-null notification for manual adjustment crossing a tier')
  })

  // Освобождава единствения активен слот (applyManualAdjustment/creditCampaignUnits
  // по-горе не изискват статус 'active' за да работят с ВЕЧЕ-съществуваща
  // кампания — само resolveCampaignForEvent-ия "еligible window" lookup
  // прави, и N1-N4 вече приключиха).
  const stoppedBlock1 = campaignsStore.stopCampaign(campaignId, adminActor)
  if (!stoppedBlock1.ok) throw new Error('cleanup: stopCampaign (block 1) failed')
}

// ═══════════════════════════════════════════════════════════════════════
// [N5]-[N6] RetryPendingGiftRewardResult.notification
// ═══════════════════════════════════════════════════════════════════════
{
  const marketingProfileId = await seedMarketingProfile('Marketing Sender')
  const campaignId = await seedActiveCampaign(campaignsStore, adminActor, marketingProfileId)
  const giftItemId = await seedGiftItem('Златна тиква')
  await addRewardTier(campaignId, 50, [{ type: 'gift_item', payload: { giftItemId } }])
  const stoppedBlock2Campaign = campaignsStore.stopCampaign(campaignId, adminActor)
  if (!stoppedBlock2Campaign.ok) throw new Error('cleanup: stopCampaign (block 2 campaignId) failed')

  await check('[N5] Успешен retry (sender вече валиден) -> notification non-null', async () => {
    const profileId = await seedProfile('N5 Player')
    // Cross the threshold BEFORE a valid sender exists, forcing a pending gap.
    const brokenCampaignId = await seedActiveCampaign(campaignsStore, adminActor, null)
    await addRewardTier(brokenCampaignId, 50, [{ type: 'gift_item', payload: { giftItemId } }])
    const adjust = campaignCreditStore.applyManualAdjustment({
      campaignId: brokenCampaignId,
      profileId,
      unitsDelta: 50,
      reason: 'cross with no sender',
      adminProfileId: adminActor.profileId,
    })
    assert(adjust.ok, 'expected adjustment ok')
    if (!adjust.ok) return
    assert(adjust.skippedRewards.length === 1, 'expected 1 skipped gift reward (no sender)')
    const gaps = campaignCreditStore.listPendingGiftRewardGaps(brokenCampaignId)
    assert(gaps.length === 1, `expected 1 pending gift gap, got ${gaps.length}`)

    // Fix via a NEW campaign that already has a valid sender, retry against it is not meaningful —
    // instead simulate the realistic self-healing path: admin fixes the SAME campaign's sender via raw SQL,
    // mirroring campaignCreditStore.ts's own test helper convention for this scenario.
    const db = await openRawDb()
    try {
      db.prepare(`UPDATE campaigns SET gift_sender_profile_id = ? WHERE campaign_id = ?;`).run(marketingProfileId, brokenCampaignId)
    } finally {
      db.close()
    }

    const retry = campaignCreditStore.retryPendingGiftReward(brokenCampaignId, profileId, gaps[0]!.tierRewardId)
    assert(retry.ok, 'expected retry ok')
    if (!retry.ok) return
    assert(retry.alreadyClaimed === false, 'expected a genuinely new claim')
    assert(retry.notification !== null, 'expected non-null notification on successful retry')
    assert(retry.notification!.payload.rewards[0]!.type === 'gift_item', 'expected gift_item reward in retry notification')

    const stoppedBrokenCampaign = campaignsStore.stopCampaign(brokenCampaignId, adminActor)
    if (!stoppedBrokenCampaign.ok) throw new Error('cleanup: stopCampaign (brokenCampaignId) failed')
  })

  await check('[N6] Повторен retry на вече предоставена награда -> alreadyClaimed:true, notification=null', async () => {
    const profileId = await seedProfile('N6 Player')
    const adjust = campaignCreditStore.applyManualAdjustment({
      campaignId,
      profileId,
      unitsDelta: 50,
      reason: 'cross with valid sender',
      adminProfileId: adminActor.profileId,
    })
    assert(adjust.ok, 'expected adjustment ok')
    if (!adjust.ok) return
    assert(adjust.grantedRewards.length === 1, 'expected the gift to be granted immediately (valid sender already configured)')
    const gaps = campaignCreditStore.listPendingGiftRewardGaps(campaignId)
    assert(gaps.length === 0, 'expected no pending gaps (already granted)')
    // Retry against an already-claimed tier reward id — fetch it directly.
    const db = await openRawDb()
    let tierRewardId = ''
    try {
      const row = db.prepare(`
        SELECT ctr.tier_reward_id AS id FROM campaign_tier_rewards ctr
        JOIN campaign_reward_tiers crt ON crt.tier_id = ctr.tier_id
        WHERE crt.campaign_id = ? LIMIT 1;
      `).get(campaignId) as { id: string }
      tierRewardId = row.id
    } finally {
      db.close()
    }
    const retry = campaignCreditStore.retryPendingGiftReward(campaignId, profileId, tierRewardId)
    assert(retry.ok, 'expected retry ok')
    if (!retry.ok) return
    assert(retry.alreadyClaimed === true, 'expected alreadyClaimed=true')
    assert(retry.notification === null, 'expected null notification on already-claimed replay')
  })
}

// ═══════════════════════════════════════════════════════════════════════
// [N7]-[N10] onRewardNotification callback wiring (campaignPurchaseHooks.ts)
// ═══════════════════════════════════════════════════════════════════════
{
  const campaignId = await seedActiveCampaign(campaignsStore, adminActor)
  await addRewardTier(campaignId, 500, [{ type: 'yellow_coins', payload: { amount: 20_000 } }])

  await check('[N7] recordPurchaseForCampaign: праг прекосен -> onRewardNotification извикан точно веднъж с коректните данни', async () => {
    const profileId = await seedProfile('N7 Player')
    const calls: Array<{ profileId: string; notificationId: string }> = []
    recordPurchaseForCampaign({
      campaignCreditStore,
      payerProfileId: profileId,
      purchaseId: randomUUID(),
      packageKey: 'coins_500',
      creditedAtIso: new Date().toISOString(),
      onRewardNotification: (pid, notification) => {
        calls.push({ profileId: pid, notificationId: notification.notificationId })
      },
    })
    assert(calls.length === 1, `expected onRewardNotification called exactly once, got ${calls.length}`)
    assert(calls[0]!.profileId === profileId, 'expected correct profileId passed to callback')
  })

  await check('[N8] recordPurchaseForCampaign: webhook replay (same purchaseId) -> onRewardNotification НЕ се извиква повторно', async () => {
    const profileId = await seedProfile('N8 Player')
    const purchaseId = randomUUID()
    const calls: unknown[] = []
    const deps = {
      campaignCreditStore,
      payerProfileId: profileId,
      purchaseId,
      packageKey: 'coins_500',
      creditedAtIso: new Date().toISOString(),
      onRewardNotification: () => { calls.push(1) },
    }
    recordPurchaseForCampaign(deps)
    recordPurchaseForCampaign(deps)
    assert(calls.length === 1, `expected onRewardNotification called exactly once across both calls (idempotent replay), got ${calls.length}`)
  })

  await check('[N9] recordPurchaseForCampaign: покупка без прекосен праг -> onRewardNotification НЕ се извиква', async () => {
    const profileId = await seedProfile('N9 Player')
    const calls: unknown[] = []
    recordPurchaseForCampaign({
      campaignCreditStore,
      payerProfileId: profileId,
      purchaseId: randomUUID(),
      packageKey: 'nonexistent_package_key',
      creditedAtIso: new Date().toISOString(),
      onRewardNotification: () => { calls.push(1) },
    })
    assert(calls.length === 0, `expected onRewardNotification NOT called (0 units, no earn rule), got ${calls.length}`)
  })

  await check('[N10] recordPurchaseForCampaign: без onRewardNotification подаден -> не хвърля', async () => {
    const profileId = await seedProfile('N10 Player')
    recordPurchaseForCampaign({
      campaignCreditStore,
      payerProfileId: profileId,
      purchaseId: randomUUID(),
      packageKey: 'coins_500',
      creditedAtIso: new Date().toISOString(),
    })
  })

  const stoppedBlock3 = campaignsStore.stopCampaign(campaignId, adminActor)
  if (!stoppedBlock3.ok) throw new Error('cleanup: stopCampaign (block 3) failed')
}

// ═══════════════════════════════════════════════════════════════════════
// [N11]-[N16] listPendingNotifications / acknowledgeNotification (§8)
// ═══════════════════════════════════════════════════════════════════════
{
  const campaignId = await seedActiveCampaign(campaignsStore, adminActor)
  await addRewardTier(campaignId, 10, [{ type: 'yellow_coins', payload: { amount: 1000 } }])

  await check('[N11] listPendingNotifications връща само profile-ownия pending ред', async () => {
    const profileA = await seedProfile('N11 A')
    const profileB = await seedProfile('N11 B')
    campaignCreditStore.creditCampaignUnits({ profileId: profileA, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: new Date(), stakeAmount: 0 })
    const notificationsA = campaignCreditStore.listPendingNotifications(profileA)
    const notificationsB = campaignCreditStore.listPendingNotifications(profileB)
    assert(notificationsA.length === 1, `expected 1 pending notification for A, got ${notificationsA.length}`)
    assert(notificationsB.length === 0, `expected 0 pending notifications for B, got ${notificationsB.length}`)
  })

  await check('[N12] acknowledgeNotification от друг профил -> not_owner, редът остава pending', async () => {
    const owner = await seedProfile('N12 Owner')
    const stranger = await seedProfile('N12 Stranger')
    campaignCreditStore.creditCampaignUnits({ profileId: owner, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: new Date(), stakeAmount: 0 })
    const [notification] = campaignCreditStore.listPendingNotifications(owner)
    assert(notification !== undefined, 'expected a pending notification')
    const result = campaignCreditStore.acknowledgeNotification(notification!.notificationId, stranger)
    assert(!result.ok && result.reason === 'not_owner', `expected not_owner, got ${JSON.stringify(result)}`)
    const stillPending = campaignCreditStore.listPendingNotifications(owner)
    assert(stillPending.length === 1, 'expected notification to remain pending after a foreign ack attempt')
  })

  await check('[N13] Успешен acknowledge -> изчезва от pending списъка', async () => {
    const profileId = await seedProfile('N13 Player')
    campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: new Date(), stakeAmount: 0 })
    const [notification] = campaignCreditStore.listPendingNotifications(profileId)
    const result = campaignCreditStore.acknowledgeNotification(notification!.notificationId, profileId)
    assert(result.ok, 'expected ack ok')
    assert(campaignCreditStore.listPendingNotifications(profileId).length === 0, 'expected empty pending list after ack')
  })

  await check('[N14] Повторен acknowledge на СЪЩИЯ ред (идемпотентен) -> ok, без грешка', async () => {
    const profileId = await seedProfile('N14 Player')
    campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: new Date(), stakeAmount: 0 })
    const [notification] = campaignCreditStore.listPendingNotifications(profileId)
    const first = campaignCreditStore.acknowledgeNotification(notification!.notificationId, profileId)
    const second = campaignCreditStore.acknowledgeNotification(notification!.notificationId, profileId)
    assert(first.ok && second.ok, 'expected both acks ok (idempotent)')
  })

  await check('[N15] "Срив преди ack": notification остава pending след "restart" (нов store instance върху същата DB)', async () => {
    const profileId = await seedProfile('N15 Player')
    campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: new Date(), stakeAmount: 0 })
    // Симулира restart — нов store instance върху СЪЩАТА DB (durable state, не in-memory).
    const restartedStore = await createCampaignCreditStore(databaseFilePath)
    try {
      const recovered = restartedStore.listPendingNotifications(profileId)
      assert(recovered.length === 1, `expected the notification to survive "restart", got ${recovered.length}`)
    } finally {
      restartedStore.close()
    }
  })

  await check('[N16] Обратен случай: вече потвърдено известие НЕ се появява повторно след "restart"', async () => {
    const profileId = await seedProfile('N16 Player')
    campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: new Date(), stakeAmount: 0 })
    const [notification] = campaignCreditStore.listPendingNotifications(profileId)
    campaignCreditStore.acknowledgeNotification(notification!.notificationId, profileId)
    const restartedStore = await createCampaignCreditStore(databaseFilePath)
    try {
      const recovered = restartedStore.listPendingNotifications(profileId)
      assert(recovered.length === 0, `expected acknowledged notification to NOT reappear after "restart", got ${recovered.length}`)
    } finally {
      restartedStore.close()
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════
// [N17]-[N19] Няколко прага с ЕДНО начисление -> ЕДНО известие; точно
// еднократно предоставяне; динамична икона на единицата (нови и стари редове)
// ═══════════════════════════════════════════════════════════════════════
{
  {
    const db = await openRawDb()
    try {
      const activeIds = (db.prepare(`SELECT campaign_id FROM campaigns WHERE status = 'active';`).all() as Array<{ campaign_id: string }>).map((r) => r.campaign_id)
      for (const id of activeIds) {
        const stopped = campaignsStore.stopCampaign(id, adminActor)
        if (!stopped.ok) throw new Error('N17 setup: stopCampaign failed')
      }
    } finally {
      db.close()
    }
  }
  const campaignId = await seedActiveCampaign(campaignsStore, adminActor)
  const ICON_URL = `/uploads/campaign-themes/${campaignId}/icons/unit.webp`
  {
    const db = await openRawDb()
    try {
      db.prepare(`UPDATE campaigns SET unit_icon_url = ? WHERE campaign_id = ?;`).run(ICON_URL, campaignId)
    } finally {
      db.close()
    }
  }
  // belot stake 0 -> 100 единици на победа; прагове 50 и 100 се прекосяват наведнъж.
  await addRewardTier(campaignId, 50, [{ type: 'yellow_coins', payload: { amount: 1_000 } }])
  await addRewardTier(campaignId, 100, [{ type: 'yellow_coins', payload: { amount: 1_500 } }, { type: 'vip_days', payload: { unit: 'days', amount: 3 } }])
  const profileId = await seedProfile('N17 Player')
  const sourceId = `room-${randomUUID()}:v1`
  const creditOnce = () => campaignCreditStore.creditCampaignUnits({ profileId, sourceType: 'belot_win', sourceId, eventAt: new Date(), stakeAmount: 0 })
  const countRows = async () => {
    const db = await openRawDb()
    try {
      const claims = (db.prepare(`SELECT COUNT(*) AS n FROM campaign_reward_claims WHERE campaign_id = ? AND profile_id = ?;`).get(campaignId, profileId) as { n: number }).n
      const notifications = (db.prepare(`SELECT COUNT(*) AS n FROM campaign_reward_notifications WHERE campaign_id = ? AND profile_id = ?;`).get(campaignId, profileId) as { n: number }).n
      return { claims, notifications }
    } finally {
      db.close()
    }
  }

  await check('[N17] Едно начисление прекосява 2 прага -> ЕДНО известие с всички 3 награди и иконата на единицата', async () => {
    const result = creditOnce()
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.notification !== null, 'expected a notification')
    const payload = result.notification!.payload
    assert(payload.rewards.length === 3, `expected 3 rewards in ONE payload, got ${payload.rewards.length}`)
    assert(payload.unitsTotal === 100, `expected unitsTotal=100, got ${payload.unitsTotal}`)
    assert(payload.unitIconUrl === ICON_URL, `expected unitIconUrl from the campaign, got ${payload.unitIconUrl}`)
    const counts = await countRows()
    assert(counts.claims === 3 && counts.notifications === 1, `expected 3 claims + 1 notification, got ${JSON.stringify(counts)}`)
  })

  await check('[N18] Повторно същото събитие + ack -> без нови награди/известия (точно еднократно)', async () => {
    const replay = creditOnce()
    assert(replay.ok && replay.alreadyCredited && replay.notification === null, `replay must be a no-op, got ${JSON.stringify(replay)}`)
    const pending = campaignCreditStore.listPendingNotifications(profileId)
    assert(pending.length === 1, `expected 1 pending (survives until "Прибери"), got ${pending.length}`)
    assert(campaignCreditStore.acknowledgeNotification(pending[0]!.notificationId, profileId).ok, 'ack failed')
    assert(campaignCreditStore.listPendingNotifications(profileId).length === 0, 'expected no pending after ack')
    const counts = await countRows()
    assert(counts.claims === 3 && counts.notifications === 1, `ack must not grant again, got ${JSON.stringify(counts)}`)
  })

  await check('[N19] По-стар pending ред без unitIconUrl -> listPendingNotifications го допълва от кампанията', async () => {
    const legacyId = randomUUID()
    const db = await openRawDb()
    try {
      db.prepare(`INSERT INTO campaign_reward_notifications (notification_id, campaign_id, profile_id, status, payload_json) VALUES (?, ?, ?, 'pending', ?);`).run(
        legacyId,
        campaignId,
        profileId,
        JSON.stringify({ campaignName: 'Legacy', unitNameSingular: 'тиква', unitNamePlural: 'тикви', unitsTotal: 100, rewards: [{ type: 'yellow_coins', amount: 1000 }] }),
      )
    } finally {
      db.close()
    }
    const pending = campaignCreditStore.listPendingNotifications(profileId).find((n) => n.notificationId === legacyId)
    assert(pending !== undefined, 'legacy row must be listed')
    assert(pending!.payload.unitIconUrl === ICON_URL, `expected enriched unitIconUrl, got ${pending!.payload.unitIconUrl}`)
  })
}

campaignCreditStore.close()
campaignsStore.close()
await cleanup()

console.log(`\nTotal: ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
