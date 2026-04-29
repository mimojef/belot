import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { pickServerBotPlayCard } from './pickServerBotPlayCard.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { isServerSeatControlledByBot } from './serverTimerStateHelpers.js'
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

  const stateWithBotControl = isServerSeatControlledByBot(state, currentSeat)
    ? state
    : {
        ...state,
        players: {
          ...state.players,
          [currentSeat]: {
            ...state.players[currentSeat],
            controlledByBot: true,
          },
        },
      }

  const card = pickServerBotPlayCard(stateWithBotControl, currentSeat)

  if (!card) {
    return { state, advanced: false, eventAt }
  }

  const nextState = rebaseServerStateToEventAt(
    submitServerPlayCard(stateWithBotControl, currentSeat, card.id),
    eventAt,
  )

  return {
    state: nextState,
    advanced: true,
    eventAt,
  }
}
