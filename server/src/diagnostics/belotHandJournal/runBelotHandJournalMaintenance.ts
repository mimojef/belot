// Поддръжка на belot hand журнала: архивиране (ZSTD), срокове и лимит на
// диска. Работи асинхронно извън gameplay пътя (компресията е в libuv
// threadpool или външен `zstd` процес; SQLite се чете на малки страници).
//
// Политика (UTC дневни партиди):
//   • активни записи в SQLite: activeDays (7) — по-старите дни се архивират;
//   • общ максимален срок: maxAgeDays (30) от създаването — по-старите дни се
//     изтриват (архиви и, ако архивирането е било невъзможно, SQLite редове).
//     Ден D се изтрива, когато целият ден е по-стар от 30 дни, т.е. запис
//     живее най-много 30 дни + остатъка от своето UTC денонощие (< 24 ч.);
//   • общ лимит на диска maxTotalBytes (1.5 GB) за всички файлове на журнала.
//
// Безопасност на архива: временен .tmp файл → fsync → пълна проверка
// (декомпресия + SHA-256 + брой редове) → атомарно rename → едва тогава
// изтриване на точно архивираните редове. Прекъсване на всяка стъпка е
// безопасно (виж reconcile по-долу). Паралелна поддръжка е изключена от
// lock файл.

import { open, rename, rm, statfs } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireBelotJournalMaintenanceLock,
  buildBelotJournalArchiveName,
  BELOT_JOURNAL_MAINTENANCE_LOCK_NAME,
  listBelotJournalArchiveFiles,
  type BelotJournalArchiveFile,
} from './belotHandJournalArchiveFiles.js'
import {
  clampZstdLevel,
  compressBelotJournalLines,
  DEFAULT_BELOT_JOURNAL_ZSTD_LEVEL,
  getArchiveExtensionForBackend,
  readBelotJournalArchiveLines,
  selectBelotJournalCompressionBackend,
  verifyBelotJournalArchive,
  type BelotJournalCompressHooks,
  type BelotJournalCompressionBackend,
} from './belotHandJournalCompression.js'
import { toUtcDay, type BelotHandJournalStore } from './belotHandJournalStore.js'
import {
  BELOT_HAND_JOURNAL_SCHEMA,
  BELOT_HAND_JOURNAL_SCHEMA_VERSION,
  type BelotHandJournalEvent,
} from './belotHandJournalTypes.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

export type BelotHandJournalStorageConfig = {
  activeDays: number
  maxAgeDays: number
  zstdLevel: number
  maxTotalBytes: number
  // Предупреждение при достигане на този дял от лимита (0.8 = 80%).
  warnRatio: number
  // Почистване започва над startCleanupRatio и спира под targetRatio.
  startCleanupRatio: number
  targetRatio: number
  // Критично малко свободно място на диска: спира записа и архивирането.
  minFreeDiskBytes: number
}

function readNumberEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= min ? value : fallback
}

export function resolveBelotHandJournalStorageConfig(): BelotHandJournalStorageConfig {
  const maxAgeDays = readNumberEnv('BELOT_HAND_JOURNAL_MAX_AGE_DAYS', 30, 1)
  return {
    activeDays: Math.min(readNumberEnv('BELOT_HAND_JOURNAL_ACTIVE_DAYS', 7, 1), maxAgeDays),
    maxAgeDays,
    zstdLevel: clampZstdLevel(readNumberEnv('BELOT_HAND_JOURNAL_ZSTD_LEVEL', DEFAULT_BELOT_JOURNAL_ZSTD_LEVEL, 1)),
    maxTotalBytes: readNumberEnv('BELOT_HAND_JOURNAL_MAX_TOTAL_MB', 1536, 1) * MB,
    warnRatio: readNumberEnv('BELOT_HAND_JOURNAL_WARN_PERCENT', 80, 1) / 100,
    startCleanupRatio: 0.95,
    targetRatio: 0.9,
    minFreeDiskBytes: readNumberEnv('BELOT_HAND_JOURNAL_MIN_FREE_DISK_MB', 1024, 0) * MB,
  }
}

// ─── Размер на диска ────────────────────────────────────────────────────────

export type BelotHandJournalStorageUsage = {
  dbBytes: number
  walBytes: number
  shmBytes: number
  zstArchiveBytes: number
  gzArchiveBytes: number
  tmpBytes: number
  corruptBytes: number
  lockBytes: number
  totalBytes: number
  archiveFiles: BelotJournalArchiveFile[]
}

export async function measureBelotHandJournalStorage(store: BelotHandJournalStore): Promise<BelotHandJournalStorageUsage> {
  const db = await store.getDbFileUsage()
  const archiveFiles = await listBelotJournalArchiveFiles(store.archiveDirectory)
  const sumBy = (predicate: (file: BelotJournalArchiveFile) => boolean) =>
    archiveFiles.filter(predicate).reduce((sum, file) => sum + file.bytes, 0)
  const zstArchiveBytes = sumBy((file) => file.kind === 'archive' && file.format === 'zst')
  const gzArchiveBytes = sumBy((file) => file.kind === 'archive' && file.format === 'gz')
  const tmpBytes = sumBy((file) => file.kind === 'tmp')
  const corruptBytes = sumBy((file) => file.kind === 'corrupt')
  let lockBytes = 0
  try {
    const handle = await open(join(store.directory, BELOT_JOURNAL_MAINTENANCE_LOCK_NAME), 'r')
    lockBytes = (await handle.stat()).size
    await handle.close()
  } catch {
    lockBytes = 0
  }
  return {
    ...db,
    zstArchiveBytes,
    gzArchiveBytes,
    tmpBytes,
    corruptBytes,
    lockBytes,
    totalBytes: db.dbBytes + db.walBytes + db.shmBytes + zstArchiveBytes + gzArchiveBytes + tmpBytes + corruptBytes + lockBytes,
    archiveFiles,
  }
}

export type BelotHandJournalStatfs = (directory: string) => Promise<{ freeBytes: number }>

export const defaultBelotHandJournalStatfs: BelotHandJournalStatfs = async (directory) => {
  const info = await statfs(directory)
  return { freeBytes: Number(info.bavail) * Number(info.bsize) }
}

// ─── Събития за състоянието на хранилището ─────────────────────────────────

export const BELOT_HAND_JOURNAL_SYSTEM_ROOM_ID = '__journal__'

export type BelotHandJournalStorageWarningKind =
  | 'storage_usage_warning'
  | 'storage_limit_reached'
  | 'disk_space_critical'
  | 'early_archive_due_to_size'
  | 'premature_archive_deletion'
  | 'premature_active_deletion'
  | 'expired_without_archive'
  | 'archive_failed'
  | 'archive_verification_failed'
  | 'archive_quarantined_corrupt'
  | 'interrupted_archive_cleaned'
  | 'interrupted_archive_reconciled'
  | 'stale_lock_taken_over'
  | 'compression_fallback_gzip'
  | 'events_dropped'
  | 'maintenance_failed'

export function createBelotHandJournalStorageEvent(params: {
  nowMs: number
  severity: 'info' | 'anomaly'
  kind: BelotHandJournalStorageWarningKind | 'maintenance_summary'
  detail: string
  data?: Record<string, unknown>
}): BelotHandJournalEvent {
  return {
    schema: BELOT_HAND_JOURNAL_SCHEMA,
    schemaVersion: BELOT_HAND_JOURNAL_SCHEMA_VERSION,
    eventType: 'journal_storage',
    severity: params.severity,
    occurredAtMs: params.nowMs,
    occurredAt: new Date(params.nowMs).toISOString(),
    roomId: BELOT_HAND_JOURNAL_SYSTEM_ROOM_ID,
    matchId: BELOT_HAND_JOURNAL_SYSTEM_ROOM_ID,
    handId: null,
    payload: { kind: params.kind, detail: params.detail, ...(params.data ? { data: params.data } : {}) },
  }
}

// ─── Поддръжка ─────────────────────────────────────────────────────────────

export type BelotHandJournalMaintenanceHooks = BelotJournalCompressHooks & {
  // Тестове: поврежда временния файл преди проверката.
  corruptTmpBeforeVerify?: boolean
  // Тестове: „срив“ след финализиране на архива, преди изтриване на редовете.
  crashAfterFinalize?: boolean
}

export type BelotHandJournalMaintenanceDeps = {
  statfs?: BelotHandJournalStatfs
  disableNodeZstd?: boolean
  disableZstdCli?: boolean
  hooks?: BelotHandJournalMaintenanceHooks
}

export type BelotHandJournalArchivedDay = {
  day: string
  file: string
  rows: number
  backend: BelotJournalCompressionBackend
  uncompressedBytes: number
  compressedBytes: number
  reason: 'age' | 'size_limit'
}

export type BelotHandJournalMaintenanceReport = {
  status: 'completed' | 'skipped_locked' | 'failed'
  archived: BelotHandJournalArchivedDay[]
  reconciledRows: number
  expiredArchiveFiles: string[]
  expiredActiveRows: number
  prematureDeletedArchiveFiles: string[]
  prematureDeletedActiveRows: number
  warnings: { kind: BelotHandJournalStorageWarningKind; detail: string; data?: Record<string, unknown> }[]
  usageBefore: number
  usageAfter: number
  freeDiskBytes: number | null
  overLimit: boolean
  diskCritical: boolean
}

const runningDirectories = new Set<string>()

export async function runBelotHandJournalMaintenance(
  store: BelotHandJournalStore,
  config: BelotHandJournalStorageConfig,
  nowMs: number = Date.now(),
  deps: BelotHandJournalMaintenanceDeps = {},
): Promise<BelotHandJournalMaintenanceReport> {
  const report: BelotHandJournalMaintenanceReport = {
    status: 'completed',
    archived: [],
    reconciledRows: 0,
    expiredArchiveFiles: [],
    expiredActiveRows: 0,
    prematureDeletedArchiveFiles: [],
    prematureDeletedActiveRows: 0,
    warnings: [],
    usageBefore: 0,
    usageAfter: 0,
    freeDiskBytes: null,
    overLimit: false,
    diskCritical: false,
  }
  const warn = (kind: BelotHandJournalStorageWarningKind, detail: string, data?: Record<string, unknown>) => {
    report.warnings.push({ kind, detail, ...(data ? { data } : {}) })
  }

  // Lock в процеса (две извиквания едновременно) + lock файл (два процеса).
  if (runningDirectories.has(store.directory)) {
    report.status = 'skipped_locked'
    return report
  }
  runningDirectories.add(store.directory)
  let lockRelease: (() => Promise<void>) | null = null
  try {
    const lock = await acquireBelotJournalMaintenanceLock(store.directory, nowMs)
    if (!lock.acquired) {
      report.status = 'skipped_locked'
      return report
    }
    lockRelease = lock.lock.release
    if (lock.tookOverStale) {
      warn('stale_lock_taken_over', `заварен lock от pid ${lock.tookOverStale.pid} (прекъсната поддръжка) е поет`, {
        holder: lock.tookOverStale,
      })
    }
    await mkdir(store.archiveDirectory, { recursive: true })

    const statfsFn = deps.statfs ?? defaultBelotHandJournalStatfs
    const readFreeDisk = async (): Promise<number | null> => {
      try {
        return (await statfsFn(store.directory)).freeBytes
      } catch {
        return null
      }
    }
    report.usageBefore = (await measureBelotHandJournalStorage(store)).totalBytes
    report.freeDiskBytes = await readFreeDisk()
    report.diskCritical = report.freeDiskBytes !== null && report.freeDiskBytes < config.minFreeDiskBytes
    if (report.diskCritical) {
      warn('disk_space_critical', `свободно място ${(report.freeDiskBytes! / MB).toFixed(0)} MB < ${(config.minFreeDiskBytes / MB).toFixed(0)} MB — архивирането се пропуска, записът спира`, {
        freeDiskBytes: report.freeDiskBytes,
      })
    }

    // 1) Незавършени временни файлове от прекъснато архивиране.
    for (const file of (await listBelotJournalArchiveFiles(store.archiveDirectory)).filter((item) => item.kind === 'tmp')) {
      await rm(file.path, { force: true })
      warn('interrupted_archive_cleaned', `изтрит незавършен архив ${file.name} (редовете са още в SQLite)`, { file: file.name })
    }

    // 2) Срив между финализиран архив и изтриване на редовете: редовете с
    //    id-та, които СА в проверения архив, се изтриват (без дублиране).
    report.reconciledRows += await reconcileArchivedRows(store, deps, warn)

    // 3) Общ срок 30 дни.
    const maxAgeCutoffDay = toUtcDay(nowMs - config.maxAgeDays * DAY_MS)
    for (const file of await listBelotJournalArchiveFiles(store.archiveDirectory)) {
      if (file.kind !== 'tmp' && file.day < maxAgeCutoffDay) {
        await rm(file.path, { force: true })
        report.expiredArchiveFiles.push(file.name)
      }
    }
    const expired = store.deleteDaysBefore(maxAgeCutoffDay)
    if (expired.deletedRows > 0) {
      report.expiredActiveRows = expired.deletedRows
      warn('expired_without_archive', `${expired.deletedRows} реда (дни ${expired.days.join(', ')}) достигнаха 30 дни без успешен архив и са изтрити`, {
        days: expired.days,
        rows: expired.deletedRows,
      })
    }
    store.deleteScoredHandsBefore(nowMs - config.maxAgeDays * DAY_MS)

    // 4) Архивиране на дните извън активния прозорец (7 дни).
    const activeCutoffDay = toUtcDay(nowMs - config.activeDays * DAY_MS)
    if (!report.diskCritical) {
      for (const day of store.listDays().filter((item) => item < activeCutoffDay)) {
        await archiveDay(store, config, day, 'age', deps, report, warn)
      }
    }

    // 5) Лимит на диска.
    await enforceSizeLimit(store, config, nowMs, deps, report, warn, readFreeDisk)

    // 6) Физическо освобождаване на място (на порции, без VACUUM).
    await store.reclaimSpace()

    const usageAfter = await measureBelotHandJournalStorage(store)
    report.usageAfter = usageAfter.totalBytes
    report.overLimit = usageAfter.totalBytes >= config.maxTotalBytes
    if (report.overLimit) {
      warn('storage_limit_reached', `журналът заема ${(usageAfter.totalBytes / MB).toFixed(1)} MB ≥ лимита ${(config.maxTotalBytes / MB).toFixed(0)} MB — новият запис спира`, {
        totalBytes: usageAfter.totalBytes,
      })
    } else if (usageAfter.totalBytes >= config.maxTotalBytes * config.warnRatio) {
      warn('storage_usage_warning', `журналът заема ${(usageAfter.totalBytes / MB).toFixed(1)} MB (${Math.round((usageAfter.totalBytes / config.maxTotalBytes) * 100)}% от лимита)`, {
        totalBytes: usageAfter.totalBytes,
      })
    }
    return report
  } catch (error) {
    report.status = 'failed'
    warn('maintenance_failed', error instanceof Error ? error.message : String(error))
    return report
  } finally {
    if (lockRelease) await lockRelease().catch(() => undefined)
    runningDirectories.delete(store.directory)
  }
}

async function reconcileArchivedRows(
  store: BelotHandJournalStore,
  deps: BelotHandJournalMaintenanceDeps,
  warn: (kind: BelotHandJournalStorageWarningKind, detail: string, data?: Record<string, unknown>) => void,
): Promise<number> {
  let reconciled = 0
  for (const file of await listBelotJournalArchiveFiles(store.archiveDirectory)) {
    if (file.kind !== 'archive' || file.minId === null || file.maxId === null) continue
    if (store.countRowsInRange(file.day, file.minId, file.maxId) === 0) continue
    // Архивът е финализиран, но редовете не са изтрити (срив/рестарт).
    // Изтриваме САМО id-тата, които реално са в архива, след пълно четене
    // (декомпресията проверява и checksum-а).
    const archivedIds: number[] = []
    try {
      for await (const line of readBelotJournalArchiveLines(file.path, deps)) {
        const match = /^\{"id":(\d+),/.exec(line)
        if (!match) throw new Error('ред без id')
        archivedIds.push(Number(match[1]))
      }
    } catch (error) {
      const quarantined = `${file.path}.corrupt`
      await rename(file.path, quarantined).catch(() => undefined)
      warn('archive_quarantined_corrupt', `архивът ${file.name} не може да бъде прочетен (${error instanceof Error ? error.message : String(error)}) — карантина; редовете остават в SQLite и ще бъдат архивирани отново`, {
        file: file.name,
      })
      continue
    }
    const deleted = store.deleteDayIds(file.day, archivedIds)
    reconciled += deleted
    warn('interrupted_archive_reconciled', `${deleted} реда от ${file.day} вече са в ${file.name} (прекъснато архивиране) — изтрити от SQLite`, {
      file: file.name,
      rows: deleted,
    })
  }
  return reconciled
}

async function archiveDay(
  store: BelotHandJournalStore,
  config: BelotHandJournalStorageConfig,
  day: string,
  reason: 'age' | 'size_limit',
  deps: BelotHandJournalMaintenanceDeps,
  report: BelotHandJournalMaintenanceReport,
  warn: (kind: BelotHandJournalStorageWarningKind, detail: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  const stats = store.getDayStats(day)
  if (stats === null) return true
  const backend = selectBelotJournalCompressionBackend({
    zstdLevel: config.zstdLevel,
    disableNodeZstd: deps.disableNodeZstd,
    disableZstdCli: deps.disableZstdCli,
  })
  if (backend === 'node-gzip' && !report.warnings.some((item) => item.kind === 'compression_fallback_gzip')) {
    warn('compression_fallback_gzip', 'няма ZSTD (нито вграден в Node, нито `zstd` CLI) — архивите се записват като .gz; инсталирай zstd или обнови Node')
  }
  const name = buildBelotJournalArchiveName(day, stats.minId, stats.maxId, getArchiveExtensionForBackend(backend))
  const finalPath = join(store.archiveDirectory, name)
  const tmpPath = `${finalPath}.tmp`
  await rm(tmpPath, { force: true })
  try {
    const result = await compressBelotJournalLines({
      lines: store.iterateDayArchiveLines(day, stats.minId, stats.maxId),
      targetPath: tmpPath,
      backend,
      zstdLevel: config.zstdLevel,
      hooks: deps.hooks,
    })
    if (deps.hooks?.corruptTmpBeforeVerify) {
      const handle = await open(tmpPath, 'r+')
      const size = (await handle.stat()).size
      await handle.write(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 0, 4, Math.max(0, Math.floor(size / 2)))
      await handle.close()
    }
    if (result.lineCount !== stats.count) {
      throw new Error(`archived ${result.lineCount} rows, expected ${stats.count}`)
    }
    const verification = await verifyBelotJournalArchive(tmpPath, result, deps)
    if (!verification.ok) {
      await rm(tmpPath, { force: true })
      warn('archive_verification_failed', `архивът за ${day} не мина проверката (${verification.reason}) — редовете остават в SQLite`, { day })
      return false
    }
    await rename(tmpPath, finalPath)
    await syncDirectory(store.archiveDirectory)
    if (deps.hooks?.crashAfterFinalize) {
      throw new Error('injected crash after finalize (test hook)')
    }
    const deleted = store.deleteDayRange(day, stats.minId, stats.maxId)
    report.archived.push({
      day,
      file: name,
      rows: deleted,
      backend,
      uncompressedBytes: result.uncompressedBytes,
      compressedBytes: result.compressedBytes,
      reason,
    })
    return true
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    warn('archive_failed', `архивирането на ${day} е неуспешно (${error instanceof Error ? error.message : String(error)}) — редовете остават в SQLite`, { day })
    return false
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // fsync на директорията прави rename-а траен (Linux); на Windows не се
  // поддържа — безопасно се пропуска.
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // неподдържано
  }
}

// Контрол на размера, по ред на безопасност за доказателствата:
//   а) ранно архивиране на най-старите активни дни (без днешния) — без
//      загуба, само компресия;
//   б) изтриване на най-старите архиви (преждевременно — с предупреждение);
//   в) изтриване на най-старите активни дни без архив (без днешния) —
//      с предупреждение;
//   г) ако и днешният ден сам надхвърля лимита — report.overLimit → новите
//      записи се спират до освобождаване (runtime-ът брои пропуснатите).
async function enforceSizeLimit(
  store: BelotHandJournalStore,
  config: BelotHandJournalStorageConfig,
  nowMs: number,
  deps: BelotHandJournalMaintenanceDeps,
  report: BelotHandJournalMaintenanceReport,
  warn: (kind: BelotHandJournalStorageWarningKind, detail: string, data?: Record<string, unknown>) => void,
  readFreeDisk: () => Promise<number | null>,
): Promise<void> {
  const startBytes = config.maxTotalBytes * config.startCleanupRatio
  const targetBytes = config.maxTotalBytes * config.targetRatio
  const total = async () => {
    await store.reclaimSpace()
    return (await measureBelotHandJournalStorage(store)).totalBytes
  }
  let current = await total()
  if (current < startBytes) return
  const today = toUtcDay(nowMs)

  // а) ранно архивиране
  const freeDisk = await readFreeDisk()
  const canCompress = freeDisk === null || freeDisk >= config.minFreeDiskBytes
  if (canCompress) {
    for (const day of store.listDays().filter((item) => item < today)) {
      if (current <= targetBytes) break
      const ok = await archiveDay(store, config, day, 'size_limit', deps, report, warn)
      if (ok) {
        warn('early_archive_due_to_size', `денят ${day} е архивиран преди 7-ия ден поради лимита на диска`, { day })
      }
      current = await total()
    }
  }

  // б) най-старите архиви
  for (const file of await listBelotJournalArchiveFiles(store.archiveDirectory)) {
    if (current <= targetBytes) break
    if (file.kind === 'tmp') continue
    await rm(file.path, { force: true })
    report.prematureDeletedArchiveFiles.push(file.name)
    warn('premature_archive_deletion', `архивът ${file.name} (ден ${file.day}) е изтрит ПРЕДИ 30-ия ден поради лимита ${(config.maxTotalBytes / MB).toFixed(0)} MB`, {
      file: file.name,
      day: file.day,
      bytes: file.bytes,
    })
    current = await total()
  }

  // в) най-старите активни дни без архив
  for (const day of store.listDays().filter((item) => item < today)) {
    if (current <= targetBytes) break
    const deleted = store.deleteDay(day)
    report.prematureDeletedActiveRows += deleted
    warn('premature_active_deletion', `${deleted} реда от ${day} са изтрити БЕЗ архив поради лимита на диска`, { day, rows: deleted })
    current = await total()
  }
}
