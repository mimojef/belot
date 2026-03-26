import { getPlayerAvatar, getPlayerDisplayName, getPlayerInitial } from '../../helpers/players.js'
import { escapeHtml } from '../../helpers/formatters.js'

export function renderPlayerAvatar(player, fallbackName) {
  const avatar = getPlayerAvatar(player)
  const displayName = getPlayerDisplayName(player, fallbackName)
  const safeName = escapeHtml(displayName)

  if (avatar) {
    return `
      <img
        src="${escapeHtml(avatar)}"
        alt="${safeName}"
        style="
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        "
      />
    `
  }

  return `
    <div
      style="
        width: 100%;
        height: 100%;
        display:flex;
        align-items:center;
        justify-content:center;
        background:
          radial-gradient(circle at 30% 30%, rgba(255,255,255,0.16), transparent 35%),
          linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)),
          #223854;
        color: rgba(255,255,255,0.92);
        font-size: clamp(22px, 1.8vw, 32px);
        font-weight: 800;
        letter-spacing: 0.02em;
      "
    >
      ${escapeHtml(getPlayerInitial(displayName))}
    </div>
  `
}
