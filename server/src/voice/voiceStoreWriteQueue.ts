// Гласов чат — повторение на lifecycle записи при заета база (Етап 2б).
//
// voiceChatStore е с кратък busy_timeout (200 ms) и при заключена база връща
// 'busy' вместо да блокира event loop-а. Lifecycle записите (начало/край на
// участие, придобито право, старт на игра, ротация) НЕ бива да се губят —
// тук се повтарят с ограничен експоненциален backoff.
//
//   * FIFO за всеки ключ: операциите за едно и също участие/маса се
//     изпълняват в реда, в който са поискани (напр. край на старото участие
//     преди началото на новото); следваща операция за ключа не тръгва, докато
//     предишната не успее;
//   * опашката е естествено ограничена (най-много няколко записа на гласова
//     маса, а масите са ограничени от лимита); при препълване над
//     maxPending се логва, но записът НЕ се изпуска;
//   * паметта е авторитетна в процеса; при рестарт voiceChatStore.reconcileOnBoot
//     приключва всичко, което не е оцеляло.

export type VoiceWriteOutcome = 'done' | 'busy'

export type VoiceStoreWriteScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultScheduler: VoiceStoreWriteScheduler = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type VoiceStoreWriteQueue = {
  /** Изпълнява веднага, ако ключът няма чакащи; иначе подрежда след тях. */
  enqueue: (key: string, label: string, operation: () => VoiceWriteOutcome) => void
  pendingCount: () => number
  dispose: () => void
}

type Entry = { label: string; operation: () => VoiceWriteOutcome }

export function createVoiceStoreWriteQueue(options: {
  scheduler?: VoiceStoreWriteScheduler
  baseDelayMs?: number
  maxDelayMs?: number
  maxPendingWarn?: number
  log?: (line: string) => void
} = {}): VoiceStoreWriteQueue {
  const scheduler = options.scheduler ?? defaultScheduler
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const maxPendingWarn = options.maxPendingWarn ?? 500
  const log = options.log ?? (() => {})
  const queues = new Map<string, { entries: Entry[]; attempts: number; handle: unknown }>()
  let disposed = false

  function total(): number {
    let count = 0
    for (const queue of queues.values()) count += queue.entries.length
    return count
  }

  function drain(key: string): void {
    const queue = queues.get(key)
    if (queue === undefined || disposed) return
    while (queue.entries.length > 0) {
      const head = queue.entries[0]!
      let outcome: VoiceWriteOutcome
      try {
        outcome = head.operation()
      } catch (error) {
        // Неочаквана грешка (не busy) — записът се пропуска, за да не блокира ключа завинаги.
        log(`[voice-chat] store write "${head.label}" failed: ${error instanceof Error ? error.message : String(error)}`)
        outcome = 'done'
      }
      if (outcome === 'busy') {
        queue.attempts += 1
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(queue.attempts - 1, 16))
        queue.handle = scheduler.setTimeout(() => {
          queue.handle = null
          drain(key)
        }, delay)
        return
      }
      queue.entries.shift()
      queue.attempts = 0
    }
    queues.delete(key)
  }

  return {
    enqueue(key, label, operation) {
      if (disposed) return
      const existing = queues.get(key)
      if (existing !== undefined) {
        existing.entries.push({ label, operation })
        const pending = total()
        if (pending > maxPendingWarn) log(`[voice-chat] store write queue is large (${pending})`)
        return
      }
      queues.set(key, { entries: [{ label, operation }], attempts: 0, handle: null })
      drain(key)
    },
    pendingCount: total,
    dispose() {
      disposed = true
      for (const queue of queues.values()) {
        if (queue.handle !== null) scheduler.clearTimeout(queue.handle)
      }
      queues.clear()
    },
  }
}
