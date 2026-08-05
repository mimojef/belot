// Adaptive геометрия за долното (местния играч) mobile ветрило — споделена
// между dealing/bidding fan renderer-а (renderCuttingSeatPanels.ts) и
// playing overlay renderer-а (renderPlayingScreen.ts), за да няма визуален
// скок при прехода last-3 -> playing, и за да не прелива извън по-тесни
// mobile viewport-и.
//
// Транформ верига (виж getCuttingSeatPanelAnchorStyle('bottom', stageScale)
// в cuttingSeatLayout.ts, ползвана идентично от двата renderer-а):
//   1. anchor div: position:fixed; left:50%; bottom:5px;
//      transform:translateX(-50%) scale(stageScale); transform-origin:bottom center;
//      (анкорът има естествен layout box 360×138 — BOTTOM_PANEL_WIDTH/HEIGHT.)
//   2. fan wrapper (1×1px): position:absolute; left:180px; top:24px; (мобилен
//      bottom seat center, вкл. BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET)
//   3. всяка карта: left:50%;top:50%; transform:translate(-50%,-50%)
//      translate(offsetX,offsetY) rotate(rotate);
//
// Композирайки тези transform-и (transform-origin композиция, translateX(-50%)
// винаги спрямо НЕтрансформираната ширина 360px), точка P от anchor-box
// координати се проектира във viewport CSS px като:
//
//   viewportX = viewportWidth/2 + stageScale * (P.x - 180)
//
// Т.е. хоризонталната позиция е ЛИНЕЙНА функция на stageScale, центрирана
// точно на viewportWidth/2 (плюс пренебрежимо малка sub-pixel корекция от
// `left:50%` върху 1px-широкия fan wrapper — CENTER_X_LOCAL_PX_CORRECTION).
// Затова fitting-ът тук работи изцяло в "anchor-local" (pre-scale) единици и
// после умножава по stageScale, вместо да борави directly със stage px.

export type BottomHandMobileGeometryInput = {
  viewportWidthCssPx: number
  stageScale: number
  targetCardCount: number
}

export type BottomHandMobileGeometrySnapshot = {
  cardWidth: number
  cardHeight: number
  spacing: number
  rotationStep: number
  centerXCorrection: number
  centerYOffset: number
  safeEdgeInsetCssPx: number
  calculatedBoundingWidthCssPx: number
  scaleFactor: number
}

export const BOTTOM_HAND_MOBILE_TARGET_CARD_COUNT = 8

// "Одобрен" максимален изглед (виж CLAUDE.md "Deal-last-3 фаза" / bidding) —
// прилага се непроменен, докато viewport-ът е достатъчно широк.
export const BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH = 211
export const BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT = 307
export const BOTTOM_HAND_MOBILE_MAX_SPACING = 70
export const BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP = 5
export const BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET = -26

// Стъпка A минимум: пренизползва СЪЩАТА "compact" spacing/rotation стойност,
// която вече е одобрена и shipped в renderCuttingSeatPanels.ts за другите
// (non-bottom) mobile fan-ове на същия card-width клас — не е произволно
// избрана стойност, а установен в кода legibility праг за тази артworks.
export const BOTTOM_HAND_MOBILE_MIN_SPACING = 42
export const BOTTOM_HAND_MOBILE_MIN_ROTATION_STEP = 3.4

// Стъпка B минимум: под 211×307 картата се смалява пропорционално, но не
// повече от този factor — при min stageScale (0.46, виж
// ACTIVE_ROOM_MIN_STAGE_SCALE) card width 211*0.6≈127 local px все още дава
// >55 CSS px реален render width, комфортно над стандартния ~44px min touch
// target.
export const BOTTOM_HAND_MOBILE_MIN_SCALE_FACTOR = 0.6

export const SAFE_EDGE_INSET_CSS_PX = 5

// Sub-pixel асиметрия от `left:50%` върху 1px-широкия fan wrapper div
// (0.5% от 1px = 0.5px, в anchor-local единици, преди stageScale). Реална,
// доказуема от transform веригата, а не произволна "магическа" корекция.
const CENTER_X_LOCAL_PX_CORRECTION = 0.5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function rotatedHalfWidth(cardWidth: number, cardHeight: number, rotationDeg: number): number {
  const rotationRad = (rotationDeg * Math.PI) / 180
  return (
    (cardWidth / 2) * Math.abs(Math.cos(rotationRad)) +
    (cardHeight / 2) * Math.abs(Math.sin(rotationRad))
  )
}

// Пълният (не наближен) axis-aligned bounding half-width на крайната
// (най-въртяна, най-раздалечена) карта във ветрилото, в anchor-local
// единици — отчита rotation + translate(-50%,-50%) + transform-origin
// (виж модулния коментар по-горе), не само `cardWidth + spacing*(N-1)/2`.
function localHalfSpan(
  cardWidth: number,
  cardHeight: number,
  spacing: number,
  rotationStep: number,
  maxCentered: number,
): number {
  const extremeRotationDeg = maxCentered * rotationStep
  return (
    maxCentered * spacing +
    rotatedHalfWidth(cardWidth, cardHeight, extremeRotationDeg) +
    CENTER_X_LOCAL_PX_CORRECTION
  )
}

/**
 * Deterministic, side-effect-free fitting на долното mobile card ветрило.
 * Без DOM четене/запис, без async/rAF/ResizeObserver — само аритметика на
 * подадените входове. Викащият код е отговорен да подаде реалната CSS
 * viewport ширина и текущия stageScale (виж getRealViewportWidthCssPx() и
 * getActiveRoomStageMetrics()).
 */
export function getBottomHandMobileGeometry(
  input: BottomHandMobileGeometryInput,
): BottomHandMobileGeometrySnapshot {
  const targetCardCount = Math.max(1, Math.floor(input.targetCardCount))
  const maxCentered = Math.max(0, (targetCardCount - 1) / 2)
  const stageScale = input.stageScale > 0 ? input.stageScale : 1
  const availableHalfWidthCssPx = Math.max(0, input.viewportWidthCssPx / 2 - SAFE_EDGE_INSET_CSS_PX)
  const availableHalfWidthLocalPx = availableHalfWidthCssPx / stageScale

  let cardWidth = BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH
  let cardHeight = BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT
  let spacing = BOTTOM_HAND_MOBILE_MAX_SPACING
  let rotationStep = BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP

  if (maxCentered > 0) {
    // Стъпка A: намали spacing (карта и rotation остават на максимум).
    if (localHalfSpan(cardWidth, cardHeight, spacing, rotationStep, maxCentered) > availableHalfWidthLocalPx) {
      const halfRotatedWidthAtMax = rotatedHalfWidth(cardWidth, cardHeight, maxCentered * rotationStep)
      const requiredSpacing =
        (availableHalfWidthLocalPx - halfRotatedWidthAtMax - CENTER_X_LOCAL_PX_CORRECTION) / maxCentered
      spacing = clamp(requiredSpacing, BOTTOM_HAND_MOBILE_MIN_SPACING, BOTTOM_HAND_MOBILE_MAX_SPACING)
    }

    // Стъпка B: spacing на минимум — смали картите пропорционално (запазва
    // aspect ratio 211:307).
    if (localHalfSpan(cardWidth, cardHeight, spacing, rotationStep, maxCentered) > availableHalfWidthLocalPx) {
      spacing = BOTTOM_HAND_MOBILE_MIN_SPACING
      const halfRotatedWidthAtMaxCardSize = rotatedHalfWidth(
        BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH,
        BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT,
        maxCentered * rotationStep,
      )
      const requiredHalfRotatedWidth =
        availableHalfWidthLocalPx - maxCentered * spacing - CENTER_X_LOCAL_PX_CORRECTION
      const rawScaleFactor =
        halfRotatedWidthAtMaxCardSize > 0 ? requiredHalfRotatedWidth / halfRotatedWidthAtMaxCardSize : 1
      const scaleFactor = clamp(rawScaleFactor, BOTTOM_HAND_MOBILE_MIN_SCALE_FACTOR, 1)
      cardWidth = BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH * scaleFactor
      cardHeight = BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT * scaleFactor
    }

    // Стъпка C (последна мярка): spacing и card size на минимум — намали
    // rotation step, но никога до 0. Бинарно търсене (детерминистично,
    // фиксиран брой итерации), защото rotatedHalfWidth не е тривиално
    // обратима спрямо ъгъла в затворена форма.
    if (localHalfSpan(cardWidth, cardHeight, spacing, rotationStep, maxCentered) > availableHalfWidthLocalPx) {
      if (
        localHalfSpan(cardWidth, cardHeight, spacing, BOTTOM_HAND_MOBILE_MIN_ROTATION_STEP, maxCentered) >
        availableHalfWidthLocalPx
      ) {
        // Дори минималният rotation step не стига — използвай пода
        // (по-нататъшно свиване би нарушило "не го нулирай").
        rotationStep = BOTTOM_HAND_MOBILE_MIN_ROTATION_STEP
      } else {
        let lo = BOTTOM_HAND_MOBILE_MIN_ROTATION_STEP
        let hi = rotationStep
        for (let i = 0; i < 30; i += 1) {
          const mid = (lo + hi) / 2
          if (localHalfSpan(cardWidth, cardHeight, spacing, mid, maxCentered) <= availableHalfWidthLocalPx) {
            lo = mid
          } else {
            hi = mid
          }
        }
        rotationStep = lo
      }
    }
  }

  const finalLocalHalfSpan = localHalfSpan(cardWidth, cardHeight, spacing, rotationStep, maxCentered)

  return {
    cardWidth,
    cardHeight,
    spacing,
    rotationStep,
    centerXCorrection: CENTER_X_LOCAL_PX_CORRECTION,
    centerYOffset: BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET,
    safeEdgeInsetCssPx: SAFE_EDGE_INSET_CSS_PX,
    calculatedBoundingWidthCssPx: 2 * finalLocalHalfSpan * stageScale,
    scaleFactor: cardWidth / BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH,
  }
}
