import { getPlayerIdByIndex } from '../helpers/players.js'
import {
  getActiveBiddingPlayerId,
  getBidInfoForPlayer,
  getBiddingTimeProgress,
  getBiddingSecondsLeft,
} from './tableBiddingUi.js'

const SEAT_ORDER_COUNTERCLOCKWISE = ['bottom', 'right', 'top', 'left']

function getPlayerByPosition(players, position) {
  return players.find((player) => player.position === position) ?? null
}

function getSeatCardCount(hands = {}, seatId) {
  return hands?.[seatId]?.length ?? 0
}

function hasSelectedCutIndex(gameState = {}) {
  return gameState?.selectedCutIndex !== null && gameState?.selectedCutIndex !== undefined
}

function shouldShowSeatBidInfo({
  phase,
  isLastThreeDealPhase,
  firstRoundDealt,
  secondRoundDealt,
}) {
  return (
    !isLastThreeDealPhase &&
    (
      phase === 'bidding' ||
      (firstRoundDealt && !secondRoundDealt && phase !== 'playing' && phase !== 'round-complete')
    )
  )
}

function resolveCurrentTurn(phase, gameState = {}) {
  return phase === 'bidding'
    ? getActiveBiddingPlayerId(gameState)
    : gameState.currentTurn ?? gameState.currentPlayerId ?? null
}

function resolveSeatMode({
  phase,
  seatId,
  activeSeatId,
  cuttingPlayer,
  cutAlreadySelected,
}) {
  if (phase === 'bidding' && activeSeatId === seatId) {
    return 'bidding-active'
  }

  if (phase === 'cutting' && cuttingPlayer === seatId && !cutAlreadySelected) {
    return 'cutting-active'
  }

  if (phase === 'dealing') {
    return 'dealing'
  }

  if (phase === 'playing' && activeSeatId === seatId) {
    return 'playing-active'
  }

  return 'idle'
}

function buildSeatUiState({
  seatId,
  player,
  cardCount,
  phase,
  activeSeatId,
  dealerPlayerId,
  cuttingPlayer,
  cutAlreadySelected,
  showBidInfo,
  gameState,
}) {
  const isBiddingActive = phase === 'bidding' && activeSeatId === seatId
  const isCuttingActive = phase === 'cutting' && cuttingPlayer === seatId && !cutAlreadySelected
  const isPlayingActive = phase === 'playing' && activeSeatId === seatId

  const biddingTimeProgress = getBiddingTimeProgress(gameState, seatId, isBiddingActive)
  const biddingSecondsLeft = getBiddingSecondsLeft(gameState, seatId, isBiddingActive)
  const cuttingTimeProgress = Math.max(
    0,
    Math.min(100, Number(gameState?.ui?.cutting?.progressPercent ?? 100))
  )

  return {
    seatId,
    player,
    cardCount,
    isDealer: dealerPlayerId === seatId,
    isActive: isBiddingActive || isCuttingActive || isPlayingActive,
    isBiddingActive,
    isCuttingActive,
    isPlayingActive,
    showBidInfo,
    bidInfo: getBidInfoForPlayer(gameState, seatId),
    biddingTimeProgress,
    biddingSecondsLeft,
    showCuttingTimer: isCuttingActive,
    cuttingTimeProgress,
    mode: resolveSeatMode({
      phase,
      seatId,
      activeSeatId,
      cuttingPlayer,
      cutAlreadySelected,
    }),
  }
}

function buildCenterBoxStyle(phase, isLastThreeDealPhase) {
  return phase === 'cutting' || isLastThreeDealPhase
    ? `
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        align-items: center;
        justify-content: center;
        width: min(86vw, 1040px);
        height: min(54vh, 520px);
        min-width: 320px;
        min-height: 260px;
        z-index: 2;
      `
    : `
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        align-items: center;
        justify-content: center;
        width: min(44vw, 480px);
        height: min(36vw, 360px);
        min-width: 240px;
        min-height: 220px;
        z-index: 2;
      `
}

export function buildTableLayoutState(players, hands = {}, gameState = {}) {
  const phase = gameState.phase ?? null
  const dealStep = gameState.dealStep ?? null
  const isLastThreeDealPhase = phase === 'dealing' && dealStep === 'last-3'
  const bidding = gameState.bidding ?? {}

  const topPlayer = getPlayerByPosition(players, 'top')
  const leftPlayer = getPlayerByPosition(players, 'left')
  const rightPlayer = getPlayerByPosition(players, 'right')
  const bottomPlayer = getPlayerByPosition(players, 'bottom')

  const topCount = getSeatCardCount(hands, 'top')
  const leftCount = getSeatCardCount(hands, 'left')
  const rightCount = getSeatCardCount(hands, 'right')
  const bottomCount = getSeatCardCount(hands, 'bottom')

  const firstRoundDealt = gameState?.firstRoundDealt ?? false
  const secondRoundDealt = gameState?.secondRoundDealt ?? false
  const cuttingPlayer = gameState?.cuttingPlayer ?? null
  const cutAlreadySelected = hasSelectedCutIndex(gameState)

  const currentTurn = resolveCurrentTurn(phase, gameState)

  const contract = bidding.contract ?? gameState.contract ?? null
  const trumpSuit = bidding.trumpSuit ?? gameState.trumpSuit ?? null
  const winningBidder = bidding.winningBidder ?? gameState.winningBidder ?? null
  const currentTrick = gameState.currentTrick ?? []
  const scores = gameState.scores ?? { teamA: 0, teamB: 0 }
  const dealerPlayerId = getPlayerIdByIndex(gameState.dealerIndex)

  const showBottomHand =
    phase === 'bidding' || phase === 'playing' || phase === 'round-complete'

  const showSeatBidInfo = shouldShowSeatBidInfo({
    phase,
    isLastThreeDealPhase,
    firstRoundDealt,
    secondRoundDealt,
  })

  const seatUi = {
    bottom: buildSeatUiState({
      seatId: 'bottom',
      player: bottomPlayer,
      cardCount: bottomCount,
      phase,
      activeSeatId: currentTurn,
      dealerPlayerId,
      cuttingPlayer,
      cutAlreadySelected,
      showBidInfo: showSeatBidInfo,
      gameState,
    }),
    right: buildSeatUiState({
      seatId: 'right',
      player: rightPlayer,
      cardCount: rightCount,
      phase,
      activeSeatId: currentTurn,
      dealerPlayerId,
      cuttingPlayer,
      cutAlreadySelected,
      showBidInfo: showSeatBidInfo,
      gameState,
    }),
    top: buildSeatUiState({
      seatId: 'top',
      player: topPlayer,
      cardCount: topCount,
      phase,
      activeSeatId: currentTurn,
      dealerPlayerId,
      cuttingPlayer,
      cutAlreadySelected,
      showBidInfo: showSeatBidInfo,
      gameState,
    }),
    left: buildSeatUiState({
      seatId: 'left',
      player: leftPlayer,
      cardCount: leftCount,
      phase,
      activeSeatId: currentTurn,
      dealerPlayerId,
      cuttingPlayer,
      cutAlreadySelected,
      showBidInfo: showSeatBidInfo,
      gameState,
    }),
  }

  return {
    topPlayer,
    leftPlayer,
    rightPlayer,
    bottomPlayer,
    topCount,
    leftCount,
    rightCount,
    bottomCount,
    phase,
    dealStep,
    isLastThreeDealPhase,
    bidding,
    currentTurn,
    contract,
    trumpSuit,
    winningBidder,
    currentTrick,
    scores,
    dealerPlayerId,
    cuttingPlayer,
    cutAlreadySelected,
    showBottomHand,
    showBottomBidInfo: seatUi.bottom.showBidInfo,
    bottomBidInfo: seatUi.bottom.bidInfo,
    bottomTimeProgress: seatUi.bottom.biddingTimeProgress,
    bottomTimerSecondsLeft: seatUi.bottom.biddingSecondsLeft,
    showBottomCuttingTimer: seatUi.bottom.showCuttingTimer,
    bottomCuttingTimeProgress: seatUi.bottom.cuttingTimeProgress,
    seatUi,
    seatOrderCounterClockwise: SEAT_ORDER_COUNTERCLOCKWISE,
    centerBoxStyle: buildCenterBoxStyle(phase, isLastThreeDealPhase),
  }
}