/**
 * checkBottomHandMobileAdaptiveGeometry.ts
 *
 * Regression checks за adaptive mobile bottom-hand ветрилото
 * (src/app/activeRoom/bottomHandMobileGeometry.ts).
 *
 * История на два свързани бъга тук:
 *
 *  Бъг #1 (overflow): cardWidth/cardHeight/spacing/rotationStep бяха
 *  фиксирани module-level константи (BOTTOM_HAND_MOBILE_CARD_WIDTH и т.н. в
 *  activeRoomShared.ts), независими от реалната viewport ширина — на всеки
 *  viewport под ~385 CSS px (при pinned stageScale=0.46, виж
 *  ACTIVE_ROOM_MIN_STAGE_SCALE) крайната карта искаше повече anchor-local
 *  half-span, отколкото имаше налично място. Фиксирано с getBottomHandMobileGeometry()
 *  — sizing/spacing/rotation се изчисляват предварително за targetCardCount=8
 *  и се вместват в safe inset от 5 CSS px.
 *
 *  Бъг #2 (ляво подравняване по време на раздаване): първата версия на
 *  фикса за #1 ГРЕШНО центрираше и ПОЗИЦИЯТА (не само размера) спрямо
 *  фиксирания targetCardCount=8 — т.е. getFanOffset смяташе `centered` спрямо
 *  8 фиксирани слота, вместо спрямо текущо видимия брой карти. Резултат:
 *  first-3/next-2 картите заемаха левите 3/5 от осемте крайни слота, вместо
 *  да са центрирани като видима група — ръката изглеждаше все едно се
 *  раздава отляво надясно. Коригирано: sizing (cardWidth/cardHeight/spacing/
 *  rotationStep) продължава да идва от snapshot-а, предварително изчислен
 *  за targetCardCount=8, но ПОЗИЦИОНИРАНЕТО (centered/maxCentered/
 *  edgeProgress в getFanOffset) вече използва текущо видимия `count`
 *  (visibleCardCount) — точно както desktop/non-mobile клоновете винаги са
 *  правили.
 *
 * Три вида проверки тук:
 *  A) Директно извикване на чистата getBottomHandMobileGeometry() — доказва
 *     самия sizing/fitting алгоритъм (targetCardCount=8 фиксиран вход,
 *     idempotent, min/max clamps, реален inset >= 5px на изисканите
 *     viewport-и, стъпки A/B/C от fitting стратегията). НЕПРОМЕНЕНО от Бъг #2
 *     фикса — sizing алгоритъмът не е пипан.
 *  B) Аналитични bounding-box проверки (независимо пресъздаване на реалната
 *     transform верига от getCuttingSeatPanelAnchorStyle('bottom', ...) +
 *     всяка карта — виж модулния коментар в bottomHandMobileGeometry.ts) —
 *     доказват, че при visibleCardCount=3/5/8 bounding-box центърът остава
 *     един и същ и левият/десният extent са симетрични.
 *  C) Source-text проверки (jsdom не е налична зависимост — established
 *     стил, виж checkPrivateRoomWaitInLobby.ts) върху реалните
 *     renderer/controller файлове.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getBottomHandMobileGeometry,
  BOTTOM_HAND_MOBILE_TARGET_CARD_COUNT,
  BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH,
  BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT,
  BOTTOM_HAND_MOBILE_MAX_SPACING,
  BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP,
  BOTTOM_HAND_MOBILE_MIN_SPACING,
  BOTTOM_HAND_MOBILE_MIN_ROTATION_STEP,
  SAFE_EDGE_INSET_CSS_PX,
} from '../src/app/activeRoom/bottomHandMobileGeometry.ts'
import { getViewportStageMetrics } from '../src/ui/layout/viewportStage.ts'
import {
  ACTIVE_ROOM_STAGE_WIDTH,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_MIN_STAGE_SCALE,
  ACTIVE_ROOM_MAX_STAGE_SCALE,
  ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
  ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
} from '../src/app/activeRoom/activeRoomShared.ts'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

function readSourceNormalized(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

console.log('\ncheckBottomHandMobileAdaptiveGeometry\n')

// ─── A) Pure sizing algorithm — real stageScale via getViewportStageMetrics ─

function stageScaleForViewport(width: number, height: number): number {
  ;(globalThis as unknown as { window: unknown }).window = { innerWidth: width, innerHeight: height }
  try {
    return getViewportStageMetrics({
      baseWidth: ACTIVE_ROOM_STAGE_WIDTH,
      baseHeight: ACTIVE_ROOM_STAGE_HEIGHT,
      minScale: ACTIVE_ROOM_MIN_STAGE_SCALE,
      maxScale: ACTIVE_ROOM_MAX_STAGE_SCALE,
      viewportHorizontalPadding: ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
      viewportVerticalPadding: ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
    }).stageScale
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
}

const REQUIRED_VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 315, height: 660 },
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 360, height: 705 },
  { width: 375, height: 667 },
  { width: 390, height: 705 },
  { width: 412, height: 915 },
]

for (const { width, height } of REQUIRED_VIEWPORTS) {
  const stageScale = stageScaleForViewport(width, height)
  const snapshot = getBottomHandMobileGeometry({
    viewportWidthCssPx: width,
    stageScale,
    targetCardCount: BOTTOM_HAND_MOBILE_TARGET_CARD_COUNT,
  })
  const leftInset = (width - snapshot.calculatedBoundingWidthCssPx) / 2
  const rightInset = leftInset
  check(
    `[5][sizing] ${width}x${height}: left inset >= ${SAFE_EDGE_INSET_CSS_PX}px at visibleCardCount=8 (got ${leftInset.toFixed(2)}px, stageScale=${stageScale.toFixed(3)})`,
    leftInset >= SAFE_EDGE_INSET_CSS_PX - 0.01,
  )
  check(
    `[5][sizing] ${width}x${height}: right inset >= ${SAFE_EDGE_INSET_CSS_PX}px at visibleCardCount=8`,
    rightInset >= SAFE_EDGE_INSET_CSS_PX - 0.01,
  )
  check(
    `[min] ${width}x${height}: spacing never below floor ${BOTTOM_HAND_MOBILE_MIN_SPACING} (got ${snapshot.spacing.toFixed(2)})`,
    snapshot.spacing >= BOTTOM_HAND_MOBILE_MIN_SPACING - 0.001,
  )
  check(
    `[min] ${width}x${height}: rotationStep never zeroed (got ${snapshot.rotationStep.toFixed(2)})`,
    snapshot.rotationStep > 0 && snapshot.rotationStep >= BOTTOM_HAND_MOBILE_MIN_ROTATION_STEP - 0.001,
  )
  check(
    `[aspect] ${width}x${height}: cardWidth/cardHeight preserves 211:307 aspect ratio`,
    Math.abs(snapshot.cardWidth / snapshot.cardHeight - BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH / BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT) < 0.001,
  )
}

// [1] The sizing helper's only count-like input is targetCardCount, and it
// is always called with 8 — the geometry it returns describes an 8-card fan
// regardless of how many cards are actually visible right now.
{
  const snapshotA = getBottomHandMobileGeometry({ viewportWidthCssPx: 360, stageScale: 0.46, targetCardCount: BOTTOM_HAND_MOBILE_TARGET_CARD_COUNT })
  const snapshotB = getBottomHandMobileGeometry({ viewportWidthCssPx: 360, stageScale: 0.46, targetCardCount: BOTTOM_HAND_MOBILE_TARGET_CARD_COUNT })
  check(
    '[1] sizing helper is always invoked with targetCardCount=8 (calling it twice, simulating separate first-3/next-2 render passes, returns identical geometry)',
    JSON.stringify(snapshotA) === JSON.stringify(snapshotB),
  )
}

// [9] Pure / idempotent: same inputs -> identical result, every field.
{
  const a = getBottomHandMobileGeometry({ viewportWidthCssPx: 375, stageScale: 0.46, targetCardCount: 8 })
  const b = getBottomHandMobileGeometry({ viewportWidthCssPx: 375, stageScale: 0.46, targetCardCount: 8 })
  check('[9] repeated call with identical inputs returns a deep-equal result', JSON.stringify(a) === JSON.stringify(b))
}

// [max] Wide viewport keeps the exact approved max look untouched.
{
  const stageScale = stageScaleForViewport(1024, 800)
  const snapshot = getBottomHandMobileGeometry({ viewportWidthCssPx: 1024, stageScale, targetCardCount: 8 })
  check('[max] wide viewport: cardWidth stays at approved max 211', snapshot.cardWidth === BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH)
  check('[max] wide viewport: cardHeight stays at approved max 307', snapshot.cardHeight === BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT)
  check('[max] wide viewport: spacing stays at approved max 70', snapshot.spacing === BOTTOM_HAND_MOBILE_MAX_SPACING)
  check('[max] wide viewport: rotationStep stays at approved max 5', snapshot.rotationStep === BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP)
  check('[max] wide viewport: centerYOffset stays -26', snapshot.centerYOffset === -26)
}

// Fitting strategy steps B/C actually engage for an artificially narrow
// width (well below any real supported phone) — proves the sizing algorithm
// itself is untouched/still works, separate from the positioning fix below.
{
  const snapshotNarrow = getBottomHandMobileGeometry({ viewportWidthCssPx: 150, stageScale: 0.46, targetCardCount: 8 })
  check('[stepB] extremely narrow viewport (150px): card size shrinks below max (scaleFactor < 1)', snapshotNarrow.scaleFactor < 1)
  check('[stepB] extremely narrow viewport (150px): spacing pinned at floor', snapshotNarrow.spacing === BOTTOM_HAND_MOBILE_MIN_SPACING)
  check(
    '[stepC] extremely narrow viewport (150px): rotationStep reduced but never zero',
    snapshotNarrow.rotationStep > 0 && snapshotNarrow.rotationStep <= BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP,
  )
}

// ─── B) Analytical bounding-box symmetry/center-stability per visibleCardCount ─
//
// Независимо пресъздаване на реалната transform верига (виж модулния
// коментар в bottomHandMobileGeometry.ts): за seat 'bottom' анкорът е
// position:fixed; left:50%; bottom:5px; transform:translateX(-50%)
// scale(stageScale); transform-origin:bottom center — с 360×138 layout box.
// Всяка карта: left:50%;top:50% (спрямо 1px fan wrapper на
// (fanCenterX,fanCenterY)=(180,24) anchor-local); transform:translate(-50%,
// -50%) translate(offsetX,offsetY) rotate(rotate). Комбинирано:
//   viewportX = viewportWidth/2 + stageScale * (0.5 + offsetX ± halfRotatedWidth)
// където 0.5 е sub-pixel корекцията от left:50% върху 1px box-а.
function cardEdgesCssPx(params: {
  index: number
  visibleCardCount: number
  cardWidth: number
  cardHeight: number
  spacing: number
  rotationStep: number
  stageScale: number
  viewportWidthCssPx: number
}): { left: number; right: number } {
  const centered = params.index - (params.visibleCardCount - 1) / 2
  const offsetX = centered * params.spacing
  const rotationRad = (centered * params.rotationStep * Math.PI) / 180
  const halfRotatedWidth =
    (params.cardWidth / 2) * Math.abs(Math.cos(rotationRad)) +
    (params.cardHeight / 2) * Math.abs(Math.sin(rotationRad))
  const subPixelCorrection = 0.5
  const localLeft = subPixelCorrection + offsetX - halfRotatedWidth
  const localRight = subPixelCorrection + offsetX + halfRotatedWidth
  return {
    left: params.viewportWidthCssPx / 2 + params.stageScale * localLeft,
    right: params.viewportWidthCssPx / 2 + params.stageScale * localRight,
  }
}

function fanBoundsCssPx(
  visibleCardCount: number,
  geometry: { cardWidth: number; cardHeight: number; spacing: number; rotationStep: number },
  stageScale: number,
  viewportWidthCssPx: number,
): { left: number; right: number; center: number } {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  for (let index = 0; index < visibleCardCount; index += 1) {
    const edges = cardEdgesCssPx({
      index,
      visibleCardCount,
      cardWidth: geometry.cardWidth,
      cardHeight: geometry.cardHeight,
      spacing: geometry.spacing,
      rotationStep: geometry.rotationStep,
      stageScale,
      viewportWidthCssPx,
    })
    left = Math.min(left, edges.left)
    right = Math.max(right, edges.right)
  }
  return { left, right, center: (left + right) / 2 }
}

for (const { width, height } of REQUIRED_VIEWPORTS) {
  const stageScale = stageScaleForViewport(width, height)
  const geometry = getBottomHandMobileGeometry({ viewportWidthCssPx: width, stageScale, targetCardCount: 8 })

  const bounds3 = fanBoundsCssPx(3, geometry, stageScale, width)
  const bounds5 = fanBoundsCssPx(5, geometry, stageScale, width)
  const bounds8 = fanBoundsCssPx(8, geometry, stageScale, width)

  check(
    `[3] ${width}x${height}: 3 visible cards are centered — left/right extent symmetric around the fan center (left=${bounds3.left.toFixed(2)}, right=${bounds3.right.toFixed(2)}, center=${bounds3.center.toFixed(2)})`,
    Math.abs(bounds3.center - width / 2) < stageScale * 1 + 0.05,
  )
  check(
    `[4] ${width}x${height}: 5 visible cards are centered — left/right extent symmetric around the fan center`,
    Math.abs(bounds5.center - width / 2) < stageScale * 1 + 0.05,
  )
  check(
    `[5] ${width}x${height}: 8 visible cards are centered, left inset >= 5px, right inset >= 5px (left=${bounds8.left.toFixed(2)}, right=${(width - bounds8.right).toFixed(2)})`,
    bounds8.left >= SAFE_EDGE_INSET_CSS_PX - 0.05 && width - bounds8.right >= SAFE_EDGE_INSET_CSS_PX - 0.05,
  )
  check(
    `[center-stable] ${width}x${height}: bounding-box center is the SAME for 3, 5 and 8 visible cards (${bounds3.center.toFixed(2)} / ${bounds5.center.toFixed(2)} / ${bounds8.center.toFixed(2)})`,
    Math.abs(bounds3.center - bounds5.center) < 0.05 && Math.abs(bounds5.center - bounds8.center) < 0.05,
  )
}

// ─── D) Vertical edge-drop (first-3 3-card fan shallowing fix) ─────────────
//
// Bug: mobile bottom fan always used countProgress=1 (full edgeDropMax=34,
// same as the 8-card fan) regardless of visibleCardCount, unlike the other
// (non-bottom) mobile seats — which already scale their edgeDropMax down via
// compact=true (20) AND countProgress≈(count-1)/7. At visibleCardCount=3
// (the first-3 deal phase), this made the two edge cards drop a full 34
// stage px below the center card — visibly deeper than the natural 3-card
// arc the other three seats show, and deeper than intended.
//
// Fix: BOTTOM_HAND_MOBILE_THREE_CARD_EDGE_DROP_FACTOR (0.5) is applied to
// edgeDrop ONLY when mobileBottomSeat && count === 3 — halving the edge-card
// vertical drop for exactly that one case. x (horizontal spacing) and
// rotate (rotationStep) are untouched by this factor; count=5/8 use
// factor=1 (bit-for-bit unchanged formula).
function verticalEdgeDropStagePx(
  index: number,
  count: number,
  edgeDropMax: number,
  countProgress: number,
  threeCardEdgeDropFactor: number,
): number {
  const centered = index - (count - 1) / 2
  const maxCentered = Math.max(1, (count - 1) / 2)
  const edgeProgress = Math.abs(centered) / maxCentered
  return edgeProgress * edgeProgress * edgeDropMax * countProgress * threeCardEdgeDropFactor
}

const MOBILE_BOTTOM_EDGE_DROP_MAX = 34 // edgeDropMax when compact=false (mobileBottomSeat is always non-compact)
const MOBILE_BOTTOM_COUNT_PROGRESS = 1 // mobileBottomSeat forces countProgress=1 regardless of count
const THREE_CARD_EDGE_DROP_FACTOR = 0.5 // must match BOTTOM_HAND_MOBILE_THREE_CARD_EDGE_DROP_FACTOR

// [D1] At count=3 (first-3), the two edge cards (index 0 and 2) sit at the
// SAME Y (symmetric), and the center card (index 1) is strictly higher
// (smaller Y = higher on screen, since Y is a downward drop from center).
{
  const yLeft = verticalEdgeDropStagePx(0, 3, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, THREE_CARD_EDGE_DROP_FACTOR)
  const yCenter = verticalEdgeDropStagePx(1, 3, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, THREE_CARD_EDGE_DROP_FACTOR)
  const yRight = verticalEdgeDropStagePx(2, 3, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, THREE_CARD_EDGE_DROP_FACTOR)
  check(`[D1] first-3 mobile bottom: left and right edge cards are at the same Y drop (left=${yLeft}, right=${yRight})`, yLeft === yRight)
  check(`[D1] first-3 mobile bottom: center card (y=${yCenter}) sits higher than the edge cards (y=${yLeft})`, yCenter < yLeft)
  check('[D1] first-3 mobile bottom: center card has zero edge-drop (unmoved)', yCenter === 0)
}

// [D2] The new (post-fix) edge-drop at count=3 is strictly smaller than the
// old (pre-fix, factor=1) edge-drop would have been — proves the fan is now
// shallower, not just repositioned.
{
  const oldEdgeDrop = verticalEdgeDropStagePx(0, 3, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, 1)
  const newEdgeDrop = verticalEdgeDropStagePx(0, 3, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, THREE_CARD_EDGE_DROP_FACTOR)
  check(`[D2] first-3 mobile bottom: new edge-drop (${newEdgeDrop} stage px) is strictly less than the old full edge-drop (${oldEdgeDrop} stage px)`, newEdgeDrop < oldEdgeDrop)
  check('[D2] old (pre-fix) edge-drop at count=3 was the full 34 stage px', oldEdgeDrop === 34)
  check('[D2] new (post-fix) edge-drop at count=3 is 17 stage px (34 × 0.5)', newEdgeDrop === 17)
}

// [D3] count=5 (next-2/bidding) and count=8 (last-3/playing) are COMPLETELY
// unaffected — the factor only engages at exactly count===3.
{
  for (const count of [5, 8]) {
    const oldEdgeDrop = verticalEdgeDropStagePx(0, count, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, 1)
    const unaffectedEdgeDrop = verticalEdgeDropStagePx(0, count, MOBILE_BOTTOM_EDGE_DROP_MAX, MOBILE_BOTTOM_COUNT_PROGRESS, count === 3 ? THREE_CARD_EDGE_DROP_FACTOR : 1)
    check(`[D3] count=${count}: edge-drop is unchanged by the first-3 fix (${unaffectedEdgeDrop} stage px, same as before)`, unaffectedEdgeDrop === oldEdgeDrop)
  }
}

// [D4] Source-text: the factor is defined as a named constant (not an
// inline magic number), gated on mobileBottomSeat && count === 3, and only
// multiplies edgeDrop (never spacing/x or rotationStep/rotate).
{
  const cuttingSeatPanelsSrcForD = readSourceNormalized(
    resolve(PROJECT_ROOT, 'src/app/activeRoom/cutting/renderCuttingSeatPanels.ts'),
  )
  check(
    '[D4] BOTTOM_HAND_MOBILE_THREE_CARD_EDGE_DROP_FACTOR is a named constant (not an inline magic number in the formula)',
    /const BOTTOM_HAND_MOBILE_THREE_CARD_EDGE_DROP_FACTOR = 0\.5/.test(cuttingSeatPanelsSrcForD),
  )
  check(
    '[D4] the factor is gated on mobileBottomSeat && count === 3 (never applies to other counts or other seats)',
    /const threeCardEdgeDropFactor = mobileBottomSeat && count === 3\s*\n\s*\? BOTTOM_HAND_MOBILE_THREE_CARD_EDGE_DROP_FACTOR\s*\n\s*: 1/.test(cuttingSeatPanelsSrcForD),
  )
  check(
    '[D4] threeCardEdgeDropFactor multiplies edgeDrop (y) only — the return statement\'s x/rotate fields are untouched by this fix',
    /const edgeDrop = edgeProgress \* edgeProgress \* edgeDropMax \* countProgress \* threeCardEdgeDropFactor/.test(cuttingSeatPanelsSrcForD) &&
      /x: centered \* spacing,\s*\n\s*y: edgeDrop,\s*\n\s*rotate: centered \* rotationStep,/.test(cuttingSeatPanelsSrcForD),
  )
  check(
    '[D4] renderPlayingScreen.ts (playing renderer) is NOT modified by this fix — no reference to the new factor there',
    !/BOTTOM_HAND_MOBILE_THREE_CARD_EDGE_DROP_FACTOR/.test(readSourceNormalized(resolve(PROJECT_ROOT, 'src/app/activeRoom/renderPlayingScreen.ts'))),
  )
}

// ─── C) Source-text wiring checks ───────────────────────────────────────────

const cuttingSeatPanelsSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/activeRoom/cutting/renderCuttingSeatPanels.ts'),
)
const playingScreenSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/activeRoom/renderPlayingScreen.ts'),
)
const controllerSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/activeRoom/createActiveRoomFlowController.ts'),
)
const geometryModuleSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/activeRoom/bottomHandMobileGeometry.ts'),
)
const viewportStageSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/ui/layout/viewportStage.ts'),
)

// [2][8] getFanOffset centers on the ACTUAL visible `count` — no fixed
// 8-slot indexing. This is what keeps 3/5-card fans centered as their own
// group instead of pinned to the left 3/5 slots of the eventual 8-card fan.
check(
  '[2][8] getFanOffset centers on the passed `count` (visibleCardCount) directly — no fixed-8-slot indirection (no `effectiveCount`/BOTTOM_HAND_MOBILE_TARGET_CARD_COUNT inside the centering math)',
  /const centered = index - \(count - 1\) \/ 2/.test(cuttingSeatPanelsSrc) &&
    /const maxCentered = Math\.max\(1, \(count - 1\) \/ 2\)/.test(cuttingSeatPanelsSrc) &&
    !/\beffectiveCount\b/.test(cuttingSeatPanelsSrc),
)
check(
  '[4b] countProgress stays fixed at 1 for mobileBottomSeat (edge-drop magnitude — not the sizing — is unaffected by this position fix, per "do not change unless proven broken")',
  /const countProgress = mobileBottomSeat \? 1 : Math\.min\(1, Math\.max\(0, \(count - 1\) \/ 7\)\)/.test(cuttingSeatPanelsSrc),
)
check(
  '[6] renderPanelDealtCard sources cardWidth from mobileGeometry (not a fixed constant, not count-dependent) for mobileBottomSeat',
  /const cardWidth = mobileBottomSeat \? \(mobileGeometry\?\.cardWidth \?\? BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH\) : PANEL_CARD_WIDTH/.test(cuttingSeatPanelsSrc),
)
check(
  '[6] getFanOffset sources spacing from mobileGeometry (the 8-card sizing snapshot) for mobileBottomSeat — independent of visibleCardCount',
  /const spacing = mobileBottomSeat\s*\n\s*\? \(mobileGeometry\?\.spacing \?\? BOTTOM_HAND_MOBILE_MAX_SPACING\)/.test(cuttingSeatPanelsSrc),
)
check(
  '[6] getFanOffset sources rotationStep from mobileGeometry for mobileBottomSeat — independent of visibleCardCount',
  /const rotationStep = mobileBottomSeat\s*\n\s*\? \(mobileGeometry\?\.rotationStep \?\? BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP\)/.test(cuttingSeatPanelsSrc),
)
check(
  '[wiring] renderDealtCardFanInPanel reads dealtHands.mobileBottomHandGeometry and threads it into every getFanOffset/renderPanelDealtCard call, alongside the real `count`',
  /const mobileGeometry = mobileBottomSeat \? \(dealtHands\.mobileBottomHandGeometry \?\? null\) : null/.test(cuttingSeatPanelsSrc) &&
    (cuttingSeatPanelsSrc.match(/getFanOffset\([^)]*mobileGeometry\)/g) ?? []).length >= 5 &&
    (cuttingSeatPanelsSrc.match(/renderPanelDealtCard\([^)]*mobileGeometry\)/g) ?? []).length >= 3,
)

// [7] Playing overlay consumes the SAME sizing snapshot (spacing/rotation
// for spreadStep/rotationStep, cardWidth/cardHeight for the button size),
// and its own centering was ALWAYS based on `cards.length` (the real,
// currently-visible hand size) — never touched by the fixed-8-slot bug, so
// no change was needed there for this fix.
check(
  '[7] getBottomHandOffset (playing) centers on `count` (cards.length, the actual current hand size) — matches the same visibleCardCount-centering contract as dealing/bidding',
  /const centeredIndex = index - \(count - 1\) \/ 2/.test(playingScreenSrc),
)
check(
  '[7] getBottomHandOffset (playing) sources spacing from mobileGeometry.spacing when mobile, same field name as the dealing/bidding renderer',
  /const spreadStep = isMobile \? \(mobileGeometry\?\.spacing \?\? BOTTOM_HAND_MOBILE_MAX_SPACING\) : 62/.test(playingScreenSrc),
)
check(
  '[7] getBottomHandOffset (playing) sources rotationStep from mobileGeometry.rotationStep when mobile',
  /const rotationStep = isMobile \? \(mobileGeometry\?\.rotationStep \?\? BOTTOM_HAND_MOBILE_MAX_ROTATION_STEP\) : 5/.test(playingScreenSrc),
)
check(
  '[7] renderBottomHandOverlay sources handCardWidth/handCardHeight from mobileBottomHandGeometry (playing), same MAX fallback constants as dealing',
  /const handCardWidth = isMobileLayout \? \(mobileBottomHandGeometry\?\.cardWidth \?\? BOTTOM_HAND_MOBILE_MAX_CARD_WIDTH\) : HAND_W/.test(playingScreenSrc) &&
    /const handCardHeight = isMobileLayout \? \(mobileBottomHandGeometry\?\.cardHeight \?\? BOTTOM_HAND_MOBILE_MAX_CARD_HEIGHT\) : HAND_H/.test(playingScreenSrc),
)
check(
  '[7] no second/duplicated fitting implementation in renderPlayingScreen.ts — it imports the geometry snapshot type/constants from bottomHandMobileGeometry.ts rather than redefining its own',
  /from '\.\/bottomHandMobileGeometry'/.test(playingScreenSrc) &&
    !/function getBottomHandMobileGeometry/.test(playingScreenSrc),
)

// [9][10] Controller: one cache, computed synchronously, keyed ONLY on real
// viewport width (not stageScale/height) — untouched by this fix.
check(
  '[9] cache comparison is keyed only on viewportWidthCssPx (not stageScale) — height-only changes cannot trigger a recompute',
  /bottomHandMobileGeometryCache !== null &&\s*\n\s*bottomHandMobileGeometryCache\.viewportWidthCssPx === viewportWidthCssPx/.test(controllerSrc) &&
    !/bottomHandMobileGeometryCache\.stageScale/.test(controllerSrc),
)
check(
  '[10] a cache miss (width changed) stores exactly one new snapshot before returning it',
  /bottomHandMobileGeometryCache = \{ viewportWidthCssPx, snapshot \}\s*\n\s*return snapshot/.test(controllerSrc),
)
check(
  '[9] geometry sizing is computed synchronously in the same function as stageScale (no setTimeout/requestAnimationFrame/Promise around the cache accessor)',
  (() => {
    const fnMatch = controllerSrc.match(/function getCachedBottomHandMobileGeometry\(stageScale: number\): BottomHandMobileGeometrySnapshot \{([\s\S]{0,600}?)\n  \}/)
    const body = fnMatch?.[1] ?? ''
    return body.length > 0 && !/setTimeout|requestAnimationFrame|Promise|async/.test(body)
  })(),
)
check(
  '[setup] getCachedBottomHandMobileGeometry is invoked once per render() pass, right next to the existing stageScale metrics call (before any phase-specific branch)',
  /const \{ stageScale, scaledStageWidth, scaledStageHeight \} = getActiveRoomStageMetrics\(\)\s*\n\s*const mobileBottomHandGeometry = isPhoneLayoutViewport\(\)\s*\n\s*\? getCachedBottomHandMobileGeometry\(stageScale\)\s*\n\s*: null/.test(controllerSrc),
)

// [7] The SAME `mobileBottomHandGeometry` variable (not a re-derived value)
// flows into dealing (dealtHandsForPanels), bidding (dealtHandsForBidding),
// and playing (renderPlayingScreen options) — single source of truth for
// SIZING; each render site still passes its own real visible card count for
// POSITIONING.
check(
  '[7] dealtHandsForPanels (deal-first-3/next-2/last-3) carries the shared mobileBottomHandGeometry',
  /mobileBottomHandGeometry,\s*\n\s*\}\s*\n\s*: null/.test(controllerSrc),
)
check(
  '[7] dealtHandsForBidding carries the same shared mobileBottomHandGeometry',
  /animStartIndex: 0,\s*\n\s*seatAnimDelays: null,\s*\n\s*mobileBottomHandGeometry,\s*\n\s*\}/.test(controllerSrc),
)
check(
  '[7] renderPlayingScreen({...}) call carries the same shared mobileBottomHandGeometry',
  /tournamentBotReplacements: activeRoomState\.tournamentBotReplacements,\s*\n\s*mobileBottomHandGeometry,\s*\n\s*cache: playingCache,/.test(controllerSrc),
)

// Viewport width source: visualViewport.width first, innerWidth fallback,
// clientWidth last resort — never screen.width/devicePixelRatio. Untouched.
check(
  '[width-source] getRealViewportWidthCssPx prefers window.visualViewport?.width',
  /window\.visualViewport\?\.width/.test(viewportStageSrc),
)
check(
  '[width-source] getRealViewportWidthCssPx falls back to window.innerWidth, then document.documentElement.clientWidth',
  /window\.innerWidth/.test(viewportStageSrc) && /document\.documentElement\.clientWidth/.test(viewportStageSrc),
)
check(
  '[width-source] getRealViewportWidthCssPx never reads screen.width or devicePixelRatio',
  !/getRealViewportWidthCssPx[\s\S]{0,400}?screen\.width/.test(viewportStageSrc) &&
    !/getRealViewportWidthCssPx[\s\S]{0,400}?devicePixelRatio/.test(viewportStageSrc),
)

// Purity: no DOM mutation / async measurement / rAF / ResizeObserver inside
// the sizing module — no asynchronous corrective render is even possible.
check(
  '[9] bottomHandMobileGeometry.ts never touches the DOM, rAF, or ResizeObserver (checked outside comments, since the docstring only disclaims these terms)',
  !/new ResizeObserver\(|requestAnimationFrame\(|\.addEventListener\(|document\.\w/.test(
    geometryModuleSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''),
  ),
)
check(
  '[9] bottomHandMobileGeometry.ts has no async/await/Promise/setTimeout — fully synchronous',
  !/async |await |Promise|setTimeout/.test(geometryModuleSrc),
)
check(
  '[9] no CSS transition on the dealt card / hand card transform, width or height (would animate a size/spacing change — none is expected since sizing never changes mid-round)',
  !/transition:\s*(width|height|transform)/i.test(cuttingSeatPanelsSrc.match(/renderPanelDealtCard[\s\S]{0,900}/)?.[0] ?? ''),
)

// [10] Desktop untouched: original desktop constants/values still literally
// present and still the ones used when mobileBottomSeat/isMobile is false.
check(
  '[10] getFanOffset desktop/compact branch is untouched: spacing 42/62, rotationStep 3.4/5',
  /: compact \? 42 : 62/.test(cuttingSeatPanelsSrc) && /: compact \? 3\.4 : 5/.test(cuttingSeatPanelsSrc),
)
check(
  '[10] getBottomHandOffset (playing) desktop branch unchanged: spacing 62, rotationStep 5',
  /: 62/.test(playingScreenSrc) && /: 5/.test(playingScreenSrc),
)
check(
  '[10] renderBottomHandOverlay/renderPanelDealtCard still fall back to desktop PANEL_CARD_WIDTH/HAND_W constants (untouched) when not mobile',
  /: PANEL_CARD_WIDTH/.test(cuttingSeatPanelsSrc) && /: HAND_W/.test(playingScreenSrc) && /: HAND_H/.test(playingScreenSrc),
)

// Selected-card lift is vertical-only — cannot push a card horizontally out
// of the safe inset zone no matter which card (including an edge card) is
// hovered/selected.
check(
  '[lift] ACTIVE_HAND_CARD_LIFT is a pure vertical translateY, never touches X — an edge card\'s hover/select lift cannot violate the horizontal safe inset',
  /const ACTIVE_HAND_CARD_LIFT = ' translateY\(-5px\)'/.test(playingScreenSrc),
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
