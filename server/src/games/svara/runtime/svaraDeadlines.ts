import { performance } from 'node:perf_hooks'
import { describeSvaraLifecycle, type SvaraMatchState } from '../engine/svaraMatch.js'

export const SVARA_TURN_MS = 15_000
export const SVARA_JOIN_MS = 15_000
export const SVARA_PRESENCE_WAIT_MS = 300_000
export const svaraEpochNow = () => Math.floor(performance.timeOrigin + performance.now())
export type SvaraDeadlineKind = 'turn' | 'svara-joining' | 'presence-wait'
export type SvaraDeadline = {
  kind: SvaraDeadlineKind
  key: string
  generation: number
  phase: 'in-progress'
  baseRevision: number
  deadlineAt: number
  playerId: string | null
  roundId: string | null
  actionVersion: number
}

/** Pure planning: no handles, callbacks or writes. Unchanged semantic keys keep their absolute deadline. */
export function planSvaraDeadlines(state: SvaraMatchState, revision: number,
  previous: readonly SvaraDeadline[], sequence: number, now: number) {
  const view = describeSvaraLifecycle(state)
  const deadlines: SvaraDeadline[] = []
  if (view.phase !== 'in-progress') return { deadlines, deadlineSequence: sequence }
  function want(kind: SvaraDeadlineKind, key: string, duration: number, playerId: string | null) {
    const existing = previous.find((entry) => entry.kind === kind && entry.key === key)
    deadlines.push(existing ?? { kind, key, generation: ++sequence, phase: 'in-progress', baseRevision: revision,
      deadlineAt: now + duration, playerId, roundId: view.roundId, actionVersion: view.actionVersion })
  }
  if (view.actorId && !view.actorAbsent) want('turn', JSON.stringify(['turn', view.roundId, view.actorId, view.actionVersion]), SVARA_TURN_MS, view.actorId)
  if (view.joining?.open && view.joining.undecided.length > 0) want('svara-joining', JSON.stringify(['join', view.roundId]), SVARA_JOIN_MS, null)
  if (view.atBoundary && view.readyPlayerIds.length < 2) want('presence-wait', JSON.stringify(['wait', view.readyPlayerIds]), SVARA_PRESENCE_WAIT_MS, view.readyPlayerIds[0] ?? null)
  return { deadlines, deadlineSequence: sequence }
}
