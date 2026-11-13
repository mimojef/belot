// Гласов чат — гарантирано освобождаване на слот (Етап 2а).
//
// releaseVoiceTable() може да върне 'busy' (базата е заключена от друг
// процес — виж VOICE_CHAT_STORE_BUSY_TIMEOUT_MS). Слотът НЕ бива да остане
// зает: заявката се пази в паметта и се повтаря с ограничен backoff, докато
// успее. Опашката е естествено ограничена — по един запис на гласова маса
// (dedupe по voiceTableId), а активните маси са най-много лимитът. Записът
// НИКОГА не се изпуска; при рестарт voiceChatStore.reconcileOnBoot()
// освобождава всичко, което не е оцеляло, така че паметта не е единствената
// гаранция.

import type { VoiceChatStore } from './voiceChatStore.js'
import type { VoiceTableId, VoiceTableReleaseReason } from './voiceChatTypes.js'

export type VoiceReleaseScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultScheduler: VoiceReleaseScheduler = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    // Не държи процеса жив само заради повторен опит.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type VoiceTableReleaseOutcome =
  | { status: 'released'; retiredRoomNames: string[] }
  | { status: 'already_released' }
  | { status: 'queued' }

export type VoiceTableReleaseQueue = {
  release: (voiceTableId: VoiceTableId, reason: VoiceTableReleaseReason) => VoiceTableReleaseOutcome
  pendingCount: () => number
  isPending: (voiceTableId: VoiceTableId) => boolean
  dispose: () => void
}

export function createVoiceTableReleaseQueue(options: {
  store: Pick<VoiceChatStore, 'releaseVoiceTable'>
  scheduler?: VoiceReleaseScheduler
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => Date
  onReleased?: (voiceTableId: VoiceTableId, retiredRoomNames: string[]) => void
  log?: (line: string) => void
}): VoiceTableReleaseQueue {
  const scheduler = options.scheduler ?? defaultScheduler
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const now = options.now ?? (() => new Date())
  const pending = new Map<VoiceTableId, { reason: VoiceTableReleaseReason; attempts: number; handle: unknown }>()
  let disposed = false

  function attempt(voiceTableId: VoiceTableId, reason: VoiceTableReleaseReason): VoiceTableReleaseOutcome | null {
    const result = options.store.releaseVoiceTable(voiceTableId, reason, now())
    if (!result.ok) return null
    if (!result.released) return { status: 'already_released' }
    options.onReleased?.(voiceTableId, result.retiredRoomNames)
    return { status: 'released', retiredRoomNames: result.retiredRoomNames }
  }

  function scheduleRetry(voiceTableId: VoiceTableId): void {
    const entry = pending.get(voiceTableId)
    if (entry === undefined || disposed) return
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(entry.attempts, 16))
    entry.handle = scheduler.setTimeout(() => {
      const current = pending.get(voiceTableId)
      if (current === undefined || disposed) return
      current.attempts += 1
      const outcome = attempt(voiceTableId, current.reason)
      if (outcome === null) {
        scheduleRetry(voiceTableId)
        return
      }
      pending.delete(voiceTableId)
    }, delay)
  }

  function release(voiceTableId: VoiceTableId, reason: VoiceTableReleaseReason): VoiceTableReleaseOutcome {
    if (pending.has(voiceTableId)) return { status: 'queued' }
    const outcome = attempt(voiceTableId, reason)
    if (outcome !== null) return outcome
    options.log?.(`[voice-chat] release busy, queued voiceTable=${voiceTableId} reason=${reason}`)
    pending.set(voiceTableId, { reason, attempts: 1, handle: null })
    scheduleRetry(voiceTableId)
    return { status: 'queued' }
  }

  function dispose(): void {
    disposed = true
    for (const entry of pending.values()) {
      if (entry.handle !== null) scheduler.clearTimeout(entry.handle)
    }
    pending.clear()
  }

  return {
    release,
    pendingCount: () => pending.size,
    isPending: (voiceTableId) => pending.has(voiceTableId),
    dispose,
  }
}
