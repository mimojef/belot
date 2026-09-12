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
import { renderLudoRollButton, renderLudoWaitingActionButton } from './dice/renderLudoRollButton'
import { renderLudoBottomBar } from './renderLudoBottomBar'
import { renderLudoAnimationStyles } from './ludoAnimationStyles'
import { planLudoHighlights, renderLudoNormalHighlight, renderLudoCaptureImpactRing } from './pieces/renderLudoHighlights'
import type { LudoDiceFace } from './dice/ludoDiceState'
import type { LudoColor, LudoLegalMove, LudoPiece, LudoPlayer } from './ludoTypes'

// Desktop board sizing — измерени (не гадани) pixel constants за
// header/bottom bar/action-бутон/padding/gap-ове, за да може дъската да
// заеме ЦЯЛОТО свободно вертикално пространство между header-а и bottom
// bar-а (виж boardRowSizeCss в renderLudoGameScreen по-долу). Стойностите
// са измерени реално в браузъра (getBoundingClientRect) на текущия
// renderLudoHeader/renderLudoBottomBar/renderLudoRollButton markup — не са
// произволни. Нито header-ът, нито bottom bar-ът, нито бутонът ползват
// vh/vw в собствения си CSS, затова височините им са константни
// независимо от viewport размера (проверено на 1280x720...1920x1080).
const LUDO_DESKTOP_HEADER_HEIGHT_PX = 69
const LUDO_DESKTOP_BOTTOM_BAR_HEIGHT_PX = 67
// padding:14px 24px на content wrapper-а (виж desktop return-а долу) — 14
// горе + 14 долу.
const LUDO_DESKTOP_CONTENT_VERTICAL_PADDING_PX = 28
// gap:14px между board реда и action-бутон реда в content wrapper-а.
const LUDO_DESKTOP_ROW_GAP_PX = 14
// renderLudoRollButton: height 46px (padding 12px×2 + line-height) +
// margin-top 10px.
const LUDO_DESKTOP_ACTION_ROW_HEIGHT_PX = 56
const LUDO_DESKTOP_VERTICAL_CHROME_PX =
  LUDO_DESKTOP_HEADER_HEIGHT_PX +
  LUDO_DESKTOP_BOTTOM_BAR_HEIGHT_PX +
  LUDO_DESKTOP_CONTENT_VERTICAL_PADDING_PX +
  LUDO_DESKTOP_ROW_GAP_PX +
  LUDO_DESKTOP_ACTION_ROW_HEIGHT_PX

// Ширинен safety cap (за да не прелее хоризонтално на много тесен-но-висок
// viewport — извън тестовия матрикс от task-а, но пазим от overflow): 24px×2
// content padding + 22px×2 gap между колони/дъска + 144px×2 ширина на
// страничните карета (renderLudoPlayerPanel, desktop non-compact).
const LUDO_DESKTOP_CONTENT_HORIZONTAL_PADDING_PX = 48
const LUDO_DESKTOP_ROW_HORIZONTAL_GAP_PX = 44
const LUDO_DESKTOP_SIDE_CARD_WIDTH_PX = 144
const LUDO_DESKTOP_HORIZONTAL_CHROME_PX =
  LUDO_DESKTOP_CONTENT_HORIZONTAL_PADDING_PX +
  LUDO_DESKTOP_ROW_HORIZONTAL_GAP_PX +
  LUDO_DESKTOP_SIDE_CARD_WIDTH_PX * 2

// boardRow height = min(наличната височина между header/bottom bar минус
// gap-овете и action-бутона, наличната ширина минус страничните карета) —
// т.е. максималният квадрат, който се побира, определян ПРЕДИМНО от
// височината (виж коментара по-горе защо header/bottomBar/action-редът са
// константни в px, независимо от viewport-а).
const LUDO_DESKTOP_BOARD_ROW_SIZE_CSS = `min(calc(100vh - ${LUDO_DESKTOP_VERTICAL_CHROME_PX}px), calc(100vw - ${LUDO_DESKTOP_HORIZONTAL_CHROME_PX}px))`

// Mobile board sizing — същия measured-constants подход като desktop-а
// по-горе, но БЕЗ header (премахнат изцяло на mobile — виж mobile клона на
// renderLudoGameScreen). Стойностите за bottom bar/action row са измерени
// реално в браузъра (renderLudoBottomBar/renderLudoRollButton — идентичен
// markup на двата layout-а, значи идентична височина). cardRowHeight
// отговаря на compact card-а от renderLudoPlayerPanel.ts (avatarSize(58) +
// insetPx(6)*2 + footerHeight(24) + border(2)*2 = 98) — държим го тук
// explicit в коментар, не internal import, за да остане renderLudoGameScreen
// единствен собственик на layout аритметиката (same convention като
// LUDO_DESKTOP_SIDE_CARD_WIDTH_PX по-горе).
const LUDO_MOBILE_BOTTOM_BAR_HEIGHT_PX = 67
const LUDO_MOBILE_ACTION_ROW_HEIGHT_PX = 56
const LUDO_MOBILE_CONTENT_TOP_PADDING_PX = 10
const LUDO_MOBILE_CONTENT_BOTTOM_PADDING_PX = 8
const LUDO_MOBILE_CONTENT_SIDE_PADDING_PX = 12
const LUDO_MOBILE_ROW_GAP_PX = 8
const LUDO_MOBILE_CARD_ROW_HEIGHT_PX = 98
const LUDO_MOBILE_VERTICAL_CHROME_PX =
  LUDO_MOBILE_BOTTOM_BAR_HEIGHT_PX +
  LUDO_MOBILE_CONTENT_TOP_PADDING_PX +
  LUDO_MOBILE_CONTENT_BOTTOM_PADDING_PX +
  LUDO_MOBILE_ROW_GAP_PX * 3 +
  LUDO_MOBILE_CARD_ROW_HEIGHT_PX * 2 +
  LUDO_MOBILE_ACTION_ROW_HEIGHT_PX
const LUDO_MOBILE_HORIZONTAL_CHROME_PX = LUDO_MOBILE_CONTENT_SIDE_PADDING_PX * 2
const LUDO_MOBILE_BOARD_SIZE_CSS = `min(calc(100dvh - ${LUDO_MOBILE_VERTICAL_CHROME_PX}px), calc(100vw - ${LUDO_MOBILE_HORIZONTAL_CHROME_PX}px))`

export interface LudoGameScreenState {
  players: Record<LudoColor, LudoPlayer>
  pieces: LudoPiece[]
  legalMoves: LudoLegalMove[]
  activeColor: LudoColor
  // Date.now() момент, в който активният играч е получил хода си — виж
  // createLudoFlowController.ts коментара при turnStartedAt. Ползва се тук
  // само за да се изчисли real elapsed time за countdown fill-а
  // (renderLudoPlayerPanel) — deadline-базирано, не JS tick брояч.
  turnStartedAt: number
  diceResult: LudoDiceFace | null
  diceRotation: { x: number; y: number }
  isDiceRolling: boolean
  canRollDice: boolean
  turnSecondsLeft: number
  useMobileLayout: boolean
}

function renderPlayerPanelSlot(state: LudoGameScreenState, color: LudoColor, compact: boolean): string {
  const isActive = state.activeColor === color
  // Изчислено ПРИ ВСЕКИ render() спрямо реалния Date.now() — не натрупва
  // грешка и остава коректно дори re-render-ът да е закъснял (browser/tab
  // lag), защото винаги гледа реалния deadline, не брой изминали tick-ове.
  const turnElapsedMs = isActive ? Math.max(0, Date.now() - state.turnStartedAt) : 0
  return renderLudoPlayerPanel(state.players[color], state.pieces, isActive, compact, turnElapsedMs)
}

// "Локален" играч = единственият не-бот в mock състава (Иван/red в
// createLudoMockPlayers) — разграничението "мой ред" vs "чужд ред" за
// desktop-овия единствен action бутон (виж renderLudoGameScreen долу).
// Няма реален auth/сесия в prototype-а, затова isBot е единственият
// наличен сигнал; при реален сървър това ще дойде от snapshot-а.
function resolveLocalPlayerColor(players: Record<LudoColor, LudoPlayer>): LudoColor {
  const localEntry = (Object.entries(players) as Array<[LudoColor, LudoPlayer]>).find(
    ([, player]) => !player.isBot,
  )
  return localEntry ? localEntry[0] : 'red'
}

export function renderLudoGameScreen(state: LudoGameScreenState): string {
  const boardHtml = renderLudoBoard()
  const rollButtonHtml = renderLudoRollButton(!state.canRollDice)

  // Споделено между desktop и mobile: единствен action елемент под/след
  // дъската вместо отделни зар + "Твой ход" каре — countdown-ът за активния
  // играч вече живее в неговото player card (renderLudoPlayerPanel,
  // isActive → gold drain bar), не тук.
  const localColor = resolveLocalPlayerColor(state.players)
  const isLocalPlayerTurn = state.activeColor === localColor
  const currentPlayerName = state.players[state.activeColor].name
  const turnActionHtml = isLocalPlayerTurn
    ? rollButtonHtml
    : renderLudoWaitingActionButton(currentPlayerName)

  if (state.useMobileLayout) {
    // Header-ът НЕ се рендира на mobile изобщо (виж task-а — заема ценна
    // вертикална площ по време на игра). Само тук, само за Ludo mobile
    // gameplay екрана — renderLudoHeader/routing/global header остават
    // напълно недокоснати, desktop продължава да го рендира по-долу.
    //
    // Външният контейнер ползва height:100dvh (не min-height) + overflow:
    // hidden — точно като desktop-а — за да НЕ може съдържанието да прелее
    // извън viewport-а и да се скрие зад bottom bar-а. Средната зона е
    // flex:1;min-height:0, а board размерът (LUDO_MOBILE_BOARD_SIZE_CSS) е
    // изчислен така, че сборът от всички редове+gap-ове+padding+bottom bar
    // да запълва точно 100dvh — bottom bar-ът винаги остава в нормалния
    // flex поток след тази зона, никога зад/под нея.
    return `
      ${renderLudoAnimationStyles()}
      <div data-ludo-screen="1" style="
        display:flex; flex-direction:column;
        height:100dvh;
        background:radial-gradient(circle at 50% 0%, #1a2230 0%, #0a0d13 70%);
        box-sizing:border-box;
        overflow:hidden;
      ">
        <div style="
          flex:1;
          min-height:0;
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:${LUDO_MOBILE_ROW_GAP_PX}px;
          padding:${LUDO_MOBILE_CONTENT_TOP_PADDING_PX}px ${LUDO_MOBILE_CONTENT_SIDE_PADDING_PX}px ${LUDO_MOBILE_CONTENT_BOTTOM_PADDING_PX}px;
          box-sizing:border-box;
          overflow:hidden;
        ">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; justify-items:center; width:100%; flex-shrink:0;">
            ${renderPlayerPanelSlot(state, 'red', true)}
            ${renderPlayerPanelSlot(state, 'blue', true)}
          </div>

          <div style="
            position:relative;
            width:${LUDO_MOBILE_BOARD_SIZE_CSS};
            aspect-ratio:1 / 1;
            flex-shrink:0;
          ">
            ${boardHtml}
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; justify-items:center; width:100%; flex-shrink:0;">
            ${renderPlayerPanelSlot(state, 'green', true)}
            ${renderPlayerPanelSlot(state, 'yellow', true)}
          </div>

          <div style="display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            ${turnActionHtml}
          </div>
        </div>

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
        <div style="display:flex; align-items:stretch; justify-content:center; gap:22px; flex-shrink:0; height:${LUDO_DESKTOP_BOARD_ROW_SIZE_CSS};">
          <div style="display:flex; flex-direction:column; justify-content:space-between; flex-shrink:0;">
            ${renderPlayerPanelSlot(state, 'red', false)}
            ${renderPlayerPanelSlot(state, 'green', false)}
          </div>

          <div style="
            position:relative;
            aspect-ratio:1 / 1;
            flex-shrink:0;
          ">
            ${boardHtml}
          </div>

          <div style="display:flex; flex-direction:column; justify-content:space-between; flex-shrink:0;">
            ${renderPlayerPanelSlot(state, 'blue', false)}
            ${renderPlayerPanelSlot(state, 'yellow', false)}
          </div>
        </div>

        <div style="display:flex; align-items:center; justify-content:center; flex-shrink:0;">
          ${turnActionHtml}
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
