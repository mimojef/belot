import { prepareRoundForCut } from './gameEngineRoundSetup.js'
import { runBotCutIfNeeded } from './gameEngineBots.js'

export function startNewGameRoundFlow(state) {
  state.scores = {
    teamA: 0,
    teamB: 0,
  }

  state.roundNumber = 1
  state.dealerIndex = null
  state.initialDealerIndex = null
  state.randomDealerChosen = false

  prepareRoundForCut(state, { pickRandomDealer: true })
  runBotCutIfNeeded(state)

  return state
}

export function restartRoundAfterAllPassFlow(state) {
  state.roundNumber += 1

  prepareRoundForCut(state, { advanceDealer: true })
  runBotCutIfNeeded(state)

  return state
}

export function startNextRoundFlow(state, api) {
  if (!state.randomDealerChosen) {
    return api.startNewGame()
  }

  state.roundNumber += 1

  prepareRoundForCut(state, { advanceDealer: true })
  runBotCutIfNeeded(state)

  return state
}