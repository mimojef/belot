/**
 * checkCampaignProfileSummaryStore.ts
 *
 * Фаза 8 (профилен popup "Кампании") — функционални проверки на
 * server/src/campaigns/campaignCreditStore.ts::getProfileCampaignSummary:
 * активен прогрес + праг-статуси (granted/pending/locked) +
 * nextIncompleteTier избор + последна действително проведена и приключена/
 * спряна кампания (вкл. soft-delete persistence и "никога активирана"
 * изключване). Изолирана temp SQLite база, подготвена през реалния
 * ensureServerDatabaseReady() runner — mirror на checkCampaignCreditStore.ts.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'

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

console.log('\ncheckCampaignProfileSummaryStore')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-profile-summary-'))
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

let nextSlotOffsetHours = -10
function reserveWindow(): { startsAt: string; endsAt: string } {
  const startOffset = nextSlotOffsetHours
  const endOffset = startOffset + 90
  nextSlotOffsetHours = endOffset + 10
  return { startsAt: hoursFromNow(startOffset), endsAt: hoursFromNow(endOffset) }
}

type SeedCampaignOptions = {
  status?: 'draft' | 'active' | 'finished' | 'stopped' | 'expired_before_activation'
  startsAt?: string
  endsAt?: string
}

async function seedCampaign(
  campaignsStore: CampaignsStore,
  adminActor: { type: 'admin'; profileId: string },
  options: SeedCampaignOptions = {},
): Promise<string> {
  const window = reserveWindow()
  const startsAt = options.startsAt ?? window.startsAt
  const endsAt = options.endsAt ?? window.endsAt
  const draft = campaignsStore.createDraftCampaign(
    { name: `Summary Test ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви' },
    adminActor,
  )
  if (!draft.ok) throw new Error('seedCampaign: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId

  const db = await openRawDb()
  try {
    db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 0, 100);`).run(campaignId)
  } finally {
    db.close()
  }

  const targetStatus = options.status ?? 'finished'
  if (targetStatus === 'draft') return campaignId

  const scheduled = campaignsStore.scheduleCampaign(campaignId, adminActor)
  if (!scheduled.ok) throw new Error(`seedCampaign: scheduleCampaign failed: ${JSON.stringify(scheduled)}`)

  if (targetStatus === 'expired_before_activation') {
    const expired = campaignsStore.expireScheduledCampaignWithoutActivating(
      campaignId,
      new Date(Date.parse(endsAt) + 1000),
      adminActor,
    )
    if (!expired.ok) throw new Error(`seedCampaign: expireScheduledCampaignWithoutActivating failed: ${JSON.stringify(expired)}`)
    return campaignId
  }

  const activated = campaignsStore.activateCampaign(campaignId, new Date(Date.parse(startsAt) + 1000), adminActor)
  if (!activated.ok) throw new Error(`seedCampaign: activateCampaign failed: ${JSON.stringify(activated)}`)
  if (targetStatus === 'active') return campaignId

  if (targetStatus === 'finished') {
    const finished = campaignsStore.finishCampaign(campaignId, new Date(Date.parse(endsAt) + 1000), adminActor)
    if (!finished.ok) throw new Error('seedCampaign: finishCampaign failed')
    return campaignId
  }

  const stopped = campaignsStore.stopCampaign(campaignId, adminActor)
  if (!stopped.ok) throw new Error('seedCampaign: stopCampaign failed')
  return campaignId
}

async function addRewardTier(
  campaignId: string,
  thresholdUnits: number,
  rewards: Array<{ type: 'yellow_coins' | 'vip_days' | 'gift_item'; payload: Record<string, unknown> }>,
): Promise<string[]> {
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

async function setCampaignDeletedAt(campaignId: string, deletedAtIso: string): Promise<void> {
  const db = await openRawDb()
  try {
    db.prepare(`UPDATE campaigns SET deleted_at = ? WHERE campaign_id = ?;`).run(deletedAtIso, campaignId)
  } finally {
    db.close()
  }
}

const campaignsStore = await createCampaignsStore(databaseFilePath)
const campaignCreditStore = await createCampaignCreditStore(databaseFilePath)
const adminActor = { type: 'admin' as const, profileId: await seedProfile('AdminActor') }

// ═══════════════════════════════════════════════════════════════════════
// [S1] Нищо никъде — активна и последна приключила кампания -> и двете null.
// ═══════════════════════════════════════════════════════════════════════
await check('[S1] Без каквато и да е кампания -> active:null, lastFinished:null', async () => {
  const profileId = await seedProfile('S1 Player')
  const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
  assert(summary.active === null, 'expected active=null')
  assert(summary.lastFinished === null, 'expected lastFinished=null')
})

// ═══════════════════════════════════════════════════════════════════════
// [S2]-[S5] Активна кампания с 2 прага, частичен прогрес.
// ═══════════════════════════════════════════════════════════════════════
{
  const campaignId = await seedCampaign(campaignsStore, adminActor, { status: 'active' })
  const [tier1CoinsId] = await addRewardTier(campaignId, 100, [{ type: 'yellow_coins', payload: { amount: 10_000 } }])
  const [tier2CoinsId, tier2VipId] = await addRewardTier(campaignId, 500, [
    { type: 'yellow_coins', payload: { amount: 50_000 } },
    { type: 'vip_days', payload: { unit: 'days', amount: 3 } },
  ])
  void tier1CoinsId
  void tier2CoinsId
  void tier2VipId

  await check('[S2] Профил без прогрес -> units=0, nextIncompleteTier=първи праг (locked)', async () => {
    const profileId = await seedProfile('S2 Player')
    const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
    assert(summary.active !== null, 'expected active campaign')
    assert(summary.active!.unitsTotal === 0, `expected 0 units, got ${summary.active!.unitsTotal}`)
    assert(summary.active!.tiers.length === 2, `expected 2 tiers, got ${summary.active!.tiers.length}`)
    assert(summary.active!.nextIncompleteTier?.thresholdUnits === 100, 'expected next tier threshold=100')
    assert(
      summary.active!.nextIncompleteTier!.rewards.every((r) => r.status === 'locked'),
      'expected all rewards locked',
    )
  })

  await check('[S3] 347/500 example: 1-ви праг получен, 2-рия locked, remaining=153', async () => {
    const profileId = await seedProfile('S3 Player')
    const result = campaignCreditStore.creditCampaignUnits({
      profileId,
      sourceType: 'belot_win',
      sourceId: `room-${randomUUID()}:v1`,
      eventAt: new Date(),
      stakeAmount: 0,
      didWin: true,
    })
    // units_per_win=100 за stake=0 -> точно 100 с едно начисление; credit
    // отново 2 пъти повече (3 х 100 - 53 условно не е точно 347) — затова
    // ползваме admin adjustment за точен контролиран брой.
    assert(result.ok, 'expected credit ok')
    const adjust = campaignCreditStore.applyManualAdjustment({
      campaignId,
      profileId,
      unitsDelta: 247,
      reason: 'test setup',
      adminProfileId: adminActor.profileId,
    })
    assert(adjust.ok, 'expected manual adjustment ok')

    const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
    assert(summary.active!.unitsTotal === 347, `expected 347 units, got ${summary.active!.unitsTotal}`)
    const tier1 = summary.active!.tiers.find((t) => t.thresholdUnits === 100)!
    assert(tier1.rewards.every((r) => r.status === 'granted'), 'expected tier1 fully granted')
    assert(summary.active!.nextIncompleteTier?.thresholdUnits === 500, 'expected next tier=500')
    assert(
      summary.active!.nextIncompleteTier!.rewards.every((r) => r.status === 'locked'),
      'expected tier2 rewards locked',
    )
  })

  await check('[S4] Всички прагове изпълнени -> nextIncompleteTier=null', async () => {
    const profileId = await seedProfile('S4 Player')
    const adjust = campaignCreditStore.applyManualAdjustment({
      campaignId,
      profileId,
      unitsDelta: 1000,
      reason: 'test setup',
      adminProfileId: adminActor.profileId,
    })
    assert(adjust.ok, 'expected manual adjustment ok')
    const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
    assert(summary.active!.nextIncompleteTier === null, 'expected nextIncompleteTier=null (всички прагове изпълнени)')
    assert(
      summary.active!.tiers.every((tier) => tier.rewards.every((r) => r.status === 'granted')),
      'expected всички награди granted',
    )
  })

  // Освобождава "единствен активен слот" за следващите блокове (S5's own
  // active campaign, после S6-S9's 'finished' seedCampaign() извиквания,
  // които минават през нормалния scheduleCampaign->activateCampaign път).
  const stoppedBlockA = campaignsStore.stopCampaign(campaignId, adminActor)
  if (!stoppedBlockA.ok) throw new Error('cleanup: stopCampaign (block A) failed')

  await check('[S5] Gift-item праг с невалиден sender -> reward status=pending, не locked', async () => {
    const giftItemId = await seedGiftItem('Златна тиква')
    const giftTierCampaignId = await seedCampaign(campaignsStore, adminActor, { status: 'active' })
    await addRewardTier(giftTierCampaignId, 50, [{ type: 'gift_item', payload: { giftItemId } }])
    const profileId = await seedProfile('S5 Player')
    const adjust = campaignCreditStore.applyManualAdjustment({
      campaignId: giftTierCampaignId,
      profileId,
      unitsDelta: 50,
      reason: 'cross threshold',
      adminProfileId: adminActor.profileId,
    })
    if (!adjust.ok) throw new Error('expected manual adjustment ok')
    assert(adjust.skippedRewards.length === 1, 'expected 1 skipped gift reward (no gift sender configured)')

    const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
    const tier = summary.active!.tiers.find((t) => t.thresholdUnits === 50)!
    assert(tier.rewards[0]!.status === 'pending', `expected status=pending, got ${tier.rewards[0]!.status}`)
    // §3: не бъркай достигнат праг с успешно предоставена награда — прагът
    // Е достигнат (50<=50), но наградата остава "дължима", затова ТОЧНО
    // този праг е nextIncompleteTier, въпреки че е "преминат" числово.
    assert(summary.active!.nextIncompleteTier?.thresholdUnits === 50, 'expected pending tier to be nextIncompleteTier despite being reached')
    const reward = tier.rewards[0]!.reward
    assert(reward.rewardType === 'gift_item', `expected gift_item reward, got ${reward.rewardType}`)
    if (reward.rewardType === 'gift_item') {
      assert(reward.name === 'Златна тиква', `expected resolved gift item name, got ${reward.name}`)
    }

    const stoppedGiftCampaign = campaignsStore.stopCampaign(giftTierCampaignId, adminActor)
    if (!stoppedGiftCampaign.ok) throw new Error('cleanup: stopCampaign (gift tier campaign) failed')
  })
}

// ═══════════════════════════════════════════════════════════════════════
// [S6]-[S9] Последна приключила кампания.
// ═══════════════════════════════════════════════════════════════════════

await check('[S6] Последна приключила кампания -> коректно име + units_total', async () => {
  const profileId = await seedProfile('S6 Player')
  const campaignId = await seedCampaign(campaignsStore, adminActor, { status: 'finished' })
  const result = campaignCreditStore.applyManualAdjustment({
    campaignId,
    profileId,
    unitsDelta: 1274,
    reason: 'historical result',
    adminProfileId: adminActor.profileId,
  })
  assert(result.ok, 'expected adjustment ok')
  const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
  assert(summary.lastFinished !== null, 'expected lastFinished non-null')
  assert(summary.lastFinished!.campaignId === campaignId, 'expected matching campaignId')
  assert(summary.lastFinished!.unitsTotal === 1274, `expected 1274 units, got ${summary.lastFinished!.unitsTotal}`)
})

await check('[S7] Играч без участие в последната приключила кампания -> units_total=0 (не измисля участие)', async () => {
  const neverParticipatedProfileId = await seedProfile('S7 NoParticipation')
  const summary = campaignCreditStore.getProfileCampaignSummary(neverParticipatedProfileId)
  assert(summary.lastFinished !== null, 'expected lastFinished non-null (campaign exists globally)')
  assert(summary.lastFinished!.unitsTotal === 0, `expected 0 units, got ${summary.lastFinished!.unitsTotal}`)
})

await check('[S8] Soft-delete на последната приключила кампания НЕ унищожава резултата', async () => {
  const profileId = await seedProfile('S8 Player')
  const campaignId = await seedCampaign(campaignsStore, adminActor, { status: 'finished' })
  campaignCreditStore.applyManualAdjustment({
    campaignId,
    profileId,
    unitsDelta: 42,
    reason: 'historical result',
    adminProfileId: adminActor.profileId,
  })
  await setCampaignDeletedAt(campaignId, new Date().toISOString())
  const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
  assert(summary.lastFinished !== null, 'expected lastFinished to survive soft-delete')
  assert(summary.lastFinished!.campaignId === campaignId, 'expected same campaignId after soft-delete')
  assert(summary.lastFinished!.unitsTotal === 42, 'expected unchanged units after soft-delete')
})

await check('[S9] Scheduled кампания, изтекла преди активиране -> НЕ се показва като "проведена"', async () => {
  const profileId = await seedProfile('S9 Player')
  // Genuinely-finished real campaign first, so there IS a legitimate
  // lastFinished candidate to fall back to.
  const realCampaignId = await seedCampaign(campaignsStore, adminActor, { status: 'finished' })
  campaignCreditStore.applyManualAdjustment({
    campaignId: realCampaignId,
    profileId,
    unitsDelta: 7,
    reason: 'historical result',
    adminProfileId: adminActor.profileId,
  })
  // Now a NEWER (by creation order / updated_at) campaign that was
  // scheduled but expired before ever being activated.
  await seedCampaign(campaignsStore, adminActor, {
    status: 'expired_before_activation',
    startsAt: hoursFromNow(1),
    endsAt: hoursFromNow(2),
  })
  const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
  assert(summary.lastFinished !== null, 'expected lastFinished non-null')
  assert(
    summary.lastFinished!.campaignId === realCampaignId,
    `expected the genuinely-activated campaign (${realCampaignId}) to win, got ${summary.lastFinished!.campaignId}`,
  )
})

// ═══════════════════════════════════════════════════════════════════════
// [S10] Едновременно стара приключила (А) и нова активна (Б) — без смесване.
// ═══════════════════════════════════════════════════════════════════════
await check('[S10] Стара приключила A + нова активна Б -> без смесване на резултатите', async () => {
  const profileId = await seedProfile('S10 Player')
  const campaignA = await seedCampaign(campaignsStore, adminActor, { status: 'finished' })
  campaignCreditStore.applyManualAdjustment({
    campaignId: campaignA,
    profileId,
    unitsDelta: 300,
    reason: 'campaign A result',
    adminProfileId: adminActor.profileId,
  })

  const campaignB = await seedCampaign(campaignsStore, adminActor, { status: 'active' })
  await addRewardTier(campaignB, 200, [{ type: 'yellow_coins', payload: { amount: 1000 } }])
  campaignCreditStore.applyManualAdjustment({
    campaignId: campaignB,
    profileId,
    unitsDelta: 50,
    reason: 'campaign B progress',
    adminProfileId: adminActor.profileId,
  })

  const summary = campaignCreditStore.getProfileCampaignSummary(profileId)
  assert(summary.active!.campaignId === campaignB, 'expected active=campaignB')
  assert(summary.active!.unitsTotal === 50, `expected 50 units in active campaign B, got ${summary.active!.unitsTotal}`)
  assert(summary.lastFinished!.campaignId === campaignA, 'expected lastFinished=campaignA')
  assert(summary.lastFinished!.unitsTotal === 300, `expected 300 units in finished campaign A, got ${summary.lastFinished!.unitsTotal}`)
})

campaignCreditStore.close()
campaignsStore.close()
await cleanup()

console.log(`\nTotal: ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
