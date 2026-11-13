// Гласов чат — durable DeleteRoom опашка и reconciliation (Етап 2б).
//
// Източникът на истината е базата: voice_room_generations със
// status='delete_pending' (никога не се губи при препълнена опашка, отворен
// circuit breaker или рестарт). Тук само се изпълнява:
//
//   1. DeleteRoom (висок приоритет) за всяко чакащо име, чийто срок е дошъл;
//      not_found = целта е постигната.
//   2. Потвърждение с ListRooms(names): 'deleted' се записва САМО ако
//      стаята реално липсва в LiveKit. Иначе — нов опит с експоненциален
//      backoff (+ jitter), записан в базата (рядко писане).
//   3. Забавен/timeout-нат CreateRoom: timeout НЕ доказва, че стаята не е
//      създадена — заявката може да стигне до LiveKit по-късно и да
//      "възкреси" вече изтрито име. Затова:
//        * DeleteRoom за име с CreateRoom в полет изчаква (сериализация по
//          име);
//        * име с неясен CreateRoom влиза в "наблюдение" за uncertainHorizonMs
//          (по-дълго от валидността на токените); докато има наблюдавани
//          имена, на sweepIntervalMs се прави ListRooms() и ВСЯКА pv_ стая,
//          която не е текущата жива генерация на активна маса, се трие.
//   4. При старт: еднократен sweep — трие всички pv_ стаи, които не са живи
//      (сираци от предишния процес, вкл. имена, непознати за базата).
//
// Без периодични сканирания, когато няма работа: таймер има само докато
// има чакащи DeleteRoom, наблюдавани имена или неизпълнен boot sweep.

import type { VoiceChatStore } from './voiceChatStore.js'
import { describeLiveKitError, type VoiceLiveKitApi } from './voiceLiveKitApi.js'
import type { VoiceLiveKitDispatcher } from './voiceLiveKitDispatcher.js'
import { VOICE_ROOM_DEFAULT_NAMESPACE, parseVoiceRoomName } from './voiceRoomNaming.js'

export type VoiceReconcilerScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultScheduler: VoiceReconcilerScheduler = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type VoiceRoomReconciler = {
  /** Нова работа (оттеглена генерация) — изпълни възможно най-скоро. */
  kick: () => void
  /**
   * Имената са оттеглени. Ако за някое има неясен CreateRoom, наблюдението
   * започва (или се удължава) ОТ МОМЕНТА НА ОТТЕГЛЯНЕТО.
   */
  noteRetired: (roomNames: readonly string[]) => void
  /** CreateRoom за името е в полет — DeleteRoom за него изчаква. */
  trackCreate: (roomName: string, promise: Promise<unknown>) => void
  /** CreateRoom е завършил с timeout/неясен изход — наблюдение за възкресяване. */
  noteUncertainCreate: (roomName: string) => void
  requestBootSweep: () => void
  /** Едно пълно преминаване (за тестове и за kick). Не се припокрива със себе си. */
  runNow: () => Promise<void>
  stats: () => { uncertainWatches: number; uncertainLiveNames: number; bootSweepPending: boolean; createsInFlight: number }
  dispose: () => void
}

export type VoiceRoomReconcilerOptions = {
  store: Pick<
    VoiceChatStore,
    'listDueRoomDeletions' | 'recordRoomDeletionAttempt' | 'nextRoomDeletionDueAt' | 'isLiveRoomName' | 'getGeneration' | 'hasPendingRoomDeletion'
  >
  /** null -> LiveKit не е конфигуриран: нищо не се изпълнява (задачите остават в базата). */
  api: VoiceLiveKitApi | null
  dispatcher: VoiceLiveKitDispatcher
  /** Всички DeleteRoom на масата са потвърдени — новата генерация е безопасна. */
  onTableDeletionsSettled?: (voiceTableId: string) => void
  /**
   * Namespace на тази среда: sweep-ът трие САМО стаи pv_<namespace>_...;
   * стаи на друг namespace (друга среда на същия LiveKit) никога не се пипат.
   */
  roomNamespace?: string
  batchSize?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  uncertainHorizonMs?: number
  sweepIntervalMs?: number
  /** Изчакване, когато име има CreateRoom в полет. */
  createInFlightRetryMs?: number
  now?: () => number
  random?: () => number
  scheduler?: VoiceReconcilerScheduler
  log?: (line: string) => void
}

export function createVoiceRoomReconciler(options: VoiceRoomReconcilerOptions): VoiceRoomReconciler {
  const { store, api, dispatcher } = options
  const batchSize = options.batchSize ?? 10
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 2_000
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 5 * 60_000
  const uncertainHorizonMs = options.uncertainHorizonMs ?? 20 * 60_000
  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000
  const createInFlightRetryMs = options.createInFlightRetryMs ?? 500
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const scheduler = options.scheduler ?? defaultScheduler
  const log = options.log ?? (() => {})

  const roomNamespace = options.roomNamespace ?? VOICE_ROOM_DEFAULT_NAMESPACE
  const createsInFlight = new Map<string, Promise<unknown>>()
  /**
   * roomName -> до кога да се наблюдава (epoch ms) или null, докато името
   * още е живо (наблюдението започва при оттеглянето). Ограничено — неясните
   * CreateRoom са редки; при препълване се изхвърлят най-старите живи.
   */
  const uncertainWatches = new Map<string, number | null>()
  const MAX_UNCERTAIN_ENTRIES = 10_000
  let bootSweepPending = false
  let lastSweepAt = 0
  let timer: unknown = null
  let timerDueAt = Number.POSITIVE_INFINITY
  let running: Promise<void> | null = null
  let rerunRequested = false
  let disposed = false

  function schedule(delayMs: number): void {
    if (disposed || api === null) return
    const dueAt = now() + Math.max(0, delayMs)
    if (timer !== null && timerDueAt <= dueAt) return
    if (timer !== null) scheduler.clearTimeout(timer)
    timerDueAt = dueAt
    timer = scheduler.setTimeout(() => {
      timer = null
      timerDueAt = Number.POSITIVE_INFINITY
      void runNow()
    }, Math.max(0, delayMs))
  }

  function nextDelayMs(): number | null {
    let next: number | null = null
    const consider = (delay: number): void => {
      next = next === null ? delay : Math.min(next, delay)
    }
    const due = store.nextRoomDeletionDueAt()
    if (due !== null) consider(Math.max(0, Date.parse(due) - now()))
    if (bootSweepPending || hasActiveWatch()) consider(Math.max(0, lastSweepAt + sweepIntervalMs - now()))
    if (createsInFlight.size > 0 && due !== null) consider(createInFlightRetryMs)
    return next
  }

  function hasActiveWatch(): boolean {
    for (const until of uncertainWatches.values()) if (until !== null) return true
    return false
  }

  function backoffMs(attempts: number): number {
    const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** Math.min(attempts, 16))
    return Math.round(exponential / 2 + random() * (exponential / 2))
  }

  async function deleteRoomDirect(name: string): Promise<boolean> {
    if (api === null) return false
    const result = await dispatcher.run({
      name: 'DeleteRoom(sweep)',
      priority: 'high',
      idempotent: true,
      run: () => api.deleteRoom(name),
    })
    return result.ok || result.code === 'not_found'
  }

  /** ListRooms() и триене на всяка pv_ стая, която не е текущата жива. */
  async function sweep(): Promise<void> {
    if (api === null) return
    const listed = await dispatcher.run({ name: 'ListRooms(sweep)', priority: 'high', idempotent: true, run: () => api.listRooms() })
    lastSweepAt = now()
    if (!listed.ok) return
    bootSweepPending = false
    for (const room of listed.value) {
      // Само собствените стаи: точен формат И собственият namespace.
      const parsed = parseVoiceRoomName(room.name)
      if (parsed === null || parsed.namespace !== roomNamespace) continue
      if (store.isLiveRoomName(room.name)) continue
      // Чакащите в базата ще бъдат обработени от опашката по-долу (с
      // потвърждение); тук се трият само непознати или вече "deleted" имена,
      // които са се появили отново (възкресени от забавен CreateRoom).
      const record = store.getGeneration(room.name)
      if (record !== null && record.status === 'delete_pending') continue
      if (createsInFlight.has(room.name)) continue
      const deleted = await deleteRoomDirect(room.name)
      log(`[voice-reconcile] sweep ${record === null ? 'orphan' : 'resurrected'} room ${deleted ? 'deleted' : 'delete failed'}`)
    }
    const nowMs = now()
    for (const [name, until] of uncertainWatches) {
      if (until !== null && until <= nowMs) uncertainWatches.delete(name)
    }
  }

  async function processDueDeletions(): Promise<void> {
    if (api === null) return
    const due = store.listDueRoomDeletions({ now: new Date(now()), limit: batchSize })
    if (due.length === 0) return
    const deletedCandidates: typeof due = []
    for (const record of due) {
      if (createsInFlight.has(record.livekitRoomName)) continue // сериализация: първо да приключи CreateRoom
      const result = await dispatcher.run({
        name: 'DeleteRoom',
        priority: 'high',
        idempotent: true,
        run: () => api.deleteRoom(record.livekitRoomName),
      })
      if (result.ok || result.code === 'not_found') {
        deletedCandidates.push(record)
      } else {
        store.recordRoomDeletionAttempt(record.livekitRoomName, {
          outcome: 'failed',
          error: result.error === null ? result.code : describeLiveKitError(result.error),
          nextAttemptAt: new Date(now() + backoffMs(record.deleteAttempts)),
        }, new Date(now()))
      }
    }
    if (deletedCandidates.length === 0) return

    // Потвърждение: стаята наистина липсва в LiveKit.
    const names = deletedCandidates.map((record) => record.livekitRoomName)
    const listed = await dispatcher.run({ name: 'ListRooms(confirm)', priority: 'high', idempotent: true, run: () => api.listRooms(names) })
    const stillPresent = new Set(listed.ok ? listed.value.map((room) => room.name) : names)
    const settledTables = new Set<string>()
    for (const record of deletedCandidates) {
      if (!listed.ok || stillPresent.has(record.livekitRoomName)) {
        store.recordRoomDeletionAttempt(record.livekitRoomName, {
          outcome: 'failed',
          error: listed.ok ? 'still_present' : 'confirm_failed',
          nextAttemptAt: new Date(now() + backoffMs(record.deleteAttempts)),
        }, new Date(now()))
        continue
      }
      const recorded = store.recordRoomDeletionAttempt(record.livekitRoomName, { outcome: 'deleted' }, new Date(now()))
      if (recorded.ok) settledTables.add(record.voiceTableId)
    }
    for (const voiceTableId of settledTables) {
      if (!store.hasPendingRoomDeletion(voiceTableId)) options.onTableDeletionsSettled?.(voiceTableId)
    }
  }

  async function runOnce(): Promise<void> {
    if (api === null || disposed) return
    try {
      if ((bootSweepPending || hasActiveWatch()) && now() - lastSweepAt >= sweepIntervalMs) {
        await sweep()
      }
      await processDueDeletions()
    } catch (error) {
      // Никога не спира опашката; задачите остават в базата.
      log(`[voice-reconcile] run failed: ${describeLiveKitError(error)}`)
    }
  }

  function runNow(): Promise<void> {
    if (running !== null) {
      rerunRequested = true
      return running
    }
    running = (async () => {
      do {
        rerunRequested = false
        await runOnce()
      } while (rerunRequested && !disposed)
    })().finally(() => {
      running = null
      const delay = nextDelayMs()
      if (delay !== null) schedule(delay)
    })
    return running
  }

  return {
    kick: () => schedule(0),
    trackCreate: (roomName, promise) => {
      createsInFlight.set(roomName, promise)
      const clear = (): void => {
        if (createsInFlight.get(roomName) === promise) createsInFlight.delete(roomName)
      }
      promise.then(clear, clear)
    },
    noteUncertainCreate: (roomName) => {
      // Още живо име -> наблюдението започва при оттеглянето (noteRetired);
      // вече оттеглено -> веднага.
      if (store.isLiveRoomName(roomName)) {
        if (!uncertainWatches.has(roomName)) {
          if (uncertainWatches.size >= MAX_UNCERTAIN_ENTRIES) {
            for (const [name, until] of uncertainWatches) {
              if (until === null) {
                uncertainWatches.delete(name)
                break
              }
            }
          }
          uncertainWatches.set(roomName, null)
        }
        return
      }
      uncertainWatches.set(roomName, now() + uncertainHorizonMs)
      schedule(Math.max(0, lastSweepAt + sweepIntervalMs - now()))
    },
    noteRetired: (roomNames) => {
      let started = false
      for (const name of roomNames) {
        if (!uncertainWatches.has(name)) continue
        uncertainWatches.set(name, now() + uncertainHorizonMs)
        started = true
      }
      if (started) schedule(Math.max(0, lastSweepAt + sweepIntervalMs - now()))
    },
    requestBootSweep: () => {
      bootSweepPending = true
      lastSweepAt = 0
      schedule(0)
    },
    runNow,
    stats: () => {
      let active = 0
      for (const until of uncertainWatches.values()) if (until !== null) active += 1
      return { uncertainWatches: active, uncertainLiveNames: uncertainWatches.size - active, bootSweepPending, createsInFlight: createsInFlight.size }
    },
    dispose: () => {
      disposed = true
      if (timer !== null) scheduler.clearTimeout(timer)
      timer = null
    },
  }
}
