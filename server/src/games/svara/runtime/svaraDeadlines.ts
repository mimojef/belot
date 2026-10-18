import { performance } from 'node:perf_hooks'
import { describeSvaraLifecycle, type SvaraMatchState } from '../engine/svaraMatch.js'

export const SVARA_TURN_MS = 15_000
export const SVARA_JOIN_MS = 15_000
export const SVARA_PRESENCE_WAIT_MS = 300_000
/** 2Б.3.7.1: прозорец за избор „Покажи“/„Скрий“ след отпадането на всички противници. */
export const SVARA_REVEAL_CHOICE_MS = 5_000
/** 2Б.3.7.1: публичен показ на картите, само след „Покажи“. */
export const SVARA_REVEAL_DISPLAY_MS = 3_000
/** 2Б.3.7.6А: публично сравняване при истинско приключило showdown (2+ оставащи) — §6 на заданието. */
export const SVARA_SHOWDOWN_DISPLAY_MS = 3_000
/**
 * 2Б.3.7.6А: продължителност на ЕДНА последователна стъпка на изплащане
 * (основна банка, после всяка странична поотделно, §7) — временна, лесно
 * променима стойност преди 2Б.3.7.6Б's реална анимация с летящи чипове.
 * Общата продължителност на прозореца = (брой стъпки) × тази константа.
 */
export const SVARA_PAYOUT_STEP_MS = 1_200
/**
 * 2Б.3.7.4Б: сървърно определена продължителност на представянето на
 * раздаването (Вход + карти), преди първият ход да стане активен. Временни,
 * леснo променими преди 2Б.3.7.5 стойности (НЕ окончателно художествено
 * решение) — виж заданието §4: 800ms за анимацията на задължителния Вход
 * (отделен именуван параметър) + 350ms на карта × 3 карти на участник.
 */
export const SVARA_DEAL_ENTRY_ANIMATION_MS = 800
export const SVARA_DEAL_CARD_ANIMATION_MS = 350
export const SVARA_DEAL_CARDS_PER_PLAYER = 3
/** 2/3/4 участници -> 2900/3950/5000ms при текущите временни константи. */
export function svaraDealingAnimationMs(participantCount: number): number {
  return SVARA_DEAL_ENTRY_ANIMATION_MS + participantCount * SVARA_DEAL_CARDS_PER_PLAYER * SVARA_DEAL_CARD_ANIMATION_MS
}
export const svaraEpochNow = () => Math.floor(performance.timeOrigin + performance.now())
export type SvaraDeadlineKind = 'dealing' | 'turn' | 'svara-joining' | 'presence-wait' | 'reveal-choice' | 'reveal-display' | 'showdown-display' | 'payout-display'
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
  if (view.dealingParticipantCount !== null) want('dealing', JSON.stringify(['dealing', view.roundId]), svaraDealingAnimationMs(view.dealingParticipantCount), null)
  if (view.actorId && !view.actorAbsent) want('turn', JSON.stringify(['turn', view.roundId, view.actorId, view.actionVersion]), SVARA_TURN_MS, view.actorId)
  if (view.joining?.open && view.joining.undecided.length > 0) want('svara-joining', JSON.stringify(['join', view.roundId]), SVARA_JOIN_MS, null)
  if (view.revealChoice?.decision === 'pending') want('reveal-choice', JSON.stringify(['reveal-choice', view.roundId]), SVARA_REVEAL_CHOICE_MS, view.revealChoice.winnerId)
  if (view.revealChoice?.decision === 'revealed') want('reveal-display', JSON.stringify(['reveal-display', view.roundId]), SVARA_REVEAL_DISPLAY_MS, view.revealChoice.winnerId)
  if (view.showdownDisplay?.phase === 'showdown') want('showdown-display', JSON.stringify(['showdown-display', view.roundId]), SVARA_SHOWDOWN_DISPLAY_MS, null)
  if (view.showdownDisplay?.phase === 'payout') want('payout-display', JSON.stringify(['payout-display', view.roundId]), Math.max(1, view.showdownDisplay.payoutStepCount) * SVARA_PAYOUT_STEP_MS, null)
  if (view.atBoundary && view.readyPlayerIds.length < 2) want('presence-wait', JSON.stringify(['wait', view.readyPlayerIds]), SVARA_PRESENCE_WAIT_MS, view.readyPlayerIds[0] ?? null)
  return { deadlines, deadlineSequence: sequence }
}
