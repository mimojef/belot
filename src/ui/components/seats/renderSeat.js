import { renderOpponentCardFan } from './renderOpponentCardFan.js'
import { renderDealerMarker } from './renderDealerMarker.js'
import { renderSeatPanel } from './renderSeatPanel.js'

export function renderSeat({ player, name, cardsCount, currentTurn, playerId, position, dealerPlayerId }) {
  const isActive = currentTurn === playerId
  const isDealer = dealerPlayerId === playerId

  let wrapperStyle = `
    position: absolute;
    z-index: 4;
  `

  let seatStyle = `
    position: absolute;
    width: clamp(112px, 8.4vw, 136px);
    height: clamp(148px, 11vw, 176px);
    z-index: 4;
  `

  if (position === 'top') {
    wrapperStyle += `
      top: clamp(14px, 1.4vw, 22px);
      left: 50%;
      transform: translateX(-50%);
      width: min(48vw, 620px);
      height: 230px;
    `

    seatStyle += `
      left: 50%;
      bottom: 0;
      transform: translateX(-50%);
    `
  }

  if (position === 'left') {
    wrapperStyle += `
      left: clamp(12px, 1.4vw, 20px);
      top: 50%;
      transform: translateY(-50%);
      width: 320px;
      height: min(46vh, 460px);
    `

    seatStyle += `
      right: 200px;
      top: 50%;
      transform: translateY(-50%);
    `
  }

  if (position === 'right') {
    wrapperStyle += `
      right: clamp(12px, 1.4vw, 20px);
      top: 50%;
      transform: translateY(-50%);
      width: 320px;
      height: min(46vh, 460px);
    `

    seatStyle += `
      left: 200px;
      top: 50%;
      transform: translateY(-50%);
    `
  }

  return `
    <div style="${wrapperStyle}">
      ${renderOpponentCardFan(cardsCount, position)}
      ${renderDealerMarker(position, isDealer)}

      <div style="${seatStyle}">
        ${renderSeatPanel(player, name, isActive)}
      </div>
    </div>
  `
}
