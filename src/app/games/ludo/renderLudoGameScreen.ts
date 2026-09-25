// Главен екран на Ludo visual prototype — комбинира header, дъска, 4 player
// панела, зар + бутон, долна контролна лента. Responsive: CSS grid, който
// пренарежда player панелите от "около дъската" (desktop) към "stacked
// отгоре/отдолу" (mobile) — виж референтните mockup-и в task-а.
//
// Чист render модул — приема mock state отвън, не пази собствено state.

import {
  renderLudoBoard,
  LUDO_BOARD_GRID_SIZE,
  LUDO_BOARD_FRAME_PADDING_CSS,
  QUADRANT_ORIGIN,
  QUADRANT_SHIFT,
  HOME_QUADRANT_SPAN,
} from './board/renderLudoBoard'
import { mapLudoColorToViewerQuadrant, type LudoViewerQuadrant } from './board/ludoPerspective'
import { renderLudoPiecesByCell } from './pieces/renderLudoPieces'
import { renderLudoPlayerPanel } from './pieces/renderLudoPlayerPanel'
import type { LudoPlayerLeaveStatus, LudoEmojiReactionDirection } from './pieces/renderLudoPlayerPanel'
import { renderLudoBottomBar } from './renderLudoBottomBar'
import { renderLudoAnimationStyles } from './ludoAnimationStyles'
import { LUDO_COLORS } from './ludoTypes'
import type { LudoColor, LudoLegalMove, LudoPiece, LudoPlayer } from './ludoTypes'
import type { LudoTurnPhase } from './engine/ludoEngineTypes'

// Кой canonical цвят пада във viewer quadrant-а `quadrant`, за даден
// localColor — обратна посока на mapLudoColorToViewerQuadrant, нужна за да
// решим КОЙ цвят рендираме на дадена екранна позиция (player panel slot,
// mobile card alignment), вместо hardcoded литерали ('red'/'blue'/...).
function viewerColorAt(quadrant: LudoViewerQuadrant, localColor: LudoColor): LudoColor {
  return LUDO_COLORS.find((color) => mapLudoColorToViewerQuadrant(color, localColor) === quadrant)!
}

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

// Responsive player-panel scale (desktop non-compact layout only) — реален
// bug fix: преди тази промяна board-ът се смаляваше плавно (CSS min()/calc()
// формулата по-горе), но player панелите бяха HARDCODED px константи в
// renderLudoPlayerPanel.ts (avatarSize:124/insetPx:8/footerHeight:38/...),
// напълно независими от board размера — при resize дъската се смаляваше,
// картите не. Fix-ът вързва панелите към ТОЗИ SAME източник (същите chrome
// константи по-горе), не нова паралелна breakpoint система:
// computeLudoDesktopBoardSizePx() е ЧИСТО JS огледало на СЪЩАТА формула,
// която LUDO_DESKTOP_BOARD_ROW_SIZE_CSS вече изразява в CSS (min на
// height-bound/width-bound спрямо СЪЩИТЕ VERTICAL_CHROME_PX/
// HORIZONTAL_CHROME_PX константи) — нужен е конкретен JS number (не CSS
// var()), защото renderLudoDiceControl.ts прави реална аритметика върху
// avatarSize/insetPx (ring size, stroke width, SVG geometry), която CSS
// calc()/var() не може да захрани на markup-build време. Извиква се от
// createLudoFlowController.ts::currentScreenState() при ВСЕКИ render() —
// controller-ът вече има debounced window 'resize' listener, който вика
// render() (виж handleResize), затова тази стойност автоматично следва
// resize-а без отделен ResizeObserver/нова reactive система.
export function computeLudoDesktopBoardSizePx(viewportWidthPx: number, viewportHeightPx: number): number {
  const heightBoundPx = viewportHeightPx - LUDO_DESKTOP_VERTICAL_CHROME_PX
  const widthBoundPx = viewportWidthPx - LUDO_DESKTOP_HORIZONTAL_CHROME_PX
  return Math.max(0, Math.min(heightBoundPx, widthBoundPx))
}

// Reference board size, при/над който панелите остават на ОРИГИНАЛНИЯ си
// fixed дизайн размер (scale=1, avatarSize=124px и т.н. — измерено реално:
// board=642px на 1600x900/1440x900 desktop viewport, LUDO_DESKTOP_SIDE_CARD_
// WIDTH_PX=144px вече е "max" бюджетът, резервиран в HORIZONTAL_CHROME по-
// горе). Под тази граница панелите се смаляват ПРОПОРЦИОНАЛНО с дъската.
// MIN_SCALE е readability/touch floor (задачата explicit позволява разумен
// minimum) — картата никога не пада под 50% от дизайн размера си на desktop
// (компактният mobile layout, отделен breakpoint, си остава напълно
// непроменен и не минава през тази скала).
const LUDO_DESKTOP_PANEL_REFERENCE_BOARD_PX = 640
const LUDO_DESKTOP_PANEL_MIN_SCALE = 0.5

export function computeLudoDesktopPanelScale(viewportWidthPx: number, viewportHeightPx: number): number {
  const boardSizePx = computeLudoDesktopBoardSizePx(viewportWidthPx, viewportHeightPx)
  return Math.min(1, Math.max(LUDO_DESKTOP_PANEL_MIN_SCALE, boardSizePx / LUDO_DESKTOP_PANEL_REFERENCE_BOARD_PX))
}

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
// 3px точно отляво/отдясно на дъската (виж task-а) — board wrapper-ът
// ползва width:100% от тази padded зона, значи board outer edge завършва
// точно SIDE_PADDING px от viewport ръба, когато width-target-ът "печели"
// в min()-а долу (виж LUDO_MOBILE_BOARD_SIZE_CSS). Height-safety клонът
// продължава да пази 360×640/660 от overlap — вертикалният бюджет
// (TOP/BOTTOM padding, ROW_GAP, cardRow, actionRow, bottomBar) е напълно
// непроменен, затова гаранцията срещу clipping там остава същата, каквато
// вече е тествана и одобрена.
const LUDO_MOBILE_CONTENT_SIDE_PADDING_PX = 3
const LUDO_MOBILE_ROW_GAP_PX = 8
const LUDO_MOBILE_CARD_ROW_HEIGHT_PX = 98
// Compact card ширина от renderLudoPlayerPanel.ts (avatarSize(58) +
// insetPx(6)*2 + border(2)*2 = 74) — explicit тук по СЪЩАТА конвенция като
// CARD_ROW_HEIGHT_PX по-горе (renderLudoGameScreen си остава единствен
// owner на layout аритметиката, не internal import), нужна за
// center-alignment формулата долу (полу-ширина за центриране спрямо home
// кръга).
const LUDO_MOBILE_CARD_WIDTH_PX = 74

// Хоризонтално подравняване на mobile player card-овете спрямо РЕАЛНИЯ
// център на съответния голям home кръг на дъската (виж task-а — предният
// fixed-edge-gap подход разместваше картите спрямо кръговете). Формулата
// извежда фракцията (0..1) от 15x15 board grid-а, в която пада центъра на
// всеки home кръг, ползвайки СЪЩИТЕ константи, с които renderLudoBoard.ts
// реално позиционира кръга (QUADRANT_ORIGIN + HOME_QUADRANT_SPAN за
// базовата позиция на quadrant-а, QUADRANT_SHIFT.x за translate()
// изместването navътре) — не е отделна/предположена стойност, а огледало
// на реалната geometry. Приема VIEWER quadrant (не цвят directno) — виж
// viewerColorAt по-горе — защото след viewer rotation-а произволен цвят
// може да седи във всеки от 4-те quadrant-а, а тук трябва РЕАЛНАТА
// rendered позиция, не canonical.
function ludoHomeCircleCenterGridFraction(quadrant: LudoViewerQuadrant): number {
  const origin = QUADRANT_ORIGIN[quadrant]
  const shift = QUADRANT_SHIFT[quadrant]
  const quadrantSpanFraction = HOME_QUADRANT_SPAN / LUDO_BOARD_GRID_SIZE
  const baseFraction = (origin.col - 1 + HOME_QUADRANT_SPAN / 2) / LUDO_BOARD_GRID_SIZE
  const shiftFraction = (shift.x / 100) * quadrantSpanFraction
  return baseFraction + shiftFraction
}

// CSS `left` за card wrapper-а (position:absolute спрямо card row-а), чиято
// широчина е зададена РАВНА на board frame широчината (виж mobile return-а
// долу) — затова "100%" тук реферира точно board frame-а, а не целия
// padded content wrapper, и центърът на картата пада точно върху центъра
// на home кръга независимо кой клон на LUDO_MOBILE_BOARD_SIZE_CSS min()-а
// печели на дадения viewport. LUDO_BOARD_FRAME_PADDING_CSS е ТОЧНО
// стойността, с която renderLudoBoard.ts прави padding на frame-а (внос,
// не дублиран низ), gridFraction е делът от вътрешната 15x15 grid зона
// (frame width минус padding от двете страни), а последните -37px
// (=CARD_WIDTH/2) центрират картата (вместо transform:translateX(-50%),
// директно в left-а — математически идентично, без допълнителен слой).
function ludoMobileCardLeftCss(quadrant: LudoViewerQuadrant): string {
  const gridFraction = ludoHomeCircleCenterGridFraction(quadrant)
  return `calc(${LUDO_BOARD_FRAME_PADDING_CSS} + (100% - 2 * ${LUDO_BOARD_FRAME_PADDING_CSS}) * ${gridFraction} - ${LUDO_MOBILE_CARD_WIDTH_PX / 2}px)`
}
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
  // Explicit viewer identity — ЕДИНСТВЕН source of truth, подаден от
  // controller-а (createLudoFlowController.ts::localColor), НЕ преизчислен
  // тук (виж git history на fix-а: старият resolveLocalPlayerColor()
  // "find first non-bot player" дублираше СЪЩАТА логика в два независими
  // файла — работи само защото засега има точно 1 non-bot в mock roster-а;
  // при реален multiplayer wiring с 2+ real players "first non-bot" вече
  // НЕ би отговорило коректно на "кой съм АЗ" за конкретния client). Board
  // perspective (renderLudoBoard) И piece stacking z-order
  // (renderLudoPieceCluster) четат ТОЗИ same поле — никога независимо
  // пресмятане на localColor извън controller-а.
  localColor: LudoColor
  pieces: LudoPiece[]
  legalMoves: LudoLegalMove[]
  activeColor: LudoColor
  // Authoritative engine turn phase — единственият source на истина за arrow
  // rotation state (виж task-а: "стрелките се въртят САМО когато конкретният
  // играч реално трябва да хвърли зар" = activeColor===playerColor &&
  // turnPhase==='waiting_for_roll'). НЕ извеждай rotation от isDiceRolling
  // (временен UI флаг, само за "flight overlay в момента тече") — точно това
  // беше root cause-ът на бъга (isDiceRolling става false веднага след
  // ROLL_RESOLVED dispatch, но turnPhase вече е awaiting_move_selection, не
  // waiting_for_roll — стрелките грешно се рестартираха точно в този момент).
  turnPhase: LudoTurnPhase
  // Date.now() момент, в който активният играч е получил хода си — виж
  // createLudoFlowController.ts коментара при turnStartedAt. Ползва се тук
  // само за да се изчисли real elapsed time за countdown fill-а
  // (renderLudoPlayerPanel) — deadline-базирано, не JS tick брояч.
  turnStartedAt: number
  // Реалната countdown продължителност за ТЕКУЩАТА фаза на активния играч
  // (10s roll / 15s move / кратък bot-processing delay) — виж
  // orchestrator/ludoOrchestratorTypes.ts LUDO_ROLL_TIMEOUT_MS/
  // LUDO_MOVE_TIMEOUT_MS/LUDO_BOT_THINK_DELAY_MS. Подадена directно от
  // controller-а, не се преизчислява тук (т.19: "запази текущата
  // player-card timer визуализация", само параметрите се различават).
  turnCountdownMs: number
  // Разделя HUMAN REACTION DEADLINE (10s roll / 15s move — реален player
  // countdown, трябва да се вижда като намаляващ timer) от BOT THINK DELAY
  // presentation-detail (~700ms LUDO_BOT_THINK_DELAY_MS — вътрешна пауза
  // преди bot action, НЕ player-facing timeout). true само когато активният
  // играч реално е human, чакащ roll/move decision (виж
  // createLudoFlowController.ts::currentScreenState() —
  // resolveLudoPendingDeadlineKind(...) !== 'none'). Когато false, player
  // панелът показва static (non-animated) countdown presentation — активният
  // играч индикатор остава, но не "изгаря" визуално за bot-ови 700ms.
  isHumanCountdownActive: boolean
  isDiceRolling: boolean
  canRollDice: boolean
  turnSecondsLeft: number
  useMobileLayout: boolean
  // Explicit "Изход" forfeit presentation (виж task-а §3/§4/§8). leftColors
  // е директно engine-ово state.leftColors — canonical, permanent, никога
  // не мига (renderPlayerPanelSlot по-долу показва 'left' статус за всеки
  // цвят в този списък, освен когато СЪЩИЯТ цвят е justLeftColor). justLeft
  // е чисто presentation-only, transient (createLudoFlowController.ts-ов
  // 5-секунден таймер) — показва 'just-left' (мигащо "Излезе от играта")
  // САМО за цвета, чийто leave event ТОКУ-ЩО е бил presented, докато flight-ът/
  // 5-те секунди все още текат. При foreground snap/reconnect justLeftColor
  // винаги е null (виж §8 "не replay-вай historical leave animation") —
  // исторически leftColors показват директно 'left', никога 'just-left'.
  leftColors: readonly LudoColor[]
  justLeftColor: LudoColor | null
  // Виж computeLudoDesktopPanelScale doc коментара по-горе — 1 = ориги-
  // налния fixed дизайн размер (голям desktop viewport), надолу до 0.5 при
  // силно смален board. Игнориран изцяло когато useMobileLayout===true
  // (компактният mobile layout не минава през тази скала).
  desktopPanelScale: number
  // Realtime emoji reaction bubbles (виж task-а "Ludo emoji" §4/§9) —
  // чисто transient presentation, никога persisted/canonical (за разлика
  // от leftColors по-горе). startedAt е Date.now() момента, в който
  // createLudoFlowController.ts е получил server echo-то (виж
  // addEmojiReaction) — elapsed се смята тук, при render(), СЪЩИЯТ pattern
  // като turnElapsedMs по-долу.
  emojiReactions: Partial<Record<LudoColor, { emojiId: string; startedAt: number }>>
}

function renderPlayerPanelSlot(
  state: LudoGameScreenState,
  color: LudoColor,
  compact: boolean,
  localColor: LudoColor,
  emojiDirection: LudoEmojiReactionDirection,
): string {
  const isActive = state.activeColor === color
  // Изчислено ПРИ ВСЕКИ render() спрямо реалния Date.now() — не натрупва
  // грешка и остава коректно дори re-render-ът да е закъснял (browser/tab
  // lag), защото винаги гледа реалния deadline, не брой изминали tick-ове.
  const turnElapsedMs = isActive ? Math.max(0, Date.now() - state.turnStartedAt) : 0
  // dice control замества avatar-а само за активния играч (виж
  // renderLudoPlayerPanel.ts — рендерира се единствено когато isActive е
  // true, затова е безопасно да подадем обекта безусловно тук). isRollable
  // е true само за локалния играч, за да остане click тригерът точно там,
  // където преди беше единственият видим "Хвърли зара" бутон.
  const diceControl = {
    // Огледално на старото `disabled:!state.canRollDice` на бутона — докато
    // roll-ът тече (isDiceRolling → canRollDice=false), click target-ът
    // изчезва (виж renderLudoDiceControl: isRollable=false → без
    // data-ludo-dice-roll-button атрибут, pointer-events:none), same
    // guard като старото disabled state.
    isRollable: isActive && color === localColor && state.canRollDice,
    // Единственото правило за rotating arrows (виж task-а): "ТОЗИ PLAYER В
    // МОМЕНТА ЧАКА ДА ХВЪРЛИ" = activeColor===color && turnPhase===
    // 'waiting_for_roll'. Важи ЕДНАКВО за local human, bot, timeout auto-
    // roll — не отделна логика per actor type (turnPhase вече е authoritative
    // за всички от тях еднакво, engine-ът не различава кой е dispatch-нал
    // действието). НЕ използва isDiceRolling/isRollable/isActive самостоятелно
    // — точно тази по-широка връзка беше root cause-ът на бъга.
    shouldRotateArrows: isActive && state.turnPhase === 'waiting_for_roll',
  }
  // Виж LudoGameScreenState.leftColors/justLeftColor doc коментара —
  // 'just-left' само докато ИМЕННО ТОЗИ цвят е активният transient
  // presentation target; всеки ДРУГ вече напуснал цвят (включително ако
  // justLeftColor сочи към различен, наскоро напуснал цвят в момента) вижда
  // директно постоянното 'left'.
  const leaveStatus: LudoPlayerLeaveStatus = !state.leftColors.includes(color)
    ? null
    : state.justLeftColor === color ? 'just-left' : 'left'

  const emojiReaction = state.emojiReactions[color]
  const emojiPresentation = emojiReaction
    ? {
        reaction: {
          emojiId: emojiReaction.emojiId,
          elapsedMs: Math.max(0, Date.now() - emojiReaction.startedAt),
          // Уникален per (color, emojiId, startedAt) — ново emoji reaction
          // за СЪЩИЯ цвят (дори идентично emojiId) е гарантирано нов DOM
          // node identity, затова CSS animation-ът винаги рестартира чисто
          // (огледално на Belot's reactionKey, виж task-а §7).
          reactionKey: `${color}:${emojiReaction.emojiId}:${emojiReaction.startedAt}`,
        },
        direction: emojiDirection,
      }
    : null

  return renderLudoPlayerPanel(
    state.players[color],
    state.pieces,
    isActive,
    compact,
    turnElapsedMs,
    diceControl,
    state.turnCountdownMs,
    isActive && state.isHumanCountdownActive,
    leaveStatus,
    state.desktopPanelScale,
    emojiPresentation,
  )
}

export function renderLudoGameScreen(state: LudoGameScreenState): string {
  const localColor = state.localColor
  const boardHtml = renderLudoBoard(localColor)

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
          <div style="position:relative; width:${LUDO_MOBILE_BOARD_SIZE_CSS}; height:${LUDO_MOBILE_CARD_ROW_HEIGHT_PX}px; flex-shrink:0;">
            <div style="position:absolute; top:0; left:${ludoMobileCardLeftCss('top-left')};">${renderPlayerPanelSlot(state, viewerColorAt('top-left', localColor), true, localColor, 'down')}</div>
            <div style="position:absolute; top:0; left:${ludoMobileCardLeftCss('top-right')};">${renderPlayerPanelSlot(state, viewerColorAt('top-right', localColor), true, localColor, 'down')}</div>
          </div>

          <div style="
            position:relative;
            width:${LUDO_MOBILE_BOARD_SIZE_CSS};
            aspect-ratio:1 / 1;
            flex-shrink:0;
          ">
            ${boardHtml}
          </div>

          <div style="position:relative; width:${LUDO_MOBILE_BOARD_SIZE_CSS}; height:${LUDO_MOBILE_CARD_ROW_HEIGHT_PX}px; flex-shrink:0;">
            <div style="position:absolute; top:0; left:${ludoMobileCardLeftCss('bottom-left')};">${renderPlayerPanelSlot(state, viewerColorAt('bottom-left', localColor), true, localColor, 'up')}</div>
            <div style="position:absolute; top:0; left:${ludoMobileCardLeftCss('bottom-right')};">${renderPlayerPanelSlot(state, viewerColorAt('bottom-right', localColor), true, localColor, 'up')}</div>
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
            ${renderPlayerPanelSlot(state, viewerColorAt('top-left', localColor), false, localColor, 'right')}
            ${renderPlayerPanelSlot(state, viewerColorAt('bottom-left', localColor), false, localColor, 'right')}
          </div>

          <div style="
            position:relative;
            aspect-ratio:1 / 1;
            flex-shrink:0;
          ">
            ${boardHtml}
          </div>

          <div style="display:flex; flex-direction:column; justify-content:space-between; flex-shrink:0;">
            ${renderPlayerPanelSlot(state, viewerColorAt('top-right', localColor), false, localColor, 'left')}
            ${renderPlayerPanelSlot(state, viewerColorAt('bottom-right', localColor), false, localColor, 'left')}
          </div>
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

// Прилага piece HTML в build-времеви markup — извикван след
// createLudoGameScreen mount-не в DOM; засега прост helper за инициален
// render (следващ patch-driven re-render идва с интерактивност).
//
// Presentation-only visual hints за legal moves/capture (target cell glow,
// selectable-piece ring, capture impact ring) са премахнати нарочно (виж
// task-а "премахни визуалните подсказки след хвърляне на зара") —
// state.legalMoves продължава да се подава непроменено на
// renderLudoPiecesByCell() по-долу, което пази selectable/clickable
// поведението (data-ludo-piece-selectable, pointer-events, click handler)
// изцяло непокътнато; премахнати са само декоративните overlay-и, изградени
// върху planLudoHighlights()/renderLudoNormalHighlight()/
// renderLudoCaptureImpactRing() (виж pieces/renderLudoHighlights.ts —
// exported helper-ите остават дефинирани там, само вече не се извикват
// оттук).
export function applyLudoBoardContent(root: ParentNode, state: LudoGameScreenState): void {
  const localColor = state.localColor
  const pieceFragments = renderLudoPiecesByCell(state.pieces, state.legalMoves, localColor)
  for (const { cellId, html } of pieceFragments) {
    const container = root.querySelector(`[data-ludo-cell-pieces="${cellId}"]`)
    if (container) container.innerHTML = html
  }
}
