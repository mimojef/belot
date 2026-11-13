// Гласов чат — ограничен изпълнител на LiveKit API операциите (Етап 2б).
//
// Гаранции към останалата част от Pika.bg:
//   * най-много maxConcurrent (4) едновременни заявки към гласовия сървър;
//   * две ОГРАНИЧЕНИ опашки: 'high' (отнемане на права, DeleteRoom, ListRooms
//     за reconciliation) винаги се обслужва преди 'normal' (CreateRoom,
//     UpdateParticipant за повишаване);
//   * препълнена опашка -> незабавен отказ 'queue_full' (без натрупване на
//     памет и без забавяне на игровия event loop);
//   * circuit breaker: breakerFailureThreshold поредни временни грешки ->
//     'open' за breakerOpenMs, през което ВСЯКА заявка се отказва веднага
//     ('breaker_open', без мрежа); после 'half_open' с една пробна заявка;
//   * повторни опити САМО за идемпотентни операции и САМО при временни грешки,
//     с експоненциален backoff + jitter; backoff-ът НЕ държи слот;
//   * нищо тук не се await-ва от игрови WebSocket handler-и.
//
// Загуба на DeleteRoom е невъзможна по конструкция: източникът на истината
// за DeleteRoom е durable опашката в базата (voice_room_generations,
// status='delete_pending') — отказ тук само отлага следващия опит
// (voiceRoomReconciler.ts), никога не губи задачата.

import { VoiceLiveKitError, classifyLiveKitError, type VoiceLiveKitErrorKind } from './voiceLiveKitApi.js'

export type VoiceDispatchPriority = 'high' | 'normal'

export type VoiceDispatchFailureCode = 'breaker_open' | 'queue_full' | 'disposed' | VoiceLiveKitErrorKind

export type VoiceDispatchResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; code: VoiceDispatchFailureCode; attempts: number; error: VoiceLiveKitError | null }

export type VoiceDispatchOperation<T> = {
  /** Само за логове/метрики (без лични данни). */
  name: string
  priority: VoiceDispatchPriority
  /** true -> позволени повторни опити при временна грешка. */
  idempotent: boolean
  run: () => Promise<T>
}

export type VoiceBreakerState = 'closed' | 'open' | 'half_open'

export type VoiceDispatcherScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type VoiceDispatcherStats = {
  breaker: VoiceBreakerState
  consecutiveFailures: number
  inFlight: number
  queuedHigh: number
  queuedNormal: number
  /** Натрупващи се броячи от старта на процеса. */
  succeeded: number
  failed: number
  rejectedBreakerOpen: number
  rejectedQueueFull: number
  breakerOpenedCount: number
}

export type VoiceLiveKitDispatcher = {
  run: <T>(operation: VoiceDispatchOperation<T>) => Promise<VoiceDispatchResult<T>>
  /** false -> breaker е 'open' (новите заявки ще бъдат отказани веднага). */
  isAvailable: () => boolean
  /** Колко ms остават до пробната заявка (0 ако breaker не е отворен). */
  retryAfterMs: () => number
  stats: () => VoiceDispatcherStats
  dispose: () => void
}

export type VoiceDispatcherOptions = {
  maxConcurrent?: number
  maxHighQueue?: number
  maxNormalQueue?: number
  breakerFailureThreshold?: number
  breakerOpenMs?: number
  /** Общ брой опити за идемпотентна операция (1 = без повторение). */
  maxAttempts?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  /**
   * Твърд таймаут върху цялата операция (над requestTimeout на SDK-то) —
   * защита, ако SDK-то по някаква причина не прекъсне заявката.
   */
  hardTimeoutMs?: number
  now?: () => number
  random?: () => number
  scheduler?: VoiceDispatcherScheduler
  log?: (line: string) => void
}

const defaultScheduler: VoiceDispatcherScheduler = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

type QueuedTask = {
  start: () => void
  reject: (code: 'disposed') => void
}

export function createVoiceLiveKitDispatcher(options: VoiceDispatcherOptions = {}): VoiceLiveKitDispatcher {
  const maxConcurrent = options.maxConcurrent ?? 4
  const maxHighQueue = options.maxHighQueue ?? 200
  const maxNormalQueue = options.maxNormalQueue ?? 50
  const threshold = options.breakerFailureThreshold ?? 5
  const breakerOpenMs = options.breakerOpenMs ?? 30_000
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 250
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 2_000
  const hardTimeoutMs = options.hardTimeoutMs ?? 4_000
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const scheduler = options.scheduler ?? defaultScheduler
  const log = options.log ?? (() => {})

  const highQueue: QueuedTask[] = []
  const normalQueue: QueuedTask[] = []
  const pendingTimers = new Set<unknown>()
  let inFlight = 0
  let disposed = false
  let breaker: VoiceBreakerState = 'closed'
  let openedAt = 0
  let halfOpenProbeInFlight = false
  let consecutiveFailures = 0
  const counters = { succeeded: 0, failed: 0, rejectedBreakerOpen: 0, rejectedQueueFull: 0, breakerOpenedCount: 0 }

  function refreshBreaker(): void {
    if (breaker === 'open' && now() - openedAt >= breakerOpenMs) {
      breaker = 'half_open'
      halfOpenProbeInFlight = false
    }
  }

  /** null -> може да тръгне; иначе код за незабавен отказ. */
  function admissionError(): 'breaker_open' | null {
    refreshBreaker()
    if (breaker === 'open') return 'breaker_open'
    if (breaker === 'half_open' && halfOpenProbeInFlight) return 'breaker_open'
    return null
  }

  function recordSuccess(): void {
    consecutiveFailures = 0
    if (breaker !== 'closed') log('[voice-livekit] circuit breaker closed')
    breaker = 'closed'
    halfOpenProbeInFlight = false
  }

  function recordTransientFailure(): void {
    consecutiveFailures += 1
    if (breaker === 'half_open' || (breaker === 'closed' && consecutiveFailures >= threshold)) {
      breaker = 'open'
      openedAt = now()
      halfOpenProbeInFlight = false
      counters.breakerOpenedCount += 1
      log(`[voice-livekit] circuit breaker open for ${breakerOpenMs}ms after ${consecutiveFailures} consecutive failures`)
    }
  }

  function pump(): void {
    while (!disposed && inFlight < maxConcurrent) {
      const next = highQueue.shift() ?? normalQueue.shift()
      if (next === undefined) return
      next.start()
    }
  }

  function withHardTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false
      const handle = scheduler.setTimeout(() => {
        if (settled) return
        settled = true
        pendingTimers.delete(handle)
        rejectPromise(new VoiceLiveKitError('transient', null, 'timeout'))
      }, hardTimeoutMs)
      pendingTimers.add(handle)
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          scheduler.clearTimeout(handle)
          pendingTimers.delete(handle)
          resolvePromise(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          scheduler.clearTimeout(handle)
          pendingTimers.delete(handle)
          rejectPromise(error)
        },
      )
    })
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const handle = scheduler.setTimeout(() => {
        pendingTimers.delete(handle)
        resolvePromise()
      }, ms)
      pendingTimers.add(handle)
    })
  }

  /** Един опит: чака слот в опашката, изпълнява, освобождава слота. */
  function attemptOnce<T>(operation: VoiceDispatchOperation<T>): Promise<VoiceDispatchResult<T>> {
    const rejection = admissionError()
    if (rejection !== null) {
      counters.rejectedBreakerOpen += 1
      return Promise.resolve({ ok: false, code: rejection, attempts: 0, error: null })
    }
    const queue = operation.priority === 'high' ? highQueue : normalQueue
    const limit = operation.priority === 'high' ? maxHighQueue : maxNormalQueue
    if (inFlight >= maxConcurrent && queue.length >= limit) {
      counters.rejectedQueueFull += 1
      return Promise.resolve({ ok: false, code: 'queue_full', attempts: 0, error: null })
    }

    return new Promise<VoiceDispatchResult<T>>((resolvePromise) => {
      const task: QueuedTask = {
        reject: (code) => resolvePromise({ ok: false, code, attempts: 0, error: null }),
        start: () => {
          // Състоянието на breaker-а може да се е сменило, докато задачата е чакала.
          const lateRejection = admissionError()
          if (lateRejection !== null) {
            counters.rejectedBreakerOpen += 1
            resolvePromise({ ok: false, code: lateRejection, attempts: 0, error: null })
            return
          }
          if (breaker === 'half_open') halfOpenProbeInFlight = true
          inFlight += 1
          let runPromise: Promise<T>
          try {
            runPromise = operation.run()
          } catch (error) {
            runPromise = Promise.reject(error)
          }
          withHardTimeout(runPromise).then(
            (value) => {
              inFlight -= 1
              recordSuccess()
              resolvePromise({ ok: true, value, attempts: 1 })
              pump()
            },
            (error: unknown) => {
              inFlight -= 1
              const classified = classifyLiveKitError(error)
              // not_found/rejected означават, че сървърът е отговорил — не е
              // проблем с наличността (не отваря breaker-а).
              if (classified.kind === 'transient') recordTransientFailure()
              else recordSuccess()
              resolvePromise({ ok: false, code: classified.kind, attempts: 1, error: classified })
              pump()
            },
          )
        },
      }
      if (inFlight < maxConcurrent && queue.length === 0 && (operation.priority === 'high' || highQueue.length === 0)) {
        task.start()
      } else {
        queue.push(task)
        pump()
      }
    })
  }

  async function run<T>(operation: VoiceDispatchOperation<T>): Promise<VoiceDispatchResult<T>> {
    if (disposed) return { ok: false, code: 'disposed', attempts: 0, error: null }
    let attempts = 0
    for (;;) {
      const result = await attemptOnce(operation)
      attempts += result.attempts
      if (result.ok) {
        counters.succeeded += 1
        return { ...result, attempts }
      }
      const retryable =
        operation.idempotent &&
        result.code === 'transient' &&
        attempts < maxAttempts &&
        !disposed &&
        admissionError() === null
      if (!retryable) {
        if (result.code === 'transient' || result.code === 'rejected') {
          counters.failed += 1
          log(`[voice-livekit] ${operation.name} failed (${result.code}) after ${attempts} attempt(s)`)
        }
        return { ...result, attempts }
      }
      const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** (attempts - 1))
      // "Full jitter" в горната половина — предпазва от синхронизирани retry вълни.
      await delay(Math.round(exponential / 2 + random() * (exponential / 2)))
    }
  }

  function retryAfterMs(): number {
    refreshBreaker()
    return breaker === 'open' ? Math.max(0, breakerOpenMs - (now() - openedAt)) : 0
  }

  function dispose(): void {
    disposed = true
    for (const handle of pendingTimers) scheduler.clearTimeout(handle)
    pendingTimers.clear()
    for (const task of highQueue.splice(0)) task.reject('disposed')
    for (const task of normalQueue.splice(0)) task.reject('disposed')
  }

  return {
    run,
    isAvailable: () => admissionError() === null,
    retryAfterMs,
    stats: () => {
      refreshBreaker()
      return {
        breaker,
        consecutiveFailures,
        inFlight,
        queuedHigh: highQueue.length,
        queuedNormal: normalQueue.length,
        ...counters,
      }
    },
    dispose,
  }
}
