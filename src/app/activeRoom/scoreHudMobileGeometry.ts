// Adaptive HUD scale за тесни mobile viewport-и — Score HUD-ът (renderScoreHud.ts)
// вече се мащабира изцяло чрез stageScale (глобалният stage-fit фактор), но
// stageScale clamp-ва до ACTIVE_ROOM_MIN_STAGE_SCALE (0.46) навсякъде в
// нормалния mobile viewport диапазон (315-412 CSS px) — той не намалява
// допълнително спрямо viewport ширина в този диапазон, докато top-seat
// профилният панел (центриран спрямо viewport центъра, също чрез stageScale)
// се отдалечава от левия ръб пропорционално на viewport ширината. Резултатът:
// HUD-ът (фиксиран natural size × constant stageScale) застъпва top-seat
// панела при тесни viewport-и. Този helper изчислява ДОПЪЛНИТЕЛЕН, чисто
// geometric HUD-specific scale множител (приложен НАД stageScale чрез
// съставно transform:scale — виж renderScoreHud.ts), базиран единствено на
// реалната CSS viewport ширина спрямо top-seat профилния панел.
//
// Всички изчисления стават в ЕДНА координатна система — CSS px — за да не
// се сравняват stage-local px срещу CSS px: natural HUD ширината (300
// stage-local px, виж SCORE_HUD_NATURAL_WIDTH_STAGE_PX) първо се преобразува
// в CSS px чрез умножение по stageScale, СЛЕД което се сравнява с наличното
// CSS пространство до top-seat панела.
//
// Pure, синхронен, детерминистичен — без DOM четене, без window, без rAF/
// ResizeObserver/async. Извикващият код подава реалната CSS viewport ширина
// (виж getRealViewportWidthCssPx()) и текущия stageScale.

export type ScoreHudMobileGeometryInput = {
  viewportWidthCssPx: number
  stageScale: number
  isMobileLayout: boolean
}

export type ScoreHudMobileGeometrySnapshot = {
  hudScale: number
  safeGapCssPx: number
}

// Breakpoint над който HUD-ът остава на своя пълен, одобрен размер
// (hudScale=1) — над тази ширина има достатъчно естествено пространство
// между HUD-а и top-seat панела дори без допълнително смаляване.
export const SCORE_HUD_MOBILE_SCALE_BREAKPOINT_CSS_PX = 360

export const SCORE_HUD_SAFE_GAP_CSS_PX = 5

// Естествената (hudScale=1) визуална ширина на РЕАЛНО РЕНДИРАНИЯ HUD content
// div-а (renderScoreHud.ts: `width:300px`) в STAGE-local px — САМО
// съдържанието, БЕЗ SCORE_HUD_INTERNAL_OFFSET (18px е позиционен left/top
// offset на content div-а спрямо анкора, не част от собствената му width).
// Root cause на предишен бъг тук: делителят при изчисляване на hudScale
// погрешно ползваше offset+width (318), докато реално рендираният content
// div (чиято дясна граница участва в реалния gap до top-seat панела) е само
// width=300 — несъответствието правеше hudScale изкуствено по-малък от
// нужното (реален измерен gap ~11-15px вместо целевите 5px). Мащабира се от
// stageScale, а не от hudScale, за да получим действителната CSS ширина при
// hudScale=1 — референтната точка спрямо която се смята колко допълнително
// трябва да се свие HUD-ът.
export const SCORE_HUD_NATURAL_WIDTH_STAGE_PX = 300

// HUD left inset (виж renderScoreHud.ts: `left: 5 - SCORE_HUD_INTERNAL_OFFSET
// * stageScale`, приложено на анкора, плюс `left: SCORE_HUD_INTERNAL_OFFSET`
// на съдържанието вътре, самото то мащабирано от същия stageScale — двата
// SCORE_HUD_INTERNAL_OFFSET*stageScale члена се съкращават алгебрично,
// оставяйки константен 5 CSS px ляв ръб, независимо от stageScale).
export const SCORE_HUD_LEFT_INSET_CSS_PX = 5

// Top-seat профилен панел (non-bottom shape, renderCuttingSeatPanels.ts):
// layout box 186×234 stage-local px, `transform:scale(0.9)` от
// transform-origin:top center, центриран спрямо anchor центъра (186/2=93,
// тъй като getCuttingSeatPanelAnchorStyle('top', ...) центрира анкора чрез
// `left:50%; transform:translateX(-50%)`, а анкорът няма собствена ширина
// извън auto-layout-а на панела). Left edge на панела в anchor-local px:
// 93 - (186 × 0.9) / 2 = 9.3, т.е. 83.7 stage-local px наляво от anchor
// центъра (viewport центъра).
const TOP_SEAT_PANEL_HALF_WIDTH_STAGE_PX = (186 * 0.9) / 2

// Border/shadow allowance — доказано геометрично като 0, не произволен
// избор: getBoundingClientRect() на панела вече ВКЛЮЧВА border-а физически
// (border е част от layout/паint box-а, border-box sizing), затова добавяне
// на отделен border allowance би било двойно броене. Панелният box-shadow
// (renderCuttingSeatPanelHtml: `0 14px 28px rgba(0,0,0,0.24)` за non-bottom
// seats) има offset-x=0 и spread=0 — сянката се разгръща само вертикално
// (offset-y=14px) и центрирано без хоризонтален spread, затова не added
// hичто отляво на border box-а и не изисква allowance. Предишна версия тук
// имаше фиксиран allowance=3, който предизвика измерено ~8px gap вместо
// целевите 5px — премахнат след реално browser измерване
// (panelRect.left - hudRect.right при allowance=0 съвпадна точно с 5.00px
// на 315/320/359/360px).
const TOP_SEAT_PANEL_BORDER_SHADOW_ALLOWANCE_CSS_PX = 0

function clamp01Max(value: number): number {
  return Math.min(1, value)
}

/**
 * Deterministic, side-effect-free HUD scale за тесни mobile viewport-и.
 * Без DOM четене/запис, без async/rAF/ResizeObserver — само аритметика на
 * подадените входове. Height НЕ участва — height-only viewport промени
 * (напр. mobile keyboard) не могат да променят резултата.
 */
export function getScoreHudMobileGeometry(
  input: ScoreHudMobileGeometryInput,
): ScoreHudMobileGeometrySnapshot {
  if (!input.isMobileLayout || input.viewportWidthCssPx > SCORE_HUD_MOBILE_SCALE_BREAKPOINT_CSS_PX) {
    return { hudScale: 1, safeGapCssPx: SCORE_HUD_SAFE_GAP_CSS_PX }
  }

  const stageScale = input.stageScale > 0 ? input.stageScale : 1

  // Top-seat анкорът е center-анкориран спрямо viewport центъра (same
  // getCuttingSeatPanelAnchorStyle('top', stageScale) transform chain
  // документирана в bottomHandMobileGeometry.ts за bottom seat — идентична
  // линейна проекция: viewportX = viewportWidth/2 + stageScale*(P.x - anchorCenterLocal),
  // тук с P.x = панелният left edge, anchorCenterLocal = 93).
  const topSeatPanelLeftEdgeCssPx =
    input.viewportWidthCssPx / 2 -
    stageScale * TOP_SEAT_PANEL_HALF_WIDTH_STAGE_PX -
    TOP_SEAT_PANEL_BORDER_SHADOW_ALLOWANCE_CSS_PX

  const naturalHudVisualWidthCssPx = SCORE_HUD_NATURAL_WIDTH_STAGE_PX * stageScale

  const availableWidthCssPx =
    topSeatPanelLeftEdgeCssPx - SCORE_HUD_LEFT_INSET_CSS_PX - SCORE_HUD_SAFE_GAP_CSS_PX

  const hudScale = naturalHudVisualWidthCssPx > 0
    ? clamp01Max(Math.max(0, availableWidthCssPx) / naturalHudVisualWidthCssPx)
    : 1

  return { hudScale, safeGapCssPx: SCORE_HUD_SAFE_GAP_CSS_PX }
}
