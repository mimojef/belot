import { getPlayerIdByIndex } from './playerOrder.js'
import { getCardSuit } from './cardUtils.js'
import { formatSuitLabel, formatContractLabel } from './contractUtils.js'
import { formatPlayerLabel } from './playerOrder.js'

export function getGameEngineStatusText(state) {
  const dealerPlayer = state.dealerIndex !== null ? getPlayerIdByIndex(state.dealerIndex) : null
  const dealerLabel = formatPlayerLabel(dealerPlayer)
  const cutterLabel = formatPlayerLabel(state.cuttingPlayer)
  const currentLabel = formatPlayerLabel(state.currentTurn)

  const contractLabel = formatContractLabel(state.contract)
  const trumpLabel = state.trumpSuit ? formatSuitLabel(state.trumpSuit) : 'Няма'
  const leadSuit =
    state.currentTrick.length > 0 ? formatSuitLabel(getCardSuit(state.currentTrick[0].card)) : 'Няма'

  if (state.phase === 'cutting') {
    if (state.selectedCutIndex !== null && state.selectedCutIndex !== undefined) {
      return `Нова раздача. Дилър е ${dealerLabel}. Цепи ${cutterLabel}. Избрана е позиция ${state.selectedCutIndex + 1} за цепене.`
    }

    return `Нова раздача. Дилър е ${dealerLabel}. Цепи ${cutterLabel}. Картите са разбъркани и разгънати за цепене.`
  }

  if (state.phase === 'bidding') {
    return `Раздадени са първите 3+2 карти. Дилър е ${dealerLabel}, на ход за обява е ${currentLabel}.`
  }

  if (state.phase === 'dealing' && state.dealStep === 'last-3') {
    return `Наддаването приключи. Играе се на ${contractLabel}${state.trumpSuit ? ` (${trumpLabel})` : ''}. Раздават се последните 3 карти.`
  }

  if (state.phase === 'playing') {
    if (state.currentTrick.length === 0) {
      return `Наддаването приключи и са раздадени последните 3 карти. Играе се на ${contractLabel}${state.trumpSuit ? ` (${trumpLabel})` : ''}. ${currentLabel} започва взятката.`
    }

    return `Играе се взятка ${state.completedTricks.length + 1}. На ход е ${currentLabel}. Водещ цвят: ${leadSuit}.`
  }

  if (state.phase === 'round-complete') {
    return `Рундът приключи. teamA има ${state.trickWins.teamA} взятки, а teamB има ${state.trickWins.teamB} взятки. Победител: ${state.roundWinnerTeam}.`
  }

  if (state.phase === 'dealing' && state.firstRoundDealt) {
    return 'Първите 3+2 карти са раздадени.'
  }

  return 'Играта е инициализирана.'
}