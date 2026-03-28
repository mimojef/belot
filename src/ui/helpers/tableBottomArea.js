import { renderBottomHandCards } from '../components/bottom/renderBottomHandCards.js'
import { renderBottomIdentityBadge } from '../components/bottom/renderBottomIdentityBadge.js'
import { renderDealerMarker } from '../components/seats/renderDealerMarker.js'

function buildFallbackBottomSeatUi({
  bottomCount = 0,
  dealerPlayerId = null,
  showBottomBidInfo = false,
  bottomBidInfo = null,
  bottomTimeProgress = 0,
  bottomTimerSecondsLeft = 0,
  showBottomCuttingTimer = false,
  bottomCuttingTimeProgress = 0,
}) {
  return {
    seatId: 'bottom',
    cardCount: bottomCount,
    isDealer: dealerPlayerId === 'bottom',
    showBidInfo: showBottomBidInfo,
    bidInfo: bottomBidInfo,
    biddingTimeProgress: bottomTimeProgress,
    biddingSecondsLeft: bottomTimerSecondsLeft,
    showCuttingTimer: showBottomCuttingTimer,
    cuttingTimeProgress: bottomCuttingTimeProgress,
  }
}

export function renderTableBottomArea({
  hands = {},
  phase = null,
  currentTurn = null,
  contract = null,
  trumpSuit = null,
  bottomPlayer = null,
  bottomCount = 0,
  dealerPlayerId = null,
  showBottomHand = false,
  showBottomBidInfo = false,
  bottomBidInfo = null,
  bottomTimeProgress = 0,
  bottomTimerSecondsLeft = 0,
  showBottomCuttingTimer = false,
  bottomCuttingTimeProgress = 0,
  bottomSeatUi = null,
}) {
  const resolvedBottomSeatUi =
    bottomSeatUi ??
    buildFallbackBottomSeatUi({
      bottomCount,
      dealerPlayerId,
      showBottomBidInfo,
      bottomBidInfo,
      bottomTimeProgress,
      bottomTimerSecondsLeft,
      showBottomCuttingTimer,
      bottomCuttingTimeProgress,
    })

  return `
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

      ${renderBottomIdentityBadge(bottomPlayer, 'Ти', currentTurn, resolvedBottomSeatUi.cardCount ?? bottomCount, {
        showBidInfo: resolvedBottomSeatUi.showBidInfo ?? false,
        lastBidInfo: resolvedBottomSeatUi.bidInfo ?? null,
        timeProgress: resolvedBottomSeatUi.biddingTimeProgress ?? 0,
        timerSecondsLeft: resolvedBottomSeatUi.biddingSecondsLeft ?? 0,
        showCuttingTimer: resolvedBottomSeatUi.showCuttingTimer ?? false,
        cuttingTimeProgress: resolvedBottomSeatUi.cuttingTimeProgress ?? 0,
      })}
      ${renderDealerMarker('bottom', resolvedBottomSeatUi.isDealer ?? dealerPlayerId === 'bottom')}
    </div>
  `
}