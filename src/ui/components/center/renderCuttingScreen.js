import { formatPlayerName } from '../../helpers/formatters.js'
import { renderCardBack } from '../common/renderCardBack.js'
import {
  resolveDealerPosition,
  resolveAutoCutIndex,
} from './cutting/cuttingScreenUtils.js'
import {
  buildLastThreeAutoStartHandler,
  buildCutClickHandler,
  buildAutoStartCutHandler,
} from './cutting/cutAnimationBuilders.js'
import { renderLastThreeDealScreen } from './cutting/renderLastThreeDealScreen.js'
import { renderCuttingDeck } from './cutting/renderCuttingDeck.js'

export function renderCuttingScreen(gameState = {}, statusText = '') {
  const cuttingPlayer = gameState.cuttingPlayer ?? null
  const isHumanCutting = cuttingPlayer === 'bottom'
  const selectedCutIndex = gameState.selectedCutIndex
  const hasSelectedCutIndex = selectedCutIndex !== null && selectedCutIndex !== undefined
  const dealerPosition = resolveDealerPosition(gameState)
  const isLastThreeDealPhase = gameState?.phase === 'dealing' && gameState?.dealStep === 'last-3'
  const autoCutIndex = resolveAutoCutIndex(gameState)

  const cuttingUi = gameState?.ui?.cutting ?? {}
  const timerSecondsLeft = Math.max(0, Number(cuttingUi.secondsLeft ?? 15))

  const shouldAutoStartCutAnimation =
    Boolean(cuttingPlayer) &&
    !isLastThreeDealPhase &&
    (
      (!isHumanCutting && !hasSelectedCutIndex) ||
      (isHumanCutting && timerSecondsLeft <= 0)
    )

  const canInteract =
    isHumanCutting &&
    !hasSelectedCutIndex &&
    timerSecondsLeft > 0

  const primaryTitle = isHumanCutting
    ? 'ТИ ЦЕПИШ'
    : `${formatPlayerName(cuttingPlayer).toUpperCase()} ЦЕПИ`

  const visibleCards = 32
  const middleIndex = (visibleCards - 1) / 2

  const dealCardHtml = renderCardBack(`
    width: clamp(72px, 5.2vw, 90px);
    height: clamp(108px, 7.9vw, 136px);
    box-shadow: 0 10px 16px rgba(0,0,0,0.16);
  `)

  if (isLastThreeDealPhase) {
    return renderLastThreeDealScreen({
      dealCardHtml,
      dealerPosition,
      buildLastThreeAutoStartHandler,
    })
  }

  return `
    <div
      data-cutting-root
      style="
        position: relative;
        width: min(92vw, 1180px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        text-align: center;
        overflow: visible;
      "
    >
      ${
        shouldAutoStartCutAnimation
          ? `
            <img
              alt=""
              src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
              style="display:none"
              onload="${buildAutoStartCutHandler(autoCutIndex, dealCardHtml, dealerPosition, cuttingPlayer)}"
            />
          `
          : ''
      }

      <div
        data-cutting-title
        style="
          font-size: clamp(26px, 3.2vw, 48px);
          line-height: 1;
          font-weight: 900;
          color: #f2a81d;
          text-shadow: 0 3px 0 rgba(0,0,0,0.50), 0 10px 20px rgba(0,0,0,0.18);
          letter-spacing: 0.03em;
          margin-bottom: 0;
          transition: opacity 0.2s ease, transform 0.2s ease;
        "
      >
        ${primaryTitle}
      </div>

      ${renderCuttingDeck({
        visibleCards,
        middleIndex,
        selectedCutIndex,
        canInteract,
        dealCardHtml,
        dealerPosition,
        buildCutClickHandler,
      })}
    </div>
  `
}