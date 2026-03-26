import { getPlayerDisplayName } from '../../helpers/players.js'
import { escapeHtml } from '../../helpers/formatters.js'
import { renderPlayerAvatar } from './renderPlayerAvatar.js'

export function renderSeatPanel(player, fallbackName, isActive) {
  const safeName = escapeHtml(getPlayerDisplayName(player, fallbackName))

  return `
    <div
      style="
        width: 100%;
        height: 100%;
        border-radius: 18px;
        overflow: hidden;
        background: rgba(15, 23, 42, 0.84);
        border: 2px solid ${isActive ? 'rgba(250, 204, 21, 0.96)' : 'rgba(255,255,255,0.12)'};
        box-shadow: ${isActive ? '0 0 0 4px rgba(250,204,21,0.14), 0 12px 30px rgba(0,0,0,0.24)' : '0 12px 24px rgba(0,0,0,0.20)'};
      "
    >
      <div
        style="
          height: calc(100% - 40px);
          padding: 7px;
        "
      >
        <div
          style="
            width: 100%;
            height: 100%;
            border-radius: 14px;
            overflow: hidden;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.10);
          "
        >
          ${renderPlayerAvatar(player, fallbackName)}
        </div>
      </div>

      <div
        style="
          height: 40px;
          background: rgba(2, 19, 38, 0.96);
          display:flex;
          align-items:center;
          justify-content:center;
          padding: 0 8px;
          color:#f8fafc;
          font-size: clamp(12px, 0.95vw, 16px);
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        "
      >
        ${safeName}
      </div>
    </div>
  `
}
