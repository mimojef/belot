import { getCardId, getCardRank, getCardSuit, getSuitColor, getSuitSymbol, sortBottomHand } from '../../helpers/cards.js'

export function renderBottomHandCards(hand = [], phase, currentTurn, contract, trumpSuit) {
  if (!hand.length) {
    return ''
  }

  const sortedHand = sortBottomHand(hand, contract, trumpSuit)
  const canPlayNow = phase === 'playing' && currentTurn === 'bottom'
  const middleIndex = (sortedHand.length - 1) / 2
  const spreadStep = sortedHand.length >= 8 ? 66 : 78

  return `
    <div
      style="
        position: relative;
        width: min(98vw, 1320px);
        height: clamp(280px, 36vh, 400px);
        margin: 0 auto;
        overflow: visible;
      "
    >
      ${sortedHand
        .map((card, index) => {
          const rank = getCardRank(card)
          const suit = getCardSuit(card)
          const color = getSuitColor(suit)
          const cardId = getCardId(card)

          const offsetFromCenter = index - middleIndex
          const distanceFromCenter = Math.abs(offsetFromCenter)
          const maxDistance = Math.max(middleIndex, 1)
          const normalizedDistance = distanceFromCenter / maxDistance

          const rotate = offsetFromCenter * 7.5
          const horizontal = offsetFromCenter * spreadStep

          // Центърът стои една идея по-високо, а краищата слизат плавно надолу
          const curveLift = 34 - (normalizedDistance * normalizedDistance * 28)

          const zIndex = 100 + index

          return `
            <div
              style="
                position: absolute;
                left: 50%;
                bottom: 0;
                width: clamp(126px, 10vw, 168px);
                height: clamp(184px, 15vw, 238px);
                transform: translateX(calc(-50% + ${horizontal}px)) translateY(-${curveLift}px) rotate(${rotate}deg);
                transform-origin: center bottom;
                z-index: ${zIndex};
                overflow: visible;
              "
            >
              <button
                type="button"
                class="bottom-card-btn"
                onclick="window.playCardAndRender && window.playCardAndRender('${cardId}')"
                onmouseenter="
                  if (${canPlayNow ? 'true' : 'false'}) {
                    this.style.transform='translateY(-9px)';
                    this.style.boxShadow='0 16px 28px rgba(0,0,0,0.24)';
                  }
                "
                onmouseleave="
                  this.style.transform='';
                  this.style.boxShadow='0 10px 20px rgba(0,0,0,0.18)';
                "
                style="
                  width: 100%;
                  height: 100%;
                  border-radius: clamp(12px, 1vw, 16px);
                  border: 1px solid #bda96e;
                  background: #efe4bd;
                  display: flex;
                  flex-direction: column;
                  justify-content: space-between;
                  padding: clamp(8px, 0.75vw, 12px);
                  box-shadow: 0 10px 20px rgba(0,0,0,0.18);
                  transition: transform 0.12s ease, box-shadow 0.12s ease;
                  cursor: ${canPlayNow ? 'pointer' : 'default'};
                  opacity: ${canPlayNow ? '1' : '0.98'};
                  pointer-events: ${canPlayNow ? 'auto' : 'none'};
                  transform-origin: center bottom;
                  position: relative;
                  z-index: 1;
                "
                ${canPlayNow ? '' : 'disabled'}
              >
                <div style="font-size: clamp(24px, 1.9vw, 32px); font-weight:700; color:${color}; text-align:left;">
                  ${rank}
                </div>
                <div style="font-size: clamp(48px, 4vw, 62px); font-weight:700; color:${color}; text-align:center;">
                  ${getSuitSymbol(suit)}
                </div>
                <div style="font-size: clamp(24px, 1.9vw, 32px); font-weight:700; color:${color}; text-align:right;">
                  ${rank}
                </div>
              </button>
            </div>
          `
        })
        .join('')}
    </div>
  `
}