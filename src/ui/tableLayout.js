import { renderHumanBiddingControls } from './components/bidding/renderHumanBiddingControls.js'
import { renderCenterContent } from './components/center/renderCenterContent.js'
import { renderTopLeftScorePanel } from './components/panels/renderTopLeftScorePanel.js'
import { buildTableLayoutState } from './helpers/tableLayoutState.js'
import { renderSeatAnimationTarget } from './helpers/tableSeatTargets.js'
import { renderTableBiddingPanel } from './helpers/tableBiddingPanel.js'
import { renderTableBottomArea } from './helpers/tableBottomArea.js'
import { renderTableSeats } from './helpers/tableSeats.js'

export function renderTableLayout(players, statusText, hands = {}, gameState = {}) {
  const viewState = buildTableLayoutState(players, hands, gameState)

  const biddingControlsHtml = renderHumanBiddingControls({
    phase: viewState.phase,
    currentTurn: viewState.currentTurn,
    bidding: viewState.bidding,
  })

  const cuttingUi = gameState?.ui?.cutting ?? {}
  const hasSelectedCutIndex =
    gameState?.selectedCutIndex !== null && gameState?.selectedCutIndex !== undefined

  const showBottomCuttingTimer =
    gameState?.phase === 'cutting' &&
    gameState?.cuttingPlayer === 'bottom' &&
    !hasSelectedCutIndex

  const bottomCuttingTimeProgress = Math.max(
    0,
    Math.min(100, Number(cuttingUi.progressPercent ?? 100))
  )

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
            contract: viewState.contract,
            trumpSuit: viewState.trumpSuit,
            winningBidder: viewState.winningBidder,
            scores: viewState.scores,
          })}

          ${renderSeatAnimationTarget('top')}
          ${renderSeatAnimationTarget('left')}
          ${renderSeatAnimationTarget('right')}
          ${renderSeatAnimationTarget('bottom')}

          ${renderTableSeats({
            topPlayer: viewState.topPlayer,
            leftPlayer: viewState.leftPlayer,
            rightPlayer: viewState.rightPlayer,
            topCount: viewState.topCount,
            leftCount: viewState.leftCount,
            rightCount: viewState.rightCount,
            currentTurn: viewState.currentTurn,
            dealerPlayerId: viewState.dealerPlayerId,
            gameState,
          })}

          <div
            data-table-center-zone
            style="${viewState.centerBoxStyle}"
          >
            ${renderCenterContent(viewState.phase, viewState.currentTrick, gameState, statusText)}
          </div>

          ${renderTableBottomArea({
            hands,
            phase: viewState.phase,
            currentTurn: viewState.currentTurn,
            contract: viewState.contract,
            trumpSuit: viewState.trumpSuit,
            bottomPlayer: viewState.bottomPlayer,
            bottomCount: viewState.bottomCount,
            dealerPlayerId: viewState.dealerPlayerId,
            showBottomHand: viewState.showBottomHand,
            showBottomBidInfo: viewState.showBottomBidInfo,
            bottomBidInfo: viewState.bottomBidInfo,
            bottomTimeProgress: viewState.bottomTimeProgress,
            bottomTimerSecondsLeft: viewState.bottomTimerSecondsLeft,
            showBottomCuttingTimer,
            bottomCuttingTimeProgress,
          })}

          ${renderTableBiddingPanel(viewState.phase, biddingControlsHtml)}
        </section>
      </main>
    </div>
  `
}