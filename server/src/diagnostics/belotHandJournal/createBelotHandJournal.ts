// Runtime на belot hand журнала в главната нишка.
//
// Hot path (observeRoomTransition) само извежда събитията (чист diff, без
// I/O) и ги слага в опашка; записът в SQLite става веднъж на event-loop
// оборот (setImmediate) в една транзакция — без отделен синхронен запис за
// всяко действие. Нищо тук не хвърля към gameplay кода и нищо не променя
// state-а: при грешка се пише console.error и (при възможност) anomaly ред.

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
import type {
  BelotHandJournalMaintenanceReport,
  BelotHandJournalRetentionConfig,
  BelotHandJournalStore,
} from './belotHandJournalStore.js'

const DEFAULT_MAX_QUEUE = 20000
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000
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
}

export type BelotHandJournal = {
  observeRoomTransition: (prevRoom: ServerRoom | null, nextRoom: ServerRoom, origin: BelotHandJournalOrigin) => void
  recordSweepDecisionRejected: (room: ServerRoom, seat: Seat, decision: 'accept' | 'decline', reason: string) => void
  flushSync: () => void
  startMaintenance: () => void
  runMaintenanceNow: () => Promise<BelotHandJournalMaintenanceReport | null>
  getStats: () => BelotHandJournalStats
  close: () => void
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function resolveBelotHandJournalRetentionConfig(): BelotHandJournalRetentionConfig {
  return {
    retentionDays: readPositiveNumberEnv('BELOT_HAND_JOURNAL_RETENTION_DAYS', 30),
    maxDbBytes: readPositiveNumberEnv('BELOT_HAND_JOURNAL_MAX_DB_MB', 2048) * 1024 * 1024,
    archiveRetentionDays: readPositiveNumberEnv('BELOT_HAND_JOURNAL_ARCHIVE_RETENTION_DAYS', 180),
    maxArchiveBytes: readPositiveNumberEnv('BELOT_HAND_JOURNAL_MAX_ARCHIVE_MB', 1024) * 1024 * 1024,
  }
}

export function isBelotHandJournalEnabled(): boolean {
  return process.env.BELOT_HAND_JOURNAL_ENABLED !== '0'
}

export function createBelotHandJournal(options: {
  store: BelotHandJournalStore | null
  now?: () => number
  maxQueue?: number
  retention?: BelotHandJournalRetentionConfig
  // Тестовете подменят асинхронния flush със синхронен.
  scheduleFlush?: (flush: () => void) => void
}): BelotHandJournal {
  const store = options.store
  const now = options.now ?? Date.now
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
  const retention = options.retention ?? resolveBelotHandJournalRetentionConfig()
  const scheduleFlush = options.scheduleFlush ?? ((flush: () => void) => setImmediate(flush))
  const stats: BelotHandJournalStats = {
    enabled: store !== null,
    queued: 0,
    written: 0,
    dropped: 0,
    writeFailures: 0,
    anomalies: 0,
    lastError: null,
  }

  let queue: BelotHandJournalEvent[] = []
  const retriedEvents = new WeakSet<BelotHandJournalEvent>()
  let flushScheduled = false
  let closed = false
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null
  let maintenanceFirstTimer: ReturnType<typeof setTimeout> | null = null
  let maintenanceRunning = false

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
    const batch = queue
    queue = []
    stats.queued = 0
    try {
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
      stats.written += result.inserted
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
      const derived = deriveBelotHandJournalEvents({
        prevRoom,
        nextRoom,
        origin,
        nowMs: now(),
        playSources: createPlaySourceRegistry(nextRoom.id),
      })
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

  async function runMaintenanceNow(): Promise<BelotHandJournalMaintenanceReport | null> {
    if (store === null || maintenanceRunning || closed) return null
    maintenanceRunning = true
    try {
      flushSync()
      const report = await store.runMaintenance(retention, now())
      if (report.archivedRows > 0 || report.deletedArchiveFiles.length > 0 || report.sizeLimitExceeded) {
        console.log(
          `[belot-hand-journal] maintenance archivedDays=${report.archivedDays.join(',') || '-'} archivedRows=${report.archivedRows} deletedArchives=${report.deletedArchiveFiles.length} dbUsedMB=${(report.dbUsedBytesAfter / 1048576).toFixed(1)} sizeLimitExceeded=${report.sizeLimitExceeded}`,
        )
      }
      return report
    } catch (error) {
      logError('maintenance failed', error)
      return null
    } finally {
      maintenanceRunning = false
    }
  }

  function startMaintenance(): void {
    if (store === null || maintenanceTimer !== null) return
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
    store?.close()
  }

  return {
    observeRoomTransition,
    recordSweepDecisionRejected,
    flushSync,
    startMaintenance,
    runMaintenanceNow,
    getStats: () => ({ ...stats, queued: queue.length }),
    close,
  }
}
