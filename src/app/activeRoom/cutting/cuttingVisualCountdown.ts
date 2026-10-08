import type { RoomGameSnapshot } from '../../network/createGameServerClient'
import { sharedServerClock } from '../../network/serverClock'
import {
  computeSeatCountdownRemainingMs,
  resolveHumanTurnTimeoutMs,
} from '../reactionCountdown'

type CuttingVisualCountdownContext = {
  roomId: string
  game: RoomGameSnapshot | null
  // true, когато цепещият е бот / поет от бот — лентата изтича за bot delay-а.
  isCutterBot?: boolean
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

// Оставащото време се изчислява винаги от authoritative server deadline-а
// (както при bidding/playing), а не от момента, в който клиентът е видял
// хода — иначе refresh/reconnect по средата на цепенето рестартира лентата
// от 100%, докато сървърът продължава да брои.
export function createCuttingVisualCountdownTracker(): CuttingVisualCountdownTracker {
  let activeCuttingVisualTurnKey: string | null = null

  function resetCuttingVisualCountdownState(): void {
    activeCuttingVisualTurnKey = null
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
    activeCuttingVisualTurnKey = getCuttingVisualTurnKey(context)
  }

  function getCuttingVisualCountdownRemainingMs(
    context: CuttingVisualCountdownContext | null,
  ): number | null {
    const turnKey = getCuttingVisualTurnKey(context)

    if (turnKey === null || turnKey !== activeCuttingVisualTurnKey) {
      return null
    }

    return computeSeatCountdownRemainingMs({
      deadlineAt: getServerTimerDeadlineAt(context),
      totalMs: resolveHumanTurnTimeoutMs(context?.game),
      isBotSeat: context?.isCutterBot === true,
      serverNow: sharedServerClock.getServerNow(),
    })
  }

  return {
    resetCuttingVisualCountdownState,
    getCuttingVisualTurnKey,
    syncCuttingVisualCountdownState,
    getCuttingVisualCountdownRemainingMs,
  }
}
