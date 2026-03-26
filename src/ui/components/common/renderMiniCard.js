import { getCardRank, getCardSuit, getSuitColor, getSuitSymbol } from '../../helpers/cards.js'

export function renderMiniCard(card, extraStyle = '') {
  const rank = getCardRank(card)
  const suit = getCardSuit(card)
  const color = getSuitColor(suit)

  return `
    <div
      style="
        width: clamp(64px, 5.5vw, 90px);
        height: clamp(92px, 8vw, 130px);
        border-radius: clamp(10px, 1vw, 14px);
        border: 1px solid #d1d5db;
        background: white;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: clamp(5px, 0.55vw, 8px);
        box-shadow: 0 10px 24px rgba(0,0,0,0.22);
        ${extraStyle}
      "
    >
      <div style="font-size: clamp(16px, 1.05vw, 20px); font-weight: 700; color: ${color};">${rank}</div>
      <div style="font-size: clamp(22px, 1.9vw, 30px); font-weight: 700; color: ${color}; align-self: center;">
        ${getSuitSymbol(suit)}
      </div>
      <div style="font-size: clamp(16px, 1.05vw, 20px); font-weight: 700; color: ${color}; align-self: flex-end;">
        ${rank}
      </div>
    </div>
  `
}
