import { renderMiniCard } from '../common/renderMiniCard.js'

export function renderCurrentTrick(currentTrick = []) {
  const map = {
    bottom: null,
    right: null,
    top: null,
    left: null,
  }

  currentTrick.forEach((entry) => {
    map[entry.playerId] = entry.card
  })

  return `
    <div
      style="
        position: relative;
        width: min(34vw, 360px);
        height: min(28vw, 300px);
        min-width: 220px;
        min-height: 190px;
      "
    >
      <div style="position:absolute; left:50%; top:12%; transform:translateX(-50%) rotate(4deg); z-index:2;">
        ${map.top ? renderMiniCard(map.top) : ''}
      </div>

      <div style="position:absolute; left:18%; top:36%; transform:rotate(-12deg); z-index:3;">
        ${map.left ? renderMiniCard(map.left) : ''}
      </div>

      <div style="position:absolute; right:18%; top:36%; transform:rotate(11deg); z-index:4;">
        ${map.right ? renderMiniCard(map.right) : ''}
      </div>

      <div style="position:absolute; left:50%; bottom:10%; transform:translateX(-50%) rotate(-5deg); z-index:5;">
        ${map.bottom ? renderMiniCard(map.bottom) : ''}
      </div>
    </div>
  `
}
