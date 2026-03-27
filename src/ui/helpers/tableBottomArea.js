import { renderBottomHandCards } from '../components/bottom/renderBottomHandCards.js'
import { renderBottomIdentityBadge } from '../components/bottom/renderBottomIdentityBadge.js'
import { renderDealerMarker } from '../components/seats/renderDealerMarker.js'

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
}) {
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

      ${renderBottomIdentityBadge(bottomPlayer, 'Ти', currentTurn, bottomCount, {
        showBidInfo: showBottomBidInfo,
        lastBidInfo: bottomBidInfo,
        timeProgress: bottomTimeProgress,
        timerSecondsLeft: bottomTimerSecondsLeft,
      })}
      ${renderDealerMarker('bottom', dealerPlayerId === 'bottom')}
    </div>
  `
}