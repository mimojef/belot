import { getPlayerAvatar, getPlayerDisplayName, getPlayerInitial } from '../../helpers/players.js'
import { escapeHtml } from '../../helpers/formatters.js'

export function renderBottomIdentityBadge(player, fallbackName, currentTurn, cardsCount) {
  const avatar = getPlayerAvatar(player)
  const displayName = getPlayerDisplayName(player, fallbackName)
  const safeName = escapeHtml(displayName)
  const isActive = currentTurn === 'bottom'

  return `
    <div
      style="
        position: absolute;
        left: 50%;
        bottom: 8px;
        transform: translateX(-50%);
        z-index: 420;
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: clamp(240px, 24vw, 340px);
        max-width: min(70vw, 420px);
        padding: 8px 12px;
        border-radius: 18px;
        background: rgba(18, 31, 49, 0.86);
        border: 3px solid ${isActive ? '#f59e0b' : 'rgba(255,255,255,0.12)'};
        box-shadow: ${isActive ? '0 0 0 4px rgba(245,158,11,0.14), 0 14px 30px rgba(0,0,0,0.26)' : '0 12px 24px rgba(0,0,0,0.22)'};
        backdrop-filter: blur(4px);
      "
    >
      <div
        style="
          width: 66px;
          height: 66px;
          border-radius: 14px;
          overflow: hidden;
          flex-shrink: 0;
          border: 2px solid rgba(255,255,255,0.18);
          background: rgba(255,255,255,0.08);
        "
      >
        ${
          avatar
            ? `
              <img
                src="${escapeHtml(avatar)}"
                alt="${safeName}"
                style="width:100%; height:100%; object-fit:cover; display:block;"
              />
            `
            : `
              <div
                style="
                  width:100%;
                  height:100%;
                  display:flex;
                  align-items:center;
                  justify-content:center;
                  background:
                    radial-gradient(circle at 30% 30%, rgba(255,255,255,0.16), transparent 35%),
                    linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)),
                    #223854;
                  color: rgba(255,255,255,0.92);
                  font-size: 28px;
                  font-weight: 800;
                "
              >
                ${escapeHtml(getPlayerInitial(displayName))}
              </div>
            `
        }
      </div>

      <div style="min-width:0; flex:1;">
        <div
          style="
            color:#ffffff;
            font-size: clamp(20px, 1.5vw, 32px);
            line-height: 1.05;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          "
        >
          ${safeName}
        </div>
        <div
          style="
            margin-top: 6px;
            display:inline-flex;
            align-items:center;
            justify-content:center;
            min-width: 120px;
            padding: 6px 12px;
            border-radius: 10px;
            background: #f2a81d;
            color:#ffffff;
            font-size: clamp(14px, 0.9vw, 16px);
            font-weight: 800;
          "
        >
          Карти: ${cardsCount}
        </div>
      </div>
    </div>
  `
}
