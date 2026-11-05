/**
 * checkCampaignReconciliationActiveCampaign.ts — Етап 2 на оптимизацията на
 * campaignCreditReconciliation при АКТИВНА кампания:
 *   (A) филтър по прозореца на кандидат-кампаниите,
 *   (B) seek индекс + row-value cursor за Belot primary scan-а,
 *   (C) обработка на порции с освобождаване на event loop-а (setImmediate).
 *
 * Само локални временни бази (mkdtemp) — никога production.
 *
 * Прозорец (A):
 *  [W1] computeReconciliationEventWindow: none / range (UTC дни, −1/+2) /
 *       unbounded (непарсваем период, offset без Z) / граници извън 4-цифрени години
 *  [W2] property: за ВСЯКО събитие (ISO и CURRENT_TIMESTAMP формат, точно
 *       начало/край, ±1 ms/s, UTC полунощ, полунощ в София, случайни моменти),
 *       което creditCampaignUnits начислява, суровият низ е в интервала
 *  [W3] job С филтър и job БЕЗ филтър достигат ИДЕНТИЧЕН ledger за всичките 6
 *       източника (активна, приключила, спряна, архивирана, две кампании с
 *       празнина, граници, закъснели редове)
 *  [W4] удължен период между tick-овете -> новите допустими редове се начисляват
 *  [W5] нова кампания с минала начална дата -> по-старите редове се начисляват
 *  [W6] tick-ът сканира само редове в интервала; изчезнал кандидат между gate-а
 *       и прозореца -> пропуск без cursor промени
 * Индекс / заявки (B):
 *  [E1] миграция: колони на индекса, повторно прилагане = no-op, старият индекс остава
 *  [E2] EXPLAIN (с и без ANALYZE, с и без прозорец, всички граници): seek индексът, без TEMP B-TREE
 *  [E3] стара OR SQL vs нова страница с row-value: идентични редове и ред (много cursor-и)
 *  [E4] source guard: row-value предикати, прозорец и общо сканиране за 6-те източника, index.ts wiring
 * Ограничен брой прегледани редове:
 *  [S1] рядък остатък: прегледани на tick <= maxExaminedRows; липсващ ред в края се хваща
 *  [S2] legacy редове със съответствие в новия ledger: прегледани (ограничено), не обработени
 *  [S3] limit в средата на страница: точно limit на tick, всеки ред точно веднъж
 * Порции / надеждност (C):
 *  [C1] контролер: бюджет по редове и по време (fake clock), awaitOutsideSlice, finish
 *  [C2] cursor-ът е записан при ВСЯКО освобождаване на event loop-а; default setImmediate
 *  [C3] stop() по време на пауза -> спира; рестарт (нов job) довършва без загуба/дубли
 *  [C4] shutdown: stop() + затваряне на credit store-а по време на пауза -> без използване след затваряне
 *  [C5] overlapping ticks по време на пауза -> no-op
 *  [C6] архивиране по време на пауза -> останалите редове не се начисляват, без грешка
 *  [C7] fast-path начисление между порциите -> точно един ledger ред
 *  [C8] wrap до началото на историята при порции
 *  [C9] SQL грешка по време на tick-а -> lastError, cursor на обработените, после довършва
 *  [C10] грешка при начисляване на ред -> failed, останалите се обработват
 * Мониторинг:
 *  [M1] health: duration >= busy >= maxSlice, slices, SQL max+label, редове по източник, onSlice
 * Производителност:
 *  [P1] синтетични данни, активна кампания: максимална пауза на event loop-а
 *       (setImmediate проба) с порции vs единичен синхронен блок
 */

import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import {
  computeReconciliationEventWindow,
  createCampaignCreditReconciliationJob,
  createReconciliationSliceController,
  type CampaignCreditReconciliationJobDeps,
  type ReconciliationEventWindow,
} from '../src/campaigns/campaignGameHooks.js'
import { reconcileMissingPurchaseCampaignCredits } from '../src/campaigns/campaignPurchaseHooks.js'
import { dbDateToUtc } from '../src/db/dbDate.js'

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
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')
const tempDirs: string[] = []
const SEEK_INDEX = 'idx_belot_match_completion_ledger_campaign_reconciliation_seek'
const OLD_BELOT_INDEX = 'idx_belot_match_completion_ledger_ended_at'
const DAY = 86_400_000
const HOUR = 3_600_000

console.log('\ncheckCampaignReconciliationActiveCampaign\n')

// Логовете на job-а (window/gate/резултати) не са предмет на теста.
const originalLog = console.log
const originalWarn = console.warn
const originalError = console.error
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  return fn().finally(() => {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  })
}

// ─── Изолирана среда ───

type Env = {
  dir: string
  dbPath: string
  rawDb: DatabaseSync
  campaignsStore: CampaignsStore
  creditStore: CampaignCreditStore
  admin: { type: 'admin'; profileId: string }
}

const openEnvs: Env[] = []

async function applyMigrations(dbPath: string): Promise<void> {
  const migrationDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  migrationDb.exec('PRAGMA foreign_keys = ON;')
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    migrationDb.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  migrationDb.close()
}

async function openEnvAt(dir: string, dbPath: string, adminProfileId: string): Promise<Env> {
  const rawDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  rawDb.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  const env: Env = {
    dir,
    dbPath,
    rawDb,
    campaignsStore: await createCampaignsStore(dbPath),
    creditStore: await createCampaignCreditStore(dbPath),
    admin: { type: 'admin', profileId: adminProfileId },
  }
  openEnvs.push(env)
  return env
}

async function createEnv(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-campaign-active-recon-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'test.db')
  await applyMigrations(dbPath)
  const adminId = randomUUID()
  const env = await openEnvAt(dir, dbPath, adminId)
  insertProfile(env, adminId)
  return env
}

/** Консистентно копие (VACUUM INTO) — за сравнение "с филтър" vs "без филтър". */
async function cloneEnv(env: Env): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-campaign-active-recon-clone-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'clone.db')
  env.rawDb.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`)
  return openEnvAt(dir, dbPath, env.admin.profileId)
}

function closeEnv(env: Env): void {
  try { env.creditStore.close() } catch { /* ignore */ }
  try { env.campaignsStore.close() } catch { /* ignore */ }
  try { env.rawDb.close() } catch { /* ignore */ }
}

function insertProfile(env: Env, profileId: string, options: { temporary?: boolean } = {}): void {
  env.rawDb.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, profile_kind, username, normalized_username,
      display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status, is_temporary
    ) VALUES (?, NULL, 'human', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active', ?)
  `).run(profileId, `P ${profileId.slice(0, 8)}`, `p ${profileId.slice(0, 8)}`, options.temporary === true ? 1 : 0)
}

function newProfile(env: Env, options: { temporary?: boolean } = {}): string {
  const id = randomUUID()
  insertProfile(env, id, options)
  return id
}

const iso = (ms: number): string => new Date(ms).toISOString()
/** SQLite CURRENT_TIMESTAMP формат. */
const dbts = (ms: number): string => iso(ms).slice(0, 19).replace('T', ' ')

const UNITS = { belot: 7, legacy: 2, ludo: 3, coin: 5, bundle: 6, vip: 4 } as const
const BELOT_STAKE = 100
const LUDO_STAKE = 50

type CampaignSpec = {
  status: 'active' | 'finished' | 'stopped'
  startsMs: number
  endsMs: number
  /** само за stopped — моментът на campaign_stopped (effective end). */
  stoppedAtMs?: number
  archived?: boolean
}

// Draft през реалния store, след това статусът, периодът и campaign_stopped
// събитието (точният момент на спиране) се задават директно — тестваме
// reconciliation-а, не admin lifecycle валидацията (която не позволява
// застъпващи се кампании, а тук ни трябват няколко едновременно).
function createCampaign(env: Env, spec: CampaignSpec): string {
  const draft = env.campaignsStore.createDraftCampaign(
    { name: `Active ${randomUUID()}`, startsAt: iso(Date.now() - HOUR), endsAt: iso(Date.now() + 1000 * HOUR), unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
    env.admin,
  )
  if (!draft.ok) throw new Error(`createDraftCampaign failed: ${JSON.stringify(draft)}`)
  const campaignId = draft.campaign.campaignId
  const rule = env.rawDb.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, ?, ?, ?);`)
  rule.run(campaignId, 'belot', BELOT_STAKE, UNITS.belot)
  rule.run(campaignId, 'belot', 0, UNITS.legacy)
  rule.run(campaignId, 'ludo', LUDO_STAKE, UNITS.ludo)
  const pkg = env.rawDb.prepare(`INSERT INTO campaign_package_earn_rules (campaign_id, package_key, units_per_purchase) VALUES (?, ?, ?);`)
  pkg.run(campaignId, 'coin_pkg', UNITS.coin)
  pkg.run(campaignId, 'bundle_pkg', UNITS.bundle)
  pkg.run(campaignId, 'vip_30', UNITS.vip)
  if (spec.status === 'stopped') {
    env.rawDb.prepare(`INSERT INTO campaign_events (event_id, campaign_id, event_type, actor_profile_id, payload_json, created_at) VALUES (?, ?, 'campaign_stopped', ?, NULL, ?);`)
      .run(randomUUID(), campaignId, env.admin.profileId, dbts(spec.stoppedAtMs ?? spec.endsMs))
  }
  env.rawDb.prepare(`UPDATE campaigns SET status = ?, starts_at = ?, ends_at = ? WHERE campaign_id = ?;`)
    .run(spec.status, iso(spec.startsMs), iso(spec.endsMs), campaignId)
  if (spec.archived === true) archiveCampaign(env, campaignId)
  return campaignId
}

function archiveCampaign(env: Env, campaignId: string): void {
  env.rawDb.prepare(`UPDATE campaigns SET archived_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(campaignId)
}

// ─── Seed по източник (суровият низ за момента се подава отвън) ───

function seedBelotPrimary(env: Env, profileId: string, endedAt: string, didWin = true): string {
  const roomId = `room-${randomUUID()}`
  const matchScope = `${roomId}:v1`
  env.rawDb.prepare(`
    INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial)
    VALUES (?, ?, ?, 'A', ?, ?, ?, 0);
  `).run(matchScope, profileId, roomId, didWin ? 1 : 0, BELOT_STAKE, endedAt)
  return matchScope
}

function seedBelotLegacy(env: Env, profileId: string, completedAt: string, didWin = true): string {
  const roomId = `legacy-${randomUUID()}`
  env.rawDb.prepare(`
    INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial)
    VALUES (?, ?, 'A', ?, ?, 0);
  `).run(roomId, profileId, didWin ? 1 : 0, completedAt)
  return roomId
}

function seedLudo(env: Env, profileIds: string[], winnerId: string, finishedAt: string): string {
  const matchId = `ludo-${randomUUID()}`
  env.rawDb.prepare(`
    INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at)
    VALUES (?, 'lroom', 'finished', ?, ?, ?, ?, ?);
  `).run(matchId, LUDO_STAKE, profileIds.length === 4 ? 4 : 2, JSON.stringify(profileIds.map((profileId) => ({ profileId }))), winnerId, finishedAt)
  return matchId
}

function seedCoin(env: Env, profileId: string, creditedAt: string): string {
  const id = `coin-${randomUUID()}`
  env.rawDb.prepare(`
    INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, status, credited_at)
    VALUES (?, ?, 'coin_pkg', 't', 100, 100, 'eur', 'paid', ?);
  `).run(id, profileId, creditedAt)
  return id
}

function seedBundle(env: Env, profileId: string, creditedAt: string): string {
  const id = `bundle-${randomUUID()}`
  env.rawDb.prepare(`
    INSERT INTO bundle_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider, status, credited_at)
    VALUES (?, ?, 'bundle_pkg', 't', 100, 30, 100, 'eur', 'stripe', 'paid', ?);
  `).run(id, profileId, creditedAt)
  return id
}

function seedVip(env: Env, profileId: string, creditedAt: string): string {
  const id = `vip-${randomUUID()}`
  env.rawDb.prepare(`
    INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, provider, status, credited_at)
    VALUES (?, ?, 'vip_30', 30, 100, 'eur', 'stripe', 'paid', ?);
  `).run(id, profileId, creditedAt)
  return id
}

/** По един ред от всеки от 6-те източника в даден момент (форматът — според таблицата в production, освен ако не е зададен). */
function seedAllSources(env: Env, atMs: number, options: { belotFormat?: 'iso' | 'db' } = {}): string[] {
  const p = () => newProfile(env)
  const belotRaw = options.belotFormat === 'db' ? dbts(atMs) : iso(atMs)
  const ludoA = p()
  const ludoB = p()
  return [
    seedBelotPrimary(env, p(), belotRaw),
    seedBelotLegacy(env, p(), dbts(atMs)),
    seedLudo(env, [ludoA, ludoB], ludoA, dbts(atMs)),
    seedCoin(env, p(), dbts(atMs)),
    seedBundle(env, p(), dbts(atMs)),
    seedVip(env, p(), dbts(atMs)),
  ]
}

function ledgerSnapshot(env: Env): string[] {
  return (env.rawDb.prepare(`
    SELECT campaign_id, profile_id, source_type, source_id, units_amount FROM campaign_unit_ledger
    WHERE source_type <> 'admin_adjustment'
    ORDER BY campaign_id, source_type, source_id, profile_id;
  `).all() as Array<Record<string, unknown>>).map((row) => `${row.campaign_id}|${row.profile_id}|${row.source_type}|${row.source_id}|${row.units_amount}`)
}

function ledgerCount(env: Env): number {
  return (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger;`).get() as { c: number }).c
}

function cursorStates(env: Env): Array<{ source_type: string; cursor_event_at: string; cursor_source_id: string; cursor_profile_id: string }> {
  return (env.rawDb.prepare(`SELECT source_type, cursor_event_at, cursor_source_id, cursor_profile_id FROM campaign_credit_reconciliation_state ORDER BY source_type;`).all() as Array<Record<string, string>>)
    .map((row) => ({ source_type: row.source_type!, cursor_event_at: row.cursor_event_at!, cursor_source_id: row.cursor_source_id!, cursor_profile_id: row.cursor_profile_id! }))
}

type CreditInput = Parameters<CampaignCreditStore['creditCampaignUnits']>[0]

function recordingStore(store: CampaignCreditStore, options: { throwFor?: (input: CreditInput) => boolean } = {}) {
  const calls: CreditInput[] = []
  const wrapped = {
    ...store,
    creditCampaignUnits: (input: CreditInput) => {
      calls.push(input)
      if (options.throwFor?.(input) === true) throw new Error(`injected credit failure ${input.sourceId}`)
      return store.creditCampaignUnits(input)
    },
  } as CampaignCreditStore
  return { store: wrapped, calls }
}

type JobOptions = {
  store?: CampaignCreditStore
  window?: boolean
  /**
   * Порции само по брой редове (50), без времеви бюджет — за тестове, които
   * проверяват точни бройки около паузите. Времевият бюджет е покрит от [C1]
   * (fake clock) и [M1]/[P1] (реален часовник).
   */
  deterministic?: boolean
  extra?: Partial<CampaignCreditReconciliationJobDeps>
}

function makeJob(env: Env, options: JobOptions = {}) {
  const deps: CampaignCreditReconciliationJobDeps = {
    databaseFilePath: env.dbPath,
    campaignCreditStore: options.store ?? env.creditStore,
    reconcilePurchases: reconcileMissingPurchaseCampaignCredits,
    hasCreditCandidateCampaign: () => env.creditStore.hasCreditCandidateCampaign(),
  }
  if (options.window !== false) deps.getCreditCandidateWindows = () => env.creditStore.listCreditCandidateWindows()
  if (options.deterministic === true) deps.sliceBudgetMs = Number.POSITIVE_INFINITY
  return createCampaignCreditReconciliationJob({ ...deps, ...options.extra })
}

async function runTicks(job: ReturnType<typeof makeJob>, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await quiet(() => job.tickNow())
}

const NOW = Date.now()

// ════════════════════════ (A) Прозорец ════════════════════════

await check('[W1] computeReconciliationEventWindow: none / range (UTC дни −1/+2) / unbounded / крайни години', () => {
  assert.deepEqual(computeReconciliationEventWindow([]), { kind: 'none' })

  const single = computeReconciliationEventWindow([{ startsAt: '2026-11-05T22:00:00.000Z', effectiveEnd: '2026-11-20T21:59:59.999Z' }])
  assert.deepEqual(single, { kind: 'range', window: { fromInclusive: '2026-11-04', toExclusive: '2026-11-22' } })

  // CURRENT_TIMESTAMP формат (напр. ends_at/stop момент) — същото парсване като resolveCampaignForEvent.
  const dbFormat = computeReconciliationEventWindow([{ startsAt: '2026-11-05 00:00:00', effectiveEnd: '2026-11-06 00:00:00' }])
  assert.deepEqual(dbFormat, { kind: 'range', window: { fromInclusive: '2026-11-04', toExclusive: '2026-11-08' } })

  // Обхващащ интервал на няколко кампании (с празнина между тях).
  const multi = computeReconciliationEventWindow([
    { startsAt: '2026-10-01T00:00:00.000Z', effectiveEnd: '2026-10-05T00:00:00.000Z' },
    { startsAt: '2026-10-20T10:00:00.000Z', effectiveEnd: '2026-10-25T10:00:00.000Z' },
  ])
  assert.deepEqual(multi, { kind: 'range', window: { fromInclusive: '2026-09-30', toExclusive: '2026-10-27' } })

  // Offset без Z -> dbDateToUtc дава невалиден низ -> resolveCampaignForEvent никога не съвпада; филтърът -> fail-open.
  assert.deepEqual(
    computeReconciliationEventWindow([{ startsAt: '2026-11-05T00:00:00+02:00', effectiveEnd: '2026-11-20T00:00:00.000Z' }]),
    { kind: 'unbounded', reason: 'unparseable_campaign_period' },
  )
  assert.deepEqual(computeReconciliationEventWindow([{ startsAt: 'garbage', effectiveEnd: 'x' }]).kind, 'unbounded')

  // Крайни години: без граница вместо счупено лексикографско сравнение.
  const far = computeReconciliationEventWindow([{ startsAt: '0500-01-01T00:00:00.000Z', effectiveEnd: '9999-06-01T00:00:00.000Z' }])
  assert.deepEqual(far, { kind: 'range', window: { fromInclusive: '', toExclusive: '99999' } })
  assert.ok('9999-12-31T23:59:59.999Z' < '99999' && '9999-12-31 23:59:59' < '99999')
})

await check('[W2] property: всяко събитие, което creditCampaignUnits начислява, е в интервала (ISO + CURRENT_TIMESTAMP, граници, часови зони)', async () => {
  const env = await createEnv()
  const base = Date.UTC(2026, 9, 10)
  // Начало в полунощ София (22:00Z предния ден), край в полунощ София (лятно/зимно часово време).
  // (схемата допуска само една 'active' кампания едновременно)
  const specs: CampaignSpec[] = [
    { status: 'active', startsMs: Date.UTC(2026, 9, 9, 21, 0, 0), endsMs: Date.UTC(2026, 9, 20, 22, 0, 0) },
    { status: 'finished', startsMs: base - 20 * DAY + 123, endsMs: base - 15 * DAY + 999 },
    { status: 'stopped', startsMs: base + 25 * DAY, endsMs: base + 40 * DAY, stoppedAtMs: base + 28 * DAY + 13 * HOUR + 7_000 },
    { status: 'finished', startsMs: base - 60 * DAY, endsMs: base - 50 * DAY, archived: true },
  ]
  for (const spec of specs) createCampaign(env, spec)

  const decision = computeReconciliationEventWindow(env.creditStore.listCreditCandidateWindows())
  assert.equal(decision.kind, 'range')
  const window = (decision as { window: ReconciliationEventWindow }).window

  const instants = new Set<number>()
  const boundaries = specs.flatMap((s) => [s.startsMs, s.endsMs, ...(s.stoppedAtMs === undefined ? [] : [s.stoppedAtMs])])
  for (const b of boundaries) {
    for (const d of [-DAY - 1000, -DAY, -HOUR, -1000, -1, 0, 1, 1000, HOUR, DAY, DAY + 1000]) instants.add(b + d)
    const midnight = Math.floor(b / DAY) * DAY
    for (const d of [-1000, -1, 0, 1, 1000, DAY - 1000, DAY - 1, DAY, -2 * HOUR, -3 * HOUR]) instants.add(midnight + d)
  }
  let seed = 42
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const lo = Math.min(...boundaries) - 5 * DAY
  const hi = Math.max(...boundaries) + 5 * DAY
  for (let i = 0; i < 400; i += 1) instants.add(Math.floor(lo + rand() * (hi - lo)))

  const profileId = newProfile(env)
  let credited = 0
  let notCredited = 0
  for (const ms of instants) {
    for (const raw of [iso(ms), dbts(ms)]) {
      const result = env.creditStore.creditCampaignUnits({
        profileId,
        sourceType: 'belot_win',
        sourceId: `w2-${randomUUID()}`,
        eventAt: new Date(dbDateToUtc(raw)),
        stakeAmount: BELOT_STAKE,
        didWin: true,
      })
      const inWindow = raw >= window.fromInclusive && raw < window.toExclusive
      if (result.ok) {
        credited += 1
        assert.ok(inWindow, `credited event ${raw} outside window [${window.fromInclusive}, ${window.toExclusive})`)
      } else {
        notCredited += 1
      }
    }
  }
  // Смислен тест: и двата изхода са застъпени.
  assert.ok(credited > 100 && notCredited > 100, `credited=${credited} notCredited=${notCredited}`)
})

await check('[W3] job С филтър == job БЕЗ филтър: идентичен ledger за 6-те източника (активна/приключила/спряна/архивирана/празнина/граници)', async () => {
  const env = await createEnv()
  const activeStart = NOW - 3 * DAY
  const activeEnd = NOW + 10 * DAY
  const finishedStart = NOW - 40 * DAY
  const finishedEnd = NOW - 30 * DAY
  const stoppedStart = NOW - 20 * DAY
  const stoppedAt = NOW - 15 * DAY + 5 * HOUR
  createCampaign(env, { status: 'active', startsMs: activeStart, endsMs: activeEnd })
  createCampaign(env, { status: 'finished', startsMs: finishedStart, endsMs: finishedEnd })
  createCampaign(env, { status: 'stopped', startsMs: stoppedStart, endsMs: NOW + 20 * DAY, stoppedAtMs: stoppedAt })
  createCampaign(env, { status: 'finished', startsMs: NOW - 200 * DAY, endsMs: NOW - 190 * DAY, archived: true })

  const moments = [
    // активна: точно начало, край-1ms, край, преди начало, полунощ
    activeStart, activeStart - 1000, activeStart + 1000, activeEnd - 1000, activeEnd, NOW - 1 * HOUR,
    Math.floor(activeStart / DAY) * DAY, Math.floor(activeStart / DAY) * DAY - 1000,
    // приключила (закъснели начисления в прозореца ѝ)
    finishedStart, finishedEnd - 1000, finishedEnd, finishedEnd + 1000, (finishedStart + finishedEnd) / 2,
    // спряна: преди / точно / след спирането
    stoppedAt - 1000, stoppedAt, stoppedAt + 1000, stoppedStart + 1000,
    // празнина между кампаниите, архивираната кампания, дълбока история
    NOW - 25 * DAY, NOW - 195 * DAY, NOW - 400 * DAY, NOW - 365 * DAY,
  ]
  for (const ms of moments) {
    seedAllSources(env, Math.floor(ms), { belotFormat: 'iso' })
    seedAllSources(env, Math.floor(ms), { belotFormat: 'db' })
  }
  // неелигибилен (временен) профил и губещ -> не се начисляват и в двата режима
  seedBelotPrimary(env, newProfile(env, { temporary: true }), iso(NOW - HOUR))
  seedBelotPrimary(env, newProfile(env), iso(NOW - HOUR), false)

  const baseline = await cloneEnv(env)
  const windowed = makeJob(env, { window: true })
  const unfiltered = makeJob(baseline, { window: false })
  await runTicks(windowed, 3)
  await runTicks(unfiltered, 3)

  const withWindow = ledgerSnapshot(env)
  const withoutWindow = ledgerSnapshot(baseline)
  assert.ok(withoutWindow.length > 0)
  assert.deepEqual(withWindow, withoutWindow)
  // и шестте source типа реално участват
  for (const sourceType of ['belot_win', 'ludo_win', 'package_purchase']) {
    assert.ok(withWindow.some((row) => row.includes(`|${sourceType}|`)), `missing ${sourceType}`)
  }
  assert.ok(withWindow.some((row) => row.includes('|legacy-')), 'missing legacy credits')
  for (const prefix of ['coin-', 'bundle-', 'vip-']) assert.ok(withWindow.some((row) => row.includes(`|${prefix}`)), `missing ${prefix}`)
  const health = windowed.getHealth()
  assert.ok(health.lastTickEventWindow !== null)
  assert.equal(health.lastError, null)
})

await check('[W4] удължен период между tick-овете -> новите допустими редове се начисляват (всички източници)', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, { status: 'active', startsMs: NOW - 2 * DAY, endsMs: NOW - 1 * DAY })
  const late = seedAllSources(env, NOW - 6 * HOUR)
  const job = makeJob(env)
  await runTicks(job, 2)
  assert.equal(ledgerCount(env), 0, 'извън първоначалния период')
  env.rawDb.prepare(`UPDATE campaigns SET ends_at = ? WHERE campaign_id = ?;`).run(iso(NOW + 5 * DAY), campaignId)
  await runTicks(job, 2)
  for (const sourceId of late) {
    const n = (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_id = ?;`).get(sourceId) as { c: number }).c
    assert.ok(n >= 1, `not credited after extension: ${sourceId}`)
  }
})

await check('[W5] нова кампания с минала начална дата -> по-старите редове се начисляват', async () => {
  const env = await createEnv()
  createCampaign(env, { status: 'active', startsMs: NOW - 1 * DAY, endsMs: NOW + 5 * DAY })
  const old = seedAllSources(env, NOW - 30 * DAY)
  const job = makeJob(env)
  await runTicks(job, 2)
  assert.equal(ledgerCount(env), 0)
  // Вече има активна кампания -> новата (с минал период) е приключила, но неархивирана.
  createCampaign(env, { status: 'finished', startsMs: NOW - 45 * DAY, endsMs: NOW - 20 * DAY })
  await runTicks(job, 2)
  for (const sourceId of old) {
    const n = (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_id = ?;`).get(sourceId) as { c: number }).c
    assert.ok(n >= 1, `old row not credited by new back-dated campaign: ${sourceId}`)
  }
})

await check('[W6] сканират се само редовете в интервала; изчезнал кандидат между gate-а и прозореца -> пропуск без cursor промени', async () => {
  const env = await createEnv()
  createCampaign(env, { status: 'active', startsMs: NOW - 2 * DAY, endsMs: NOW + 2 * DAY })
  for (let i = 0; i < 30; i += 1) seedAllSources(env, NOW - (100 + i) * DAY) // далечна история
  seedAllSources(env, NOW - HOUR)
  const { store, calls } = recordingStore(env.creditStore)
  const job = makeJob(env, { store })
  await runTicks(job, 1)
  assert.equal(calls.length, 7, `only in-window rows are credited/attempted (ludo = 2 участника), got ${calls.length}`)
  const rows = job.getHealth().lastTickRowsBySource!
  assert.deepEqual({ ...rows }, { belotPrimary: 1, belotLegacy: 1, ludo: 2, coin: 1, bundle: 1, vip: 1 })

  const before = cursorStates(env)
  const raceJob = makeJob(env, { store, extra: { getCreditCandidateWindows: () => [] } })
  calls.length = 0
  await runTicks(raceJob, 1)
  assert.equal(calls.length, 0)
  assert.equal(raceJob.getHealth().lastSkipReason, 'no_credit_candidate_campaign')
  assert.deepEqual(cursorStates(env), before)

  // Грешка при четенето на периодите -> fail-open (без филтър), не пропуск.
  const failOpen = makeJob(env, { store, extra: { getCreditCandidateWindows: () => { throw new Error('boom') } } })
  calls.length = 0
  await runTicks(failOpen, 1)
  assert.ok(calls.length > 7, `fail-open scans history, got ${calls.length}`)
  assert.equal(failOpen.getHealth().lastTickEventWindow, null)
})

// ════════════════════════ (B) Индекс / заявки ════════════════════════

await check('[E1] миграция: колони на seek индекса, повторно прилагане = no-op, старият индекс остава', async () => {
  const env = await createEnv()
  const columns = (env.rawDb.prepare(`PRAGMA index_info(${SEEK_INDEX})`).all() as Array<{ name: string }>).map((c) => c.name)
  assert.deepEqual(columns, ['is_guest_trial', 'ended_at', 'match_scope', 'profile_id', 'did_win'])
  const oldColumns = (env.rawDb.prepare(`PRAGMA index_info(${OLD_BELOT_INDEX})`).all() as Array<{ name: string }>).map((c) => c.name)
  assert.deepEqual(oldColumns, ['did_win', 'is_guest_trial', 'ended_at', 'match_scope', 'profile_id'])
  const migration = await readFile(join(migrationsDir, '20261105_002_create_belot_match_completion_ledger_campaign_reconciliation_seek_index.sql'), 'utf8')
  env.rawDb.exec(migration)
  env.rawDb.exec(migration)
  const count = (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = ?`).get(SEEK_INDEX) as { c: number }).c
  assert.equal(count, 1)
  assert.ok(!/DROP\s+INDEX/i.test(migration), 'миграцията не премахва индекси')
})

const BELOT_FILTERS = `
        AND NOT EXISTS (SELECT 1 FROM campaign_unit_ledger cul WHERE cul.source_type = 'belot_win' AND cul.profile_id = bmcl.profile_id AND cul.source_id = bmcl.match_scope)
        AND NOT EXISTS (SELECT 1 FROM tournament_matches tm WHERE tm.room_id = bmcl.room_id)`
const BELOT_SELECT = `SELECT bmcl.match_scope AS match_scope, bmcl.profile_id AS profile_id, bmcl.ended_at AS ended_at
      FROM belot_match_completion_ledger bmcl
      WHERE bmcl.is_guest_trial = 0
        AND bmcl.profile_id IS NOT NULL`
const BELOT_ORDER = `ORDER BY bmcl.ended_at ASC, bmcl.match_scope ASC, bmcl.profile_id ASC LIMIT ?`
const WINDOW_SQL = `
        AND bmcl.ended_at >= ? AND bmcl.ended_at < ?`
// Копие на production страницата (Belot primary): флаг needs_credit в SELECT,
// във WHERE само индексируеми условия (интервал + cursor диапазон).
function newBelotPageSql(hasLower: boolean, hasUpper: boolean, withWindow: boolean): string {
  return `SELECT bmcl.match_scope AS match_scope, bmcl.profile_id AS profile_id, bmcl.ended_at AS ended_at,
             CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_unit_ledger cul WHERE cul.source_type = 'belot_win' AND cul.profile_id = bmcl.profile_id AND cul.source_id = bmcl.match_scope)
               AND NOT EXISTS (SELECT 1 FROM tournament_matches tm WHERE tm.room_id = bmcl.room_id)
             THEN 1 ELSE 0 END AS needs_credit
      FROM belot_match_completion_ledger bmcl
      WHERE bmcl.is_guest_trial = 0
        AND bmcl.profile_id IS NOT NULL${withWindow ? WINDOW_SQL : ''}${hasLower ? `
        AND (bmcl.ended_at, bmcl.match_scope, bmcl.profile_id) > (?, ?, ?)` : ''}${hasUpper ? `
        AND (bmcl.ended_at, bmcl.match_scope, bmcl.profile_id) <= (?, ?, ?)` : ''}
      ${BELOT_ORDER}`
}
const OLD_BELOT_SQL = {
  after: `${BELOT_SELECT}
        AND (bmcl.ended_at > ? OR (bmcl.ended_at = ? AND bmcl.match_scope > ?) OR (bmcl.ended_at = ? AND bmcl.match_scope = ? AND bmcl.profile_id > ?))${BELOT_FILTERS}
      ${BELOT_ORDER}`,
  through: `${BELOT_SELECT}
        AND (bmcl.ended_at < ? OR (bmcl.ended_at = ? AND bmcl.match_scope < ?) OR (bmcl.ended_at = ? AND bmcl.match_scope = ? AND bmcl.profile_id <= ?))${BELOT_FILTERS}
      ${BELOT_ORDER}`,
}

async function createPlanDb(rows: number, analyze: boolean): Promise<DatabaseSync> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-campaign-active-plan-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'plan.db')
  await applyMigrations(dbPath)
  // Само планове/ред на редовете — профилите не са нужни.
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
  const insert = db.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial) VALUES (?, ?, ?, 'A', ?, 100, ?, ?)`)
  db.exec('BEGIN')
  for (let i = 0; i < rows; i += 1) {
    const room = `r-${i}`
    // ties: 4 участника на мач, част от мачовете със същия ended_at
    for (let s = 0; s < 4; s += 1) insert.run(`${room}:v1`, `p-${(i * 7 + s) % 997}`, room, s % 2, iso(NOW - Math.floor(i / 3) * 60_000), i % 50 === 0 ? 1 : 0)
  }
  db.exec('COMMIT')
  if (analyze) db.exec('ANALYZE;')
  return db
}

await check('[E2] EXPLAIN (с/без ANALYZE, с/без прозорец, всички комбинации граници): Belot primary страницата ползва seek индекса, без TEMP B-TREE', async () => {
  for (const analyze of [false, true]) {
    const db = await createPlanDb(3000, analyze)
    for (const withWindow of [false, true]) {
      for (const [hasLower, hasUpper] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        const sql = newBelotPageSql(hasLower, hasUpper, withWindow)
        const paramCount = (sql.match(/\?/g) ?? []).length
        const params = Array.from({ length: paramCount }, (_, i) => (i === paramCount - 1 ? 500 : iso(NOW - DAY)))
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail)
        const label = `analyze=${analyze} window=${withWindow} lower=${hasLower} upper=${hasUpper}: ${plan.join(' | ')}`
        assert.ok(plan.some((d) => d.includes(`SEARCH bmcl USING INDEX ${SEEK_INDEX}`) || d.includes(`SEARCH bmcl USING COVERING INDEX ${SEEK_INDEX}`)), label)
        assert.ok(!plan.some((d) => d.includes('TEMP B-TREE')), label)
        // cursor/интервал условията са в seek-а (не филтър след пълно обхождане)
        if (hasLower || withWindow) assert.ok(plan.some((d) => d.includes(SEEK_INDEX) && /ended_at|\(ended_at/.test(d)), label)
      }
    }
    db.close()
  }
})

await check('[E3] стара OR SQL vs нова страница с row-value (Belot primary): идентични редове и ред при много cursor-и', async () => {
  const db = await createPlanDb(400, false)
  const all = db.prepare(`SELECT ended_at, match_scope, profile_id FROM belot_match_completion_ledger WHERE is_guest_trial = 0 ORDER BY ended_at, match_scope, profile_id`).all() as Array<{ ended_at: string; match_scope: string; profile_id: string }>
  const cursors = [all[0]!, all[1]!, all[17]!, all[200]!, all[all.length - 2]!, all[all.length - 1]!, { ended_at: '0000', match_scope: '', profile_id: '' }, { ended_at: '9999', match_scope: '', profile_id: '' }]
  // ties: cursor в средата на група със същия ended_at/match_scope
  const tieIndex = all.findIndex((row, i) => i > 0 && row.ended_at === all[i - 1]!.ended_at && row.match_scope === all[i - 1]!.match_scope)
  if (tieIndex > 0) cursors.push(all[tieIndex]!)
  for (const c of cursors) {
    for (const limit of [500, 7, 1]) {
      const oldParams = [c.ended_at, c.ended_at, c.match_scope, c.ended_at, c.match_scope, c.profile_id, limit]
      const newParams = [c.ended_at, c.match_scope, c.profile_id, limit]
      // (в тази база няма начислени/турнирни редове -> всеки ред е needs_credit=1)
      const strip = (rows: unknown[]) => (rows as Array<Record<string, string | number>>).map((r) => {
        if ('needs_credit' in r) assert.equal(r.needs_credit, 1)
        return `${r.ended_at}|${r.match_scope}|${r.profile_id}`
      })
      assert.deepEqual(strip(db.prepare(newBelotPageSql(true, false, false)).all(...newParams)), strip(db.prepare(OLD_BELOT_SQL.after).all(...oldParams)))
      assert.deepEqual(strip(db.prepare(newBelotPageSql(false, true, false)).all(...newParams)), strip(db.prepare(OLD_BELOT_SQL.through).all(...oldParams)))
    }
  }
  db.close()
})

await check('[E4] source guard: row-value предикати, прозорец във всичките 6 източника, index.ts wiring', async () => {
  const hooks = await readFile(resolve(serverRoot, 'src/campaigns/campaignGameHooks.ts'), 'utf8')
  const purchases = await readFile(resolve(serverRoot, 'src/campaigns/campaignPurchaseHooks.ts'), 'utf8')
  const index = await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8')
  assert.ok(hooks.includes('AND (bmcl.ended_at, bmcl.match_scope, bmcl.profile_id) > (?, ?, ?)'))
  assert.ok(hooks.includes('AND (bmcl.ended_at, bmcl.match_scope, bmcl.profile_id) <= (?, ?, ?)'))
  assert.ok(!hooks.includes('bmcl.ended_at > ?') && !hooks.includes('bmcl.ended_at < ?'), 'old Belot primary OR predicates still present')
  for (const column of ['bmcl.ended_at', 'pmr.completed_at', 'lrm.finished_at']) {
    assert.ok(hooks.includes(`reconciliationEventWindowClause('${column}', bounds.eventWindow)`), column)
  }
  assert.ok(purchases.includes(`reconciliationEventWindowClause('t.credited_at', bounds.eventWindow)`))
  // всички 6 източника минават през общото сканиране с ограничен брой прегледани редове
  assert.equal(hooks.split('await runBoundedReconciliationScan<').length - 1, 3, 'belot primary + legacy + ludo')
  assert.equal(purchases.split('await runBoundedReconciliationScan<').length - 1, 1, 'coin/bundle/vip (обща функция)')
  for (const rowSource of ["'belotPrimary'", "'belotLegacy'", "'ludo'"]) assert.ok(hooks.includes(`rowSource: ${rowSource},`), rowSource)
  // "вече начислено" не е във WHERE на страниците (иначе LIMIT не ограничава прегледаните редове)
  assert.ok(hooks.includes('THEN 1 ELSE 0 END AS needs_credit') && purchases.includes('THEN 1 ELSE 0 END AS needs_credit'))
  // C1 legacy предикатите остават буквално
  assert.ok(hooks.includes('AND (pmr.completed_at, pmr.room_id, pmr.profile_id) > (?, ?, ?)'))
  assert.ok(index.includes('getCreditCandidateWindows: () => campaignCreditStore.listCreditCandidateWindows()'))
  assert.ok(index.includes(`mainThreadTimings.record('job', 'campaignCreditReconciliationSlice', durationMs)`))
  // Етап 1 wiring-ът е непокътнат
  assert.ok(index.includes('hasCreditCandidateCampaign: () => campaignCreditStore.hasCreditCandidateCampaign()'))
  assert.ok(index.includes(`setInterval: (fn, ms) => timedSetInterval('campaignCreditReconciliation', fn, ms)`))
})

// ════════════════════════ Ограничен брой прегледани редове ════════════════════════

await check('[S1] рядък остатък: прегледаните редове на tick <= maxExaminedRows; липсващ ред в края се начислява за ограничен брой tick-ове', async () => {
  const env = await createEnv()
  const campaignId = createCampaign(env, { status: 'active', startsMs: NOW - 5 * DAY, endsMs: NOW + 5 * DAY })
  const done = newProfile(env)
  const insertMatch = env.rawDb.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial) VALUES (?, ?, ?, 'A', 1, ?, ?, 0)`)
  const insertLedger = env.rawDb.prepare(`INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at) VALUES (?, ?, 'belot_win', ?, ?, ?)`)
  env.rawDb.exec('BEGIN')
  for (let i = 0; i < 3000; i += 1) {
    const endedAt = iso(NOW - 4 * DAY + i * 1000)
    insertMatch.run(`done-${i}:v1`, done, `done-${i}`, BELOT_STAKE, endedAt)
    insertLedger.run(campaignId, done, `done-${i}:v1`, UNITS.belot, endedAt)
  }
  env.rawDb.exec('COMMIT')
  const missingScope = seedBelotPrimary(env, newProfile(env), iso(NOW - HOUR))
  const { store, calls } = recordingStore(env.creditStore)
  const job = makeJob(env, { store, extra: { pageSize: 200, maxExaminedRows: 1000 } })
  let ticks = 0
  const credited = () => (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_id = ?`).get(missingScope) as { c: number }).c
  while (credited() === 0 && ticks < 10) {
    await runTicks(job, 1)
    ticks += 1
    const h = job.getHealth()
    assert.ok(h.lastTickExaminedBySource!.belotPrimary <= 1000, `examined ${h.lastTickExaminedBySource!.belotPrimary}`)
  }
  assert.equal(credited(), 1)
  assert.ok(ticks <= Math.ceil(3001 / 1000), `ticks=${ticks}`)
  // нито един вече начислен ред не е подаван за начисление
  assert.ok(calls.every((c) => !c.sourceId.startsWith('done-')), 'already-credited rows must not be re-credited')
  await runTicks(job, 3)
  assert.equal(credited(), 1)
  assert.equal(ledgerCount(env), 3001)
})

await check('[S2] legacy редове със съответствие в новия ledger: прегледани (ограничено), никога обработени', async () => {
  const env = await createEnv()
  createCampaign(env, { status: 'active', startsMs: NOW - 5 * DAY, endsMs: NOW + 5 * DAY })
  const insertResult = env.rawDb.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES (?, ?, 'A', 1, ?, 0)`)
  const profileId = newProfile(env)
  env.rawDb.exec('BEGIN')
  for (let i = 0; i < 1500; i += 1) {
    const at = NOW - 4 * DAY + i * 1000
    const scope = seedBelotPrimary(env, profileId, iso(at))
    insertResult.run(scope.replace(/:v1$/, ''), profileId, dbts(at))
  }
  env.rawDb.exec('COMMIT')
  const job = makeJob(env, { extra: { pageSize: 300, maxExaminedRows: 1000 } })
  for (let i = 0; i < 3; i += 1) {
    await runTicks(job, 1)
    const h = job.getHealth()
    assert.equal(h.lastError, null)
    assert.equal(h.lastTickRowsBySource!.belotLegacy, 0)
    assert.ok(h.lastTickExaminedBySource!.belotLegacy > 0 && h.lastTickExaminedBySource!.belotLegacy <= 1000)
  }
  const legacyCredits = (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_id NOT LIKE '%:v1'`).get() as { c: number }).c
  assert.equal(legacyCredits, 0, 'няма двойно начисление под legacy source_id формата')
})

await check('[S3] limit в средата на страница: точно limit реда на tick, всеки ред точно веднъж, без пропуски', async () => {
  const env = await createEnv()
  createCampaign(env, { status: 'active', startsMs: NOW - 5 * DAY, endsMs: NOW + 5 * DAY })
  const scopes: string[] = []
  for (let i = 0; i < 40; i += 1) scopes.push(seedBelotPrimary(env, newProfile(env), iso(NOW - 3 * DAY + i * 1000)))
  const { store, calls } = recordingStore(env.creditStore)
  const job = makeJob(env, { store, extra: { limit: 7, pageSize: 100 } })
  for (let tick = 1; tick <= 6; tick += 1) {
    await runTicks(job, 1)
    assert.equal(job.getHealth().lastTickRowsBySource!.belotPrimary, Math.min(7, 40 - (tick - 1) * 7))
  }
  assert.deepEqual(calls.map((c) => c.sourceId), scopes, 'ред по ред, без пропуски и повторения')
  assert.equal(ledgerCount(env), 40)
})

// ════════════════════════ (C) Порции / надеждност ════════════════════════

await check('[C1] контролер: бюджет по редове и по време (fake clock), awaitOutsideSlice, finish', async () => {
  let clock = 0
  const yields: number[] = []
  const slices: number[] = []
  const controller = createReconciliationSliceController({
    maxRowsPerSlice: 3,
    sliceBudgetMs: 20,
    nowMs: () => clock,
    yieldToEventLoop: async () => { yields.push(clock) },
    isAborted: () => false,
    onSlice: (ms) => { slices.push(ms); throw new Error('monitoring failure is swallowed') },
  })
  clock = 1; assert.equal(controller.rowProcessed('belotPrimary'), false)
  clock = 2; assert.equal(controller.rowProcessed('belotPrimary'), false)
  clock = 3; assert.equal(controller.rowProcessed('ludo'), true, '3 реда = изчерпан бюджет')
  await controller.yieldNow()
  clock = 10; assert.equal(controller.rowProcessed('coin'), false)
  clock = 31; assert.equal(controller.rowProcessed('coin'), true, '>=20 ms = изчерпан бюджет')
  await controller.checkpoint()
  assert.equal(yields.length, 2)
  // await извън порция: времето на чакане не е блокиране
  clock = 40
  await controller.awaitOutsideSlice(new Promise<void>((resolveWait) => setImmediate(() => { clock = 500; resolveWait() })))
  clock = 505
  const sqlResult = controller.timeSql('x.select', () => { clock = 512; return 42 })
  assert.equal(sqlResult, 42)
  const stats = controller.finish()
  assert.deepEqual(slices, [3, 28, 9, 12])
  assert.equal(stats.slices, 4)
  assert.equal(stats.maxSliceMs, 28)
  assert.equal(stats.busyMs, 52)
  assert.equal(stats.maxSqlMs, 7)
  assert.equal(stats.maxSqlLabel, 'x.select')
  assert.deepEqual({ ...stats.rowsBySource }, { belotPrimary: 2, belotLegacy: 0, ludo: 1, coin: 2, bundle: 0, vip: 0 })
  // checkpoint без изчерпан бюджет не освобождава
  let c2 = 0
  let y2 = 0
  const quietController = createReconciliationSliceController({ maxRowsPerSlice: 50, sliceBudgetMs: 20, nowMs: () => c2, yieldToEventLoop: async () => { y2 += 1 }, isAborted: () => false })
  await quietController.checkpoint()
  assert.equal(y2, 0)
})

/** Активна кампания + N пропуснати Belot победи + по малко от другите източници. */
async function seedBacklog(belotRows: number): Promise<{ env: Env; campaignId: string }> {
  const env = await createEnv()
  const campaignId = createCampaign(env, { status: 'active', startsMs: NOW - 5 * DAY, endsMs: NOW + 5 * DAY })
  for (let i = 0; i < belotRows; i += 1) seedBelotPrimary(env, newProfile(env), iso(NOW - 4 * DAY + i * 1000))
  for (let i = 0; i < 20; i += 1) seedAllSources(env, NOW - 3 * DAY + i * 1000)
  return { env, campaignId }
}

// seedAllSources: 7 обработени реда (belot primary + legacy + 2 ludo участника
// + coin + bundle + vip), но 6 ledger реда — губещият в Ludo при winner_only
// (default) е not_winner и не получава ред.
const ROWS_PER_SEED = 7
const LEDGER_PER_SEED = 6
const EXPECTED_EXTRA_ROWS_PER_SEED = LEDGER_PER_SEED

await check('[C2] cursor-ът е записан при ВСЯКО освобождаване на event loop-а; default setImmediate освобождава', async () => {
  const { env } = await seedBacklog(260)
  const { store, calls } = recordingStore(env.creditStore)
  let yields = 0
  const job = makeJob(env, {
    store,
    extra: {
      yieldToEventLoop: async () => {
        yields += 1
        const last = calls[calls.length - 1]
        if (last !== undefined) {
          const saved = cursorStates(env).some((s) => s.cursor_source_id === last.sourceId && s.cursor_profile_id === last.profileId)
          assert.ok(saved, `cursor not saved before yield for ${last.sourceId}/${last.profileId}`)
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 1)
  const health = job.getHealth()
  assert.equal(health.lastError, null)
  assert.ok(yields >= Math.floor((260 + 20 * ROWS_PER_SEED) / 50), `yields=${yields}`)
  // порциите приключват и при всяко освобождаване, и при трите await import('node:sqlite')
  assert.equal(health.lastTickSlices, yields + 3 + 1)
  assert.equal(ledgerCount(env), 260 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)

  // default (setImmediate) — таймер/immediate на друг "клиент" се изпълнява ПО ВРЕМЕ на tick-а
  const { env: env2 } = await seedBacklog(200)
  const job2 = makeJob(env2)
  let interleaved = 0
  let tickDone = false
  const spin = () => { if (!tickDone) { interleaved += 1; setImmediate(spin) } }
  setImmediate(spin)
  await quiet(() => job2.tickNow())
  tickDone = true
  assert.ok(interleaved >= 4, `event loop not released during tick (interleaved=${interleaved})`)
  assert.equal(ledgerCount(env2), 200 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)
})

await check('[C3] stop() по време на пауза -> спира; рестарт (нов job) довършва без загуба и без дубли', async () => {
  const { env } = await seedBacklog(300)
  const { store, calls } = recordingStore(env.creditStore)
  let callsAtStop = -1
  const job = makeJob(env, {
    store,
    deterministic: true,
    extra: {
      yieldToEventLoop: async () => {
        if (callsAtStop < 0 && calls.length >= 100) {
          job.stop()
          callsAtStop = calls.length
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 1)
  assert.equal(callsAtStop, 100)
  assert.equal(calls.length, callsAtStop, `processed after stop: ${calls.length - callsAtStop}`)
  assert.equal(ledgerCount(env), callsAtStop)
  const health = job.getHealth()
  assert.equal(health.lastError, null)
  assert.equal(health.state, 'stopped')
  // cursor-ът сочи последния обработен ред
  const last = calls[calls.length - 1]!
  assert.ok(cursorStates(env).some((s) => s.source_type === 'belot_win' && s.cursor_source_id === last.sourceId && s.cursor_profile_id === last.profileId))

  // "рестарт": нов job instance върху същата база
  const restarted = makeJob(env)
  await runTicks(restarted, 2)
  const total = 300 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED
  assert.equal(ledgerCount(env), total)
  const dupes = (env.rawDb.prepare(`SELECT COUNT(*) AS c FROM (SELECT source_id, profile_id FROM campaign_unit_ledger GROUP BY source_type, source_id, profile_id HAVING COUNT(*) > 1)`).get() as { c: number }).c
  assert.equal(dupes, 0)
  const units = (env.rawDb.prepare(`SELECT SUM(units_total) AS s FROM campaign_profile_totals`).get() as { s: number }).s
  assert.equal(units, 300 * UNITS.belot + 20 * (UNITS.belot + UNITS.legacy + UNITS.ludo + UNITS.coin + UNITS.bundle + UNITS.vip))
})

await check('[C4] shutdown: stop() + затваряне на credit store-а по време на пауза -> без използване след затваряне, без грешка', async () => {
  const { env } = await seedBacklog(200)
  const { store, calls } = recordingStore(env.creditStore)
  let callsAtShutdown = -1
  let yields = 0
  const job = makeJob(env, {
    store,
    extra: {
      yieldToEventLoop: async () => {
        yields += 1
        if (yields === 1) {
          // mirror на index.ts shutdown реда: job.close() -> ... -> campaignCreditStore.close()
          job.close()
          env.creditStore.close()
          callsAtShutdown = calls.length
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 1)
  assert.equal(calls.length, callsAtShutdown, 'no credit calls after the store was closed')
  assert.equal(job.getHealth().lastError, null)
  assert.equal(job.getHealth().inFlight, false)
  // reconciliation връзката е затворена (finally) — нова write транзакция минава веднага
  const probe = new DatabaseSync(env.dbPath)
  probe.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; COMMIT;')
  probe.close()
  env.creditStore = await createCampaignCreditStore(env.dbPath)
})

await check('[C5] overlapping ticks по време на пауза -> no-op (inFlight guard), без двойна обработка', async () => {
  const { env } = await seedBacklog(150)
  const { store, calls } = recordingStore(env.creditStore)
  let overlapping: Promise<void> | null = null
  const job = makeJob(env, {
    store,
    extra: {
      yieldToEventLoop: async () => {
        if (overlapping === null) overlapping = job.tickNow()
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 1)
  await overlapping
  assert.equal(calls.length, 150 + 20 * ROWS_PER_SEED, 'всеки ред е опитан точно веднъж')
  assert.equal(ledgerCount(env), 150 + 20 * LEDGER_PER_SEED)
})

await check('[C6] архивиране по време на пауза -> останалите редове не се начисляват, без грешка', async () => {
  const { env, campaignId } = await seedBacklog(200)
  let yields = 0
  let creditedAtArchive = -1
  const job = makeJob(env, {
    deterministic: true,
    extra: {
      yieldToEventLoop: async () => {
        yields += 1
        if (yields === 1) {
          creditedAtArchive = ledgerCount(env)
          archiveCampaign(env, campaignId)
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 1)
  assert.equal(creditedAtArchive, 50)
  assert.equal(ledgerCount(env), 50)
  assert.equal(job.getHealth().lastError, null)
  await runTicks(job, 1)
  assert.equal(job.getHealth().lastSkipReason, 'no_credit_candidate_campaign')
  assert.equal(ledgerCount(env), 50)
})

await check('[C7] fast-path начисление между порциите -> точно един ledger ред', async () => {
  const { env } = await seedBacklog(120)
  const target = env.rawDb.prepare(`SELECT match_scope, profile_id, ended_at, stake_amount FROM belot_match_completion_ledger ORDER BY ended_at, match_scope, profile_id LIMIT 1 OFFSET 100`).get() as { match_scope: string; profile_id: string; ended_at: string; stake_amount: number }
  let yields = 0
  const job = makeJob(env, {
    deterministic: true,
    extra: {
      yieldToEventLoop: async () => {
        yields += 1
        if (yields === 1) {
          const live =env.creditStore.creditCampaignUnits({ profileId: target.profile_id, sourceType: 'belot_win', sourceId: target.match_scope, eventAt: new Date(dbDateToUtc(target.ended_at)), stakeAmount: target.stake_amount, didWin: true })
          assert.ok(live.ok && !live.alreadyCredited)
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 2)
  const rows = env.rawDb.prepare(`SELECT units_amount FROM campaign_unit_ledger WHERE source_id = ? AND profile_id = ?`).all(target.match_scope, target.profile_id) as Array<{ units_amount: number }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.units_amount, UNITS.belot)
  const totals = env.rawDb.prepare(`SELECT units_total FROM campaign_profile_totals WHERE profile_id = ?`).get(target.profile_id) as { units_total: number }
  assert.equal(totals.units_total, UNITS.belot)
  assert.equal(ledgerCount(env), 120 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)
})

await check('[C8] wrap до началото на историята при порции', async () => {
  const { env } = await seedBacklog(120)
  // cursor-ът е в средата: редовете ПРЕДИ него трябва да се хванат от wrap-а
  const mid = env.rawDb.prepare(`SELECT match_scope, profile_id, ended_at FROM belot_match_completion_ledger ORDER BY ended_at, match_scope, profile_id LIMIT 1 OFFSET 60`).get() as { match_scope: string; profile_id: string; ended_at: string }
  env.rawDb.prepare(`INSERT INTO campaign_credit_reconciliation_state (source_type, cursor_event_at, cursor_source_id, cursor_profile_id) VALUES ('belot_win', ?, ?, ?)`).run(mid.ended_at, mid.match_scope, mid.profile_id)
  const job = makeJob(env)
  await runTicks(job, 1)
  assert.equal(job.getHealth().lastBelotResult?.cursorWrapped, true)
  assert.equal(ledgerCount(env), 120 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)
})

await check('[C9] SQL грешка по време на tick-а -> lastError, cursor на обработените, след възстановяване довършва без дубли', async () => {
  const { env } = await seedBacklog(120)
  let yields = 0
  const job = makeJob(env, {
    deterministic: true,
    extra: {
      yieldToEventLoop: async () => {
        yields += 1
        // счупва Ludo заявката, преди Ludo етапът да започне
        if (yields === 1) env.rawDb.exec('ALTER TABLE ludo_room_matches RENAME TO ludo_room_matches_broken;')
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      },
    },
  })
  await runTicks(job, 1)
  const health = job.getHealth()
  assert.ok(health.lastError !== null && /ludo_room_matches/.test(health.lastError), String(health.lastError))
  const afterError = ledgerCount(env)
  assert.equal(afterError, 120 + 20 * 2, 'belot primary + legacy обработени преди грешката')
  env.rawDb.exec('ALTER TABLE ludo_room_matches_broken RENAME TO ludo_room_matches;')
  await runTicks(job, 2)
  assert.equal(job.getHealth().lastError, null)
  assert.equal(ledgerCount(env), 120 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)
})

await check('[C10] грешка при начисляване на ред -> failed, останалите се обработват', async () => {
  const { env } = await seedBacklog(80)
  const failing = env.rawDb.prepare(`SELECT match_scope FROM belot_match_completion_ledger ORDER BY ended_at LIMIT 1 OFFSET 55`).get() as { match_scope: string }
  const { store } = recordingStore(env.creditStore, { throwFor: (input) => input.sourceId === failing.match_scope })
  const job = makeJob(env, { store })
  await runTicks(job, 1)
  assert.equal(job.getHealth().lastBelotResult?.failed, 1)
  assert.equal(ledgerCount(env), 80 - 1 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)
  // без инжектираната грешка следващият цикъл го довършва
  const healthy = makeJob(env)
  await runTicks(healthy, 2)
  assert.equal(ledgerCount(env), 80 + 20 * EXPECTED_EXTRA_ROWS_PER_SEED)
})

// ════════════════════════ Мониторинг ════════════════════════

await check('[M1] health: duration >= busy >= maxSlice, slices, SQL max+label, редове по източник, onSlice', async () => {
  const { env } = await seedBacklog(130)
  const sliceDurations: number[] = []
  const job = makeJob(env, { extra: { onSlice: (ms) => sliceDurations.push(ms) } })
  assert.equal(job.getHealth().lastTickDurationMs, null)
  await runTicks(job, 1)
  const h = job.getHealth()
  assert.ok(h.lastTickDurationMs !== null && h.lastTickBusyMs !== null && h.lastTickMaxSliceMs !== null)
  assert.ok(h.lastTickDurationMs! + 0.01 >= h.lastTickBusyMs!, `duration ${h.lastTickDurationMs} busy ${h.lastTickBusyMs}`)
  assert.ok(h.lastTickBusyMs! + 0.01 >= h.lastTickMaxSliceMs!)
  assert.equal(h.lastTickSlices, sliceDurations.length)
  assert.ok(Math.abs(sliceDurations.reduce((a, b) => a + b, 0) - h.lastTickBusyMs!) < 0.05)
  assert.ok(h.lastTickMaxSqlMs !== null && typeof h.lastTickMaxSqlLabel === 'string' && h.lastTickMaxSqlLabel.length > 0)
  assert.ok(h.lastTickSqlTotalMs !== null && h.lastTickSqlTotalMs <= h.lastTickBusyMs! + 0.05)
  assert.deepEqual({ ...h.lastTickRowsBySource! }, { belotPrimary: 150, belotLegacy: 20, ludo: 40, coin: 20, bundle: 20, vip: 20 })
  for (const [source, processedRows] of Object.entries(h.lastTickRowsBySource!)) {
    assert.ok(h.lastTickExaminedBySource![source as keyof typeof h.lastTickExaminedBySource] >= processedRows, `examined < processed for ${source}`)
  }
  assert.ok(h.lastTickEventWindow !== null)
  // пропуснат tick (Етап 1) също обновява показателите, без редове
  const empty = await createEnv()
  const skipJob = makeJob(empty)
  await runTicks(skipJob, 1)
  const s = skipJob.getHealth()
  assert.equal(s.lastSkipReason, 'no_credit_candidate_campaign')
  assert.equal(s.lastTickSlices, 1)
  assert.equal(s.lastTickEventWindow, null)
  assert.deepEqual({ ...s.lastTickRowsBySource! }, { belotPrimary: 0, belotLegacy: 0, ludo: 0, coin: 0, bundle: 0, vip: 0 })
})

// ════════════════════════ Производителност ════════════════════════

const PERF_BELOT_MATCHES = Number(process.env.PERF_BELOT_MATCHES ?? 12_000)
const PERF_MAX_GAP_MS = Number(process.env.PERF_MAX_GAP_MS ?? 150)

// setImmediate верига: всяко изпълнение = една итерация на event loop-а;
// разликата между две изпълнения = най-дългата синхронна работа между тях.
// stop() изчаква още една итерация, за да отчете и паузата точно преди края.
function startEventLoopProbe(): { stop: () => Promise<number> } {
  let last = performance.now()
  let maxGap = 0
  let running = true
  const probe = () => {
    const nowMs = performance.now()
    if (nowMs - last > maxGap) maxGap = nowMs - last
    last = nowMs
    if (running) setImmediate(probe)
  }
  setImmediate(probe)
  return {
    stop: async () => {
      await new Promise<void>((resolveProbe) => setImmediate(resolveProbe))
      await new Promise<void>((resolveProbe) => setImmediate(resolveProbe))
      running = false
      return maxGap
    },
  }
}

async function measureTick(job: ReturnType<typeof makeJob>): Promise<{ gap: number; health: ReturnType<ReturnType<typeof makeJob>['getHealth']> }> {
  const probe = startEventLoopProbe()
  await new Promise<void>((resolveStart) => setImmediate(resolveStart))
  await runTicks(job, 1)
  const gap = await probe.stop()
  return { gap, health: job.getHealth() }
}

await check(`[P1] синтетични данни (${PERF_BELOT_MATCHES} Belot мача x4), активна кампания: максимална пауза на event loop-а с порции vs единичен блок`, async () => {
  const env = await createEnv()
  createCampaign(env, { status: 'active', startsMs: NOW - 7 * DAY, endsMs: NOW + 30 * DAY })
  const profiles: string[] = []
  for (let i = 0; i < 2000; i += 1) profiles.push(newProfile(env, { temporary: i % 20 === 0 }))
  const pick = (i: number) => profiles[(i * 7919) % profiles.length]!
  const insertBelot = env.rawDb.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
  const insertLegacy = env.rawDb.prepare(`INSERT OR IGNORE INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES (?, ?, ?, ?, ?, 0)`)
  const insertLudo = env.rawDb.prepare(`INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at) VALUES (?, 'lroom', 'finished', ?, 2, ?, ?, ?)`)
  env.rawDb.exec('BEGIN')
  for (let m = 0; m < PERF_BELOT_MATCHES; m += 1) {
    const room = `perf-${m}`
    const t = NOW - (m % 180) * DAY - (m % 1000) * 1000
    for (let s = 0; s < 4; s += 1) {
      insertBelot.run(`${room}:v1`, pick(m * 4 + s), room, s % 2 === 0 ? 'A' : 'B', s % 2, [0, 50, 100, 200][m % 4], iso(t))
      insertLegacy.run(`old-${room}`, pick(m * 4 + s + 1), 'A', s % 2, dbts(t - 400 * DAY))
    }
    if (m % 4 === 0) insertLudo.run(`perf-ludo-${m}`, [0, 50][m % 2], JSON.stringify([{ profileId: pick(m) }, { profileId: pick(m + 1) }]), pick(m), dbts(t))
  }
  env.rawDb.exec('COMMIT')

  // Еднакви изходни бази за трите режима.
  const singleBlockEnv = await cloneEnv(env)
  const noWindowEnv = await cloneEnv(env)
  const NO_SLICING = { maxRowsPerSlice: Number.MAX_SAFE_INTEGER, sliceBudgetMs: Number.POSITIVE_INFINITY }

  // Сравнение при ЕДНАКВА работа: прозорец + порции (Етап 2) срещу прозорец
  // без порции (единичен синхронен блок). Tick 1 = backlog с реални
  // начисления; tick 2-3 = стабилно състояние (повторно сканиране на
  // остатъка в прозореца: губещи при winner_only, временни профили).
  const singleJob = makeJob(singleBlockEnv, { window: true, extra: NO_SLICING })
  const job = makeJob(env)
  const rowsLine = (h: ReturnType<ReturnType<typeof makeJob>['getHealth']>) => JSON.stringify(h.lastTickRowsBySource)
  let worstGap = 0
  let worstSlice = 0
  let singleWorstGap = 0
  for (let i = 1; i <= 3; i += 1) {
    const single = await measureTick(singleJob)
    const sliced = await measureTick(job)
    singleWorstGap = Math.max(singleWorstGap, single.gap)
    worstGap = Math.max(worstGap, sliced.gap)
    worstSlice = Math.max(worstSlice, sliced.health.lastTickMaxSliceMs ?? 0)
    originalLog(`        tick ${i} single block: tick=${single.health.lastTickDurationMs}ms maxSlice=${single.health.lastTickMaxSliceMs}ms probeGap=${single.gap.toFixed(1)}ms rows=${rowsLine(single.health)}`)
    originalLog(`        tick ${i} stage 2     : tick=${sliced.health.lastTickDurationMs}ms busy=${sliced.health.lastTickBusyMs}ms maxSlice=${sliced.health.lastTickMaxSliceMs}ms slices=${sliced.health.lastTickSlices} maxSql=${sliced.health.lastTickMaxSqlMs}ms(${sliced.health.lastTickMaxSqlLabel}) probeGap=${sliced.gap.toFixed(1)}ms rows=${rowsLine(sliced.health)}`)
    assert.equal(sliced.health.lastError, null)
    assert.equal(single.health.lastError, null)
  }
  assert.deepEqual(ledgerSnapshot(env), ledgerSnapshot(singleBlockEnv), 'порциите не променят резултата')

  // Информативно: без прозорец (историята извън кампанията се сканира) и без порции.
  const noWindow = await measureTick(makeJob(noWindowEnv, { window: false, extra: NO_SLICING }))
  originalLog(`        reference (no window, no slicing): tick=${noWindow.health.lastTickDurationMs}ms probeGap=${noWindow.gap.toFixed(1)}ms rows=${rowsLine(noWindow.health)}`)

  assert.ok(worstGap <= PERF_MAX_GAP_MS, `max event-loop gap ${worstGap.toFixed(1)}ms > ${PERF_MAX_GAP_MS}ms`)
  assert.ok(worstGap < singleWorstGap, `sliced gap ${worstGap.toFixed(1)} not below single-block gap ${singleWorstGap.toFixed(1)}`)
  // Пробата и контролерът мерят едно и също (пробата има собствен overhead).
  assert.ok(worstGap <= worstSlice + 50, `probe gap ${worstGap.toFixed(1)} vs reported maxSlice ${worstSlice.toFixed(1)}`)
})

console.log = originalLog
for (const env of openEnvs) closeEnv(env)
for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
