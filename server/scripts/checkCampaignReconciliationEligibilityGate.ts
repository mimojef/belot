/**
 * checkCampaignReconciliationEligibilityGate.ts — eligibility gate на
 * campaignCreditReconciliation job-а + jobAsync timing на tick-а.
 *
 * Без кандидат-кампания (active или неархивирана finished/stopped) tick-ът
 * пропуска историческите сканирания: нито един reconcile*, нито cursor запис,
 * нито creditCampaignUnits. Изолирана temp SQLite база, реални миграции,
 * реален campaignsStore/campaignCreditStore.
 *
 *  [G1]  Няма кампании -> skip: 0 credit извиквания, purchase reconcile не е
 *        извикан, няма cursor редове, lastSkipReason попълнен
 *  [G2]  Всички кампании архивирани (finished + stopped) -> skip, cursor-ите
 *        (вкл. updated_at) непокътнати, мач в прозореца им не се начислява
 *  [G3]  Само draft/scheduled -> skip
 *  [G4]  Нова активна кампания -> execute, пропуснатата победа се начислява
 *  [G5]  finished, неархивирана -> закъсняло начисление в прозореца
 *  [G6]  stopped, неархивирана -> начислява до момента на спиране, не след него
 *  [G7]  soft-deleted finished, неархивирана -> execute (deleted_at непроменен)
 *  [G8]  Възобновяване: skip tick-ове -> активиране -> следващият tick
 *        начислява; повторни tick-ове не дублират; лог само при смяна
 *  [G9]  active -> finished -> archived: следващият tick е skip, ledger-ът и
 *        cursor-ите са непроменени
 *  [G10] Грешка в eligibility проверката -> fail-open, един console.error
 *  [G11] Без gate зависимост -> досегашното поведение (сканира и без кампании)
 *  [G12] Архивиране между gate и сканиране -> 0 начисления, без грешка
 *  [G13] Архивиране по средата на сканирането -> само редовете преди него
 *  [G14] Без двойно начисление: live credit + няколко tick-а -> 1 ledger ред
 *  [G15] Съответствие на предиката: status x archived x deleted ->
 *        hasCreditCandidateCampaign() === creditCampaignUnits() ok
 *  [G16] Timer callback-ите връщат Promise-а на tick-а; overlap guard; tick с
 *        грешка resolve-ва (не reject-ва), без unhandled rejection
 *  [G17] jobAsync отчита цялото async времетраене през timeSyncAndAsync
 *  [G18] Source review: index.ts wiring, без `void runTick()`, споделен предикат
 */

import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import {
  createCampaignCreditReconciliationJob,
  type CampaignCreditReconciliationJobDeps,
} from '../src/campaigns/campaignGameHooks.js'
import { reconcileMissingPurchaseCampaignCredits } from '../src/campaigns/campaignPurchaseHooks.js'
import { createMainThreadTimingMetrics } from '../src/monitoring/mainThreadTimingMetrics.js'

process.env.CAMPAIGNS_FEATURE_ENABLED = '1'

let passed = 0
let failed = 0
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')
const tempDirs: string[] = []

console.log('\ncheckCampaignReconciliationEligibilityGate\n')

// ─── Изолирана среда ───

type Env = {
  dbPath: string
  rawDb: DatabaseSync
  campaignsStore: CampaignsStore
  creditStore: CampaignCreditStore
  admin: { type: 'admin'; profileId: string }
}

const openEnvs: Env[] = []

async function createEnv(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-campaign-eligibility-gate-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'test.db')
  const migrationDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  migrationDb.exec('PRAGMA foreign_keys = ON;')
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    migrationDb.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  migrationDb.close()

  const rawDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  rawDb.exec('PRAGMA foreign_keys = ON;')
  const env: Env = {
    dbPath,
    rawDb,
    campaignsStore: await createCampaignsStore(dbPath),
    creditStore: await createCampaignCreditStore(dbPath),
    admin: { type: 'admin', profileId: randomUUID() },
  }
  insertProfile(env, env.admin.profileId)
  openEnvs.push(env)
  return env
}

function insertProfile(env: Env, profileId: string, kind: 'human' | 'bot' = 'human'): void {
  env.rawDb.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, profile_kind, username, normalized_username,
      display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status, is_temporary
    ) VALUES (?, NULL, ?, NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active', 0)
  `).run(profileId, kind, `P ${profileId.slice(0, 8)}`, `p ${profileId.slice(0, 8)}`)
}

function hoursFromNowIso(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

function toDbDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

const BELOT_STAKE = 100
const BELOT_UNITS = 7

type CampaignTarget = 'draft' | 'scheduled' | 'active' | 'finished' | 'stopped'

// Реален lifecycle през campaignsStore (draft -> scheduled -> active ->
// finished/stopped). Прозорец [now-1h, now+1000h) по подразбиране.
function createCampaign(env: Env, target: CampaignTarget): string {
  const startsAt = hoursFromNowIso(-1)
  const endsAt = hoursFromNowIso(1000)
  const draft = env.campaignsStore.createDraftCampaign(
    { name: `Gate ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
    env.admin,
  )
  if (!draft.ok) throw new Error(`createDraftCampaign failed: ${JSON.stringify(draft)}`)
  const campaignId = draft.campaign.campaignId
  env.rawDb.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', ?, ?);`)
    .run(campaignId, BELOT_STAKE, BELOT_UNITS)
  if (target === 'draft') return campaignId

  const scheduled = env.campaignsStore.scheduleCampaign(campaignId, env.admin)
  if (!scheduled.ok) throw new Error(`scheduleCampaign failed: ${JSON.stringify(scheduled)}`)
  if (target === 'scheduled') return campaignId

  const activated = env.campaignsStore.activateCampaign(campaignId, new Date(), env.admin)
  if (!activated.ok) throw new Error(`activateCampaign failed: ${JSON.stringify(activated)}`)
  if (target === 'active') return campaignId

  if (target === 'finished') {
    const finished = env.campaignsStore.finishCampaign(campaignId, new Date(new Date(endsAt).getTime() + 3_600_000), env.admin)
    if (!finished.ok) throw new Error(`finishCampaign failed: ${JSON.stringify(finished)}`)
    return campaignId
  }
  const stopped = env.campaignsStore.stopCampaign(campaignId, env.admin)
  if (!stopped.ok) throw new Error(`stopCampaign failed: ${JSON.stringify(stopped)}`)
  return campaignId
}

function archiveCampaign(env: Env, campaignId: string): void {
  env.rawDb.prepare(`UPDATE campaigns SET archived_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(campaignId)
}

// Пропусната Белот победа (belot_match_completion_ledger без campaign_unit_ledger ред).
function seedBelotWin(env: Env, profileId: string, endedAtMs: number = Date.now() - 5 * 60_000): string {
  const roomId = `room-${randomUUID()}`
  const matchScope = `${roomId}:v1`
  env.rawDb.prepare(`
    INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial)
    VALUES (?, ?, ?, 'A', 1, ?, ?, 0);
  `).run(matchScope, profileId, roomId, BELOT_STAKE, toDbDate(endedAtMs))
  return matchScope
}

function ledgerRows(env: Env, matchScope: string): Array<{ campaign_id: string; units_amount: number }> {
  const rows = env.rawDb
    .prepare(`SELECT campaign_id, units_amount FROM campaign_unit_ledger WHERE source_type = 'belot_win' AND source_id = ?;`)
    .all(matchScope) as Array<{ campaign_id: string; units_amount: number }>
  // node:sqlite връща null-prototype обекти — plain копие за deepEqual.
  return rows.map((row) => ({ campaign_id: row.campaign_id, units_amount: row.units_amount }))
}

function cursorRows(env: Env): unknown[] {
  return env.rawDb.prepare(`SELECT * FROM campaign_credit_reconciliation_state ORDER BY source_type;`).all()
}

function countingStore(store: CampaignCreditStore, afterCredit?: (callIndex: number) => void) {
  const counter = { calls: 0 }
  const wrapped = {
    ...store,
    creditCampaignUnits: (input: Parameters<CampaignCreditStore['creditCampaignUnits']>[0]) => {
      counter.calls += 1
      const result = store.creditCampaignUnits(input)
      afterCredit?.(counter.calls)
      return result
    },
  } as CampaignCreditStore
  return { store: wrapped, counter }
}

type JobOptions = {
  store?: CampaignCreditStore
  gate?: (() => boolean) | 'none'
  extra?: Partial<CampaignCreditReconciliationJobDeps>
}

function makeJob(env: Env, options: JobOptions = {}) {
  const purchase = { calls: 0 }
  const store = options.store ?? env.creditStore
  const deps: CampaignCreditReconciliationJobDeps = {
    databaseFilePath: env.dbPath,
    campaignCreditStore: store,
    reconcilePurchases: (databaseFilePath, campaignCreditStore, bounds) => {
      purchase.calls += 1
      return reconcileMissingPurchaseCampaignCredits(databaseFilePath, campaignCreditStore, bounds)
    },
    ...options.extra,
  }
  if (options.gate !== 'none') {
    deps.hasCreditCandidateCampaign = options.gate ?? (() => env.creditStore.hasCreditCandidateCampaign())
  }
  return { job: createCampaignCreditReconciliationJob(deps), purchase }
}

const GATE_LOG_MARKERS = ['skipping historical scans', 'resuming historical scans', 'eligibility check failed']

async function captureGateLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const isGateLine = (args: unknown[]) => GATE_LOG_MARKERS.some((marker) => String(args[0]).includes(marker))
  console.log = (...args: unknown[]) => { if (isGateLine(args)) logs.push(String(args[0])); else originalLog(...args) }
  console.error = (...args: unknown[]) => { if (isGateLine(args)) errors.push(String(args[0])); else originalError(...args) }
  try {
    return { result: await fn(), logs, errors }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== Skip: няма кандидат-кампания ===')

await check('[G1] Няма кампании -> skip без сканиране, без cursor, без credit', async () => {
  const env = await createEnv()
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const counting = countingStore(env.creditStore)
  const { job, purchase } = makeJob(env, { store: counting.store })
  const { logs } = await captureGateLogs(() => job.tickNow())
  job.close()

  assert.equal(env.creditStore.hasCreditCandidateCampaign(), false)
  assert.equal(counting.counter.calls, 0, 'creditCampaignUnits не бива да се вика')
  assert.equal(purchase.calls, 0, 'purchase reconciliation не бива да се вика')
  assert.deepEqual(cursorRows(env), [], 'никакъв cursor ред -> belot/ludo сканирането не е започнало')
  assert.deepEqual(ledgerRows(env, scope), [])
  const health = job.getHealth()
  assert.equal(health.lastSkipReason, 'no_credit_candidate_campaign')
  assert.equal(health.lastError, null)
  assert.equal(health.lastBelotResult, null)
  assert.equal(logs.length, 1, 'един skip лог')
})

await check('[G2] Всички кампании архивирани -> skip, cursor-ите непокътнати', async () => {
  const env = await createEnv()
  const finishedId = createCampaign(env, 'finished')
  archiveCampaign(env, finishedId)
  const stoppedId = createCampaign(env, 'stopped')
  archiveCampaign(env, stoppedId)
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  env.rawDb.exec(`
    INSERT INTO campaign_credit_reconciliation_state (source_type, cursor_event_at, cursor_source_id, cursor_profile_id, updated_at)
    VALUES ('belot_win', '2026-10-01 10:00:00', 'scope-x', 'p-x', '2026-10-01 10:00:05'),
           ('ludo_win', '2026-10-02 11:00:00', 'match-y', 'p-y', '2026-10-02 11:00:05');
  `)
  const before = cursorRows(env)

  const counting = countingStore(env.creditStore)
  const { job, purchase } = makeJob(env, { store: counting.store })
  await captureGateLogs(async () => { await job.tickNow(); await job.tickNow() })
  job.close()

  assert.equal(env.creditStore.hasCreditCandidateCampaign(), false)
  assert.equal(counting.counter.calls, 0)
  assert.equal(purchase.calls, 0)
  assert.deepEqual(cursorRows(env), before, 'cursor-ите (вкл. updated_at) не се променят при skip')
  assert.deepEqual(ledgerRows(env, scope), [], 'архивирана кампания не получава начисление')
})

await check('[G3] Само draft/scheduled -> skip', async () => {
  const env = await createEnv()
  createCampaign(env, 'draft')
  createCampaign(env, 'scheduled')
  const player = randomUUID()
  insertProfile(env, player)
  seedBelotWin(env, player)
  const counting = countingStore(env.creditStore)
  const { job } = makeJob(env, { store: counting.store })
  await captureGateLogs(() => job.tickNow())
  job.close()
  assert.equal(env.creditStore.hasCreditCandidateCampaign(), false)
  assert.equal(counting.counter.calls, 0)
  assert.deepEqual(cursorRows(env), [])
  assert.equal(job.getHealth().lastSkipReason, 'no_credit_candidate_campaign')
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Execute: има кандидат-кампания ===')

await check('[G4] Активна кампания -> execute, пропуснатата победа се начислява', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'active')
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const { job, purchase } = makeJob(env)
  await job.tickNow()
  job.close()
  assert.deepEqual(ledgerRows(env, scope), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }])
  assert.equal(purchase.calls, 1)
  assert.notDeepEqual(cursorRows(env), [], 'сканирането е изпълнено')
  assert.equal(job.getHealth().lastSkipReason, null)
  assert.equal(job.getHealth().lastError, null)
})

await check('[G5] finished, неархивирана -> закъсняло начисление в прозореца', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'finished')
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const { job } = makeJob(env)
  await job.tickNow()
  job.close()
  assert.deepEqual(ledgerRows(env, scope), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }])
})

await check('[G6] stopped, неархивирана -> начислява преди спирането, не след него', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'stopped')
  const player = randomUUID()
  insertProfile(env, player)
  const beforeStop = seedBelotWin(env, player, Date.now() - 10 * 60_000)
  const afterStop = seedBelotWin(env, player, Date.now() + 10 * 60_000)
  const { job } = makeJob(env)
  await job.tickNow()
  job.close()
  assert.deepEqual(ledgerRows(env, beforeStop), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }])
  assert.deepEqual(ledgerRows(env, afterStop), [], 'събитие след момента на спиране не се начислява')
})

await check('[G7] soft-deleted finished, неархивирана -> execute (deleted_at поведение непроменено)', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'finished')
  const deleted = env.campaignsStore.softDeleteCampaign(campaignId, env.admin)
  assert.ok(deleted.ok, 'softDeleteCampaign')
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  assert.equal(env.creditStore.hasCreditCandidateCampaign(), true)
  const { job } = makeJob(env)
  await job.tickNow()
  job.close()
  assert.deepEqual(ledgerRows(env, scope), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }])
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Преходи: възобновяване, архивиране, грешки ===')

await check('[G8] skip tick-ове -> нова активна кампания -> възобновяване без дублиране; лог само при смяна', async () => {
  const env = await createEnv()
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const { job } = makeJob(env)
  const { logs } = await captureGateLogs(async () => {
    await job.tickNow()
    await job.tickNow()
    await job.tickNow()
    assert.equal(job.getHealth().lastSkipReason, 'no_credit_candidate_campaign')
    assert.deepEqual(cursorRows(env), [], 'skip tick-овете не местят cursor-ите')

    const campaignId = createCampaign(env, 'active')
    await job.tickNow()
    assert.deepEqual(ledgerRows(env, scope), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }], 'възобновено начисление')
    await job.tickNow()
    await job.tickNow()
    assert.equal(ledgerRows(env, scope).length, 1, 'повторни tick-ове не дублират')
    assert.equal(job.getHealth().lastSkipReason, null)
  })
  job.close()
  assert.equal(logs.length, 2, `точно skip + resume лог, получено: ${JSON.stringify(logs)}`)
  assert.ok(logs[0]!.includes('skipping historical scans'))
  assert.ok(logs[1]!.includes('resuming historical scans'))
})

await check('[G9] active -> finished -> archived: следващият tick е skip, ledger и cursor непроменени', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'active')
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const { job } = makeJob(env)
  await captureGateLogs(async () => {
    await job.tickNow()
    assert.equal(ledgerRows(env, scope).length, 1)

    const finished = env.campaignsStore.finishCampaign(campaignId, new Date(Date.now() + 2000 * 3_600_000), env.admin)
    assert.ok(finished.ok, 'finishCampaign')
    archiveCampaign(env, campaignId)
    const cursorBefore = cursorRows(env)
    const ledgerCountBefore = (env.rawDb.prepare('SELECT COUNT(*) AS c FROM campaign_unit_ledger').get() as { c: number }).c

    await job.tickNow()
    assert.equal(job.getHealth().lastSkipReason, 'no_credit_candidate_campaign')
    assert.deepEqual(cursorRows(env), cursorBefore)
    assert.equal((env.rawDb.prepare('SELECT COUNT(*) AS c FROM campaign_unit_ledger').get() as { c: number }).c, ledgerCountBefore)
  })
  job.close()
})

await check('[G10] Грешка в eligibility проверката -> fail-open (пълно сканиране), един console.error', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'active')
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const { job, purchase } = makeJob(env, { gate: () => { throw new Error('eligibility boom') } })
  const { errors } = await captureGateLogs(async () => {
    await job.tickNow()
    await job.tickNow()
  })
  job.close()
  assert.deepEqual(ledgerRows(env, scope), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }], 'fail-open начислява')
  assert.equal(purchase.calls, 2, 'и двата tick-а изпълняват пълното сканиране')
  assert.equal(errors.length, 1, 'грешката се логва само при първия tick')
  assert.equal(job.getHealth().lastError, null, 'грешката в gate-а не проваля tick-а')
  assert.equal(job.getHealth().lastSkipReason, null)
})

await check('[G11] Без gate зависимост -> досегашното поведение (сканира и без кампании)', async () => {
  const env = await createEnv()
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const counting = countingStore(env.creditStore)
  const { job, purchase } = makeJob(env, { store: counting.store, gate: 'none' })
  await job.tickNow()
  job.close()
  assert.equal(counting.counter.calls, 1, 'редът се сканира и подава на creditCampaignUnits')
  assert.equal(purchase.calls, 1)
  assert.notDeepEqual(cursorRows(env), [])
  assert.deepEqual(ledgerRows(env, scope), [], 'без кампания -> no_eligible_campaign, нищо не се пише')
  assert.equal(job.getHealth().lastSkipReason, null)
})

await check('[G12] Архивиране между gate и сканиране -> 0 начисления, без грешка', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'finished')
  const player = randomUUID()
  insertProfile(env, player)
  const scope = seedBelotWin(env, player)
  const counting = countingStore(env.creditStore)
  const { job } = makeJob(env, {
    store: counting.store,
    gate: () => {
      const eligible = env.creditStore.hasCreditCandidateCampaign()
      archiveCampaign(env, campaignId)
      return eligible
    },
  })
  await job.tickNow()
  job.close()
  assert.equal(counting.counter.calls, 1, 'сканирането е изпълнено (gate върна true)')
  assert.deepEqual(ledgerRows(env, scope), [], 'архивираната кампания не получава начисление')
  assert.equal(job.getHealth().lastError, null)
})

await check('[G13] Архивиране по средата на сканирането -> само редовете преди архивирането', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'finished')
  const playerA = randomUUID()
  const playerB = randomUUID()
  insertProfile(env, playerA)
  insertProfile(env, playerB)
  const first = seedBelotWin(env, playerA, Date.now() - 20 * 60_000)
  const second = seedBelotWin(env, playerB, Date.now() - 10 * 60_000)
  const counting = countingStore(env.creditStore, (callIndex) => {
    if (callIndex === 1) archiveCampaign(env, campaignId)
  })
  const { job } = makeJob(env, { store: counting.store })
  await job.tickNow()
  job.close()
  assert.equal(counting.counter.calls, 2)
  assert.deepEqual(ledgerRows(env, first), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }])
  assert.deepEqual(ledgerRows(env, second), [], 'след архивирането не се начислява')
  assert.equal(job.getHealth().lastError, null)
})

await check('[G14] Без двойно начисление: live credit + няколко tick-а -> 1 ledger ред', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'active')
  const player = randomUUID()
  insertProfile(env, player)
  const endedAtMs = Date.now() - 5 * 60_000
  const scope = seedBelotWin(env, player, endedAtMs)
  const live = env.creditStore.creditCampaignUnits({
    profileId: player,
    sourceType: 'belot_win',
    sourceId: scope,
    eventAt: new Date(Math.floor(endedAtMs / 1000) * 1000),
    stakeAmount: BELOT_STAKE,
    didWin: true,
  })
  assert.ok(live.ok, 'live credit')
  const { job } = makeJob(env)
  await job.tickNow()
  await job.tickNow()
  await job.tickNow()
  job.close()
  assert.deepEqual(ledgerRows(env, scope), [{ campaign_id: campaignId, units_amount: BELOT_UNITS }])
  const total = env.creditStore.getProfileCampaignTotal(campaignId, player)
  assert.equal(total, BELOT_UNITS, 'тоталът не е удвоен')
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Съответствие на SQL предиката ===')

await check('[G15] status x archived x deleted: hasCreditCandidateCampaign() === creditCampaignUnits() ok', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, 'draft')
  const player = randomUUID()
  insertProfile(env, player)
  const statuses: CampaignTarget[] = ['draft', 'scheduled', 'active', 'finished', 'stopped']
  const eligibleCombos: string[] = []
  for (const status of statuses) {
    for (const archived of [false, true]) {
      for (const deleted of [false, true]) {
        env.rawDb.prepare(`
          UPDATE campaigns SET status = ?,
            archived_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            deleted_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE campaign_id = ?;
        `).run(status, archived ? 1 : 0, deleted ? 1 : 0, campaignId)
        const combo = `${status}/archived=${archived}/deleted=${deleted}`
        const gate = env.creditStore.hasCreditCandidateCampaign()
        const credit = env.creditStore.creditCampaignUnits({
          profileId: player,
          sourceType: 'belot_win',
          sourceId: `parity-${combo}`,
          eventAt: new Date(),
          stakeAmount: BELOT_STAKE,
          didWin: true,
        })
        assert.equal(gate, credit.ok, `${combo}: gate=${gate}, credit=${JSON.stringify(credit)}`)
        if (!credit.ok) assert.equal(credit.reason, 'no_eligible_campaign', combo)
        if (gate) eligibleCombos.push(combo)
      }
    }
  }
  assert.deepEqual(eligibleCombos, [
    'active/archived=false/deleted=false',
    'active/archived=false/deleted=true',
    'finished/archived=false/deleted=false',
    'finished/archived=false/deleted=true',
    'stopped/archived=false/deleted=false',
    'stopped/archived=false/deleted=true',
  ])
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Timer callback-и и jobAsync ===')

type CapturedTimer = { fn: () => unknown; ms: number }
function fakeTimers() {
  const intervals: CapturedTimer[] = []
  const timeouts: CapturedTimer[] = []
  const handle = () => ({ unref: () => {} }) as never
  return {
    intervals,
    timeouts,
    deps: {
      setInterval: (fn: () => unknown, ms: number) => { intervals.push({ fn, ms }); return handle() },
      clearInterval: () => {},
      setTimeout: (fn: () => unknown, ms: number) => { timeouts.push({ fn, ms }); return handle() },
      clearTimeout: () => {},
    } satisfies Partial<CampaignCreditReconciliationJobDeps>,
  }
}

await check('[G16] Callback-ите връщат Promise-а на tick-а; overlap guard; грешка -> resolve, без unhandled rejection', async () => {
  const env = await createEnv()
  createCampaign(env, 'active')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const timers = fakeTimers()
    const { job, purchase } = makeJob(env, { extra: timers.deps })
    job.start()
    assert.equal(timers.intervals.length, 1)
    assert.equal(timers.intervals[0]!.ms, 300_000, 'интервалът е непроменен')
    assert.equal(timers.timeouts[0]!.ms, 30_000, 'отложеният първи tick е непроменен')

    const first = timers.intervals[0]!.fn()
    const overlapping = timers.intervals[0]!.fn()
    assert.ok(first instanceof Promise, 'interval callback връща Promise')
    assert.ok(overlapping instanceof Promise)
    await Promise.all([first, overlapping])
    assert.equal(purchase.calls, 1, 'overlapping извикване не стартира втори tick')

    const initial = timers.timeouts[0]!.fn()
    assert.ok(initial instanceof Promise, 'initial timeout callback връща Promise')
    await initial
    assert.equal(purchase.calls, 2)
    job.stop()

    const failingTimers = fakeTimers()
    const failing = makeJob(env, {
      extra: {
        ...failingTimers.deps,
        reconcilePurchases: async () => { throw new Error('purchase boom') },
      },
    })
    failing.job.start()
    const originalError = console.error
    console.error = () => {}
    let settled: 'resolved' | 'rejected'
    try {
      settled = await (failingTimers.intervals[0]!.fn() as Promise<void>).then(() => 'resolved' as const, () => 'rejected' as const)
    } finally {
      console.error = originalError
    }
    failing.job.stop()
    assert.equal(settled, 'resolved', 'tick с грешка resolve-ва')
    assert.equal(failing.job.getHealth().lastError, 'purchase boom')
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
    assert.deepEqual(unhandled, [], 'няма unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

await check('[G17] jobAsync отчита цялото async времетраене на tick-а (timeSyncAndAsync wrapper)', async () => {
  const env = await createEnv()
  createCampaign(env, 'active')
  const timings = createMainThreadTimingMetrics()
  const captured: Array<() => unknown> = []
  const ASYNC_DELAY_MS = 60
  const { job } = makeJob(env, {
    extra: {
      // Същото като index.ts: timedSetInterval -> timeSyncAndAsync('job', 'jobAsync', label, fn).
      setInterval: (fn: () => unknown) => {
        captured.push(() => timings.timeSyncAndAsync('job', 'jobAsync', 'campaignCreditReconciliation', fn))
        return ({ unref: () => {} }) as never
      },
      setTimeout: () => ({ unref: () => {} }) as never,
      clearInterval: () => {},
      clearTimeout: () => {},
      reconcilePurchases: async (databaseFilePath, campaignCreditStore, bounds) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, ASYNC_DELAY_MS))
        return reconcileMissingPurchaseCampaignCredits(databaseFilePath, campaignCreditStore, bounds)
      },
    },
  })
  job.start()
  await (captured[0]!() as Promise<void>)
  job.stop()
  const snapshot = timings.snapshotTenSecondAndReset()
  const asyncStat = snapshot.jobAsync?.campaignCreditReconciliation
  const syncStat = snapshot.job?.campaignCreditReconciliation
  assert.ok(asyncStat !== undefined && asyncStat.count === 1, `jobAsync запис: ${JSON.stringify(snapshot)}`)
  assert.ok(syncStat !== undefined && syncStat.count === 1, 'sync job запис')
  assert.ok(asyncStat.maxDurationMs >= ASYNC_DELAY_MS - 5, `jobAsync ${asyncStat.maxDurationMs}ms покрива async частта`)
  assert.ok(syncStat.maxDurationMs < asyncStat.maxDurationMs, 'sync частта е само до първия await')
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Source review ===')

await check('[G18] index.ts wiring, без `void runTick()`, споделен предикат', async () => {
  const indexSource = await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8')
  assert.ok(
    indexSource.includes('hasCreditCandidateCampaign: () => campaignCreditStore.hasCreditCandidateCampaign()'),
    'index.ts подава eligibility gate-а на job-а',
  )
  assert.ok(indexSource.includes(`setInterval: (fn, ms) => timedSetInterval('campaignCreditReconciliation', fn, ms)`))
  assert.ok(indexSource.includes(`setTimeout: (fn, ms) => timedSetTimeout('campaignCreditReconciliation', fn, ms)`))

  const hooksSource = await readFile(resolve(serverRoot, 'src/campaigns/campaignGameHooks.ts'), 'utf8')
  assert.ok(!hooksSource.includes('void runTick()'), 'timer callback-ите връщат Promise-а на tick-а')
  assert.ok(hooksSource.includes('setTimer(() => runTick(), intervalMs)'))
  const gateIndex = hooksSource.indexOf('const gateDecision = decideGate()')
  const firstScanIndex = hooksSource.indexOf('await reconcileMissingBelotCampaignCredits(', gateIndex)
  assert.ok(gateIndex > 0 && firstScanIndex > gateIndex, 'gate-ът е преди първото сканиране')

  const storeSource = await readFile(resolve(serverRoot, 'src/campaigns/campaignCreditStore.ts'), 'utf8')
  assert.equal(storeSource.split('${CREDIT_CANDIDATE_CAMPAIGN_SQL}').length - 1, 2, 'двете заявки ползват един и същ предикат')
  assert.ok(!/WHERE archived_at IS NULL\s+AND status IN/.test(storeSource), 'няма дублиран inline предикат')
})

for (const env of openEnvs) {
  try { env.creditStore.close() } catch { /* ignore */ }
  try { env.campaignsStore.close() } catch { /* ignore */ }
  try { env.rawDb.close() } catch { /* ignore */ }
}
for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
