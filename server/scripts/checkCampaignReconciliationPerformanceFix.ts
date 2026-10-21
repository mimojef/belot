/**
 * checkCampaignReconciliationPerformanceFix.ts — campaign credit reconciliation
 * performance fix A + B1 + C1 (legacy Belot seek).
 *
 * C1 (legacy seek SQL + индекс):
 *  [C1.1] стара OR SQL vs нова row-value SQL: идентични редове И ред за много
 *         cursor-и (празен, случайни, ties, граници, след max, преди min),
 *         limits 500/7/1, с production wrap логиката
 *  [C1.2] production reconcileMissingBelotCampaignCredits обработва ТОЧНО
 *         същата последователност legacy редове tick по tick (вкл. wrap/reset)
 *         като симулацията със старата SQL
 *  [C1.3] EXPLAIN: seek index с row-value constraint, без TEMP B-TREE;
 *         production source съдържа новите предикати, не старите
 *  [C1.4] migration: индексът съществува с точните колони; повторно
 *         прилагане е no-op; старият индекс остава
 * B1 (един cursor запис на source/batch):
 *  [B1.1] runReconciliationBatch unit: нормален край, exception, празен batch, без saver
 *  [B1.2] точно един cursor save на source за tick (belot primary/legacy, ludo, coin/bundle/vip)
 *  [B1.3] финалният cursor = последният обработен ред (skipped/ineligible/not_winner)
 *  [B1.4] legacy insufficient-stake `return` (ex-`continue`) път
 *  [B1.5] per-row failure път
 *  [B1.6] unexpected exception: cursor = текущия ред, грешката се препредава
 *  [B1.7] провал на финалния cursor save -> replay без дублирани credits
 *  [B1.8] wrap/reset поведението е непроменено
 * A (отложен първи tick):
 *  [A.1]-[A.6] start() без синхронен tick; tick след delay; stop преди timer;
 *              unref; 5-min interval непроменен; start/stop/start без дублиране
 */

import { strict as assert } from 'node:assert'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createCampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import {
  createCampaignCreditReconciliationJob,
  reconcileMissingBelotCampaignCredits,
  reconcileMissingLudoCampaignCredits,
  runReconciliationBatch,
} from '../src/campaigns/campaignGameHooks.js'
import { reconcileMissingPurchaseCampaignCredits } from '../src/campaigns/campaignPurchaseHooks.js'

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
const migrationsDir = resolve(__dirname, '..', 'database', 'migrations')
const SEEK_MIGRATION = '20261021_002_create_profile_match_results_campaign_reconciliation_seek_index.sql'
const SEEK_INDEX = 'idx_profile_match_results_campaign_reconciliation_seek'
const tempDirs: string[] = []

async function createMigratedDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-campaign-recon-perf-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'test.db')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  db.close()
  return dbPath
}

// Seed връзка без FK (синтетичните редове не изискват пълни profiles/tournaments).
function openSeed(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: false })
}

const ts = (secondOffset: number): string =>
  new Date(Date.UTC(2026, 0, 1) + secondOffset * 1000).toISOString().slice(0, 19).replace('T', ' ')

type LegacyRow = { room_id: string; profile_id: string; completed_at: string; did_win: number }
type Cursor = { eventAt: string; sourceId: string; profileId: string }
const EMPTY_CURSOR: Cursor = { eventAt: '', sourceId: '', profileId: '' }

// ─── Стара (HEAD b4f2271) и нова legacy SQL — точно копие на production текста ───
const LEGACY_FILTERS = `
        AND NOT EXISTS (
            SELECT 1 FROM campaign_unit_ledger cul
            WHERE cul.source_type = 'belot_win'
              AND cul.profile_id = pmr.profile_id
              AND (cul.source_id = pmr.room_id OR cul.source_id LIKE pmr.room_id || ':v%')
          )
        AND NOT EXISTS (
            SELECT 1 FROM belot_match_completion_ledger bmcl2
            WHERE bmcl2.room_id = pmr.room_id AND bmcl2.profile_id = pmr.profile_id
          )
        AND NOT EXISTS (
            SELECT 1 FROM tournament_matches tm WHERE tm.room_id = pmr.room_id
          )
      ORDER BY pmr.completed_at ASC, pmr.room_id ASC, pmr.profile_id ASC
      LIMIT ?;`
const LEGACY_SELECT = `
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at, pmr.did_win AS did_win
      FROM profile_match_results pmr
      WHERE pmr.is_guest_trial = 0
        AND pmr.profile_id IS NOT NULL`
const OLD_SQL = {
  fromStart: `${LEGACY_SELECT}${LEGACY_FILTERS}`,
  after: `${LEGACY_SELECT}
        AND (
          pmr.completed_at > ?
          OR (pmr.completed_at = ? AND pmr.room_id > ?)
          OR (pmr.completed_at = ? AND pmr.room_id = ? AND pmr.profile_id > ?)
        )${LEGACY_FILTERS}`,
  through: `${LEGACY_SELECT}
        AND (
          pmr.completed_at < ?
          OR (pmr.completed_at = ? AND pmr.room_id < ?)
          OR (pmr.completed_at = ? AND pmr.room_id = ? AND pmr.profile_id <= ?)
        )${LEGACY_FILTERS}`,
}
const NEW_SQL = {
  fromStart: OLD_SQL.fromStart,
  after: `${LEGACY_SELECT}
        AND (pmr.completed_at, pmr.room_id, pmr.profile_id) > (?, ?, ?)${LEGACY_FILTERS}`,
  through: `${LEGACY_SELECT}
        AND (pmr.completed_at, pmr.room_id, pmr.profile_id) <= (?, ?, ?)${LEGACY_FILTERS}`,
}
const oldParams = (c: Cursor) => [c.eventAt, c.eventAt, c.sourceId, c.eventAt, c.sourceId, c.profileId]
const newParams = (c: Cursor) => [c.eventAt, c.sourceId, c.profileId]

// Production tick логиката (FromStart / After + Through(wrap)) за дадена SQL версия.
function fetchLegacyTick(db: DatabaseSync, variant: 'old' | 'new', cursor: Cursor, limit: number): { rows: LegacyRow[]; wrapped: boolean } {
  const sql = variant === 'old' ? OLD_SQL : NEW_SQL
  const params = variant === 'old' ? oldParams : newParams
  if (cursor.eventAt === '') return { rows: db.prepare(sql.fromStart).all(limit) as LegacyRow[], wrapped: false }
  let rows = db.prepare(sql.after).all(...params(cursor), limit) as LegacyRow[]
  let wrapped = false
  if (rows.length < limit) {
    const wrappedRows = db.prepare(sql.through).all(...params(cursor), limit - rows.length) as LegacyRow[]
    if (wrappedRows.length > 0) {
      wrapped = true
      rows = rows.concat(wrappedRows)
    }
  }
  return { rows, wrapped }
}
const rowKeys = (rows: LegacyRow[]) => JSON.stringify(rows.map((r) => [r.completed_at, r.room_id, r.profile_id, r.did_win]))

// Синтетичен legacy dataset с всички edge cases.
function seedLegacyDataset(dbPath: string, count: number): void {
  const seed = openSeed(dbPath)
  const insertPmr = seed.prepare(`INSERT OR IGNORE INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES (?, ?, 'A', ?, ?, ?)`)
  const insertBmcl = seed.prepare(`INSERT OR IGNORE INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial) VALUES (?, ?, ?, 'A', 0, 0, ?, 0)`)
  const insertCul = seed.prepare(`INSERT OR IGNORE INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at) VALUES ('seed-campaign', ?, 'belot_win', ?, 1, '2026-01-01T00:00:00.000Z')`)
  const insertTm = seed.prepare(`INSERT OR IGNORE INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id) VALUES (?, 't', 'r', ?, 'ta', 'tb')`)
  let state = 7
  const rand = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
  seed.exec('BEGIN')
  for (let i = 0; i < count; i += 1) {
    const second = Math.floor(i / 3) // ties: по 3 реда на секунда
    // room ids с лексикографски граници: lr-1, lr-10, lr-100 ...
    const room = `lr-${Math.floor(i / 2)}`
    const profile = rand() < 0.03 ? null : `p-${Math.floor(rand() * 40)}`
    const guest = rand() < 0.05 ? 1 : 0
    insertPmr.run(room, profile, i % 2, ts(second), guest)
    if (profile !== null) {
      const roll = rand()
      if (roll < 0.04) insertCul.run(profile, room) // credited (точен source_id)
      else if (roll < 0.06) insertCul.run(profile, `${room}:v2`) // credited (LIKE ':v%' път)
      else if (roll < 0.09) insertBmcl.run(`scope-${room}`, profile, room, ts(second)) // в новия ledger
    }
    if (rand() < 0.02) insertTm.run(`tm-${i}`, room) // турнирна стая
  }
  seed.exec('COMMIT')
  seed.close()
}

// Spy credit store: записва legacy извикванията, никога не пише.
function createSpyStore(
  decide: (input: { profileId: string; sourceId: string }) => { ok: boolean; reason?: string } | 'throw' = () => ({ ok: false, reason: 'no_eligible_campaign' }),
) {
  const calls: Array<{ profileId: string; sourceType: string; sourceId: string }> = []
  const store = {
    creditCampaignUnits(input: { profileId: string; sourceType: string; sourceId: string }) {
      calls.push({ profileId: input.profileId, sourceType: input.sourceType, sourceId: input.sourceId })
      const outcome = decide(input)
      if (outcome === 'throw') throw new Error(`spy failure for ${input.sourceId}`)
      return outcome
    },
  }
  return { store: store as unknown as CampaignCreditStore, calls }
}

function readCursor(dbPath: string, sourceType: string): Cursor {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db.prepare(`SELECT cursor_event_at AS eventAt, cursor_source_id AS sourceId, cursor_profile_id AS profileId
    FROM campaign_credit_reconciliation_state WHERE source_type = ?`).get(sourceType) as Cursor | undefined
  db.close()
  return row ?? EMPTY_CURSOR
}

// Брои cursor UPSERT-ите (saveReconciliationCursor) по source_type чрез patch на StatementSync.run.
async function countCursorSaves<T>(fn: () => Promise<T>, failFirstSave = false): Promise<{ result: T | null; error: unknown; saves: Map<string, number> }> {
  const original = StatementSync.prototype.run
  const saves = new Map<string, number>()
  let shouldFail = failFirstSave
  StatementSync.prototype.run = function patchedRun(this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL.includes('ON CONFLICT(source_type) DO UPDATE')) {
      const sourceType = String(args[0])
      saves.set(sourceType, (saves.get(sourceType) ?? 0) + 1)
      if (shouldFail) {
        shouldFail = false
        throw new Error('simulated cursor save failure')
      }
    }
    return original.apply(this, args as never)
  } as typeof original
  try {
    return { result: await fn(), error: null, saves }
  } catch (error) {
    return { result: null, error, saves }
  } finally {
    StatementSync.prototype.run = original
  }
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== C1: legacy seek SQL + index ===')
const c1DbPath = await createMigratedDb()
seedLegacyDataset(c1DbPath, 4000)

await check('[C1.1] old OR SQL vs new row-value SQL: identical rows and order (many cursors, limits 500/7/1, wrap)', () => {
  const db = new DatabaseSync(c1DbPath, { readOnly: true })
  const all = db.prepare(`SELECT room_id AS sourceId, profile_id AS profileId, completed_at AS eventAt FROM profile_match_results
    WHERE is_guest_trial = 0 AND profile_id IS NOT NULL ORDER BY completed_at, room_id, profile_id`).all() as Cursor[]
  assert.ok(all.length > 3000, 'dataset too small')
  const cursors: Array<[string, Cursor]> = [['empty', EMPTY_CURSOR]]
  for (let i = 0; i < 40; i += 1) cursors.push([`row#${(i * 97) % all.length}`, all[(i * 97) % all.length]!])
  const tieRow = all[300]!
  cursors.push(['tie: same ts, empty room', { eventAt: tieRow.eventAt, sourceId: '', profileId: '' }])
  cursors.push(['tie: same ts+room, empty profile', { eventAt: tieRow.eventAt, sourceId: tieRow.sourceId, profileId: '' }])
  cursors.push(['tie: same ts, room prefix boundary', { eventAt: tieRow.eventAt, sourceId: 'lr-1', profileId: 'p-9' }])
  cursors.push(['first row', all[0]!])
  cursors.push(['last row (forces wrap)', all[all.length - 1]!])
  cursors.push(['after max', { eventAt: '9999-12-31 23:59:59', sourceId: '', profileId: '' }])
  cursors.push(['before min (non-empty)', { eventAt: '0000-01-01 00:00:00', sourceId: '', profileId: '' }])
  let comparisons = 0
  for (const [name, cursor] of cursors) {
    for (const limit of [500, 7, 1]) {
      const oldTick = fetchLegacyTick(db, 'old', cursor, limit)
      const newTick = fetchLegacyTick(db, 'new', cursor, limit)
      assert.equal(rowKeys(newTick.rows), rowKeys(oldTick.rows), `mismatch for cursor ${name}, limit ${limit}`)
      assert.equal(newTick.wrapped, oldTick.wrapped, `wrap flag mismatch for cursor ${name}, limit ${limit}`)
      comparisons += 1
    }
  }
  // Edge cases присъстват в dataset-а и са изключени еднакво.
  const excluded = db.prepare(`SELECT
      SUM(is_guest_trial = 1) AS guest, SUM(profile_id IS NULL) AS nullProfile,
      (SELECT COUNT(*) FROM campaign_unit_ledger) AS credited,
      (SELECT COUNT(*) FROM belot_match_completion_ledger) AS inNewLedger,
      (SELECT COUNT(*) FROM tournament_matches) AS tournament
    FROM profile_match_results`).get() as Record<string, number>
  for (const [field, value] of Object.entries(excluded)) assert.ok(value > 0, `edge case ${field} not present in dataset`)
  db.close()
  assert.ok(comparisons === cursors.length * 3)
})

await check('[C1.2] production legacy sweep processes exactly the old-SQL sequence tick by tick (incl. wrap)', async () => {
  const limit = 7
  const ticks = 12
  // Симулация (стара SQL): cursor = последният обработен ред; редовете никога не изчезват (spy не credit-ва).
  const simDb = new DatabaseSync(c1DbPath, { readOnly: true })
  let simCursor = readCursor(c1DbPath, 'belot_win_legacy')
  const expected: string[][] = []
  const expectedWrapped: boolean[] = []
  for (let i = 0; i < ticks; i += 1) {
    const { rows, wrapped } = fetchLegacyTick(simDb, 'old', simCursor, limit)
    expected.push(rows.map((r) => `${r.room_id}|${r.profile_id}`))
    expectedWrapped.push(wrapped)
    if (rows.length > 0) {
      const last = rows[rows.length - 1]!
      simCursor = { eventAt: last.completed_at, sourceId: last.room_id, profileId: last.profile_id }
    }
  }
  simDb.close()
  // Production (нова SQL) с spy store.
  const actual: string[][] = []
  const actualWrapped: boolean[] = []
  for (let i = 0; i < ticks; i += 1) {
    const spy = createSpyStore()
    const result = await reconcileMissingBelotCampaignCredits(c1DbPath, spy.store, { limit, useDurableCursor: true })
    actual.push(spy.calls.filter((call) => call.sourceId.startsWith('lr-')).map((call) => `${call.sourceId}|${call.profileId}`))
    actualWrapped.push(result.cursorWrapped)
  }
  assert.deepEqual(actual, expected, 'production legacy sequence differs from old-SQL simulation')
  // Primary scan-ът (belot_match_completion_ledger) също задава cursorWrapped; сравняваме само ако legacy е wrap-нал.
  for (let i = 0; i < ticks; i += 1) if (expectedWrapped[i]) assert.equal(actualWrapped[i], true, `tick ${i} should report wrap`)
})

await check('[C1.3] EXPLAIN uses the seek index with row-value constraint and no TEMP B-TREE; production source uses new predicates', () => {
  const db = new DatabaseSync(c1DbPath, { readOnly: true })
  const cursor: Cursor = { eventAt: ts(500), sourceId: 'lr-700', profileId: 'p-1' }
  const planOf = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...newParams(cursor), 500) as Array<{ detail: string }>).map((row) => row.detail)
  const afterPlan = planOf(NEW_SQL.after)
  const throughPlan = planOf(NEW_SQL.through)
  db.close()
  assert.ok(afterPlan.some((d) => d.includes(SEEK_INDEX) && d.includes('(completed_at,room_id,profile_id)>(?,?,?)')), afterPlan.join(' | '))
  assert.ok(throughPlan.some((d) => d.includes(SEEK_INDEX) && d.includes('(completed_at,room_id,profile_id)<(?,?,?)')), throughPlan.join(' | '))
  assert.ok(!afterPlan.some((d) => d.includes('TEMP B-TREE')) && !throughPlan.some((d) => d.includes('TEMP B-TREE')), 'TEMP B-TREE present')
  const source = readFileSync(resolve(__dirname, '..', 'src', 'campaigns', 'campaignGameHooks.ts'), 'utf8')
  assert.ok(source.includes('AND (pmr.completed_at, pmr.room_id, pmr.profile_id) > (?, ?, ?)'), 'production AfterCursor predicate missing')
  assert.ok(source.includes('AND (pmr.completed_at, pmr.room_id, pmr.profile_id) <= (?, ?, ?)'), 'production ThroughCursor predicate missing')
  assert.ok(!source.includes('pmr.completed_at > ?') && !source.includes('pmr.completed_at < ?'), 'old legacy OR predicates still present')
})

await check('[C1.4] migration: seek index exists with exact columns, re-apply is a no-op, old index kept', async () => {
  const db = new DatabaseSync(c1DbPath)
  const columns = (db.prepare(`PRAGMA index_info(${SEEK_INDEX})`).all() as Array<{ name: string }>).map((c) => c.name)
  assert.deepEqual(columns, ['is_guest_trial', 'completed_at', 'room_id', 'profile_id', 'did_win'])
  db.exec(await readFile(join(migrationsDir, SEEK_MIGRATION), 'utf8'))
  db.exec(await readFile(join(migrationsDir, SEEK_MIGRATION), 'utf8'))
  const count = (name: string) => (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) as { n: number }).n
  assert.equal(count(SEEK_INDEX), 1)
  assert.equal(count('idx_profile_match_results_campaign_reconciliation'), 1, 'old index must remain')
  db.close()
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== B1: one cursor write per source/batch ===')

await check('[B1.1] runReconciliationBatch: one save with last row; exception saves current row and rethrows; empty/no saver -> no save', () => {
  const saved: string[] = []
  runReconciliationBatch(['a', 'b', 'c'], () => {}, (row) => saved.push(row))
  assert.deepEqual(saved, ['c'])
  saved.length = 0
  assert.throws(() => runReconciliationBatch(['a', 'b', 'c'], (row) => { if (row === 'b') throw new Error('boom') }, (row) => saved.push(row)), /boom/)
  assert.deepEqual(saved, ['b'])
  saved.length = 0
  runReconciliationBatch([], () => {}, (row: string) => saved.push(row))
  assert.deepEqual(saved, [])
  let processed = 0
  runReconciliationBatch(['a', 'b'], () => { processed += 1 }, null)
  assert.equal(processed, 2)
})

const b1DbPath = await createMigratedDb()
{
  const seed = openSeed(b1DbPath)
  for (let i = 0; i < 9; i += 1) {
    seed.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial) VALUES (?, ?, ?, 'A', ?, 0, ?, 0)`)
      .run(`scope-${i}`, `bp-${i}`, `br-${i}`, i % 2, ts(i))
    seed.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES (?, ?, 'A', ?, ?, 0)`)
      .run(`lr-${i}`, `lp-${i}`, i % 2, ts(100 + i))
    seed.prepare(`INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at) VALUES (?, 'lroom', 'finished', 0, 2, ?, ?, ?)`)
      .run(`lm-${i}`, JSON.stringify([{ profileId: `la-${i}` }, { profileId: `lb-${i}` }]), `la-${i}`, ts(200 + i))
  }
  for (let i = 0; i < 4; i += 1) {
    seed.prepare(`INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, status, credited_at) VALUES (?, ?, 'k', 't', 100, 100, 'eur', 'paid', ?)`)
      .run(`cp-${i}`, `cpp-${i}`, ts(300 + i))
  }
  seed.close()
}

await check('[B1.2] exactly one cursor save per source per tick (belot primary + legacy, ludo, coin; bundle/vip none)', async () => {
  const spy = createSpyStore()
  const belot = await countCursorSaves(() => reconcileMissingBelotCampaignCredits(b1DbPath, spy.store, { limit: 500, useDurableCursor: true }))
  assert.equal(belot.error, null)
  assert.equal(belot.saves.get('belot_win'), 1)
  assert.equal(belot.saves.get('belot_win_legacy'), 1)
  const ludo = await countCursorSaves(() => reconcileMissingLudoCampaignCredits(b1DbPath, spy.store, { limit: 500, useDurableCursor: true }))
  assert.equal(ludo.saves.get('ludo_win'), 1)
  const purchases = await countCursorSaves(() => reconcileMissingPurchaseCampaignCredits(b1DbPath, spy.store, { limit: 500 }))
  assert.equal(purchases.saves.get('package_purchase_coin'), 1)
  assert.equal(purchases.saves.get('package_purchase_bundle') ?? 0, 0, 'no bundle rows -> no save (empty cursor, nothing to reset)')
  assert.equal(purchases.saves.get('package_purchase_vip') ?? 0, 0)
  assert.equal(spy.calls.length, 9 + 9 + 18 + 4, 'every row still processed')
})

await check('[B1.3] final cursor equals last processed row for skipped / ineligible / not_winner outcomes', async () => {
  const reasons = ['no_eligible_campaign', 'ineligible_profile', 'not_winner']
  let n = 0
  const spy = createSpyStore(() => ({ ok: false, reason: reasons[n++ % reasons.length] }))
  // Втори tick: cursor след първия; limit 4 -> AfterCursor + wrap -> последният ред е от wrap частта.
  await reconcileMissingBelotCampaignCredits(b1DbPath, spy.store, { limit: 4, useDurableCursor: true })
  const legacyCalls = spy.calls.filter((call) => call.sourceId.startsWith('lr-'))
  const primaryCalls = spy.calls.filter((call) => call.sourceId.startsWith('scope-'))
  const legacyCursor = readCursor(b1DbPath, 'belot_win_legacy')
  const primaryCursor = readCursor(b1DbPath, 'belot_win')
  assert.equal(`${legacyCursor.sourceId}|${legacyCursor.profileId}`, `${legacyCalls.at(-1)!.sourceId}|${legacyCalls.at(-1)!.profileId}`)
  assert.equal(`${primaryCursor.sourceId}|${primaryCursor.profileId}`, `${primaryCalls.at(-1)!.sourceId}|${primaryCalls.at(-1)!.profileId}`)
})

await check('[B1.4] legacy insufficient-stake path (ex-continue) still advances cursor to that row', async () => {
  const dbPath = await createMigratedDb()
  const seed = openSeed(dbPath)
  seed.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES ('lr-a', 'p-1', 'A', 1, ?, 0)`).run(ts(1))
  seed.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES ('lr-b', 'p-2', 'A', 1, ?, 0)`).run(ts(2))
  // lr-b: друг участник има stake_debit, p-2 не -> insufficient info -> skip без credit
  seed.prepare(`INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after) VALUES (?, 'lr-b', 'p-other', 'stake_debit', 10, 0)`).run(randomUUID())
  seed.close()
  const spy = createSpyStore()
  const originalError = console.error
  console.error = () => {}
  let result
  try {
    result = await reconcileMissingBelotCampaignCredits(dbPath, spy.store, { limit: 500, useDurableCursor: true })
  } finally {
    console.error = originalError
  }
  assert.equal(result.skippedInsufficientStakeInfo, 1)
  assert.deepEqual(spy.calls.map((call) => call.sourceId), ['lr-a'], 'lr-b must not be credited')
  const cursor = readCursor(dbPath, 'belot_win_legacy')
  assert.equal(`${cursor.sourceId}|${cursor.profileId}`, 'lr-b|p-2', 'cursor must advance past the skipped last row')
})

await check('[B1.5] per-row failure: counted as failed, batch continues, cursor = last row', async () => {
  const dbPath = await createMigratedDb()
  const seed = openSeed(dbPath)
  for (let i = 0; i < 5; i += 1) {
    seed.prepare(`INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at) VALUES (?, 'lroom', 'finished', 0, 2, ?, ?, ?)`)
      .run(`lm-${i}`, JSON.stringify([{ profileId: `la-${i}` }, { profileId: `lb-${i}` }]), `la-${i}`, ts(i))
  }
  seed.close()
  const spy = createSpyStore((input) => (input.sourceId === 'lm-2' ? 'throw' : { ok: false, reason: 'no_eligible_campaign' }))
  const originalError = console.error
  console.error = () => {}
  let result
  try {
    result = await reconcileMissingLudoCampaignCredits(dbPath, spy.store, { limit: 500, useDurableCursor: true })
  } finally {
    console.error = originalError
  }
  assert.equal(result.failed, 2, 'both participants of lm-2 fail')
  assert.equal(result.scanned, 10)
  const cursor = readCursor(dbPath, 'ludo_win')
  assert.equal(`${cursor.sourceId}|${cursor.profileId}`, 'lm-4|lb-4')
})

await check('[B1.6] unexpected exception escaping a row: cursor saved at that row, error rethrown', async () => {
  const dbPath = await createMigratedDb()
  const seed = openSeed(dbPath)
  for (let i = 0; i < 5; i += 1) {
    seed.prepare(`INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at) VALUES (?, 'lroom', 'finished', 0, 2, ?, ?, ?)`)
      .run(`lm-${i}`, JSON.stringify([{ profileId: `la-${i}` }, { profileId: `lb-${i}` }]), `la-${i}`, ts(i))
  }
  seed.close()
  const spy = createSpyStore((input) => (input.sourceId === 'lm-2' ? 'throw' : { ok: false, reason: 'no_eligible_campaign' }))
  const originalError = console.error
  // Грешка в catch блока (console.error) излиза извън per-row try -> неочаквано exception.
  console.error = () => { throw new Error('logger exploded') }
  let caught: unknown = null
  try {
    await reconcileMissingLudoCampaignCredits(dbPath, spy.store, { limit: 500, useDurableCursor: true })
  } catch (error) {
    caught = error
  } finally {
    console.error = originalError
  }
  assert.ok(caught instanceof Error && caught.message === 'logger exploded', 'error must be rethrown')
  const cursor = readCursor(dbPath, 'ludo_win')
  assert.equal(`${cursor.sourceId}|${cursor.profileId}`, 'lm-2|la-2', 'cursor must point to the row being processed (same as old per-row finally)')
  assert.equal(spy.calls.length, 5, 'rows after the failing one are not processed')
})

await check('[B1.7] final cursor save failure -> replay next tick, no duplicate credits (real credit store)', async () => {
  const dbPath = await createMigratedDb()
  const raw = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  const campaignsStore = await createCampaignsStore(dbPath)
  const creditStore = await createCampaignCreditStore(dbPath)
  const insertProfile = (id: string) => raw.prepare(`INSERT INTO profiles (profile_id, account_id, profile_kind, username, normalized_username,
    display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status, is_temporary)
    VALUES (?, NULL, 'human', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active', 0)`).run(id, id, id.toLowerCase())
  const admin = { type: 'admin' as const, profileId: randomUUID() }
  insertProfile(admin.profileId)
  const startsAt = new Date(Date.now() - 3_600_000).toISOString()
  const endsAt = new Date(Date.now() + 1000 * 3_600_000).toISOString()
  const draft = campaignsStore.createDraftCampaign({ name: `perf-fix ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null }, admin)
  if (!draft.ok) throw new Error('createDraftCampaign failed')
  raw.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, 'belot', 0, 5)`).run(draft.campaign.campaignId)
  if (!campaignsStore.scheduleCampaign(draft.campaign.campaignId, admin).ok) throw new Error('schedule failed')
  if (!campaignsStore.activateCampaign(draft.campaign.campaignId, new Date(), admin).ok) throw new Error('activate failed')
  const nowDb = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 19).replace('T', ' ')
  for (let i = 0; i < 10; i += 1) {
    insertProfile(`winner-${i}`)
    raw.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES (?, ?, 'A', 1, ?, 0)`)
      .run(`lr-${String(i).padStart(2, '0')}`, `winner-${i}`, nowDb(-600 + i))
  }
  const ledgerCount = () => (raw.prepare(`SELECT COUNT(*) AS n FROM campaign_unit_ledger WHERE source_type = 'belot_win'`).get() as { n: number }).n
  const failedTick = await countCursorSaves(() => reconcileMissingBelotCampaignCredits(dbPath, creditStore, { limit: 4, useDurableCursor: true }), true)
  assert.ok(failedTick.error instanceof Error && /simulated cursor save failure/.test(failedTick.error.message), 'save failure must propagate')
  assert.equal(ledgerCount(), 4, 'first 4 rows credited despite cursor save failure')
  assert.equal(readCursor(dbPath, 'belot_win_legacy').eventAt, '', 'cursor not advanced')
  await reconcileMissingBelotCampaignCredits(dbPath, creditStore, { limit: 4, useDurableCursor: true })
  assert.equal(ledgerCount(), 8, 'replay skips already credited rows (NOT EXISTS) and credits the next 4 — no duplicates')
  await reconcileMissingBelotCampaignCredits(dbPath, creditStore, { limit: 4, useDurableCursor: true })
  await reconcileMissingBelotCampaignCredits(dbPath, creditStore, { limit: 4, useDurableCursor: true })
  assert.equal(ledgerCount(), 10, 'every row credited exactly once')
  const distinct = (raw.prepare(`SELECT COUNT(DISTINCT profile_id || '|' || source_id) AS n FROM campaign_unit_ledger WHERE source_type = 'belot_win'`).get() as { n: number }).n
  assert.equal(distinct, 10)
  creditStore.close()
  campaignsStore.close()
  raw.close()
})

await check('[B1.8] wrap and reset behavior unchanged', async () => {
  const dbPath = await createMigratedDb()
  const seed = openSeed(dbPath)
  for (let i = 0; i < 10; i += 1) {
    seed.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial) VALUES (?, 'p', 'A', 1, ?, 0)`)
      .run(`lr-${String(i).padStart(2, '0')}`, ts(i))
  }
  seed.close()
  const run = async () => {
    const spy = createSpyStore()
    const result = await reconcileMissingBelotCampaignCredits(dbPath, spy.store, { limit: 7, useDurableCursor: true })
    return { ids: spy.calls.map((call) => call.sourceId), wrapped: result.cursorWrapped }
  }
  const t1 = await run()
  assert.deepEqual(t1.ids, ['lr-00', 'lr-01', 'lr-02', 'lr-03', 'lr-04', 'lr-05', 'lr-06'])
  assert.equal(t1.wrapped, false)
  const t2 = await run()
  assert.deepEqual(t2.ids, ['lr-07', 'lr-08', 'lr-09', 'lr-00', 'lr-01', 'lr-02', 'lr-03'])
  assert.equal(t2.wrapped, true)
  assert.equal(readCursor(dbPath, 'belot_win_legacy').sourceId, 'lr-03', 'cursor = last row of the wrapped part')
  // Reset: няма кандидати -> cursor-ът се нулира.
  const wipe = openSeed(dbPath)
  wipe.exec('DELETE FROM profile_match_results')
  wipe.close()
  const t3 = await countCursorSaves(run)
  assert.deepEqual((t3.result as { ids: string[] }).ids, [])
  assert.equal(readCursor(dbPath, 'belot_win_legacy').eventAt, '', 'cursor reset when nothing matches')
  assert.equal(t3.saves.get('belot_win_legacy'), 1, 'reset is the only save')
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== A: deferred initial tick ===')
{
  const flagBefore = process.env.CAMPAIGNS_FEATURE_ENABLED
  delete process.env.CAMPAIGNS_FEATURE_ENABLED // tick-ът става евтин no-op (без DB работа)

  type FakeHandle = { id: number; unrefCalls: number; unref: () => void }
  const makeTimers = () => {
    const timeouts: Array<{ fn: () => void; ms: number; handle: FakeHandle; cleared: boolean }> = []
    const intervals: Array<{ fn: () => void; ms: number; handle: FakeHandle; cleared: boolean }> = []
    let nextId = 1
    const handle = (): FakeHandle => {
      const h: FakeHandle = { id: nextId++, unrefCalls: 0, unref: () => { h.unrefCalls += 1 } }
      return h
    }
    return {
      timeouts,
      intervals,
      deps: {
        setTimeout: (fn: () => void, ms: number) => { const h = handle(); timeouts.push({ fn, ms, handle: h, cleared: false }); return h as never },
        clearTimeout: (id: unknown) => { for (const t of timeouts) if (t.handle === id) t.cleared = true },
        setInterval: (fn: () => void, ms: number) => { const h = handle(); intervals.push({ fn, ms, handle: h, cleared: false }); return h as never },
        clearInterval: (id: unknown) => { for (const t of intervals) if (t.handle === id) t.cleared = true },
      },
    }
  }
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }
  const makeJob = (timers: ReturnType<typeof makeTimers>, extra: { initialDelayMs?: number } = {}) =>
    createCampaignCreditReconciliationJob({ databaseFilePath: b1DbPath, campaignCreditStore: createSpyStore().store, ...timers.deps, ...extra })

  await check('[A.1] start() does not run reconciliation synchronously; schedules a 30s initial timer', () => {
    const timers = makeTimers()
    const job = makeJob(timers)
    job.start()
    assert.equal(job.getHealth().lastTickAt, null, 'no tick during start()')
    assert.equal(timers.timeouts.length, 1)
    assert.equal(timers.timeouts[0]!.ms, 30_000)
    job.stop()
  })

  await check('[A.2] initial timer runs the tick after the configured delay', async () => {
    const timers = makeTimers()
    const job = makeJob(timers, { initialDelayMs: 1234 })
    job.start()
    assert.equal(timers.timeouts[0]!.ms, 1234)
    timers.timeouts[0]!.fn()
    await flush()
    assert.notEqual(job.getHealth().lastTickAt, null, 'tick ran after timer')
    assert.notEqual(job.getHealth().lastSuccessAt, null)
    job.stop()
  })

  await check('[A.3] stop() before the timer fires clears it and no tick runs', async () => {
    const timers = makeTimers()
    const job = makeJob(timers)
    job.start()
    job.stop()
    assert.equal(timers.timeouts[0]!.cleared, true, 'initial timer cleared')
    assert.equal(timers.intervals[0]!.cleared, true, 'interval cleared')
    timers.timeouts[0]!.fn() // дори ако callback-ът все пак се изпълни
    await flush()
    assert.equal(job.getHealth().lastTickAt, null)
  })

  await check('[A.4] initial timer and interval are unref()-ed', () => {
    const timers = makeTimers()
    const job = makeJob(timers)
    job.start()
    assert.equal(timers.timeouts[0]!.handle.unrefCalls, 1)
    assert.equal(timers.intervals[0]!.handle.unrefCalls, 1)
    job.stop()
  })

  await check('[A.5] periodic 5-minute interval unchanged and still ticks', async () => {
    const timers = makeTimers()
    const job = makeJob(timers)
    job.start()
    assert.equal(timers.intervals.length, 1)
    assert.equal(timers.intervals[0]!.ms, 300_000)
    timers.intervals[0]!.fn()
    await flush()
    assert.notEqual(job.getHealth().lastTickAt, null)
    job.stop()
  })

  await check('[A.6] double start is a no-op; start/stop/start schedules exactly one new initial timer', () => {
    const timers = makeTimers()
    const job = makeJob(timers)
    job.start()
    job.start()
    assert.equal(timers.timeouts.length, 1, 'second start() ignored')
    assert.equal(timers.intervals.length, 1)
    job.stop()
    job.start()
    assert.equal(timers.timeouts.length, 2)
    assert.equal(timers.timeouts.filter((t) => !t.cleared).length, 1, 'only the new initial timer is live')
    assert.equal(timers.intervals.filter((t) => !t.cleared).length, 1)
    job.stop()
  })

  if (flagBefore !== undefined) process.env.CAMPAIGNS_FEATURE_ENABLED = flagBefore
}

for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
