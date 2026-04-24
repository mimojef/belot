import type { RoomGameSnapshot } from '../../network/createGameServerClient'

export const CUTTING_COUNTDOWN_MS = 15000
const SHORT_CUTTING_VISUAL_TIMER_THRESHOLD_MS = 1500

type CuttingVisualCountdownContext = {
  roomId: string
  game: RoomGameSnapshot | null
}

export type CuttingVisualCountdownTracker = {
  resetCuttingVisualCountdownState: () => void
  getCuttingVisualTurnKey: (
    context: CuttingVisualCountdownContext | null,
  ) => string | null
  syncCuttingVisualCountdownState: (
    context: CuttingVisualCountdownContext | null,
  ) => void
  getCuttingVisualCountdownRemainingMs: (
    context: CuttingVisualCountdownContext | null,
  ) => number | null
}

function parseTimerDeadlineAt(rawValue: unknown): number | null {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : null
  }

  if (typeof rawValue !== 'string') {
    return null
  }

  const trimmedValue = rawValue.trim()

  if (trimmedValue.length === 0) {
    return null
  }

  const numericValue = Number(trimmedValue)

  if (Number.isFinite(numericValue)) {
    return numericValue
  }

  const parsedDateValue = Date.parse(trimmedValue)

  return Number.isFinite(parsedDateValue) ? parsedDateValue : null
}

function getServerTimerDeadlineAt(context: CuttingVisualCountdownContext | null): number | null {
  return parseTimerDeadlineAt(context?.game?.timerDeadlineAt)
}

function resolveCuttingVisualStartedAt(
  context: CuttingVisualCountdownContext | null,
): number {
  const serverTimerDeadlineAt = getServerTimerDeadlineAt(context)
  const now = Date.now()

  if (serverTimerDeadlineAt === null) {
    return now
  }

  const remainingMs = serverTimerDeadlineAt - now

  if (
    !Number.isFinite(remainingMs) ||
    remainingMs <= SHORT_CUTTING_VISUAL_TIMER_THRESHOLD_MS
  ) {
    return now
  }

  return serverTimerDeadlineAt - CUTTING_COUNTDOWN_MS
}

export function createCuttingVisualCountdownTracker(): CuttingVisualCountdownTracker {
  let activeCuttingVisualTurnKey: string | null = null
  let activeCuttingVisualStartedAt = 0

  function resetCuttingVisualCountdownState(): void {
    activeCuttingVisualTurnKey = null
    activeCuttingVisualStartedAt = 0
  }

  function getCuttingVisualTurnKey(
    context: CuttingVisualCountdownContext | null,
  ): string | null {
    if (!context) {
      return null
    }

    const cuttingSnapshot = context.game?.cutting ?? null
    const cutterSeat = cuttingSnapshot?.cutterSeat ?? null

    if (!cuttingSnapshot || !cutterSeat || cuttingSnapshot.selectedCutIndex !== null) {
      return null
    }

    const phaseMarker =
      context.game?.authoritativePhase ?? context.game?.phase ?? 'cutting'
    const timerMarker = getServerTimerDeadlineAt(context) ?? 'no-timer'

    return `${context.roomId}:${phaseMarker}:${cutterSeat}:${timerMarker}`
  }

  function syncCuttingVisualCountdownState(
    context: CuttingVisualCountdownContext | null,
  ): void {
    const turnKey = getCuttingVisualTurnKey(context)

    if (turnKey === null) {
      resetCuttingVisualCountdownState()
      return
    }

    if (activeCuttingVisualTurnKey === turnKey) {
      return
    }

    activeCuttingVisualTurnKey = turnKey
    activeCuttingVisualStartedAt = resolveCuttingVisualStartedAt(context)
  }

  function getCuttingVisualCountdownRemainingMs(
    context: CuttingVisualCountdownContext | null,
  ): number | null {
    const turnKey = getCuttingVisualTurnKey(context)

    if (turnKey === null) {
      return null
    }

    if (
      activeCuttingVisualTurnKey !== turnKey ||
      !Number.isFinite(activeCuttingVisualStartedAt) ||
      activeCuttingVisualStartedAt <= 0
    ) {
      return CUTTING_COUNTDOWN_MS
    }

    const elapsedMs = Math.max(0, Date.now() - activeCuttingVisualStartedAt)

    return Math.max(0, CUTTING_COUNTDOWN_MS - elapsedMs)
  }

  return {
    resetCuttingVisualCountdownState,
    getCuttingVisualTurnKey,
    syncCuttingVisualCountdownState,
    getCuttingVisualCountdownRemainingMs,
  }
}
