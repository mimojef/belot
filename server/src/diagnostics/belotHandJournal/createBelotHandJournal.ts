// Runtime на belot hand журнала в главната нишка.
//
// Hot path (observeRoomTransition) само извежда събитията (чист diff, без
// I/O) и ги слага в опашка; записът в SQLite става веднъж на event-loop
// оборот (setImmediate) в една транзакция — без отделен синхронен запис за
// всяко действие. Нищо тук не хвърля към gameplay кода и нищо не променя
// state-а: при грешка се пише console.error и (при възможност) anomaly ред.
//
// Пазач на хранилището: на всеки 60 s мери всички файлове на журнала и
// свободното място на диска (между измерванията — оценка по записаните
// байтове). При достигнат лимит (1.5 GB) или критично малко място записът
// се спира (игрите продължават), пропуснатите събития се броят и при
// възобновяване се записва предупреждение. Поддръжката (архивиране/срокове)
// е на всеки час — виж runBelotHandJournalMaintenance.ts.

import type { Seat, ServerRoom } from '../../core/serverTypes.js'
import {
  buildBelotHandStartedEvents,
  buildBelotSweepAcceptRejectedEvents,
  createBelotJournalAnomalyEvent,
  deriveBelotHandJournalEvents,
  getBelotHandContext,
  getBelotJournalAuthState,
  type BelotHandJournalPlaySourceRegistry,
} from './deriveBelotHandJournalEvents.js'
import type {
  BelotHandJournalEvent,
  BelotHandJournalOrigin,
  BelotHandJournalPlaySource,
} from './belotHandJournalTypes.js'
import type { BelotHandJournalStore } from './belotHandJournalStore.js'
import { safeInvokeTimingHook, type MainThreadTimingHook } from '../../monitoring/mainThreadTimingMetrics.js'
import { selectBelotJournalCompressionBackend } from './belotHandJournalCompression.js'
import {
  createBelotHandJournalStorageEvent,
  defaultBelotHandJournalStatfs,
  measureBelotHandJournalStorage,
  resolveBelotHandJournalStorageConfig,
  runBelotHandJournalMaintenance,
  type BelotHandJournalMaintenanceDeps,
  type BelotHandJournalMaintenanceReport,
  type BelotHandJournalStatfs,
  type BelotHandJournalStorageConfig,
  type BelotHandJournalStorageWarningKind,
} from './runBelotHandJournalMaintenance.js'

const DEFAULT_MAX_QUEUE = 20000
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000
const STORAGE_CHECK_INTERVAL_MS = 60 * 1000
// Повторно предупреждение за същото състояние най-често веднъж на 6 часа.
const WARNING_REPEAT_MS = 6 * 60 * 60 * 1000
// SQLite индекси/страници над чистия payload — консервативна оценка.
const ESTIMATED_DB_OVERHEAD_FACTOR = 2
const MAINTENANCE_FIRST_RUN_DELAY_MS = 2 * 60 * 1000
// Горни граници за паметта (стаи, видени от старта на процеса). При
// изтриване на най-старите записи: източникът на картите става 'unknown', а
// проверката за hand_started се прави отново с една заявка към базата.
const MAX_TRACKED_PLAY_SOURCE_ROOMS = 2000
const MAX_SEEN_ROOM_IDS = 20000

function trimOldest<K>(collection: Map<K, unknown> | Set<K>, max: number): void {
  while (collection.size > max) {
    const oldest = collection.keys().next()
    if (oldest.done) return
    collection.delete(oldest.value)
  }
}

export type BelotHandJournalStats = {
  enabled: boolean
  queued: number
  written: number
  dropped: number
  writeFailures: number
  anomalies: number
  lastError: string | null
  writesPaused: 'size_limit' | 'disk_critical' | null
  droppedWhilePaused: number
  lastUsageBytes: number | null
  lastFreeDiskBytes: number | null
}

export type BelotHandJournal = {
  observeRoomTransition: (prevRoom: ServerRoom | null, nextRoom: ServerRoom, origin: BelotHandJournalOrigin) => void
  recordSweepDecisionRejected: (room: ServerRoom, seat: Seat, decision: 'accept' | 'decline', reason: string) => void
  flushSync: () => void
  startMaintenance: () => void
  runMaintenanceNow: () => Promise<BelotHandJournalMaintenanceReport | null>
  checkStorageNow: () => Promise<void>
  getStats: () => BelotHandJournalStats
  close: () => void
}

export function isBelotHandJournalEnabled(): boolean {
  return process.env.BELOT_HAND_JOURNAL_ENABLED !== '0'
}

export function createBelotHandJournal(options: {
  store: BelotHandJournalStore | null
  now?: () => number
  maxQueue?: number
  storage?: BelotHandJournalStorageConfig
  statfs?: BelotHandJournalStatfs
  maintenanceDeps?: BelotHandJournalMaintenanceDeps
  // Тестовете подменят асинхронния flush със синхронен.
  scheduleFlush?: (flush: () => void) => void
  // Phase 0B — monitoring-only timings (label: observe | derive | flush |
  // serialize | write | storageCheck | maintenance). Никога не влияе на журнала.
  onTiming?: MainThreadTimingHook
}): BelotHandJournal {
  const store = options.store
  const now = options.now ?? Date.now
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
  const storage = options.storage ?? resolveBelotHandJournalStorageConfig()
  const statfsFn = options.statfs ?? defaultBelotHandJournalStatfs
  const timingHook = options.onTiming ?? null
  // Phase 0B: maintenance получава същия hook за вътрешните sync стъпки
  // (порции на изтриването, reclaim, архивни страници) и async wall-ове.
  const maintenanceTimingHook = options.maintenanceDeps?.onTiming ?? timingHook
  const maintenanceDeps: BelotHandJournalMaintenanceDeps = {
    statfs: statfsFn,
    ...options.maintenanceDeps,
    ...(maintenanceTimingHook !== null ? { onTiming: maintenanceTimingHook } : {}),
  }
  const scheduleFlush = options.scheduleFlush ?? ((flush: () => void) => setImmediate(flush))
  const stats: BelotHandJournalStats = {
    enabled: store !== null,
    queued: 0,
    written: 0,
    dropped: 0,
    writeFailures: 0,
    anomalies: 0,
    lastError: null,
    writesPaused: null,
    droppedWhilePaused: 0,
    lastUsageBytes: null,
    lastFreeDiskBytes: null,
  }

  let queue: BelotHandJournalEvent[] = []
  const retriedEvents = new WeakSet<BelotHandJournalEvent>()
  let flushScheduled = false
  let closed = false
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null
  let maintenanceFirstTimer: ReturnType<typeof setTimeout> | null = null
  let maintenancePromise: Promise<BelotHandJournalMaintenanceReport | null> | null = null
  let storageTimer: ReturnType<typeof setInterval> | null = null
  let storageCheckPromise: Promise<void> | null = null
  // Оценка на размера между две измервания: последно измерено + записано.
  let bytesSinceMeasure = 0
  let droppedSincePause: Record<'size_limit' | 'disk_critical', number> = { size_limit: 0, disk_critical: 0 }
  const lastWarningAt = new Map<string, number>()

  // Източник на всяка карта (ръчно / изтекъл таймер / бот) — само в паметта
  // за текущото раздаване на стаята; след рестарт става 'unknown'.
  const playSourcesByRoom = new Map<string, { handId: string; sources: Map<string, BelotHandJournalPlaySource> }>()
  // Стаи, видени след старта на процеса — при първо виждане проверяваме дали
  // текущото раздаване вече има hand_started (напр. преди рестарт).
  const seenRoomIds = new Set<string>()
  // hand_started, чакащи в опашката (още не са в базата).
  const pendingStartedHandIds = new Set<string>()

  function createPlaySourceRegistry(roomId: string): BelotHandJournalPlaySourceRegistry {
    return {
      get: (handId, cardId) => {
        const entry = playSourcesByRoom.get(roomId)
        return entry && entry.handId === handId ? entry.sources.get(cardId) : undefined
      },
      set: (handId, cardId, source) => {
        let entry = playSourcesByRoom.get(roomId)
        if (!entry || entry.handId !== handId) {
          entry = { handId, sources: new Map() }
          playSourcesByRoom.delete(roomId)
          playSourcesByRoom.set(roomId, entry)
          trimOldest(playSourcesByRoom, MAX_TRACKED_PLAY_SOURCE_ROOMS)
        }
        entry.sources.set(cardId, source)
      },
    }
  }

  function logError(context: string, error: unknown): void {
    stats.lastError = `${context}: ${error instanceof Error ? error.message : String(error)}`
    console.error(`[belot-hand-journal] ${context} (gameplay unaffected)`, error)
  }

  function enqueue(events: readonly BelotHandJournalEvent[]): void {
    if (store === null || closed || events.length === 0) return
    for (const event of events) {
      // При спрян запис се пропускат игровите събития; предупрежденията за
      // хранилището (малки) минават, освен при критично малко място.
      if (stats.writesPaused !== null && (event.eventType !== 'journal_storage' || stats.writesPaused === 'disk_critical')) {
        stats.dropped += 1
        stats.droppedWhilePaused += 1
        droppedSincePause[stats.writesPaused] += 1
        continue
      }
      if (queue.length >= maxQueue) {
        stats.dropped += 1
        continue
      }
      if (event.eventType === 'hand_started' && event.handId !== null) {
        pendingStartedHandIds.add(event.handId)
      }
      if (event.eventType === 'anomaly') {
        stats.anomalies += 1
        const payload = event.payload as { anomalyType?: string; check?: { detail?: string } }
        console.warn(
          `[belot-hand-journal] anomaly type=${payload.anomalyType ?? '?'} room=${event.roomId} hand=${event.handId ?? '-'} detail=${payload.check?.detail ?? ''}`,
        )
      }
      queue.push(event)
    }
    stats.queued = queue.length
    if (!flushScheduled) {
      flushScheduled = true
      scheduleFlush(() => {
        flushScheduled = false
        flushSync()
      })
    }
  }

  function flushSync(): void {
    if (store === null || queue.length === 0) return
    const flushStartedAt = timingHook !== null ? performance.now() : 0
    try {
      flushSyncUnmeasured()
    } finally {
      if (timingHook !== null) safeInvokeTimingHook(timingHook, 'flush', performance.now() - flushStartedAt)
    }
  }

  function flushSyncUnmeasured(): void {
    if (store === null || queue.length === 0) return
    const batch = queue
    queue = []
    stats.queued = 0
    try {
      const writeStartedAt = timingHook !== null ? performance.now() : 0
      const result = store.insertEvents(batch, (event, claim) => ({
        ...event,
        eventType: 'anomaly',
        severity: 'anomaly',
        payload: {
          anomalyType: 'duplicate_hand_scoring',
          relatedEventType: 'hand_scored',
          check: {
            name: 'hand_scored_at_most_once',
            ok: false,
            anomalyType: 'duplicate_hand_scoring',
            detail: `hand ${event.handId} already scored at ${new Date(claim.previous.scoredAtMs).toISOString()} (match ${claim.previous.matchBefore} -> ${claim.previous.matchAfter})`,
            data: { previous: claim.previous },
          },
        },
      }))
      if (timingHook !== null) {
        const insertMs = performance.now() - writeStartedAt
        const serializeMs = result.serializeMs ?? 0
        safeInvokeTimingHook(timingHook, 'serialize', serializeMs)
        safeInvokeTimingHook(timingHook, 'write', Math.max(0, insertMs - serializeMs))
      }
      stats.written += result.inserted
      bytesSinceMeasure += result.bytes * ESTIMATED_DB_OVERHEAD_FACTOR
      if (stats.lastUsageBytes !== null && stats.writesPaused === null && stats.lastUsageBytes + bytesSinceMeasure >= storage.maxTotalBytes) {
        pauseWrites('size_limit', `оценка ${((stats.lastUsageBytes + bytesSinceMeasure) / 1048576).toFixed(1)} MB достига лимита`)
        void checkStorageNow()
      }
      for (const duplicate of result.duplicates) {
        stats.anomalies += 1
        console.warn(`[belot-hand-journal] anomaly type=duplicate_hand_scoring room=${duplicate.roomId} hand=${duplicate.handId}`)
      }
      for (const event of batch) {
        if (event.eventType === 'hand_started' && event.handId !== null) pendingStartedHandIds.delete(event.handId)
      }
    } catch (error) {
      stats.writeFailures += 1
      // Един повторен опит при следващия flush (напр. SQLITE_BUSY), после се
      // изхвърля, за да не расте паметта безкрайно. Транзакцията е
      // rollback-ната изцяло, затова повторният опит е безопасен.
      if (!batch.some((event) => retriedEvents.has(event))) {
        for (const event of batch) retriedEvents.add(event)
        queue = [...batch, ...queue].slice(0, maxQueue)
        stats.queued = queue.length
      } else {
        stats.dropped += batch.length
      }
      logError('write failed', error)
    }
  }

  function ensureHandStartedForFirstSighting(room: ServerRoom): BelotHandJournalEvent[] {
    if (store === null || seenRoomIds.has(room.id)) return []
    seenRoomIds.add(room.id)
    trimOldest(seenRoomIds, MAX_SEEN_ROOM_IDS)
    const state = getBelotJournalAuthState(room)
    if (state === null) return []
    const hand = getBelotHandContext(room, state)
    if (hand === null || pendingStartedHandIds.has(hand.handId)) return []
    if (store.hasEventForHand(hand.handId, 'hand_started')) return []
    return buildBelotHandStartedEvents({ room, state, hand, nowMs: now(), reconstructedMidHand: true })
  }

  function observeRoomTransition(prevRoom: ServerRoom | null, nextRoom: ServerRoom, origin: BelotHandJournalOrigin): void {
    if (store === null || closed) return
    if (timingHook === null) {
      observeRoomTransitionUnmeasured(prevRoom, nextRoom, origin)
      return
    }
    const observeStartedAt = performance.now()
    try {
      observeRoomTransitionUnmeasured(prevRoom, nextRoom, origin)
    } finally {
      safeInvokeTimingHook(timingHook, 'observe', performance.now() - observeStartedAt)
    }
  }

  function observeRoomTransitionUnmeasured(prevRoom: ServerRoom | null, nextRoom: ServerRoom, origin: BelotHandJournalOrigin): void {
    try {
      if (prevRoom !== null && prevRoom.game.authoritativeState === nextRoom.game.authoritativeState) {
        return
      }
      const events: BelotHandJournalEvent[] = []
      if (prevRoom !== null) {
        events.push(...ensureHandStartedForFirstSighting(prevRoom))
      }
      seenRoomIds.add(nextRoom.id)
      trimOldest(seenRoomIds, MAX_SEEN_ROOM_IDS)
      const deriveStartedAt = timingHook !== null ? performance.now() : 0
      const derived = deriveBelotHandJournalEvents({
        prevRoom,
        nextRoom,
        origin,
        nowMs: now(),
        playSources: createPlaySourceRegistry(nextRoom.id),
      })
      if (timingHook !== null) safeInvokeTimingHook(timingHook, 'derive', performance.now() - deriveStartedAt)
      // Дубликат на hand_started (напр. стая, видяна за първи път веднага
      // след рестарт, когато prevRoom е null) — пропускаме го.
      for (const event of derived) {
        if (event.eventType === 'hand_started' && event.handId !== null) {
          if (pendingStartedHandIds.has(event.handId) || events.some((e) => e.eventType === 'hand_started' && e.handId === event.handId)) {
            continue
          }
        }
        events.push(event)
      }
      enqueue(events)
    } catch (error) {
      logError(`observe failed room=${nextRoom.id}`, error)
      try {
        enqueue([
          createBelotJournalAnomalyEvent({
            room: nextRoom,
            handId: null,
            nowMs: now(),
            relatedEventType: null,
            check: {
              name: 'journal_observe_completed',
              ok: false,
              anomalyType: 'journal_internal_error',
              detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 2000) : String(error),
            },
          }),
        ])
      } catch {
        // нищо повече не може да се направи
      }
    }
  }

  function recordSweepDecisionRejected(room: ServerRoom, seat: Seat, decision: 'accept' | 'decline', reason: string): void {
    if (store === null || closed) return
    try {
      enqueue(buildBelotSweepAcceptRejectedEvents({ room, seat, decision, reason, nowMs: now() }))
    } catch (error) {
      logError(`sweep reject record failed room=${room.id}`, error)
    }
  }

  // ─── Предупреждения за хранилището ─────────────────────────────────────

  function recordStorageWarning(
    kind: BelotHandJournalStorageWarningKind | 'maintenance_summary',
    detail: string,
    data?: Record<string, unknown>,
    options: { severity?: 'info' | 'anomaly'; rateLimitKey?: string } = {},
  ): void {
    const key = options.rateLimitKey
    if (key !== undefined) {
      const last = lastWarningAt.get(key)
      if (last !== undefined && now() - last < WARNING_REPEAT_MS) return
      lastWarningAt.set(key, now())
    }
    const severity = options.severity ?? 'anomaly'
    const line = `[belot-hand-journal] storage ${kind}: ${detail}`
    if (severity === 'anomaly') console.warn(line)
    else console.log(line)
    try {
      enqueue([createBelotHandJournalStorageEvent({ nowMs: now(), severity, kind, detail, data })])
    } catch (error) {
      logError('storage warning record failed', error)
    }
  }

  function pauseWrites(reason: 'size_limit' | 'disk_critical', detail: string): void {
    if (stats.writesPaused === reason) return
    // Предупреждението се записва ПРЕДИ паузата (при size_limit минава).
    if (reason === 'size_limit') {
      recordStorageWarning('storage_limit_reached', `записът на журнала е спрян: ${detail}; игрите продължават`, {
        maxTotalBytes: storage.maxTotalBytes,
      })
    } else {
      console.warn(`[belot-hand-journal] storage disk_space_critical: ${detail} — записът на журнала е спрян; игрите продължават`)
    }
    stats.writesPaused = reason
  }

  function resumeWrites(): void {
    if (stats.writesPaused === null) return
    const previous = stats.writesPaused
    const dropped = droppedSincePause
    stats.writesPaused = null
    droppedSincePause = { size_limit: 0, disk_critical: 0 }
    recordStorageWarning(
      'events_dropped',
      `записът е възобновен (беше спрян: ${previous}); пропуснати събития: ${dropped.size_limit + dropped.disk_critical}`,
      { reason: previous, droppedSizeLimit: dropped.size_limit, droppedDiskCritical: dropped.disk_critical },
    )
  }

  // Ако проверка вече тече, връща същото обещание.
  function checkStorageNow(): Promise<void> {
    if (store === null || closed) return Promise.resolve()
    if (storageCheckPromise !== null) return storageCheckPromise
    const storageCheckStartedAt = performance.now()
    storageCheckPromise = checkStorageOnce().finally(() => {
      storageCheckPromise = null
      safeInvokeTimingHook(timingHook, 'storageCheck', performance.now() - storageCheckStartedAt)
    })
    return storageCheckPromise
  }

  async function checkStorageOnce(): Promise<void> {
    if (store === null) return
    try {
      flushSync()
      const usage = await measureBelotHandJournalStorage(store)
      let freeDiskBytes: number | null = null
      try {
        freeDiskBytes = (await statfsFn(store.directory)).freeBytes
      } catch {
        freeDiskBytes = null
      }
      if (closed) return
      stats.lastUsageBytes = usage.totalBytes
      stats.lastFreeDiskBytes = freeDiskBytes
      bytesSinceMeasure = 0
      const percent = Math.round((usage.totalBytes / storage.maxTotalBytes) * 100)
      if (freeDiskBytes !== null && freeDiskBytes < storage.minFreeDiskBytes) {
        pauseWrites('disk_critical', `свободно място ${(freeDiskBytes / 1048576).toFixed(0)} MB < ${(storage.minFreeDiskBytes / 1048576).toFixed(0)} MB`)
        return
      }
      if (usage.totalBytes >= storage.maxTotalBytes) {
        pauseWrites('size_limit', `${(usage.totalBytes / 1048576).toFixed(1)} MB ≥ ${(storage.maxTotalBytes / 1048576).toFixed(0)} MB`)
        // Опит за освобождаване веднага (архивиране/почистване).
        void runMaintenanceNow()
        return
      }
      resumeWrites()
      if (usage.totalBytes >= storage.maxTotalBytes * storage.warnRatio) {
        recordStorageWarning(
          'storage_usage_warning',
          `журналът заема ${(usage.totalBytes / 1048576).toFixed(1)} MB (${percent}% от ${(storage.maxTotalBytes / 1048576).toFixed(0)} MB)`,
          { totalBytes: usage.totalBytes, percent },
          { rateLimitKey: 'usage_warning' },
        )
        if (usage.totalBytes >= storage.maxTotalBytes * storage.startCleanupRatio) void runMaintenanceNow()
      }
    } catch (error) {
      logError('storage check failed', error)
    }
  }

  // Phase 0B: maintenance е async (wall → 'maintenance'), но между await-ите
  // прави SYNC SQLite работа (COUNT, listDays…). Всеки sync store метод,
  // извикан от maintenance, се мери като 'maintenance.<метод>' (фиксирани
  // имена от кода). Методи, връщащи Promise/async iterator, не се записват
  // тук — тяхната sync работа (порции на изтриването, reclaim стъпки,
  // архивни страници) се мери отвътре с фиксираните label-и от
  // belotHandJournalTimingLabels.ts (maintenanceDeps.onTiming).
  function withSyncStoreMethodTiming(target: BelotHandJournalStore, hook: MainThreadTimingHook): BelotHandJournalStore {
    return new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver)
        if (typeof value !== 'function' || typeof property !== 'string') return value
        const method = value as (...args: unknown[]) => unknown
        return (...args: unknown[]): unknown => {
          const startedAt = performance.now()
          let result: unknown
          let isAsyncResult = false
          try {
            result = method.apply(object, args)
            isAsyncResult = result !== null && typeof result === 'object' &&
              (typeof (result as { then?: unknown }).then === 'function' || Symbol.asyncIterator in result)
            return result
          } finally {
            if (!isAsyncResult) safeInvokeTimingHook(hook, `maintenance.${property}`, performance.now() - startedAt)
          }
        }
      },
    })
  }

  // Ако поддръжката вече тече, връща същото обещание (никога две наведнъж).
  function runMaintenanceNow(): Promise<BelotHandJournalMaintenanceReport | null> {
    if (store === null || closed) return Promise.resolve(null)
    if (maintenancePromise !== null) return maintenancePromise
    const maintenanceStartedAt = performance.now()
    maintenancePromise = runMaintenanceOnce().finally(() => {
      maintenancePromise = null
      safeInvokeTimingHook(timingHook, 'maintenance', performance.now() - maintenanceStartedAt)
    })
    return maintenancePromise
  }

  async function runMaintenanceOnce(): Promise<BelotHandJournalMaintenanceReport | null> {
    if (store === null) return null
    try {
      flushSync()
      const maintenanceStore = timingHook === null ? store : withSyncStoreMethodTiming(store, timingHook)
      const report = await runBelotHandJournalMaintenance(maintenanceStore, storage, now(), maintenanceDeps)
      if (closed) return report
      for (const warning of report.warnings) {
        // Тези две се записват от checkStorageNow със собствена логика.
        if (warning.kind === 'storage_usage_warning' || warning.kind === 'storage_limit_reached') continue
        if (warning.kind === 'disk_space_critical') continue
        recordStorageWarning(warning.kind, warning.detail, warning.data)
      }
      if (report.archived.length > 0 || report.expiredArchiveFiles.length > 0 || report.reconciledRows > 0) {
        recordStorageWarning(
          'maintenance_summary',
          `поддръжка: архивирани дни ${report.archived.map((item) => item.day).join(', ') || '-'}, изтекли архиви ${report.expiredArchiveFiles.length}, размер ${(report.usageBefore / 1048576).toFixed(1)} → ${(report.usageAfter / 1048576).toFixed(1)} MB`,
          {
            archived: report.archived,
            expiredArchiveFiles: report.expiredArchiveFiles,
            reconciledRows: report.reconciledRows,
            usageBefore: report.usageBefore,
            usageAfter: report.usageAfter,
            deleteChunks: report.deleteChunks,
            maxDeleteChunkMs: Math.round(report.maxDeleteChunkMs * 1000) / 1000,
            reclaimFreedPages: report.reclaimFreedPages,
            walBytesBefore: report.walBytesBefore,
            walBytesAfter: report.walBytesAfter,
          },
          { severity: 'info' },
        )
      }
      return report
    } catch (error) {
      logError('maintenance failed', error)
      return null
    } finally {
      if (!closed) void checkStorageNow()
    }
  }

  function startMaintenance(): void {
    if (store === null || maintenanceTimer !== null) return
    const backend = selectBelotJournalCompressionBackend({ zstdLevel: storage.zstdLevel, ...options.maintenanceDeps })
    console.log(
      `[belot-hand-journal] storage policy: active ${storage.activeDays}d + archive to ${storage.maxAgeDays}d total, compression=${backend} level=${storage.zstdLevel}, limit=${(storage.maxTotalBytes / 1048576).toFixed(0)}MB (warn ${Math.round(storage.warnRatio * 100)}%), minFreeDisk=${(storage.minFreeDiskBytes / 1048576).toFixed(0)}MB`,
    )
    if (backend === 'node-gzip') {
      console.warn('[belot-hand-journal] няма ZSTD (Node без zlib ZSTD и без `zstd` CLI) — архивите ще са .gz')
    }
    void checkStorageNow()
    storageTimer = setInterval(() => {
      void checkStorageNow()
    }, STORAGE_CHECK_INTERVAL_MS)
    storageTimer.unref?.()
    maintenanceFirstTimer = setTimeout(() => {
      void runMaintenanceNow()
    }, MAINTENANCE_FIRST_RUN_DELAY_MS)
    maintenanceFirstTimer.unref?.()
    maintenanceTimer = setInterval(() => {
      void runMaintenanceNow()
    }, MAINTENANCE_INTERVAL_MS)
    maintenanceTimer.unref?.()
  }

  function close(): void {
    if (closed) return
    flushSync()
    closed = true
    if (maintenanceTimer !== null) clearInterval(maintenanceTimer)
    if (maintenanceFirstTimer !== null) clearTimeout(maintenanceFirstTimer)
    if (storageTimer !== null) clearInterval(storageTimer)
    // Прекъсната поддръжка (ако тече) оставя само .tmp файл и lock — и двете
    // се почистват безопасно при следващото пускане.
    store?.close()
  }

  return {
    observeRoomTransition,
    recordSweepDecisionRejected,
    flushSync,
    startMaintenance,
    runMaintenanceNow,
    checkStorageNow,
    getStats: () => ({ ...stats, queued: queue.length }),
    close,
  }
}
