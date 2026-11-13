/**
 * checkVoiceRetention.ts
 *
 * T1 — гарантирано периодично изтриване на личните данни на гласовия чат
 * (voiceChatStore.purgeEndedVoiceMemberships + voiceRetentionSweeper):
 *   * участията (лични данни) на маси, освободени преди >30 дни, се изтриват
 *     НЕЗАВИСИМО от статуса на LiveKit стаите;
 *   * техническите редове (маса + генерации) остават, докато стаите не са
 *     потвърдено изтрити;
 *   * активни маси и активни участия не се пипат;
 *   * малки партиди с отстъпване на event loop-а; повторен опит при
 *     SQLITE_BUSY; при старт и на всеки 6 часа; dispose спира всичко.
 * Само изолирани временни бази.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceRetention.ts
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createVoiceChatStore, type VoiceChatStore } from '../src/voice/voiceChatStore.js'
import { createVoiceRetentionSweeper, VOICE_RETENTION_SWEEP_INTERVAL_MS } from '../src/voice/voiceRetentionSweeper.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

const sourceMigrations = join(resolve(process.cwd()), 'database', 'migrations')
const sqliteModule = await import('node:sqlite')
type SqliteDatabase = InstanceType<typeof sqliteModule.DatabaseSync>
const tempRoots: string[] = []
const toClose: Array<{ close: () => void }> = []

async function freshDatabase(): Promise<{ path: string; raw: SqliteDatabase; store: VoiceChatStore }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-voice-retention-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') await cp(join(sourceMigrations, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const raw = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
  raw.exec('PRAGMA foreign_keys = ON;')
  toClose.push(raw)
  const store = await createVoiceChatStore(path, { busyTimeoutMs: 50 })
  toClose.push(store)
  return { path, raw, store }
}

const NOW = Date.UTC(2027, 2, 1, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

function seedProfile(raw: SqliteDatabase): string {
  const profileId = randomUUID()
  const accountId = randomUUID()
  raw.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
  raw.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human');`).run(
    profileId, accountId, `P${profileId.slice(0, 6)}`, `p-${profileId}`,
  )
  return profileId
}

/** Маса: releasedDaysAgo=null -> активна. roomStatus — статус на генерацията (null = без стая). */
function seedTable(raw: SqliteDatabase, input: { releasedDaysAgo: number | null; roomStatus: 'live' | 'delete_pending' | 'deleted' | null; members: number; activeMembers?: number; grants?: number }): string {
  const id = randomUUID()
  const created = NOW - 60 * DAY
  if (input.releasedDaysAgo === null) {
    raw.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, private_room_id, created_at) VALUES (?, 'active', 'waiting', ?, ?);`).run(id, randomUUID(), iso(created))
  } else {
    raw.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, private_room_id, created_at, released_at, release_reason) VALUES (?, 'released', 'waiting', ?, ?, ?, 'waiting_room_closed');`)
      .run(id, randomUUID(), iso(created), iso(NOW - input.releasedDaysAgo * DAY))
  }
  if (input.roomStatus !== null) {
    const retired = input.roomStatus === 'live' ? null : iso(NOW - 40 * DAY)
    raw.prepare(`INSERT INTO voice_room_generations (livekit_room_name, voice_table_id, generation, status, created_at, retire_requested_at, retire_reason, deleted_confirmed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?);`)
      .run(`pv_test_${id}_g1`, id, input.roomStatus, iso(created), retired, retired === null ? null : 'table_released', input.roomStatus === 'deleted' ? iso(NOW - 39 * DAY) : null)
  }
  const active = input.activeMembers ?? 0
  for (let index = 0; index < input.members; index += 1) {
    const ended = index >= active
    raw.prepare(`INSERT INTO voice_table_memberships (membership_id, voice_table_id, profile_id, started_at, speaking_entitled_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?);`)
      .run(randomUUID(), id, seedProfile(raw), iso(created), iso(created), ended ? iso(created + DAY) : null, ended ? 'table_released' : null)
  }
  for (let index = 0; index < (input.grants ?? 0); index += 1) {
    raw.prepare(`INSERT INTO voice_speaking_grants (voice_table_id, match_seq, profile_id, granted_at) VALUES (?, 1, ?, ?);`).run(id, seedProfile(raw), iso(created))
  }
  return id
}

const count = (raw: SqliteDatabase, sql: string, ...params: Array<string | number>): number => Number((raw.prepare(sql).get(...params) as { n: number }).n)
const memberships = (raw: SqliteDatabase, tableId: string): number => count(raw, 'SELECT COUNT(*) AS n FROM voice_table_memberships WHERE voice_table_id = ?', tableId)
const tableExists = (raw: SqliteDatabase, tableId: string): boolean => count(raw, 'SELECT COUNT(*) AS n FROM voice_tables WHERE voice_table_id = ?', tableId) === 1

function manualScheduler() {
  let seq = 0
  const timers = new Map<number, { cb: () => void; delayMs: number }>()
  return {
    timers,
    scheduler: {
      setTimeout: (cb: () => void, delayMs: number): unknown => {
        seq += 1
        timers.set(seq, { cb, delayMs })
        return seq
      },
      clearTimeout: (handle: unknown): void => { timers.delete(handle as number) },
    },
    /** Изпълнява най-ранния таймер с дадено закъснение. */
    fire(delayMs: number): boolean {
      for (const [id, timer] of timers) {
        if (timer.delayMs !== delayMs) continue
        timers.delete(id)
        timer.cb()
        return true
      }
      return false
    },
  }
}
const flush = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolveFlush) => setImmediate(resolveFlush))
}

console.log('\ncheckVoiceRetention\n')

try {
  await check('[R1] Store: участия на маси, освободени преди >30 дни, се трият независимо от LiveKit стаите; техническите редове остават до потвърдено изтриване', async () => {
    const { raw, store } = await freshDatabase()
    const pending = seedTable(raw, { releasedDaysAgo: 31, roomStatus: 'delete_pending', members: 4, grants: 2 })
    const live = seedTable(raw, { releasedDaysAgo: 45, roomStatus: 'live', members: 3 })
    const deleted = seedTable(raw, { releasedDaysAgo: 40, roomStatus: 'deleted', members: 2 })
    const recent = seedTable(raw, { releasedDaysAgo: 29, roomStatus: 'deleted', members: 4 })
    const result = store.purgeEndedVoiceMemberships({ endedBefore: new Date(NOW - 30 * DAY), limit: 100 })
    assert(result.ok, 'ok')
    if (!result.ok) return
    assertEqual(result.memberships, 9, 'изтрити участия (4 + 3 + 2)')
    assertEqual(result.grants, 2, 'наследени grants')
    assertEqual(memberships(raw, pending), 0, 'delete_pending стая не блокира изтриването на личните данни')
    assertEqual(memberships(raw, live), 0, 'жива (неизтрита) стая не блокира')
    assertEqual(memberships(raw, deleted), 0, 'потвърдено изтрита стая')
    assertEqual(memberships(raw, recent), 4, '29 дни — още се пазят')
    assert(tableExists(raw, pending) && tableExists(raw, live), 'техническите редове остават (стаите още не са потвърдено изтрити)')
    assertEqual(count(raw, 'SELECT COUNT(*) AS n FROM voice_room_generations WHERE voice_table_id = ?', pending), 1, 'генерацията за потвърденото изтриване остава')
  })

  await check('[R2] Активни маси и активни участия не се пипат (дори с много стари дати)', async () => {
    const { raw, store } = await freshDatabase()
    const active = seedTable(raw, { releasedDaysAgo: null, roomStatus: 'live', members: 4, activeMembers: 2 })
    const result = store.purgeEndedVoiceMemberships({ endedBefore: new Date(NOW), limit: 100 })
    assert(result.ok && result.memberships === 0, 'нищо не е изтрито')
    assertEqual(memberships(raw, active), 4, 'и активните, и приключилите участия на активна маса остават')
    // Защита в SQL: незатворено участие на освободена маса (аномалия) също не се трие.
    const anomaly = seedTable(raw, { releasedDaysAgo: 60, roomStatus: null, members: 2, activeMembers: 1 })
    const second = store.purgeEndedVoiceMemberships({ endedBefore: new Date(NOW - 30 * DAY), limit: 100 })
    assert(second.ok && second.memberships === 1, 'само приключилото участие')
    assertEqual(memberships(raw, anomaly), 1, 'незатвореното остава')
  })

  await check('[R3] Sweeper: малки партиди с отстъпване на event loop-а; след личните данни — техническите редове (само потвърдено изтритите стаи)', async () => {
    const { raw, store } = await freshDatabase()
    const tables: string[] = []
    for (let index = 0; index < 30; index += 1) tables.push(seedTable(raw, { releasedDaysAgo: 35, roomStatus: index % 2 === 0 ? 'deleted' : 'delete_pending', members: 4 }))
    const { scheduler } = manualScheduler()
    let yields = 0
    const sweeper = createVoiceRetentionSweeper({ store, scheduler, now: () => NOW, log: () => {}, batchSize: 25, yieldToEventLoop: async () => { yields += 1 } })
    const result = await sweeper.runNow()
    assertEqual(result.status, 'done', 'статус')
    assertEqual(result.memberships, 120, 'всички 120 участия')
    assert(result.batches >= 5, `няколко партиди (${result.batches})`)
    assert(yields >= 4, `отстъпване между партидите (${yields})`)
    assertEqual(result.tables, 15, 'техническите редове само на потвърдено изтритите стаи')
    assertEqual(count(raw, 'SELECT COUNT(*) AS n FROM voice_table_memberships'), 0, 'няма лични данни')
    assertEqual(count(raw, "SELECT COUNT(*) AS n FROM voice_tables WHERE status = 'released'"), 15, 'масите с чакащи стаи остават')
    sweeper.dispose()
  })

  await check('[R4] SQLITE_BUSY: повторен опит с пауза и успех след освобождаване; при трайно заета база — отказ без изключение, следващото преминаване изтрива', async () => {
    const { path, raw, store } = await freshDatabase()
    const table = seedTable(raw, { releasedDaysAgo: 31, roomStatus: 'deleted', members: 3 })
    const locker = new sqliteModule.DatabaseSync(path, { open: true })
    toClose.push(locker)
    locker.exec('BEGIN IMMEDIATE;')
    const manual = manualScheduler()
    const sweeper = createVoiceRetentionSweeper({ store, scheduler: manual.scheduler, now: () => NOW, log: () => {}, busyRetryDelaysMs: [111, 222], yieldToEventLoop: async () => {} })
    const running = sweeper.runNow()
    await flush()
    assert(manual.fire(111), 'първа пауза 111 ms')
    await flush()
    locker.exec('COMMIT;')
    assert(manual.fire(222), 'втора пауза 222 ms')
    const result = await running
    assertEqual(result.status, 'done', 'успех след освобождаване')
    assertEqual(result.busyRetries, 2, 'два повторни опита')
    assertEqual(memberships(raw, table), 0, 'изтрити')

    const table2 = seedTable(raw, { releasedDaysAgo: 31, roomStatus: 'deleted', members: 2 })
    locker.exec('BEGIN IMMEDIATE;')
    const gaveUpPromise = sweeper.runNow()
    await flush()
    manual.fire(111)
    await flush()
    manual.fire(222)
    const gaveUp = await gaveUpPromise
    assertEqual(gaveUp.status, 'busy_gave_up', 'отказ при трайно заета база')
    assertEqual(memberships(raw, table2), 2, 'нищо не е изтрито частично')
    locker.exec('COMMIT;')
    const next = await sweeper.runNow()
    assert(next.status === 'done' && memberships(raw, table2) === 0, 'следващото преминаване изтрива')
    sweeper.dispose()
  })

  await check('[R5] График: първо преминаване при start(), после на всеки 6 часа; без припокриване; dispose спира таймерите', async () => {
    const { raw, store } = await freshDatabase()
    const manual = manualScheduler()
    const sweeper = createVoiceRetentionSweeper({ store, scheduler: manual.scheduler, now: () => NOW, log: () => {}, yieldToEventLoop: async () => {} })
    seedTable(raw, { releasedDaysAgo: 31, roomStatus: 'deleted', members: 1 })
    sweeper.start()
    sweeper.start()
    await flush()
    assertEqual(sweeper.stats().runs, 1, 'преминаване при старт (start е идемпотентен)')
    assert([...manual.timers.values()].some((timer) => timer.delayMs === VOICE_RETENTION_SWEEP_INTERVAL_MS), 'следващо след 6 часа')
    assertEqual(VOICE_RETENTION_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000, '6 часа')
    assert(manual.fire(VOICE_RETENTION_SWEEP_INTERVAL_MS), 'периодично преминаване')
    await flush()
    assertEqual(sweeper.stats().runs, 2, 'второ преминаване')
    assertEqual([...manual.timers.values()].filter((timer) => timer.delayMs === VOICE_RETENTION_SWEEP_INTERVAL_MS).length, 1, 'точно един планиран таймер')
    sweeper.dispose()
    assertEqual(manual.timers.size, 0, 'dispose изчиства таймерите')
  })

  await check('[R6] Изтриване на профил: участията се изтриват каскадно (ON DELETE CASCADE)', async () => {
    const { raw } = await freshDatabase()
    const table = seedTable(raw, { releasedDaysAgo: 1, roomStatus: 'deleted', members: 1 })
    const profileId = (raw.prepare('SELECT profile_id FROM voice_table_memberships WHERE voice_table_id = ?').get(table) as { profile_id: string }).profile_id
    raw.prepare('DELETE FROM profiles WHERE profile_id = ?').run(profileId)
    assertEqual(memberships(raw, table), 0, 'каскадно изтрито')
  })

  await check('[R7] Интеграция (статично): voiceChatService стартира sweeper-а при boot и го спира при dispose; без старото еднократно извикване', async () => {
    const service = await readFile('src/voice/voiceChatService.ts', 'utf8')
    assert(service.includes('retention.start()'), 'start при boot')
    assert(service.includes('retention.dispose()'), 'dispose')
    assert(!/store\.purgeReleasedVoiceTables\(/.test(service), 'няма директно еднократно извикване')
  })
} finally {
  for (const item of toClose.reverse()) {
    try { item.close() } catch { /* вече затворено */ }
  }
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
