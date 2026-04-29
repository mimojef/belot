import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { pickServerBotPlayCard } from './pickServerBotPlayCard.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { submitServerPlayCard } from './submitServerPlayCard.js'

export type AdvanceExpiredServerPlayingStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
}

export function advanceExpiredServerPlayingState(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): AdvanceExpiredServerPlayingStateResult {
  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return { state, advanced: false, eventAt }
  }

  const currentSeat = playing.currentTurnSeat

  if (!currentSeat) {
    return { state, advanced: false, eventAt }
  }

  const card = pickServerBotPlayCard(state, currentSeat)

  if (!card) {
    return { state, advanced: false, eventAt }
  }

  const nextState = rebaseServerStateToEventAt(
    submitServerPlayCard(state, currentSeat, card.id),
    eventAt,
  )

  return {
    state: nextState,
    advanced: true,
    eventAt,
  }
}
