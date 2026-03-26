import { getPlayerIdByIndex } from './helpers/players.js'
import { renderHumanBiddingControls } from './components/bidding/renderHumanBiddingControls.js'
import { renderCenterContent } from './components/center/renderCenterContent.js'
import { renderBottomHandCards } from './components/bottom/renderBottomHandCards.js'
import { renderBottomIdentityBadge } from './components/bottom/renderBottomIdentityBadge.js'
import { renderTopLeftScorePanel } from './components/panels/renderTopLeftScorePanel.js'
import { renderSeat } from './components/seats/renderSeat.js'
import { renderDealerMarker } from './components/seats/renderDealerMarker.js'

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
    gameState?.bidding?.currentTurn ??
    gameState?.currentPlayerId ??
    gameState?.currentTurn ??
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

export function renderTableLayout(players, statusText, hands = {}, gameState = {}) {
  const topPlayer = players.find((player) => player.position === 'top')
  const leftPlayer = players.find((player) => player.position === 'left')
  const rightPlayer = players.find((player) => player.position === 'right')
  const bottomPlayer = players.find((player) => player.position === 'bottom')

  const topCount = hands.top?.length ?? 0
  const leftCount = hands.left?.length ?? 0
  const rightCount = hands.right?.length ?? 0
  const bottomCount = hands.bottom?.length ?? 0

  const phase = gameState.phase ?? null
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

  const biddingControlsHtml = renderHumanBiddingControls({
    phase,
    currentTurn,
    bidding,
  })

  const firstRoundDealt = gameState?.firstRoundDealt ?? false
  const secondRoundDealt = gameState?.secondRoundDealt ?? false

  const showBottomBidInfo =
    phase === 'bidding' ||
    (firstRoundDealt && !secondRoundDealt && phase !== 'playing' && phase !== 'round-complete')

  const isBottomActive = currentTurn === 'bottom'
  const bottomBidInfo = getBidInfoForPlayer(gameState, 'bottom')
  const bottomTimeProgress = getBiddingTimeProgress(gameState, 'bottom', isBottomActive)
  const bottomTimerSecondsLeft = getBiddingSecondsLeft(gameState, 'bottom', isBottomActive)

  const centerBoxStyle =
    phase === 'cutting'
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

  return `
    <div class="app">
      <main
        class="table-wrap"
        style="
          padding: 0;
          min-height: 100vh;
          height: 100vh;
        "
      >
        <section
          class="table"
          style="
            position: relative;
            width: 100vw;
            height: 100vh;
            min-height: 100vh;
            max-width: none;
            border-radius: 0;
            border: none;
            padding: 0;
            overflow: hidden;
            background:
              radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 18%, rgba(0,0,0,0) 19%),
              radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 32%, rgba(0,0,0,0) 33%),
              radial-gradient(circle at center, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 48%, rgba(0,0,0,0) 49%),
              radial-gradient(circle at center, #6da5cf 0%, #5f97c2 38%, #4d83ad 68%, #43749c 100%);
          "
        >
          ${renderTopLeftScorePanel({
            contract,
            trumpSuit,
            winningBidder,
            scores,
          })}

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

          <div style="${centerBoxStyle}">
            ${renderCenterContent(phase, currentTrick, gameState, statusText)}
          </div>

          <div
            style="
              position: absolute;
              left: 50%;
              bottom: clamp(10px, 1.4vw, 18px);
              transform: translateX(-50%);
              width: min(98vw, 1360px);
              z-index: 5;
            "
          >
            ${
              showBottomHand
                ? renderBottomHandCards(hands.bottom ?? [], phase, currentTurn, contract, trumpSuit)
                : ''
            }

            ${renderBottomIdentityBadge(bottomPlayer, 'Ти', currentTurn, bottomCount, {
              showBidInfo: showBottomBidInfo,
              lastBidInfo: bottomBidInfo,
              timeProgress: bottomTimeProgress,
              timerSecondsLeft: bottomTimerSecondsLeft,
            })}
            ${renderDealerMarker('bottom', dealerPlayerId === 'bottom')}
          </div>

          ${
            phase === 'bidding'
              ? `
                <div
                  style="
                    position: absolute;
                    left: 50%;
                    bottom: clamp(250px, 31vh, 380px);
                    transform: translateX(-50%);
                    width: min(92vw, 440px);
                    padding: 10px;
                    border-radius: 16px;
                    background: rgba(17, 34, 56, 0.88);
                    border: 2px solid #d79a1e;
                    box-shadow: 0 14px 28px rgba(0,0,0,0.24);
                    z-index: 8;
                  "
                >
                  ${biddingControlsHtml}
                </div>
              `
              : ''
          }
        </section>
      </main>
    </div>
  `
}