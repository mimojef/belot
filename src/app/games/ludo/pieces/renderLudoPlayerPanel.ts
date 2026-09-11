// Player панел (avatar, име, рейтинг, брой пионки в играта) — визуален стил
// следва desktop/mobile референтите: тъмна card, цветна рамка/glow за
// активния играч, малка онлайн точка, компактни pawn-икони за брой пионки.

import { LUDO_COLOR_HEX, LUDO_COLOR_LABEL } from '../ludoTypes'
import type { LudoColor, LudoPiece, LudoPlayer } from '../ludoTypes'

function countPiecesInPlay(pieces: LudoPiece[], color: LudoColor): number {
  return pieces.filter((p) => p.color === color && !p.cell.startsWith('home-')).length
}

function renderPawnDots(color: LudoColor, activeCount: number): string {
  const hex = LUDO_COLOR_HEX[color]
  return Array.from({ length: 4 }, (_, i) => `
    <span style="
      display:inline-block; width:9px; height:9px; border-radius:50% 50% 50% 10%;
      background:${i < activeCount ? hex : 'rgba(255,255,255,0.15)'};
      transform:rotate(45deg);
    "></span>
  `).join('')
}

export function renderLudoPlayerPanel(
  player: LudoPlayer,
  pieces: LudoPiece[],
  isActive: boolean,
  useCompactLayout = false,
): string {
  const hex = LUDO_COLOR_HEX[player.color]
  const activeCount = countPiecesInPlay(pieces, player.color)
  const initials = player.name.trim().slice(0, 1).toUpperCase()

  return `
    <div
      data-ludo-player-panel="${player.color}"
      style="
        display:flex; align-items:center; gap:${useCompactLayout ? '8px' : '12px'};
        background:rgba(10,14,20,0.82);
        border:2px solid ${isActive ? hex : `${hex}55`};
        border-radius:14px;
        padding:${useCompactLayout ? '6px 10px' : '10px 14px'};
        box-shadow:${isActive ? `0 0 0 3px ${hex}33, 0 0 14px ${hex}55` : 'none'};
        transition:box-shadow 200ms ease, border-color 200ms ease;
        min-width:0;
      "
    >
      <div style="position:relative; flex-shrink:0;">
        <div style="
          width:${useCompactLayout ? '34px' : '46px'}; height:${useCompactLayout ? '34px' : '46px'};
          border-radius:50%;
          background:linear-gradient(160deg, #3a3f4a 0%, #1c2128 100%);
          border:2px solid ${hex};
          display:flex; align-items:center; justify-content:center;
          font-weight:800; color:#fff; font-size:${useCompactLayout ? '13px' : '16px'};
          overflow:hidden;
        ">
          ${player.avatarUrl
            ? `<img src="${player.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;">`
            : initials}
        </div>
        <span style="
          position:absolute; right:-1px; bottom:-1px;
          width:10px; height:10px; border-radius:50%;
          background:${hex};
          border:2px solid rgba(10,14,20,0.95);
        "></span>
      </div>

      <div style="min-width:0; flex:1;">
        <div style="
          font-size:${useCompactLayout ? '12px' : '14px'}; font-weight:800; color:#fff;
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        ">${player.name}</div>
        <div style="display:flex; align-items:center; gap:3px; margin-top:2px;">
          ${renderPawnDots(player.color, activeCount)}
        </div>
      </div>
    </div>
  `
}

export function ludoPlayerAriaLabel(player: LudoPlayer): string {
  return `${player.name} — ${LUDO_COLOR_LABEL[player.color]}`
}
