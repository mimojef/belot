import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { pickServerAutoCutIndex } from './pickServerAutoCutIndex.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { resolveServerCutPhase } from './resolveServerCutPhase.js'
import { selectServerCutIndex } from './selectServerCutIndex.js'
import {
  clearServerTimerState,
  isServerSeatControlledByBot,
} from './serverTimerStateHelpers.js'

export type AdvanceExpiredServerCuttingStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
}

function resolveSelectedServerCut(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): AdvanceExpiredServerCuttingStateResult {
  const resolvedState = {
    ...resolveServerCutPhase(state),
    timer: clearServerTimerState(),
  }

  return {
    state: rebaseServerStateToEventAt(resolvedState, eventAt),
    advanced: true,
    eventAt,
  }
}

export function advanceExpiredServerCuttingState(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): AdvanceExpiredServerCuttingStateResult {
  if (state.round.selectedCutIndex !== null) {
    return resolveSelectedServerCut(state, eventAt)
  }

  const cutterSeat = state.round.cutterSeat
  const stateWithBotControl =
    cutterSeat !== null && !isServerSeatControlledByBot(state, cutterSeat)
      ? {
          ...state,
          players: {
            ...state.players,
            [cutterSeat]: {
              ...state.players[cutterSeat],
              controlledByBot: true,
            },
          },
        }
      : state

  return {
    state: rebaseServerStateToEventAt(
      selectServerCutIndex(stateWithBotControl, pickServerAutoCutIndex(stateWithBotControl)),
      eventAt,
    ),
    advanced: true,
    eventAt,
  }
}
