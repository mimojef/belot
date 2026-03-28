import { renderOpponentCardFan } from './renderOpponentCardFan.js'
import { renderDealerMarker } from './renderDealerMarker.js'
import { renderSeatPanel } from './renderSeatPanel.js'
import {
  getActiveBiddingPlayerId,
  getBidInfoForPlayer,
  getBiddingTimeProgress,
  getBiddingSecondsLeft,
} from '../../helpers/tableBiddingUi.js'

function buildSeatWrapperStyle(position) {
  let wrapperStyle = `
    position: absolute;
    z-index: 4;
  `

  if (position === 'top') {
    wrapperStyle += `
      top: clamp(4px, 0.6vw, 10px);
      left: 50%;
      transform: translateX(-50%);
      width: min(48vw, 620px);
      height: 230px;
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
  }

  if (position === 'right') {
    wrapperStyle += `
      right: clamp(12px, 1.4vw, 20px);
      top: 50%;
      transform: translateY(-50%);
      width: 320px;
      height: min(46vh, 460px);
    `
  }

  return wrapperStyle
}

function buildSeatCardStyle(position, showBidInfo) {
  let seatStyle = `
    position: absolute;
    width: clamp(112px, 8.4vw, 136px);
    height: ${showBidInfo ? 'clamp(186px, 13.8vw, 220px)' : 'clamp(148px, 11vw, 176px)'};
    z-index: 4;
  `

  if (position === 'top') {
    seatStyle += `
      left: 50%;
      top: 0;
      transform: translateX(-50%);
    `
  }

  if (position === 'left') {
    seatStyle += `
      right: 200px;
      top: 50%;
      transform: translateY(-50%);
    `
  }

  if (position === 'right') {
    seatStyle += `
      left: 200px;
      top: 50%;
      transform: translateY(-50%);
    `
  }

  return seatStyle
}

function buildFallbackSeatUi({
  playerId,
  cardsCount,
  currentTurn,
  dealerPlayerId,
  gameState = {},
}) {
  const phase = gameState?.phase ?? null
  const activeBiddingPlayerId = getActiveBiddingPlayerId(gameState)
  const isBiddingPhase = phase === 'bidding'

  const isActive = isBiddingPhase
    ? activeBiddingPlayerId === playerId
    : currentTurn === playerId

  const firstRoundDealt = gameState?.firstRoundDealt ?? false
  const secondRoundDealt = gameState?.secondRoundDealt ?? false

  const showBidInfo =
    phase === 'bidding' ||
    (firstRoundDealt && !secondRoundDealt && phase !== 'playing' && phase !== 'round-complete')

  return {
    seatId: playerId,
    cardCount: cardsCount,
    isDealer: dealerPlayerId === playerId,
    isActive,
    showBidInfo,
    bidInfo: getBidInfoForPlayer(gameState, playerId),
    biddingTimeProgress: getBiddingTimeProgress(gameState, playerId, isActive),
    biddingSecondsLeft: getBiddingSecondsLeft(gameState, playerId, isActive),
    showCuttingTimer: false,
    cuttingTimeProgress: 0,
    mode: isActive ? 'active' : 'idle',
  }
}

export function renderSeat({
  player,
  name,
  cardsCount,
  currentTurn,
  playerId,
  position,
  dealerPlayerId,
  gameState = {},
  seatUi = null,
}) {
  const resolvedSeatUi =
    seatUi ??
    gameState?.seatUi?.[playerId] ??
    buildFallbackSeatUi({
      playerId,
      cardsCount,
      currentTurn,
      dealerPlayerId,
      gameState,
    })

  const resolvedCardsCount = resolvedSeatUi.cardCount ?? cardsCount
  const isDealer = resolvedSeatUi.isDealer ?? dealerPlayerId === playerId
  const isActive = resolvedSeatUi.isActive ?? false
  const showBidInfo = resolvedSeatUi.showBidInfo ?? false
  const lastBidInfo = resolvedSeatUi.bidInfo ?? null
  const timeProgress = resolvedSeatUi.biddingTimeProgress ?? 0
  const timerSecondsLeft = resolvedSeatUi.biddingSecondsLeft ?? 0
  const showCuttingTimer = resolvedSeatUi.showCuttingTimer ?? false
  const cuttingTimeProgress = resolvedSeatUi.cuttingTimeProgress ?? 0

  const wrapperStyle = buildSeatWrapperStyle(position)
  const seatStyle = buildSeatCardStyle(position, showBidInfo)

  return `
    <div style="${wrapperStyle}">
      ${renderOpponentCardFan(resolvedCardsCount, position)}
      ${renderDealerMarker(position, isDealer)}

      <div style="${seatStyle}">
        ${renderSeatPanel(player, name, isActive, {
          playerId,
          showBidInfo,
          lastBidInfo,
          timeProgress,
          timerSecondsLeft,
          showCuttingTimer,
          cuttingTimeProgress,
        })}
      </div>
    </div>
  `
}