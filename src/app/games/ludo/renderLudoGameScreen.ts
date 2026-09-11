// Главен екран на Ludo visual prototype — комбинира header, дъска, 4 player
// панела, зар + бутон, долна контролна лента. Responsive: CSS grid, който
// пренарежда player панелите от "около дъската" (desktop) към "stacked
// отгоре/отдолу" (mobile) — виж референтните mockup-и в task-а.
//
// Чист render модул — приема mock state отвън, не пази собствено state.

import { renderLudoBoard } from './board/renderLudoBoard'
import { ludoGridPointForCellId } from './board/ludoBoardGeometry'
import { renderLudoPiecesByCell } from './pieces/renderLudoPieces'
import { renderLudoPlayerPanel } from './pieces/renderLudoPlayerPanel'
import { renderLudoTurnTimer } from './pieces/renderLudoTurnTimer'
import { renderLudoDice } from './dice/renderLudoDice'
import { renderLudoRollButton } from './dice/renderLudoRollButton'
import { renderLudoBottomBar } from './renderLudoBottomBar'
import { renderLudoAnimationStyles } from './ludoAnimationStyles'
import { planLudoHighlights, renderLudoNormalHighlight, renderLudoCaptureImpactRing } from './pieces/renderLudoHighlights'
import type { LudoDiceFace } from './dice/ludoDiceState'
import type { LudoColor, LudoLegalMove, LudoPiece, LudoPlayer } from './ludoTypes'

export interface LudoGameScreenState {
  players: Record<LudoColor, LudoPlayer>
  pieces: LudoPiece[]
  legalMoves: LudoLegalMove[]
  activeColor: LudoColor
  diceResult: LudoDiceFace | null
  diceRotation: { x: number; y: number }
  isDiceRolling: boolean
  canRollDice: boolean
  turnSecondsLeft: number
  useMobileLayout: boolean
}

function renderPlayerPanelSlot(state: LudoGameScreenState, color: LudoColor, compact: boolean): string {
  return renderLudoPlayerPanel(state.players[color], state.pieces, state.activeColor === color, compact)
}

export function renderLudoGameScreen(state: LudoGameScreenState): string {
  const boardHtml = renderLudoBoard()
  const diceHtml = renderLudoDice(state.diceRotation, state.isDiceRolling)
  const rollButtonHtml = renderLudoRollButton(!state.canRollDice)
  const timerHtml = renderLudoTurnTimer('Твой ход', state.turnSecondsLeft)

  if (state.useMobileLayout) {
    return `
      ${renderLudoAnimationStyles()}
      <div data-ludo-screen="1" style="
        display:flex; flex-direction:column;
        min-height:100dvh;
        background:radial-gradient(circle at 50% 0%, #1a2230 0%, #0a0d13 70%);
        box-sizing:border-box;
      ">
        ${renderLudoHeader(true)}

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:8px 10px;">
          ${renderPlayerPanelSlot(state, 'red', true)}
          ${renderPlayerPanelSlot(state, 'blue', true)}
        </div>

        <div style="padding:4px 10px; flex:0 0 auto;">
          ${boardHtml}
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:8px 10px;">
          ${renderPlayerPanelSlot(state, 'green', true)}
          ${renderPlayerPanelSlot(state, 'yellow', true)}
        </div>

        <div style="display:flex; align-items:center; justify-content:center; gap:16px; padding:8px 10px 4px;">
          <div>
            ${diceHtml}
            ${rollButtonHtml}
          </div>
          ${timerHtml}
        </div>

        <div style="flex:1 0 auto; min-height:8px;"></div>
        ${renderLudoBottomBar()}
      </div>
    `
  }

  return `
    ${renderLudoAnimationStyles()}
    <div data-ludo-screen="1" style="
      display:flex; flex-direction:column;
      height:100vh;
      background:radial-gradient(circle at 50% 0%, #1a2230 0%, #0a0d13 70%);
      box-sizing:border-box;
      overflow:hidden;
    ">
      ${renderLudoHeader(false)}

      <div style="
        flex:1;
        min-height:0;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:14px;
        padding:14px 24px;
        box-sizing:border-box;
        overflow-y:auto;
      ">
        <div style="
          position:relative;
          width:min(58vh, 60vw, 620px);
          max-width:100%;
          flex-shrink:0;
        ">
          <div style="position:absolute; left:-4px; top:-4px; transform:translate(-100%, -50%);">${renderPlayerPanelSlot(state, 'red', false)}</div>
          <div style="position:absolute; right:-4px; top:-4px; transform:translate(100%, -50%);">${renderPlayerPanelSlot(state, 'blue', false)}</div>
          <div style="position:absolute; left:-4px; bottom:-4px; transform:translate(-100%, 50%);">${renderPlayerPanelSlot(state, 'green', false)}</div>
          <div style="position:absolute; right:-4px; bottom:-4px; transform:translate(100%, 50%);">${renderPlayerPanelSlot(state, 'yellow', false)}</div>

          ${boardHtml}
        </div>

        <div style="display:flex; align-items:center; justify-content:center; gap:24px; flex-shrink:0;">
          <div>
            ${diceHtml}
            ${rollButtonHtml}
          </div>
          ${timerHtml}
        </div>
      </div>

      ${renderLudoBottomBar()}
    </div>
  `
}

function renderLudoHeader(useMobileLayout: boolean): string {
  return `
    <header style="
      display:flex; align-items:center; justify-content:space-between;
      padding:${useMobileLayout ? '10px 12px' : '14px 28px'};
      border-bottom:1px solid rgba(212,165,32,0.2);
    ">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:${useMobileLayout ? '18px' : '22px'};">&#9819;</span>
        <div>
          <div style="font-size:${useMobileLayout ? '10px' : '11px'}; font-weight:700; color:#d4a520; letter-spacing:0.08em; text-transform:uppercase;">Pika.bg — Още игри</div>
          <div style="font-size:${useMobileLayout ? '15px' : '20px'}; font-weight:900; color:#fff;">Не се сърди човече</div>
        </div>
      </div>
    </header>
  `
}

// Прилага highlight/piece HTML в build-времеви markup — извикван след
// createLudoGameScreen mount-не в DOM; засега прост helper за инициален
// render (следващ patch-driven re-render идва с интерактивност).
export function applyLudoBoardContent(root: ParentNode, state: LudoGameScreenState): void {
  const pieceFragments = renderLudoPiecesByCell(state.pieces, state.legalMoves)
  for (const { cellId, html } of pieceFragments) {
    const container = root.querySelector(`[data-ludo-cell-pieces="${cellId}"]`)
    if (container) container.innerHTML = html
  }

  const highlights = planLudoHighlights(state.legalMoves)
  for (const cellId of highlights.normalCellIds) {
    const el = root.querySelector(`[data-ludo-cell-highlight="${cellId}"]`)
    if (el) {
      el.innerHTML = renderLudoNormalHighlight()
      el.removeAttribute('hidden')
    }
  }

  // Capture ring-овете се рендират в board-level overlay (data-ludo-effects-
  // overlay), НЕ вътре в target клетката — иначе съседни grid клетки,
  // идващи след нея в document order, скриват изтичащата част на ring-а
  // (CSS Grid stacking е по document order при еднакъв z-index). Overlay-ят
  // е absolute-positioned над цялата дъска с висок z-index, затова ring-ът
  // остава изцяло видим независимо къде е target клетката.
  const effectsOverlay = root.querySelector('[data-ludo-effects-overlay="1"]')
  if (effectsOverlay) effectsOverlay.innerHTML = ''
  for (const cellId of highlights.captureCellIds) {
    if (!effectsOverlay) continue
    const point = ludoGridPointForCellId(cellId)
    effectsOverlay.insertAdjacentHTML('beforeend', renderLudoCaptureImpactRing(point))
  }
}
