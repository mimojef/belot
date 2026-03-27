import { renderSeat } from '../components/seats/renderSeat.js'

export function renderTableSeats({
  topPlayer,
  leftPlayer,
  rightPlayer,
  topCount,
  leftCount,
  rightCount,
  currentTurn,
  dealerPlayerId,
  gameState,
}) {
  return `
    ${renderSeat({
      player: topPlayer,
      name: 'Играч 2',
      cardsCount: topCount,
      currentTurn,
      playerId: 'top',
      position: 'top',
      dealerPlayerId,
      gameState,
    })}

    ${renderSeat({
      player: leftPlayer,
      name: 'Играч 1',
      cardsCount: leftCount,
      currentTurn,
      playerId: 'left',
      position: 'left',
      dealerPlayerId,
      gameState,
    })}

    ${renderSeat({
      player: rightPlayer,
      name: 'Играч 3',
      cardsCount: rightCount,
      currentTurn,
      playerId: 'right',
      position: 'right',
      dealerPlayerId,
      gameState,
    })}
  `
}