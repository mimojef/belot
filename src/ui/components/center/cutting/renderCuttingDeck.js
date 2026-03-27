import {
  buildHoverEnterHandler,
  buildHoverLeaveHandler,
} from './cuttingScreenUtils.js'
import { renderCardBack } from '../../common/renderCardBack.js'

export function renderCuttingDeck({
  visibleCards,
  middleIndex,
  selectedCutIndex,
  canInteract,
  dealCardHtml,
  dealerPosition,
  buildCutClickHandler,
}) {
  return `
    <div
      style="
        position: relative;
        width: min(90vw, 1080px);
        height: clamp(210px, 28vw, 320px);
        margin-top: 0;
        overflow: visible;
      "
    >
      <div
        data-cutting-deck
        style="
          position: absolute;
          inset: 0;
          pointer-events: ${canInteract ? 'auto' : 'none'};
        "
      >
        ${Array.from({ length: visibleCards })
          .map((_, index) => {
            const offset = index - middleIndex
            const isSelected = index === selectedCutIndex

            const x = offset * 18
            const baseY = 0
            const selectedLift = isSelected ? 24 : 0
            const y = baseY - selectedLift
            const rotate = 0
            const zIndex = isSelected ? 500 : 40 + index

            const selectedOutline = isSelected
              ? 'drop-shadow(0 0 0 4px rgba(242,168,29,0.95)) drop-shadow(0 22px 28px rgba(0,0,0,0.28))'
              : 'drop-shadow(0 10px 18px rgba(0,0,0,0.16))'

            return `
              <button
                type="button"
                data-cut-card-index="${index}"
                data-base-x="${x}"
                data-base-y="${y}"
                data-base-rotate="${rotate}"
                ${canInteract ? '' : 'disabled'}
                onclick="${buildCutClickHandler(index, canInteract, dealCardHtml, dealerPosition)}"
                onmouseenter="${buildHoverEnterHandler(canInteract, x, baseY, rotate)}"
                onmouseleave="${buildHoverLeaveHandler(x, y, rotate, selectedOutline)}"
                style="
                  position: absolute;
                  left: 50%;
                  top: 50%;
                  transform: translateX(${x}px) translateY(calc(-50% + ${y}px)) rotate(${rotate}deg);
                  transform-origin: center center;
                  z-index: ${zIndex};
                  padding: 0;
                  margin: 0;
                  border: none;
                  background: transparent;
                  cursor: ${canInteract ? 'pointer' : 'default'};
                  transition: transform 0.14s ease, filter 0.14s ease, opacity 0.18s linear;
                  filter: ${selectedOutline};
                "
                aria-label="Цепи от карта ${index + 1}"
              >
                ${renderCardBack(`
                  width: clamp(78px, 5.7vw, 96px);
                  height: clamp(116px, 8.7vw, 146px);
                  box-shadow: ${isSelected ? '0 16px 24px rgba(0,0,0,0.24)' : '0 10px 18px rgba(0,0,0,0.16)'};
                `)}
              </button>
            `
          })
          .join('')}
      </div>

      <div
        data-cutting-animation-layer
        style="
          position: absolute;
          inset: 0;
          pointer-events: none;
          overflow: visible;
          z-index: 900;
        "
      ></div>
    </div>
  `
}