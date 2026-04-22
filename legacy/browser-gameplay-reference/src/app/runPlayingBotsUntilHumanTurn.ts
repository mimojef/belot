import type { AppBootstrap } from './bootstrap'
import { pickBotCardToPlay } from '../core/rules/pickBotCardToPlay'

const MAX_AUTO_PLAYS_PER_RUN = 32

export function runPlayingBotsUntilHumanTurn(app: AppBootstrap): boolean {
  let hasAdvanced = false

  for (let step = 0; step < MAX_AUTO_PLAYS_PER_RUN; step += 1) {
    const state = app.engine.getState()

    if (state.phase !== 'playing') {
      return hasAdvanced
    }

    const currentTurnSeat =
      state.playing?.currentTurnSeat ?? state.currentTrick.currentSeat

    if (!currentTurnSeat) {
      return hasAdvanced
    }

    const currentPlayer = state.players[currentTurnSeat]

    if (!currentPlayer) {
      return hasAdvanced
    }

    const isBotTurn =
      currentPlayer.mode === 'bot' || currentPlayer.controlledByBot

    if (!isBotTurn) {
      return hasAdvanced
    }

    const selectedCard = pickBotCardToPlay(state, currentTurnSeat)

    if (!selectedCard) {
      return hasAdvanced
    }

    app.engine.submitPlayCard(selectedCard.id)
    hasAdvanced = true
  }

  return hasAdvanced
}