import { formatPlayerName, escapeHtml } from '../../helpers/formatters.js'
import { renderCardBack } from '../common/renderCardBack.js'

export function renderCuttingScreen(gameState = {}, statusText = '') {
  const cuttingPlayer = gameState.cuttingPlayer ?? null
  const isHumanCutting = cuttingPlayer === 'bottom'
  const selectedCutIndex = gameState.selectedCutIndex
  const hasSelectedCutIndex = selectedCutIndex !== null && selectedCutIndex !== undefined

  const primaryTitle = isHumanCutting ? 'ТИ ЦЕПИШ' : `${formatPlayerName(cuttingPlayer).toUpperCase()} ЦЕПИ`

  const subtitle = hasSelectedCutIndex
    ? `Цепенето е избрано от позиция ${Number(selectedCutIndex) + 1}.`
    : isHumanCutting
      ? 'Посочи точната карта, от която искаш да цепиш.'
      : `${formatPlayerName(cuttingPlayer)} цепи картите...`

  const visibleCards = 32
  const middleIndex = (visibleCards - 1) / 2

  return `
    <div
      style="
        width: min(92vw, 1180px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        text-align: center;
      "
    >
      <div
        style="
          font-size: clamp(34px, 4.8vw, 72px);
          line-height: 1;
          font-weight: 900;
          color: #f2a81d;
          text-shadow: 0 3px 0 rgba(0,0,0,0.50), 0 10px 20px rgba(0,0,0,0.18);
          letter-spacing: 0.03em;
        "
      >
        ${primaryTitle}
      </div>

      <div
        style="
          font-size: clamp(20px, 2.1vw, 42px);
          line-height: 1.15;
          font-weight: 700;
          color: #ffffff;
          text-shadow: 0 2px 0 rgba(0,0,0,0.48), 0 8px 18px rgba(0,0,0,0.16);
        "
      >
        ${escapeHtml(subtitle)}
      </div>

      <div
        style="
          position: relative;
          width: min(90vw, 1080px);
          height: clamp(210px, 28vw, 320px);
          margin-top: 6px;
          pointer-events: ${isHumanCutting && !hasSelectedCutIndex ? 'auto' : 'none'};
        "
      >
        ${Array.from({ length: visibleCards })
          .map((_, index) => {
            const offset = index - middleIndex
            const isSelected = index === selectedCutIndex

            const x = offset * 18
            const baseY = Math.abs(offset) * 1.8
            const selectedLift = isSelected ? 24 : 0
            const y = baseY - selectedLift
            const rotate = offset * 1.55
            const zIndex = isSelected ? 500 : 40 + index

            const selectedOutline = isSelected
              ? 'drop-shadow(0 0 0 4px rgba(242,168,29,0.95)) drop-shadow(0 22px 28px rgba(0,0,0,0.28))'
              : 'drop-shadow(0 10px 18px rgba(0,0,0,0.16))'

            return `
              <button
                type="button"
                ${isHumanCutting && !hasSelectedCutIndex ? `onclick="window.confirmCutAndRender && window.confirmCutAndRender(${index})"` : 'disabled'}
                onmouseenter="
                  if (${isHumanCutting && !hasSelectedCutIndex ? 'true' : 'false'}) {
                    this.style.transform='translateX(${x}px) translateY(calc(-50% + ${baseY - 16}px)) rotate(${rotate}deg)';
                    this.style.filter='drop-shadow(0 18px 28px rgba(0,0,0,0.22))';
                  }
                "
                onmouseleave="
                  this.style.transform='translateX(${x}px) translateY(calc(-50% + ${y}px)) rotate(${rotate}deg)';
                  this.style.filter='${selectedOutline}';
                "
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
                  cursor: ${isHumanCutting && !hasSelectedCutIndex ? 'pointer' : 'default'};
                  transition: transform 0.14s ease, filter 0.14s ease;
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

        ${
          hasSelectedCutIndex
            ? `
              <div
                style="
                  position: absolute;
                  left: 50%;
                  bottom: -8px;
                  transform: translateX(-50%);
                  z-index: 220;
                  padding: 8px 14px;
                  border-radius: 12px;
                  background: rgba(242, 168, 29, 0.96);
                  border: 1px solid rgba(255,255,255,0.20);
                  color: #ffffff;
                  font-size: clamp(13px, 0.95vw, 16px);
                  font-weight: 800;
                  white-space: nowrap;
                  pointer-events: none;
                  box-shadow: 0 12px 20px rgba(0,0,0,0.22);
                "
              >
                Избрана позиция за цепене: ${Number(selectedCutIndex) + 1}
              </div>
            `
            : isHumanCutting
              ? `
                <div
                  style="
                    position: absolute;
                    left: 50%;
                    bottom: -8px;
                    transform: translateX(-50%);
                    z-index: 220;
                    padding: 8px 14px;
                    border-radius: 12px;
                    background: rgba(17, 34, 56, 0.78);
                    border: 1px solid rgba(255,255,255,0.10);
                    color: rgba(255,255,255,0.95);
                    font-size: clamp(13px, 0.95vw, 16px);
                    font-weight: 700;
                    white-space: nowrap;
                    pointer-events: none;
                  "
                >
                  Избери точната позиция за цепене
                </div>
              `
              : `
                <div
                  style="
                    position: absolute;
                    left: 50%;
                    bottom: -8px;
                    transform: translateX(-50%);
                    z-index: 220;
                    padding: 8px 14px;
                    border-radius: 12px;
                    background: rgba(17, 34, 56, 0.78);
                    border: 1px solid rgba(255,255,255,0.10);
                    color: rgba(255,255,255,0.95);
                    font-size: clamp(13px, 0.95vw, 16px);
                    font-weight: 700;
                    white-space: nowrap;
                    pointer-events: none;
                  "
                >
                  Изчаква се изборът на ${escapeHtml(formatPlayerName(cuttingPlayer))}
                </div>
              `
        }
      </div>

      ${
        statusText
          ? `
            <div
              style="
                max-width: min(84vw, 820px);
                padding: 12px 18px;
                border-radius: 16px;
                background: rgba(17, 34, 56, 0.72);
                border: 1px solid rgba(255,255,255,0.10);
                color: rgba(255,255,255,0.92);
                font-size: clamp(14px, 1vw, 18px);
                line-height: 1.4;
              "
            >
              ${escapeHtml(statusText)}
            </div>
          `
          : ''
      }
    </div>
  `
}