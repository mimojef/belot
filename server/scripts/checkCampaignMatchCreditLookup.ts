/**
 * checkCampaignMatchCreditLookup.ts
 *
 * Фаза 6 ("Показване на кампанийните единици в Белот End Game") — проверки
 * на campaignCreditStore.ts::getMatchCreditSnapshot, новата read-only
 * lookup функция, която End Game екранът ползва за показване на реално
 * начислените кампанийни единици за КОНКРЕТЕН приключил мач (не
 * натрупания профилен total, виж task spec §4).
 *
 * [M1] Печеливш профил с начислени единици -> getMatchCreditSnapshot
 *      връща точния campaignId/campaignName/unit имена/икона/units_amount,
 *      КОГАТО подадения expectedEventAtIso съвпада с реалния event_at ред.
 * [M2] Mismatched expectedEventAtIso (симулира replay-in-same-room staleness
 *      — виж messageTypes.ts::request_campaign_match_credit doc коментара:
 *      campaign_unit_ledger's source_id=room.id не е match-unique при
 *      replay в СЪЩАТА стая) -> връща null, НЕ показва ПРЕДИШЕН match-ов
 *      credit за текущия.
 * [M3] "347 -> 372 vs +25" разликата (task spec §4, основно изискване):
 *      ДВЕ отделни начисления (различни sourceId/"стаи") за СЪЩИЯ профил+
 *      кампания -> getProfileCampaignTotal връща СУМАТА, докато
 *      getMatchCreditSnapshot за ВСЯКА от двете връща САМО нейната собствена
 *      match-specific стойност, не акумулирания total.
 * [M4] Губещ/невключен профил (няма ledger ред за този sourceId) -> null
 *      (task spec §7 — "играч без начислени единици не вижда фалшива
 *      награда").
 * [M5] source_type scoping — belot_win lookup не "вижда" ludo_win ред за
 *      същия (profileId, sourceId, eventAt), дори ID-тата да съвпадат.
 * [M6] Кампания, архивирана СЛЕД начисляването -> getMatchCreditSnapshot
 *      продължава да връща коректно име/единици/икона (task spec §6 —
 *      "използвай ОРИГИНАЛНИЯ campaign_id ред, не текущо активната
 *      кампания"; campaigns FK е ON DELETE RESTRICT, редът оцелява).
 * [M7] 0-units резултат (кампания без earn rule за дадения stake) — ledger
 *      РЕД се пише (resolveUnitsAmountForEvent връща 0, creditCore не
 *      skip-ва INSERT-а), но lookup-ът ИЗРИЧНО филтрира `units_amount > 0`
 *      -> връща null, никога "+0" (task spec §9).
 * [M8] Фаза 6.1 — scoped source_id (`${roomId}:v${N}`, виж
 *      campaignGameHooks.ts::recordBelotMatchForCampaign) се намира от
 *      lookup-а чрез LIKE-prefix match на голия roomId.
 * [M9] Фаза 6.1 — два мача в СЪЩАТА стая (v1/v2) резолюират НЕЗАВИСИМО,
 *      никога кръстосано (виж checkCampaignBelotReplayMatchIdentity.ts за
 *      пълния end-to-end replay lifecycle покритие).
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'

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

console.log('\ncheckCampaignMatchCreditLookup')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-match-credit-'))
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
    db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, NULL, ?, ?);`).run(
      profileId,
      displayName,
      displayName.toLowerCase(),
    )
    return profileId
  } finally {
    db.close()
  }
}

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

async function seedCampaign(
  campaignsStore: CampaignsStore,
  adminActor: { type: 'admin'; profileId: string },
  options: { withBelotRule?: boolean; iconUrl?: string | null } = {},
): Promise<string> {
  const defaultWindow = reserveDefaultCampaignWindow()
  const withBelotRule = options.withBelotRule ?? true
  const draft = campaignsStore.createDraftCampaign(
    {
      name: `Test Campaign ${randomUUID()}`,
      startsAt: defaultWindow.startsAt,
      endsAt: defaultWindow.endsAt,
      unitNameSingular: 'тиква',
      unitNamePlural: 'тикви',
      giftSenderProfileId: null,
    },
    adminActor,
  )
  if (!draft.ok) throw new Error('seedCampaign: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId
  campaignSampleEventAt.set(campaignId, new Date(new Date(defaultWindow.startsAt).getTime() + 3_600_000))

  // createDraftCampaign/updateCampaign не поддържат unit_icon_url (само
  // admin image-upload flow-ът го пипа, виж campaignAdminStore.ts) — за
  // теста директен raw SQL UPDATE е достатъчен, mirror на
  // setGiftSenderDirectly в checkCampaignCreditStore.ts.
  {
    const db = await openRawDb()
    try {
      db.prepare(`UPDATE campaigns SET unit_icon_url = ? WHERE campaign_id = ?;`).run(
        options.iconUrl ?? '/assets/campaigns/pumpkin.webp',
        campaignId,
      )
    } finally {
      db.close()
    }
  }

  if (withBelotRule) {
    const db = await openRawDb()
    try {
      db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 0, 25);`).run(campaignId)
      db.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'ludo', 0, 50);`).run(campaignId)
    } finally {
      db.close()
    }
  }

  const scheduled = campaignsStore.scheduleCampaign(campaignId, adminActor)
  if (!scheduled.ok) throw new Error(`seedCampaign: scheduleCampaign failed: ${JSON.stringify(scheduled)}`)
  const activated = campaignsStore.activateCampaign(campaignId, new Date(), adminActor)
  if (!activated.ok) throw new Error(`seedCampaign: activateCampaign failed: ${JSON.stringify(activated)}`)
  const finished = campaignsStore.finishCampaign(campaignId, new Date(Date.now() + 200 * 3_600_000), adminActor)
  if (!finished.ok) throw new Error('seedCampaign: finishCampaign failed')
  return campaignId
}

async function archiveCampaignDirectly(campaignId: string): Promise<void> {
  const db = await openRawDb()
  try {
    db.prepare(`UPDATE campaigns SET archived_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(campaignId)
  } finally {
    db.close()
  }
}

async function countLedgerRows(campaignId: string, profileId: string, sourceType: string, sourceId: string): Promise<number> {
  const db = await openRawDb()
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ? AND source_type = ? AND source_id = ?;`,
    ).get(campaignId, profileId, sourceType, sourceId) as { c: number }
    return row.c
  } finally {
    db.close()
  }
}

const campaignsStore = await createCampaignsStore(databaseFilePath)
const creditStore = await createCampaignCreditStore(databaseFilePath)
const adminProfileId = await seedProfile('Admin')
const adminActor = { type: 'admin' as const, profileId: adminProfileId }

const campaign1 = await seedCampaign(campaignsStore, adminActor)
const winnerProfile = await seedProfile('Winner')
const loserProfile = await seedProfile('Loser')

await check('[M1] winner profile — exact event_at match returns correct snapshot', async () => {
  const eventAt = sampleEventAtFor(campaign1)
  const result = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'belot_win',
    sourceId: 'room-m1',
    eventAt,
    stakeAmount: 0,
    didWin: true,
  })
  assert(result.ok, `credit failed: ${JSON.stringify(result)}`)

  const snapshot = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', 'room-m1', eventAt.toISOString())
  assert(snapshot !== null, 'expected a snapshot, got null')
  assert(snapshot!.campaignId === campaign1, 'campaignId mismatch')
  assert(snapshot!.unitsAmount === 25, `expected 25 units, got ${snapshot!.unitsAmount}`)
  assert(snapshot!.unitNameSingular === 'тиква', 'unitNameSingular mismatch')
  assert(snapshot!.unitNamePlural === 'тикви', 'unitNamePlural mismatch')
  assert(snapshot!.unitIconUrl === '/assets/campaigns/pumpkin.webp', 'unitIconUrl mismatch')
})

await check('[M2] mismatched expectedEventAtIso (replay-in-same-room staleness) returns null', async () => {
  const eventAt = sampleEventAtFor(campaign1)
  const wrongEventAtIso = new Date(eventAt.getTime() + 60_000).toISOString()
  const snapshot = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', 'room-m1', wrongEventAtIso)
  assert(snapshot === null, 'expected null for mismatched event_at, but got a snapshot (stale-match leak)')
})

await check('[M3] per-match amount stays distinct from accumulated profile total', async () => {
  const eventAtA = sampleEventAtFor(campaign1)
  const resultA = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'belot_win',
    sourceId: 'room-m3-a',
    eventAt: eventAtA,
    stakeAmount: 0,
    didWin: true,
  })
  assert(resultA.ok, `credit A failed: ${JSON.stringify(resultA)}`)

  const eventAtB = new Date(eventAtA.getTime() + 60_000)
  const resultB = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'belot_win',
    sourceId: 'room-m3-b',
    eventAt: eventAtB,
    stakeAmount: 0,
    didWin: true,
  })
  assert(resultB.ok, `credit B failed: ${JSON.stringify(resultB)}`)

  const snapshotA = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', 'room-m3-a', eventAtA.toISOString())
  const snapshotB = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', 'room-m3-b', eventAtB.toISOString())
  assert(snapshotA !== null && snapshotA.unitsAmount === 25, 'snapshot A should show its own 25 units')
  assert(snapshotB !== null && snapshotB.unitsAmount === 25, 'snapshot B should show its own 25 units (NOT accumulated 50)')

  const total = creditStore.getProfileCampaignTotal(campaign1, winnerProfile)
  assert(total >= 50, `expected accumulated total >= 50 (room-m1 + m3-a + m3-b), got ${total}`)
})

await check('[M4] uninvolved/losing profile has no ledger row — returns null', async () => {
  const eventAt = sampleEventAtFor(campaign1)
  const snapshot = creditStore.getMatchCreditSnapshot(loserProfile, 'belot_win', 'room-m1', eventAt.toISOString())
  assert(snapshot === null, 'losing/uninvolved profile must never see a fabricated reward')
})

await check('[M5] source_type scoping — belot_win lookup does not leak ludo_win row', async () => {
  const eventAt = sampleEventAtFor(campaign1)
  const sharedSourceId = 'shared-id-m5'
  const ludoResult = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'ludo_win',
    sourceId: sharedSourceId,
    eventAt,
    stakeAmount: 0,
    didWin: true,
  })
  assert(ludoResult.ok, `ludo credit failed: ${JSON.stringify(ludoResult)}`)

  const belotSnapshot = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', sharedSourceId, eventAt.toISOString())
  assert(belotSnapshot === null, 'belot_win lookup must not return a ludo_win row for the same source_id')

  const ludoSnapshot = creditStore.getMatchCreditSnapshot(winnerProfile, 'ludo_win', sharedSourceId, eventAt.toISOString())
  assert(ludoSnapshot !== null && ludoSnapshot.unitsAmount === 50, 'ludo_win lookup should correctly find its own row')
})

await check('[M6] archived campaign — snapshot still correctly resolvable (original campaign, not current active)', async () => {
  const eventAt = sampleEventAtFor(campaign1)
  await archiveCampaignDirectly(campaign1)
  const snapshot = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', 'room-m1', eventAt.toISOString())
  assert(snapshot !== null, 'archived campaign must not break the lookup (FK is ON DELETE RESTRICT, row survives)')
  assert(snapshot!.campaignId === campaign1, 'must still point at the ORIGINAL campaign, not a currently-active one')
  assert(snapshot!.unitsAmount === 25, 'units amount must remain correct after archival')
})

await check('[M7] no earn rule for the stake — 0-units ledger row is filtered out, lookup returns null (never "+0")', async () => {
  const campaignNoRule = await seedCampaign(campaignsStore, adminActor, { withBelotRule: false })
  const eventAt = sampleEventAtFor(campaignNoRule)
  const profile = await seedProfile('NoRulePlayer')
  const result = creditStore.creditCampaignUnits({
    profileId: profile,
    sourceType: 'belot_win',
    sourceId: 'room-m7',
    eventAt,
    stakeAmount: 0,
    didWin: true,
  })
  assert(result.ok === true, `expected creditCampaignUnits to succeed with 0 units: ${JSON.stringify(result)}`)
  assert((result as { unitsCredited: number }).unitsCredited === 0, 'expected 0 units credited (no matching earn rule)')
  const rowCount = await countLedgerRows(campaignNoRule, profile, 'belot_win', 'room-m7')
  assert(rowCount === 1, `expected a 0-amount ledger row to still be written, got ${rowCount} rows`)
  const snapshot = creditStore.getMatchCreditSnapshot(profile, 'belot_win', 'room-m7', eventAt.toISOString())
  assert(snapshot === null, 'lookup must filter out the 0-units row, never showing a fabricated "+0" result')
})

await check('[M8] Phase 6.1 scoped source_id (`${roomId}:v${N}`) is found via LIKE-prefix match on the bare roomId', async () => {
  // Отделна, свежа кампания (НЕ campaign1 — вече архивирана от [M6] по-горе,
  // значи вече не резолюира за никакво ново събитие в прозореца си).
  const campaignM8 = await seedCampaign(campaignsStore, adminActor)
  const eventAt = sampleEventAtFor(campaignM8)
  const roomId = 'room-m8'
  const scopedSourceId = `${roomId}:v7`
  const result = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'belot_win',
    sourceId: scopedSourceId,
    eventAt,
    stakeAmount: 0,
    didWin: true,
  })
  assert(result.ok, `credit failed: ${JSON.stringify(result)}`)

  // Caller-ът (index.ts WS handler) подава голия roomId, никога scoped
  // стойността — виж campaignCreditStore.ts::getMatchCreditSnapshot doc
  // коментара.
  const snapshot = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', roomId, eventAt.toISOString())
  assert(snapshot !== null, 'expected the scoped-format row to be found via the bare roomId LIKE prefix match')
  assert(snapshot!.unitsAmount === 25, `expected 25 units, got ${snapshot!.unitsAmount}`)
})

await check('[M9] Two matches in the same room (scoped v1/v2) resolve independently via lookup, never cross-matched', async () => {
  const campaignM9 = await seedCampaign(campaignsStore, adminActor)
  const roomId = 'room-m9'
  const eventAtMatch1 = sampleEventAtFor(campaignM9)
  const eventAtMatch2 = new Date(eventAtMatch1.getTime() + 60_000)

  const resultMatch1 = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'belot_win',
    sourceId: `${roomId}:v1`,
    eventAt: eventAtMatch1,
    stakeAmount: 0,
    didWin: true,
  })
  assert(resultMatch1.ok, `match 1 credit failed: ${JSON.stringify(resultMatch1)}`)

  const resultMatch2 = creditStore.creditCampaignUnits({
    profileId: winnerProfile,
    sourceType: 'belot_win',
    sourceId: `${roomId}:v2`,
    eventAt: eventAtMatch2,
    stakeAmount: 0,
    didWin: true,
  })
  assert(resultMatch2.ok, `match 2 credit failed: ${JSON.stringify(resultMatch2)}`)

  const snapshotMatch1 = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', roomId, eventAtMatch1.toISOString())
  const snapshotMatch2 = creditStore.getMatchCreditSnapshot(winnerProfile, 'belot_win', roomId, eventAtMatch2.toISOString())
  assert(snapshotMatch1 !== null && snapshotMatch1.unitsAmount === 25, 'match 1 lookup should resolve its own 25 units')
  assert(snapshotMatch2 !== null && snapshotMatch2.unitsAmount === 25, 'match 2 lookup should resolve its own 25 units, not match 1 again')
})

campaignsStore.close()
creditStore.close()
await cleanup()

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
