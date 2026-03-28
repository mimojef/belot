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
  seatUi = {},
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
      seatUi: seatUi.top ?? null,
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
      seatUi: seatUi.left ?? null,
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
      seatUi: seatUi.right ?? null,
    })}
  `
}