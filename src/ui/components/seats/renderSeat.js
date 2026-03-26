import { renderOpponentCardFan } from './renderOpponentCardFan.js'
import { renderDealerMarker } from './renderDealerMarker.js'
import { renderSeatPanel } from './renderSeatPanel.js'

function getBidInfoForPlayer(gameState = {}, playerId) {
  const history = gameState?.bidding?.history ?? gameState?.bidHistory ?? []

  if (!Array.isArray(history) || history.length === 0) {
    return null
  }

  const lastEntry = [...history].reverse().find((entry) => entry?.playerId === playerId)

  if (!lastEntry) {
    return null
  }

  if (lastEntry.type === 'pass') {
    return { type: 'pass' }
  }

  if (lastEntry.type === 'double') {
    return { type: 'double' }
  }

  if (lastEntry.type === 'redouble') {
    return { type: 'redouble' }
  }

  if (lastEntry.type === 'all-trumps') {
    return { type: 'all-trumps' }
  }

  if (lastEntry.type === 'no-trumps') {
    return { type: 'no-trumps' }
  }

  if (lastEntry.type === 'suit') {
    return {
      type: 'suit',
      suit: lastEntry.suit ?? lastEntry.trumpSuit ?? null,
    }
  }

  if (lastEntry.contract === 'all-trumps') {
    return { type: 'all-trumps' }
  }

  if (lastEntry.contract === 'no-trumps') {
    return { type: 'no-trumps' }
  }

  if (lastEntry.contract === 'color' || lastEntry.suit || lastEntry.trumpSuit) {
    return {
      type: 'suit',
      suit: lastEntry.suit ?? lastEntry.trumpSuit ?? null,
    }
  }

  return lastEntry.label ? { label: lastEntry.label } : null
}

function getActiveBiddingPlayerId(gameState = {}) {
  return (
    gameState?.ui?.bidding?.activePlayerId ??
    gameState?.bidding?.currentPlayerId ??
    gameState?.bidding?.currentPlayer ??
    gameState?.bidding?.activePlayerId ??
    gameState?.bidding?.activePlayer ??
    gameState?.currentPlayerId ??
    gameState?.currentPlayer ??
    null
  )
}

function getBiddingTimeProgress(gameState = {}, playerId, isActive) {
  if (!isActive) {
    return 0
  }

  const phase = gameState?.phase ?? null

  if (phase !== 'bidding') {
    return 0
  }

  const uiMsLeft = gameState?.ui?.bidding?.msLeft ?? null
  const uiTurnLimitMs = gameState?.ui?.bidding?.turnLimitMs ?? null

  if (uiMsLeft !== null && uiTurnLimitMs) {
    const safeMsLeft = Math.max(0, Number(uiMsLeft))
    const safeLimit = Math.max(1, Number(uiTurnLimitMs))
    return (safeMsLeft / safeLimit) * 100
  }

  const turnStartedAt = gameState?.bidding?.turnStartedAt ?? gameState?.turnStartedAt ?? null
  const turnTimeLimitMs = gameState?.bidding?.turnTimeLimitMs ?? gameState?.turnTimeLimitMs ?? 15000

  if (!turnStartedAt || !turnTimeLimitMs) {
    return 100
  }

  const startedAtMs = new Date(turnStartedAt).getTime()

  if (Number.isNaN(startedAtMs)) {
    return 100
  }

  const elapsed = Date.now() - startedAtMs
  const remaining = Math.max(0, turnTimeLimitMs - elapsed)

  return (remaining / turnTimeLimitMs) * 100
}

function getBiddingSecondsLeft(gameState = {}, playerId, isActive) {
  if (!isActive) {
    return 0
  }

  const phase = gameState?.phase ?? null

  if (phase !== 'bidding') {
    return 0
  }

  const uiSecondsLeft = gameState?.ui?.bidding?.secondsLeft ?? null

  if (uiSecondsLeft !== null && uiSecondsLeft !== undefined) {
    return Math.max(0, Number(uiSecondsLeft))
  }

  const turnStartedAt = gameState?.bidding?.turnStartedAt ?? gameState?.turnStartedAt ?? null
  const turnTimeLimitMs = gameState?.bidding?.turnTimeLimitMs ?? gameState?.turnTimeLimitMs ?? 15000

  if (!turnStartedAt || !turnTimeLimitMs) {
    return Math.ceil(turnTimeLimitMs / 1000)
  }

  const startedAtMs = new Date(turnStartedAt).getTime()

  if (Number.isNaN(startedAtMs)) {
    return Math.ceil(turnTimeLimitMs / 1000)
  }

  const elapsed = Date.now() - startedAtMs
  const remaining = Math.max(0, turnTimeLimitMs - elapsed)

  return Math.ceil(remaining / 1000)
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
}) {
  const activeBiddingPlayerId = getActiveBiddingPlayerId(gameState)
  const phase = gameState?.phase ?? null
  const isBiddingPhase = phase === 'bidding'

  const isActive = isBiddingPhase ? activeBiddingPlayerId === playerId : currentTurn === playerId
  const isDealer = dealerPlayerId === playerId

  const firstRoundDealt = gameState?.firstRoundDealt ?? false
  const secondRoundDealt = gameState?.secondRoundDealt ?? false

  const showBidInfo =
    phase === 'bidding' ||
    (firstRoundDealt && !secondRoundDealt && phase !== 'playing' && phase !== 'round-complete')

  const lastBidInfo = getBidInfoForPlayer(gameState, playerId)
  const timeProgress = getBiddingTimeProgress(gameState, playerId, isActive)
  const timerSecondsLeft = getBiddingSecondsLeft(gameState, playerId, isActive)

  let wrapperStyle = `
    position: absolute;
    z-index: 4;
  `

  let seatStyle = `
    position: absolute;
    width: clamp(112px, 8.4vw, 136px);
    height: ${showBidInfo ? 'clamp(186px, 13.8vw, 220px)' : 'clamp(148px, 11vw, 176px)'};
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
        ${renderSeatPanel(player, name, isActive, {
          showBidInfo,
          lastBidInfo,
          timeProgress,
          timerSecondsLeft,
        })}
      </div>
    </div>
  `
}