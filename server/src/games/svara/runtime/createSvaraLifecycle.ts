import { randomUUID } from 'node:crypto'
import { svaraEpochNow, type SvaraDeadline, type SvaraDeadlineKind } from './svaraDeadlines.js'
export { SVARA_TURN_MS, SVARA_JOIN_MS, SVARA_PRESENCE_WAIT_MS, SVARA_DEAL_ENTRY_ANIMATION_MS, SVARA_DEAL_CARD_ANIMATION_MS,
  SVARA_DEAL_CARDS_PER_PLAYER, svaraDealingAnimationMs, type SvaraDeadline, type SvaraDeadlineKind } from './svaraDeadlines.js'
import type { SvaraPublicTable } from '../protocol/svaraSnapshotProtocol.js'
import type { SvaraMatchRuntime, SvaraSystemCommand } from './svaraMatchRuntime.js'
import { safeInvokeTimingHook, type MainThreadTimingHook } from '../../../monitoring/mainThreadTimingMetrics.js'

export interface SvaraClock {
  /** Monotonic epoch milliseconds, also suitable for client deadline display. */
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
  defer(callback: () => void): () => void
}

type Entry = SvaraDeadline & { cancel: () => void }

function realClock(): SvaraClock {
  return createSvaraRealClock()
}

// Реалният часовник; по избор с Phase 0B timing hook за sync callback-ите на
// таймерите ('svaraDeadline' за schedule, 'svaraContinuation' за defer).
// Без hook поведението е идентично с досегашния realClock().
export function createSvaraRealClock(onTiming?: MainThreadTimingHook): SvaraClock {
  const timed = (label: string, callback: () => void): (() => void) => {
    if (!onTiming) return callback
    return () => {
      const startedAt = performance.now()
      try {
        callback()
      } finally {
        safeInvokeTimingHook(onTiming, label, performance.now() - startedAt)
      }
    }
  }
  return {
    now: svaraEpochNow,
    schedule(callback, delay) {
      const handle = setTimeout(timed('svaraDeadline', callback), delay)
      handle.unref()
      return () => clearTimeout(handle)
    },
    defer(callback) {
      const handle = setImmediate(timed('svaraContinuation', callback))
      handle.unref()
      return () => clearImmediate(handle)
    },
  }
}

/** The single server owner of deadlines and deterministic progression.
 * All mutations go through the existing runtime/engine, synchronously.
 * At the deadline, expiry wins: sync() runs before a newly received command,
 * independent of whether Node has dispatched its timer callback yet. */
export function createSvaraLifecycle(runtime: SvaraMatchRuntime, deps: {
  clock?: SvaraClock
  onChange: (matchId: string, before: SvaraPublicTable) => void
  onError?: (cause: unknown) => void
}) {
  const clock = deps.clock ?? realClock()
  const namespace = randomUUID()
  const schedules = new Map<string, Map<SvaraDeadlineKind, Entry>>()
  const continuations = new Map<string, () => void>()
  const running = new Set<string>()
  let stopped = false

  function clear(matchId: string) {
    for (const entry of schedules.get(matchId)?.values() ?? []) entry.cancel()
    schedules.delete(matchId)
  }

  function refresh(matchId: string): void {
    if (stopped || !runtime.hasMatch(matchId)) { clear(matchId); return }
    if (runtime.isMatchFinished(matchId)) {
      clear(matchId)
      continuations.get(matchId)?.()
      continuations.delete(matchId)
      return
    }
    const wanted = new Map(runtime.getDeadlinesForServer(matchId).map((deadline) => [deadline.kind, deadline]))
    const entries = schedules.get(matchId) ?? new Map<SvaraDeadlineKind, Entry>()
    for (const [kind, entry] of entries) {
      if (wanted.get(kind)?.generation !== entry.generation) { entry.cancel(); entries.delete(kind) }
    }
    for (const [kind, target] of wanted) {
      if (entries.has(kind)) continue // look, retry, reconnect and other viewers never reset a deadline
      const entry: Entry = { ...target, cancel: () => {} }
      entries.set(kind, entry)
      const fire = () => {
        if (stopped || schedules.get(matchId)?.get(kind) !== entry) return
        if (clock.now() < entry.deadlineAt) { entry.cancel = clock.schedule(fire, entry.deadlineAt - clock.now()); return }
        try { sync(matchId) } catch (cause) { deps.onError?.(cause) }
      }
      entry.cancel = clock.schedule(fire, Math.max(0, entry.deadlineAt - clock.now()))
    }
    if (entries.size) schedules.set(matchId, entries)
    else schedules.delete(matchId)
  }

  function due(matchId: string): Entry | undefined {
    return [...schedules.get(matchId)?.values() ?? []].filter((entry) => clock.now() >= entry.deadlineAt)
      .sort((a, b) => a.deadlineAt - b.deadlineAt || a.generation - b.generation)[0]
  }

  function system(matchId: string, command: SvaraSystemCommand, commandId: string): void {
    const before = runtime.getPublicTable(matchId)
    runtime.executeSystemCommand(matchId, commandId, command)
    refresh(matchId)
    deps.onChange(matchId, before)
  }

  function sync(matchId: string): void {
    if (stopped || running.has(matchId) || !runtime.hasMatch(matchId)) return
    // An incoming packet may flush overdue work before a scheduled yield.
    continuations.get(matchId)?.()
    continuations.delete(matchId)
    running.add(matchId)
    try {
      for (let step = 0; step < 16; step++) {
        refresh(matchId) // semantic fence: discard callbacks from an old actor/phase/wait owner
        const expired = due(matchId)
        if (expired) {
          let command: SvaraSystemCommand
          if (expired.kind === 'turn') command = { type: 'turn-timeout', playerId: expired.playerId!, roundId: expired.roundId!, actionVersion: expired.actionVersion }
          else if (expired.kind === 'dealing') command = { type: 'finish-dealing', roundId: expired.roundId! }
          else if (expired.kind === 'svara-joining') command = { type: 'close-svara-joining', roundId: expired.roundId! }
          else if (expired.kind === 'reveal-choice') command = { type: 'expire-reveal-choice', roundId: expired.roundId! }
          else if (expired.kind === 'reveal-display') command = { type: 'close-reveal-display', roundId: expired.roundId! }
          else if (expired.kind === 'showdown-display') command = { type: 'advance-showdown-display', roundId: expired.roundId! }
          else if (expired.kind === 'payout-display') command = { type: 'close-payout-display', roundId: expired.roundId! }
          else command = { type: 'finish-presence-wait', winnerId: expired.playerId }
          // IDs have their own system namespace. Failed transitions retain the
          // expired record: a retry cannot silently grant another 15s/5min.
          system(matchId, command, `${namespace}:timer:${expired.generation}`)
          continue
        }
        const command = runtime.getAutomaticCommand(matchId)
        if (!command) return
        system(matchId, command, `${namespace}:progress:${runtime.getMatchRevision(matchId)}`)
      }
      refresh(matchId)
      if (due(matchId) || runtime.getAutomaticCommand(matchId)) {
        continuations.set(matchId, clock.defer(() => {
          continuations.delete(matchId)
          try { sync(matchId) } catch (cause) { deps.onError?.(cause) }
        }))
      }
    } finally { running.delete(matchId) }
  }

  return {
    sync, refresh,
    timing(matchId: string) {
      const serverNow = clock.now()
      return { type: 'svara_match_timing' as const, matchId, revision: runtime.getMatchRevision(matchId), serverNow,
        deadlines: [...schedules.get(matchId)?.values() ?? []].map((entry) => ({ kind: entry.kind,
          deadlineAt: entry.deadlineAt, remainingMs: Math.max(0, entry.deadlineAt - serverNow), playerId: entry.playerId })) }
    },
    exportDeadlines(matchId: string): SvaraDeadline[] {
      return [...schedules.get(matchId)?.values() ?? []].map(({ cancel: _cancel, ...data }) => ({ ...data }))
    },
    shutdown() {
      stopped = true
      for (const matchId of schedules.keys()) clear(matchId)
      for (const cancel of continuations.values()) cancel()
      continuations.clear()
    },
  }
}
