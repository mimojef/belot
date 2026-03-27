import { getPlayerIdByIndex } from '../helpers/players.js'
import {
  getActiveBiddingPlayerId,
  getBidInfoForPlayer,
  getBiddingTimeProgress,
  getBiddingSecondsLeft,
} from './tableBiddingUi.js'

export function buildTableLayoutState(players, hands = {}, gameState = {}) {
  const topPlayer = players.find((player) => player.position === 'top')
  const leftPlayer = players.find((player) => player.position === 'left')
  const rightPlayer = players.find((player) => player.position === 'right')
  const bottomPlayer = players.find((player) => player.position === 'bottom')

  const topCount = hands.top?.length ?? 0
  const leftCount = hands.left?.length ?? 0
  const rightCount = hands.right?.length ?? 0
  const bottomCount = hands.bottom?.length ?? 0

  const phase = gameState.phase ?? null
  const dealStep = gameState.dealStep ?? null
  const isLastThreeDealPhase = phase === 'dealing' && dealStep === 'last-3'
  const bidding = gameState.bidding ?? {}

  const currentTurn =
    phase === 'bidding'
      ? getActiveBiddingPlayerId(gameState)
      : gameState.currentTurn ?? gameState.currentPlayerId ?? null

  const contract = bidding.contract ?? gameState.contract ?? null
  const trumpSuit = bidding.trumpSuit ?? gameState.trumpSuit ?? null
  const winningBidder = bidding.winningBidder ?? gameState.winningBidder ?? null
  const currentTrick = gameState.currentTrick ?? []
  const scores = gameState.scores ?? { teamA: 0, teamB: 0 }
  const dealerPlayerId = getPlayerIdByIndex(gameState.dealerIndex)

  const showBottomHand =
    phase === 'bidding' || phase === 'playing' || phase === 'round-complete'

  const firstRoundDealt = gameState?.firstRoundDealt ?? false
  const secondRoundDealt = gameState?.secondRoundDealt ?? false

  const showBottomBidInfo =
    !isLastThreeDealPhase &&
    (
      phase === 'bidding' ||
      (firstRoundDealt && !secondRoundDealt && phase !== 'playing' && phase !== 'round-complete')
    )

  const isBottomActive = currentTurn === 'bottom'
  const bottomBidInfo = getBidInfoForPlayer(gameState, 'bottom')
  const bottomTimeProgress = getBiddingTimeProgress(gameState, 'bottom', isBottomActive)
  const bottomTimerSecondsLeft = getBiddingSecondsLeft(gameState, 'bottom', isBottomActive)

  const centerBoxStyle =
    phase === 'cutting' || isLastThreeDealPhase
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
    showBottomHand,
    showBottomBidInfo,
    bottomBidInfo,
    bottomTimeProgress,
    bottomTimerSecondsLeft,
    centerBoxStyle,
  }
}