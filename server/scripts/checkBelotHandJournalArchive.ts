/**
 * checkBelotHandJournalArchive.ts
 *
 * Архивиране, срокове и лимит на диска на belot hand журнала (ZSTD):
 *  [1]  записи по-стари от 7 дни → дневен .zst архив, редовете излизат от SQLite
 *  [2]  общо 30 дни → архивът се изтрива; неархивирани редове също (с предупреждение)
 *  [3]  пълно раздаване се възстановява от архива със същите данни (и същия отчет)
 *  [4]  всички събития преди и след архивиране са идентични (id по id)
 *  [5]  стари .gz архиви (стар и нов формат на името) се четат
 *  [6]  прекъсване по време на компресия (+ заварен .tmp от убит процес)
 *  [7]  неуспешна проверка на архива; повреден финален архив → карантина
 *  [8]  рестарт по време на архивиране (срив след финализиране, заварен lock)
 *  [9]  две едновременни архивиращи операции (в процеса и lock файлът)
 *  [10] 80% и 100% от лимита (ранно архивиране, преждевременно изтриване, пауза)
 *  [11] критично малко свободно място на диска
 *  [12] липсващ ZSTD (нито вграден, нито CLI) → .gz резервен архив
 *  [13] без дублирани или изгубени записи при нормално архивиране
 *  [14] игрите продължават при проблем с хранилището
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import type { ServerRoom } from '../src/core/serverTypes.js'
import type { ServerAntiBadLuckConfig } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import {
  acquireBelotJournalMaintenanceLock,
  BELOT_JOURNAL_MAINTENANCE_LOCK_NAME,
  listBelotJournalArchiveFiles,
} from '../src/diagnostics/belotHandJournal/belotHandJournalArchiveFiles.js'
import { clampZstdLevel } from '../src/diagnostics/belotHandJournal/belotHandJournalCompression.js'
import {
  createBelotHandJournalStore,
  getBelotHandJournalArchiveDirectory,
  type BelotHandJournalStore,
  type BelotHandJournalStoredEvent,
} from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import { createBelotHandJournal, type BelotHandJournal } from '../src/diagnostics/belotHandJournal/createBelotHandJournal.js'
import { formatBelotHandJournalReport } from '../src/diagnostics/belotHandJournal/formatBelotHandJournalReport.js'
import { loadBelotHandJournalEvents } from '../src/diagnostics/belotHandJournal/loadBelotHandJournalEvents.js'
import {
  measureBelotHandJournalStorage,
  resolveBelotHandJournalStorageConfig,
  runBelotHandJournalMaintenance,
  type BelotHandJournalMaintenanceDeps,
  type BelotHandJournalStorageConfig,
} from '../src/diagnostics/belotHandJournal/runBelotHandJournalMaintenance.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

console.log('\n═══ checkBelotHandJournalArchive ═══')

const DAY = 24 * 3600 * 1000
const BASE_NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
let fakeNow = BASE_NOW
const realDateNow = Date.now
Date.now = () => fakeNow
const ABL = { threshold: 5, resetGeneration: 0 } as unknown as ServerAntiBadLuckConfig
const GB = 1024 * 1024 * 1024
const FREE_OK: BelotHandJournalMaintenanceDeps['statfs'] = async () => ({ freeBytes: 100 * GB })

function config(overrides: Partial<BelotHandJournalStorageConfig> = {}): BelotHandJournalStorageConfig {
  return {
    activeDays: 7,
    maxAgeDays: 30,
    zstdLevel: 6,
    maxTotalBytes: 1.5 * GB,
    warnRatio: 0.8,
    startCleanupRatio: 0.95,
    targetRatio: 0.9,
    minFreeDiskBytes: 1024 * 1024 * 1024,
    ...overrides,
  }
}

async function tempStore(): Promise<{ dir: string; store: BelotHandJournalStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'bhj-archive-'))
  return { dir, store: await createBelotHandJournalStore({ directory: dir }) }
}

function journalFor(store: BelotHandJournalStore, extra: Parameters<typeof createBelotHandJournal>[0] extends infer O ? Partial<O> : never = {}): BelotHandJournal {
  return createBelotHandJournal({
    store,
    now: () => fakeNow,
    scheduleFlush: (flush) => flush(),
    statfs: FREE_OK,
    storage: config(),
    ...extra,
  })
}

let roomCounter = 0
// Пълен мач с реалния engine, започващ в startMs (един UTC ден).
function simulateMatchAt(journal: BelotHandJournal, startMs: number): string {
  roomCounter += 1
  const id = `archive-room-${roomCounter}`
  fakeNow = startMs
  const { room: r1 } = createRoomWithHumanHost({ roomId: id, connectionId: `${id}-1`, identity: { displayName: 'Lidiya', profileId: `profile-${id}` } as never })
  const { room: r2 } = addHumanToRoom(r1, { connectionId: `${id}-2`, identity: { displayName: 'ANI777', profileId: 'profile-ani' } as never })
  const { room: r3 } = addBotToRoom(r2, {} as never)
  let room: ServerRoom = initializeRoomAuthoritativeGameState(addBotToRoom(r3, {} as never).room)
  journal.observeRoomTransition(null, room, 'worker_tick')
  for (let step = 0; step < 400000; step += 1) {
    fakeNow += 500
    const next = advanceRoomAuthoritativeGame(room, fakeNow, ABL)
    if (next !== room) {
      journal.observeRoomTransition(room, next, 'worker_tick')
      room = next
    }
    if ((room.game.authoritativeState as { phase?: string } | null)?.phase === 'match-ended') break
  }
  journal.flushSync()
  return id
}

function dayStart(offsetDays: number): number {
  const day = new Date(BASE_NOW - offsetDays * DAY)
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8, 0, 0)
}

async function seed(store: BelotHandJournalStore, offsets: number[]): Promise<Map<number, string>> {
  const journal = journalFor(store)
  const rooms = new Map<number, string>()
  for (const offset of offsets) rooms.set(offset, simulateMatchAt(journal, dayStart(offset)))
  fakeNow = BASE_NOW
  return rooms
}

async function loadAll(dir: string, options: { includeArchives?: boolean } = {}) {
  return loadBelotHandJournalEvents({ directory: dir, query: { sinceMs: 0 }, includeArchives: options.includeArchives })
}

function serialize(events: readonly BelotHandJournalStoredEvent[]): string {
  return JSON.stringify([...events].sort((a, b) => a.id - b.id))
}

async function archiveFiles(dir: string) {
  return listBelotJournalArchiveFiles(getBelotHandJournalArchiveDirectory(dir))
}

function storageEvents(store: BelotHandJournalStore, kind?: string): BelotHandJournalStoredEvent[] {
  return store
    .queryEvents({ roomId: '__journal__' })
    .filter((event) => kind === undefined || (event.payload as { kind?: string }).kind === kind)
}

// ─── [1] ─────────────────────────────────────────────────────────────────────
await check('[1] по-старите от 7 дни дни → дневен .zst архив; активните остават в SQLite', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [10, 9, 2])
  const daysBefore = store.listDays()
  const report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK })
  assert(report.status === 'completed', JSON.stringify(report.warnings))
  assert(report.archived.length === 2 && report.archived.every((item) => item.backend === 'node-zstd' && item.reason === 'age'), JSON.stringify(report.archived))
  const files = await archiveFiles(dir)
  assert(files.length === 2 && files.every((file) => file.format === 'zst' && file.kind === 'archive'), files.map((f) => f.name).join(','))
  const daysAfter = store.listDays()
  assert(daysAfter.length === 1 && daysAfter[0] === daysBefore[daysBefore.length - 1], `active days ${daysAfter.join(',')}`)
  // Валиден стандартен ZSTD frame с magic 28 b5 2f fd.
  const { readFile } = await import('node:fs/promises')
  const head = (await readFile(files[0]!.path)).subarray(0, 4).toString('hex')
  assert(head === '28b52ffd', `zstd magic ${head}`)
  store.close()
})

// ─── [2] ─────────────────────────────────────────────────────────────────────
await check('[2] общо 30 дни: архивът изтича; неархивирани редове над 30 дни се трият с предупреждение', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [10])
  await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK })
  assert((await archiveFiles(dir)).length === 1, 'archived at day 10')
  // 19 дни по-късно денят е на 29 дни → остава; на 21-вия ден (31 дни) → изтрит.
  let report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW + 19 * DAY, { statfs: FREE_OK })
  assert(report.expiredArchiveFiles.length === 0 && (await archiveFiles(dir)).length === 1, 'kept at 29 days')
  report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW + 21 * DAY, { statfs: FREE_OK })
  assert(report.expiredArchiveFiles.length === 1 && (await archiveFiles(dir)).length === 0, 'deleted after 30 days')

  // SQLite редове на 35 дни (архивирането е било невъзможно) → изтрити.
  const second = await tempStore()
  await seed(second.store, [35])
  const rows = second.store.queryEvents({ sinceMs: 0 }).length
  const expired = await runBelotHandJournalMaintenance(second.store, config(), BASE_NOW, { statfs: FREE_OK })
  assert(expired.expiredActiveRows === rows && expired.archived.length === 0, `expired ${expired.expiredActiveRows}/${rows}`)
  assert(expired.warnings.some((w) => w.kind === 'expired_without_archive'), 'warning recorded')
  assert(second.store.queryEvents({ sinceMs: 0 }).length === 0, 'no rows older than 30 days')
  store.close()
  second.store.close()
})

// ─── [3] + [4] + [13] ────────────────────────────────────────────────────────
await check('[3][4][13] пълно раздаване и всички събития са идентични преди и след архивиране; без дубликати/загуби', async () => {
  const { dir, store } = await tempStore()
  const rooms = await seed(store, [12, 8, 1])
  const before = await loadAll(dir)
  const roomId = rooms.get(12)!
  const reportBefore = formatBelotHandJournalReport(before.events.filter((event) => event.roomId === roomId))
  await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK })
  const after = await loadAll(dir)
  assert(after.fromArchives > 0 && after.fromDatabase > 0, `archives=${after.fromArchives} db=${after.fromDatabase}`)
  assert(after.duplicatesSkipped === 0, `duplicates ${after.duplicatesSkipped}`)
  assert(after.events.length === before.events.length, `count ${after.events.length} != ${before.events.length}`)
  assert(serialize(after.events) === serialize(before.events), 'events differ after archiving')
  const ids = after.events.map((event) => event.id)
  assert(new Set(ids).size === ids.length, 'ids unique')
  // Раздаване от архива: CLI заявка по стая връща същото, вкл. 32 карти.
  const byRoom = await loadBelotHandJournalEvents({ directory: dir, query: { roomId } })
  assert(byRoom.fromArchives === byRoom.events.length && byRoom.fromDatabase === 0, 'room fully from archive')
  assert(formatBelotHandJournalReport(byRoom.events) === reportBefore, 'same report from archive')
  const started = byRoom.events.find((event) => event.eventType === 'hand_started')!
  const deal = (started.payload as { deal: Record<string, string[]> }).deal
  assert(Object.values(deal).flat().length === 32, '32 cards restored')
  // По профил (hand_started в архива) и по хронологичен прозорец.
  const byProfile = await loadBelotHandJournalEvents({ directory: dir, query: { profileId: `profile-${roomId}`, sinceMs: dayStart(13) } })
  assert(byProfile.events.length === byRoom.events.length, `profile query ${byProfile.events.length} vs ${byRoom.events.length}`)
  const recentOnly = await loadBelotHandJournalEvents({ directory: dir, query: { sinceMs: dayStart(2) } })
  assert(recentOnly.archivesRead.length === 0, 'archives outside [since, until] are not read')
  store.close()
})

// ─── [5] ─────────────────────────────────────────────────────────────────────
await check('[5] стари .gz архиви се четат (стар и нов формат на името)', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [11, 10])
  const all = (await loadAll(dir)).events
  const [first, second] = store.listDays()
  const toGzip = (day: string) =>
    zlib.gzipSync(Buffer.from(all.filter((e) => new Date(e.occurredAtMs).toISOString().startsWith(day)).map((e) => `${JSON.stringify(e)}\n`).join('')))
  const archiveDir = getBelotHandJournalArchiveDirectory(dir)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(archiveDir, { recursive: true })
  await writeFile(join(archiveDir, `belot-hand-journal-${first}-1791000000000.jsonl.gz`), toGzip(first!))
  const secondStats = store.getDayStats(second!)!
  await writeFile(join(archiveDir, `belot-hand-journal-${second}-id${secondStats.minId}-${secondStats.maxId}.jsonl.gz`), toGzip(second!))
  // Активните редове се премахват ръчно, за да остане само архивът.
  store.deleteDay(first!)
  store.deleteDay(second!)
  const loaded = await loadAll(dir)
  assert(loaded.fromArchives === all.length && loaded.errors.length === 0, `${loaded.fromArchives}/${all.length} ${loaded.errors.join(';')}`)
  assert(serialize(loaded.events) === serialize(all), 'gz events identical')
  store.close()
})

// ─── [6] ─────────────────────────────────────────────────────────────────────
await check('[6] прекъсване по време на компресия → редовете остават; заварен .tmp се почиства; повторен опит успява', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [9])
  const before = serialize((await loadAll(dir)).events)
  const report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK, hooks: { failAfterLines: 5 } })
  assert(report.archived.length === 0 && report.warnings.some((w) => w.kind === 'archive_failed'), JSON.stringify(report.warnings))
  assert((await archiveFiles(dir)).length === 0, 'no archive / no tmp left')
  assert(serialize((await loadAll(dir)).events) === before, 'rows intact')
  // Убит процес оставя .tmp.
  const stats = store.getDayStats(store.listDays()[0]!)!
  await writeFile(join(getBelotHandJournalArchiveDirectory(dir), `belot-hand-journal-${stats.day}-id${stats.minId}-${stats.maxId}.jsonl.zst.tmp`), 'partial')
  const retry = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK })
  assert(retry.warnings.some((w) => w.kind === 'interrupted_archive_cleaned'), 'tmp cleaned')
  assert(retry.archived.length === 1, 'archived on retry')
  assert(serialize((await loadAll(dir)).events) === before, 'identical after retry')
  store.close()
})

// ─── [7] ─────────────────────────────────────────────────────────────────────
await check('[7] неуспешна проверка → без архив, редовете остават; повреден архив → карантина и повторно архивиране', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [9])
  const before = serialize((await loadAll(dir)).events)
  const report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK, hooks: { corruptTmpBeforeVerify: true } })
  assert(report.warnings.some((w) => w.kind === 'archive_verification_failed'), JSON.stringify(report.warnings))
  assert((await archiveFiles(dir)).length === 0 && store.listDays().length === 1, 'nothing archived, rows kept')

  // Финализиран архив, после повреден на диска, докато редовете още са в
  // SQLite (срив след финализиране) → карантина, редовете се архивират отново.
  await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK, hooks: { crashAfterFinalize: true } })
  const [archive] = await archiveFiles(dir)
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(archive!.path)
  bytes[Math.floor(bytes.length / 2)] ^= 0xff
  await writeFile(archive!.path, bytes)
  const repaired = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK })
  assert(repaired.warnings.some((w) => w.kind === 'archive_quarantined_corrupt'), JSON.stringify(repaired.warnings))
  const files = await archiveFiles(dir)
  assert(files.some((f) => f.kind === 'corrupt') && files.some((f) => f.kind === 'archive'), files.map((f) => f.name).join(','))
  const after = await loadAll(dir)
  assert(serialize(after.events) === before && after.errors.length === 0, 'data intact; corrupt file is not read')
  store.close()
})

// ─── [8] ─────────────────────────────────────────────────────────────────────
await check('[8] рестарт по време на архивиране: срив след финализиране + заварен lock → без дубликати', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [9, 8])
  const before = serialize((await loadAll(dir)).events)
  const crashed = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK, hooks: { crashAfterFinalize: true } })
  assert(crashed.warnings.some((w) => w.kind === 'archive_failed'), 'crash reported')
  const mid = await loadAll(dir)
  assert(serialize(mid.events) === before && mid.duplicatesSkipped > 0, 'reader de-duplicates while rows are in both places')
  store.close()
  // Процесът е убит, докато държи lock-а.
  await writeFile(join(dir, BELOT_JOURNAL_MAINTENANCE_LOCK_NAME), JSON.stringify({ pid: 2147483646, host: (await import('node:os')).hostname(), acquiredAtMs: BASE_NOW, token: 'dead' }))
  const restarted = await createBelotHandJournalStore({ directory: dir })
  const report = await runBelotHandJournalMaintenance(restarted, config(), BASE_NOW, { statfs: FREE_OK })
  assert(report.status === 'completed', report.status)
  assert(report.warnings.some((w) => w.kind === 'stale_lock_taken_over'), 'stale lock taken over')
  assert(report.reconciledRows > 0 && report.warnings.some((w) => w.kind === 'interrupted_archive_reconciled'), 'reconciled')
  const files = (await archiveFiles(dir)).filter((file) => file.kind === 'archive')
  assert(files.length === 2 && new Set(files.map((f) => f.day)).size === 2, files.map((f) => f.name).join(','))
  const after = await loadAll(dir)
  assert(serialize(after.events) === before && after.duplicatesSkipped === 0, 'no duplicates, nothing lost')
  restarted.close()
})

// ─── [9] ─────────────────────────────────────────────────────────────────────
await check('[9] две едновременни архивиращи операции → само една работи', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [9])
  const before = serialize((await loadAll(dir)).events)
  const [a, b] = await Promise.all([
    runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK }),
    runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK }),
  ])
  const statuses = [a.status, b.status].sort()
  assert(statuses[0] === 'completed' && statuses[1] === 'skipped_locked', statuses.join(','))
  assert((await archiveFiles(dir)).length === 1, 'single archive')
  assert(serialize((await loadAll(dir)).events) === before, 'identical')
  // Между процеси: lock файлът.
  const first = await acquireBelotJournalMaintenanceLock(dir, BASE_NOW)
  const second = await acquireBelotJournalMaintenanceLock(dir, BASE_NOW)
  assert(first.acquired && !second.acquired, 'second process is locked out')
  if (first.acquired) await first.lock.release()
  const third = await acquireBelotJournalMaintenanceLock(dir, BASE_NOW)
  assert(third.acquired, 'lock re-acquirable after release')
  if (third.acquired) await third.lock.release()
  store.close()
})

// ─── [10] ────────────────────────────────────────────────────────────────────
await check('[10] 80%: предупреждение; 100%: ранно архивиране → преждевременно изтриване на най-старите → пауза на записа', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [20, 15, 3, 2, 1])
  await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK })
  const usage = (await measureBelotHandJournalStorage(store)).totalBytes

  // 80%
  const warnJournal = journalFor(store, { storage: config({ maxTotalBytes: Math.ceil(usage / 0.85) }) })
  await warnJournal.checkStorageNow()
  assert(warnJournal.getStats().writesPaused === null, 'not paused at 85%')
  assert(storageEvents(store, 'storage_usage_warning').length === 1, 'usage warning recorded')
  await warnJournal.checkStorageNow()
  assert(storageEvents(store, 'storage_usage_warning').length === 1, 'warning rate-limited')

  // 100%: лимит под текущото → поддръжката архивира рано активните дни (без
  // днешния), после трие най-старите архиви, после активни дни без архив.
  const archivesBefore = (await archiveFiles(dir)).length
  const activeDaysBefore = store.listDays().length
  const tight = config({ maxTotalBytes: Math.floor(usage * 0.5) })
  const report = await runBelotHandJournalMaintenance(store, tight, BASE_NOW, { statfs: FREE_OK })
  assert(report.warnings.some((w) => w.kind === 'early_archive_due_to_size'), JSON.stringify(report.warnings.map((w) => w.kind)))
  assert(report.archived.some((item) => item.reason === 'size_limit'), 'early archived')
  const prematureKinds = report.warnings.map((w) => w.kind)
  assert(prematureKinds.includes('premature_archive_deletion') || report.usageAfter <= tight.maxTotalBytes * tight.targetRatio, 'oldest archives deleted when needed')
  if (prematureKinds.includes('premature_archive_deletion')) {
    const deletedDays = report.prematureDeletedArchiveFiles
    const remaining = (await archiveFiles(dir)).map((f) => f.name)
    assert(deletedDays.every((name) => remaining.every((other) => name.localeCompare(other) <= 0 || other.includes('.corrupt'))), 'oldest first')
  }
  assert(archivesBefore + activeDaysBefore > 0, 'sanity')

  // Пауза: лимит, по-малък от самата база (днешният ден не се трие).
  const pauseConfig = config({ maxTotalBytes: 1024 })
  const pausing = journalFor(store, { storage: pauseConfig })
  await pausing.checkStorageNow()
  await pausing.runMaintenanceNow()
  await pausing.checkStorageNow()
  assert(pausing.getStats().writesPaused === 'size_limit', `paused=${pausing.getStats().writesPaused}`)
  assert(storageEvents(store, 'storage_limit_reached').length >= 1, 'limit warning recorded')
  const gameRows = () => store.queryEvents({ sinceMs: 0 }).filter((event) => event.roomId !== '__journal__').length
  const gameRowsBefore = gameRows()
  simulateMatchAt(pausing, BASE_NOW + 3600 * 1000)
  const dropped = pausing.getStats().droppedWhilePaused
  assert(dropped > 0 && gameRows() === gameRowsBefore, `dropped=${dropped} rows ${gameRows()} vs ${gameRowsBefore}`)
  // Лимитът е освободен → записът се възобновява с предупреждение.
  pauseConfig.maxTotalBytes = 1.5 * GB
  await pausing.checkStorageNow()
  assert(pausing.getStats().writesPaused === null, 'resumed')
  const resumeEvent = storageEvents(store, 'events_dropped').at(-1)
  assert(resumeEvent !== undefined && (resumeEvent.payload as any).data.droppedSizeLimit === dropped, JSON.stringify(resumeEvent?.payload))
  pausing.close()
})

// ─── [11] ────────────────────────────────────────────────────────────────────
await check('[11] критично малко свободно място: записът и архивирането спират; възобновяване с предупреждение за пропуснатите', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [9, 1])
  let freeBytes = 10 * 1024 * 1024
  const statfs = async () => ({ freeBytes })
  const journal = journalFor(store, { statfs, maintenanceDeps: { statfs } })
  await journal.checkStorageNow()
  assert(journal.getStats().writesPaused === 'disk_critical', 'paused on low disk')
  const report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs })
  assert(report.diskCritical && report.archived.length === 0, 'archiving skipped when disk is critical')
  assert((await archiveFiles(dir)).length === 0, 'no temp files created')
  simulateMatchAt(journal, BASE_NOW)
  const dropped = journal.getStats().droppedWhilePaused
  assert(dropped > 0, 'events dropped')
  freeBytes = 50 * GB
  await journal.checkStorageNow()
  assert(journal.getStats().writesPaused === null, 'resumed')
  const resumeEvent = storageEvents(store, 'events_dropped')[0]
  assert(resumeEvent !== undefined && (resumeEvent.payload as any).data.droppedDiskCritical === dropped, JSON.stringify(resumeEvent?.payload))
  store.close()
})

// ─── [12] ────────────────────────────────────────────────────────────────────
await check('[12] липсващ ZSTD (вграден и CLI) → .gz архив + предупреждение; четенето работи', async () => {
  const { dir, store } = await tempStore()
  await seed(store, [9])
  const before = serialize((await loadAll(dir)).events)
  const report = await runBelotHandJournalMaintenance(store, config(), BASE_NOW, { statfs: FREE_OK, disableNodeZstd: true, disableZstdCli: true })
  assert(report.archived[0]?.backend === 'node-gzip' && report.archived[0].file.endsWith('.jsonl.gz'), JSON.stringify(report.archived))
  assert(report.warnings.some((w) => w.kind === 'compression_fallback_gzip'), 'fallback warning')
  assert(serialize((await loadAll(dir)).events) === before, 'gz fallback readable and identical')
  // Четене на .zst без декомпресор → ясна грешка, без срив.
  const second = await tempStore()
  await seed(second.store, [9])
  await runBelotHandJournalMaintenance(second.store, config(), BASE_NOW, { statfs: FREE_OK })
  const unreadable = await loadBelotHandJournalEvents({ directory: second.dir, query: { sinceMs: 0 }, compression: { disableNodeZstd: true, disableZstdCli: true } })
  assert(unreadable.errors.some((error) => error.includes('zstd')), unreadable.errors.join(';'))
  assert(clampZstdLevel(0) === 1 && clampZstdLevel(30) === 19 && clampZstdLevel(6) === 6, 'level clamp')
  process.env.BELOT_HAND_JOURNAL_ZSTD_LEVEL = '9'
  assert(resolveBelotHandJournalStorageConfig().zstdLevel === 9, 'level from env')
  delete process.env.BELOT_HAND_JOURNAL_ZSTD_LEVEL
  const defaults = resolveBelotHandJournalStorageConfig()
  assert(defaults.zstdLevel === 6 && defaults.activeDays === 7 && defaults.maxAgeDays === 30 && defaults.maxTotalBytes === 1536 * 1024 * 1024 && defaults.warnRatio === 0.8, JSON.stringify(defaults))
  store.close()
  second.store.close()
})

// ─── [14] ────────────────────────────────────────────────────────────────────
await check('[14] игрите продължават при проблем с хранилището (затворена база, грешен път)', async () => {
  const { store } = await tempStore()
  const journal = journalFor(store)
  store.close() // всеки запис ще хвърля
  const originalError = console.error
  console.error = () => undefined
  try {
    const roomId = simulateMatchAt(journal, BASE_NOW)
    assert(roomId.length > 0, 'match completed')
    assert(journal.getStats().writeFailures > 0, 'failures counted, not thrown')
  } finally {
    console.error = originalError
  }
  // Архивната директория е файл → поддръжката се проваля безопасно.
  const second = await tempStore()
  await seed(second.store, [9])
  await rm(getBelotHandJournalArchiveDirectory(second.dir), { recursive: true, force: true })
  await writeFile(getBelotHandJournalArchiveDirectory(second.dir), 'not a directory')
  const report = await runBelotHandJournalMaintenance(second.store, config(), BASE_NOW, { statfs: FREE_OK })
  assert(report.status === 'failed' || report.warnings.some((w) => w.kind === 'archive_failed'), report.status)
  assert(second.store.listDays().length === 1, 'rows kept')
  assert((await readdir(second.dir)).every((name) => !name.endsWith('.lock')), 'lock released')
  second.store.close()
})

Date.now = realDateNow
console.log(`\n  passed=${passed} failed=${failed}`)
if (failed > 0) process.exit(1)
