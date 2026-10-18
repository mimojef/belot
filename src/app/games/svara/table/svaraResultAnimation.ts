import type {
  SvaraMatchSnapshotMessage, SvaraMatchTimingMessage, SvaraSnapshotPayoutStep,
} from '../../../network/createGameServerClient'

// Mirrors the existing server presentation windows; never starts a local clock.
export const SVARA_SHOWDOWN_MS = 3_000
export const SVARA_PAYOUT_STEP_MS = 1_200
export const SVARA_SHOWDOWN_FLIP_MS = 420
// Reserved for the owner's special sound. No substitute asset or playback.
export const SVARA_TIE_SOUND_SRC: string | null = null

export type SvaraResultVisualState = {
  roundKey: string | null
  showCards: boolean
  flipProgress: number
  tie: boolean
  payout: {
    key: string
    step: SvaraSnapshotPayoutStep
    progress: number
    recipients: Array<{ playerId: string; amount: number }>
  } | null
  remainingSteps: SvaraSnapshotPayoutStep[]
}

/** Stateless sampling makes duplicate snapshots, refresh and remount seek to
 * the same instant. No award callbacks, local start times or chip mutations. */
export function computeSvaraResultVisualState(
  snapshot: SvaraMatchSnapshotMessage | null,
  timing: SvaraMatchTimingMessage | null,
  serverNow: number,
): SvaraResultVisualState {
  const empty: SvaraResultVisualState = {
    roundKey: null, showCards: false, flipProgress: 1, tie: false, payout: null, remainingSteps: [],
  }
  const round = snapshot?.round
  if (!snapshot || !round || (round.kind !== 'showdown-display' && round.kind !== 'reveal-choice')) return empty
  const roundKey = JSON.stringify([snapshot.matchId, round.roundId])
  // Timing and snapshots arrive separately. Never borrow the previous round's
  // deadline, even if it belongs to the same match and has the same kind.
  if (!timing || timing.matchId !== snapshot.matchId || timing.revision !== snapshot.revision) return { ...empty, roundKey }
  if (round.kind === 'reveal-choice' && round.decision !== 'revealed') return { ...empty, roundKey }
  const kind = round.kind === 'reveal-choice' ? 'reveal-display'
    : round.displayPhase === 'showdown' ? 'showdown-display' : 'payout-display'
  const deadline = timing.deadlines.find((entry) => entry.kind === kind)
  if (!deadline || !Number.isFinite(deadline.deadlineAt) || !Number.isFinite(serverNow)) return { ...empty, roundKey }
  const steps = round.kind === 'showdown-display'
    ? [...round.payout].sort((a, b) => a.sequence - b.sequence) : []
  const duration = kind === 'payout-display' ? Math.max(1, steps.length) * SVARA_PAYOUT_STEP_MS : SVARA_SHOWDOWN_MS
  const elapsed = serverNow - (deadline.deadlineAt - duration)
  if (elapsed < 0 || serverNow >= deadline.deadlineAt) return { ...empty, roundKey }
  const base = { ...empty, roundKey, tie: round.kind === 'showdown-display' && round.svaraTie }
  if (kind !== 'payout-display') {
    return { ...base, showCards: true, flipProgress: Math.min(1, elapsed / SVARA_SHOWDOWN_FLIP_MS), remainingSteps: steps }
  }
  const index = Math.floor(elapsed / SVARA_PAYOUT_STEP_MS)
  const step = steps[index]
  const remainingSteps = steps.slice(index)
  // Locked pots are never a payout destination, even for a malformed input.
  if (!step || snapshot.lockedPots.some((pot) => pot.potId === step.potId)) return { ...base, remainingSteps }
  // `share` is the engine's exact per-recipient award, including its policy
  // for a removed remainder. Never divide a bank in the client.
  const amount = step.share ?? (step.winners.length === 1 ? step.amount : null)
  if (amount === null || amount <= 0) return { ...base, remainingSteps }
  return {
    ...base, remainingSteps,
    payout: {
      key: JSON.stringify([snapshot.matchId, round.roundId, step.stepId]),
      step, progress: (elapsed - index * SVARA_PAYOUT_STEP_MS) / SVARA_PAYOUT_STEP_MS,
      recipients: [...new Set(step.winners)].map((playerId) => ({ playerId, amount })),
    },
  }
}
