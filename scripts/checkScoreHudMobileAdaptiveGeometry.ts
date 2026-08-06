/**
 * checkScoreHudMobileAdaptiveGeometry.ts
 *
 * Regression checks за adaptive mobile Score HUD scale
 * (src/app/activeRoom/scoreHudMobileGeometry.ts).
 *
 * Бъг: Score HUD-ът се мащабираше изцяло чрез stageScale (глобалният
 * stage-fit фактор за цялата 1600x900 сцена), който clamp-ва до
 * ACTIVE_ROOM_MIN_STAGE_SCALE (0.46) навсякъде в нормалния mobile viewport
 * диапазон (315-412 CSS px) — стойността НЕ намалява допълнително спрямо
 * viewport ширина в този диапазон. Top-seat профилният панел (center-
 * анкориран спрямо viewport центъра чрез същия stageScale) се отдалечава от
 * левия ръб пропорционално на viewport ширината, но HUD-ът (фиксиран
 * natural size x constant stageScale) не намаляваше допълнително — при
 * тесни viewport-и (~315-360px) HUD-ът застъпваше top-seat панела/аватара.
 *
 * Фикс: getScoreHudMobileGeometry() изчислява ДОПЪЛНИТЕЛЕН, чисто geometric
 * HUD-specific scale множител (приложен НАД stageScale чрез съставно
 * transform:scale(stageScale*hudScale) в renderScoreHud.ts), базиран
 * единствено на реалната CSS viewport ширина спрямо top-seat профилния
 * панел (НЕ спрямо card fan-а — виж коментара в scoreHudMobileGeometry.ts).
 *
 * Три вида проверки тук:
 *  A) Директно извикване на чистата getScoreHudMobileGeometry() — доказва
 *     формулата: >360px -> hudScale===1; <=360px -> геометричен
 *     min(1, availableWidthCss/naturalHudVisualWidthCss); monotonic;
 *     height-independent; desktop unaffected.
 *  B) Аналитични bounding-box проверки (независимо пресъздаване на реалната
 *     transform верига: HUD anchor top/left + top-seat panel anchor,
 *     getCuttingSeatPanelAnchorStyle('top', ...)) — доказват реален >=5px
 *     CSS px gap между HUD-а и top-seat панела на всеки изискан viewport.
 *  C) Source-text проверки върху реалните renderer/controller файлове —
 *     confirming wiring (getRealViewportWidthCssPx usage, no DOM/rAF/
 *     ResizeObserver in the helper, content/z-index/stacking untouched).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getScoreHudMobileGeometry,
  SCORE_HUD_MOBILE_SCALE_BREAKPOINT_CSS_PX,
  SCORE_HUD_SAFE_GAP_CSS_PX,
  SCORE_HUD_NATURAL_WIDTH_STAGE_PX,
  SCORE_HUD_LEFT_INSET_CSS_PX,
} from '../src/app/activeRoom/scoreHudMobileGeometry.ts'

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

console.log('\ncheckScoreHudMobileAdaptiveGeometry\n')

// ─── A) Pure formula: breakpoint, monotonicity, bounds, height-independence ─

const STAGE_SCALE = 0.46 // constant across the mobile viewport range — see module docstring

const REQUIRED_WIDTHS = [315, 320, 340, 359, 360, 361, 375, 390, 412]

const scaleAtWidth = new Map<number, number>()
for (const width of REQUIRED_WIDTHS) {
  const { hudScale } = getScoreHudMobileGeometry({
    viewportWidthCssPx: width,
    stageScale: STAGE_SCALE,
    isMobileLayout: true,
  })
  scaleAtWidth.set(width, hudScale)
}

check(
  '[A] SCORE_HUD_MOBILE_SCALE_BREAKPOINT_CSS_PX is exactly 360',
  SCORE_HUD_MOBILE_SCALE_BREAKPOINT_CSS_PX === 360,
)
check(
  '[A] SCORE_HUD_SAFE_GAP_CSS_PX is exactly 5',
  SCORE_HUD_SAFE_GAP_CSS_PX === 5,
)

for (const width of [361, 375, 390, 412]) {
  check(`[A] width=${width}px (>360): hudScale === 1`, scaleAtWidth.get(width) === 1)
}

for (const width of [315, 320, 340, 359, 360]) {
  const scale = scaleAtWidth.get(width)!
  check(`[A] width=${width}px (<=360): hudScale < 1`, scale < 1)
  check(`[A] width=${width}px: hudScale > 0 (never collapses to zero/negative)`, scale > 0)
}

check(
  '[A] hudScale is monotonically non-decreasing across 315 -> 320 -> 359 -> 360',
  scaleAtWidth.get(315)! <= scaleAtWidth.get(320)! &&
    scaleAtWidth.get(320)! <= scaleAtWidth.get(359)! &&
    scaleAtWidth.get(359)! <= scaleAtWidth.get(360)!,
)

check(
  '[A] no sharp breakpoint jump: 359 -> 360 changes by less than 359 -> 315 (smooth, not a step function between individual widths)',
  scaleAtWidth.get(360)! - scaleAtWidth.get(359)! < scaleAtWidth.get(359)! - scaleAtWidth.get(315)!,
)

check(
  '[A] hudScale never exceeds 1 at any tested width',
  REQUIRED_WIDTHS.every((w) => scaleAtWidth.get(w)! <= 1),
)

check(
  '[A] width=360: hudScale is only slightly below 1 (not collapsed) — expect > 0.5',
  scaleAtWidth.get(360)! > 0.5,
)

check(
  '[A] desktop (isMobileLayout=false) always returns hudScale===1, regardless of narrow width',
  getScoreHudMobileGeometry({ viewportWidthCssPx: 315, stageScale: 1.06, isMobileLayout: false }).hudScale === 1,
)

check(
  '[A] height does not participate in the formula — getScoreHudMobileGeometry has no height parameter at all',
  (() => {
    const fnSource = readSourceNormalized(
      resolve(PROJECT_ROOT, 'src/app/activeRoom/scoreHudMobileGeometry.ts'),
    )
    const inputTypeMatch = fnSource.match(/export type ScoreHudMobileGeometryInput = \{([\s\S]*?)\}/)
    return inputTypeMatch !== null && !/height/i.test(inputTypeMatch[1]!)
  })(),
)

check(
  '[A] result is deterministic — calling twice with the same input yields the same hudScale',
  (() => {
    const a = getScoreHudMobileGeometry({ viewportWidthCssPx: 315, stageScale: STAGE_SCALE, isMobileLayout: true })
    const b = getScoreHudMobileGeometry({ viewportWidthCssPx: 315, stageScale: STAGE_SCALE, isMobileLayout: true })
    return a.hudScale === b.hudScale
  })(),
)

// ─── B) Analytic gap: independent transform-chain reconstruction ───────────

// Top-seat profile panel (non-bottom shape, renderCuttingSeatPanels.ts):
// layout box 186x234 stage-local px, transform:scale(0.9) from
// transform-origin:top center, centered on the anchor center (186/2=93 —
// getCuttingSeatPanelAnchorStyle('top', ...) centers the anchor via
// left:50%; transform:translateX(-50%), and the anchor has no width of its
// own outside the panel's auto layout). Independently re-derived here (not
// imported) so this test would catch a change to either side of the
// contract without silently trusting the same constant.
//
// Border/shadow allowance is 0 — proven by real browser measurement (see
// checkPlayedCardStacking.ts [HUD-Gap] and the report accompanying this
// fix): getBoundingClientRect() on the panel already includes its border
// (border-box layout), and the panel's box-shadow has offset-x=0/spread=0
// (renderCuttingSeatPanelHtml: `0 14px 28px rgba(0,0,0,0.24)`), so nothing
// bleeds further left than the border box. A prior version of this
// constant (=3) caused a real measured ~8px gap instead of the target 5px.
const TOP_SEAT_PANEL_HALF_WIDTH_STAGE_PX = (186 * 0.9) / 2
const TOP_SEAT_PANEL_BORDER_SHADOW_ALLOWANCE_CSS_PX = 0

function topSeatPanelLeftEdgeCssPx(viewportWidthCssPx: number, stageScale: number): number {
  return (
    viewportWidthCssPx / 2 -
    stageScale * TOP_SEAT_PANEL_HALF_WIDTH_STAGE_PX -
    TOP_SEAT_PANEL_BORDER_SHADOW_ALLOWANCE_CSS_PX
  )
}

function hudRightEdgeCssPx(viewportWidthCssPx: number, stageScale: number): number {
  const { hudScale } = getScoreHudMobileGeometry({ viewportWidthCssPx, stageScale, isMobileLayout: true })
  // renderScoreHud.ts: outer anchor left = 5 - SCORE_HUD_INTERNAL_OFFSET*combinedScale;
  // inner content left = SCORE_HUD_INTERNAL_OFFSET (local px), scaled by the
  // same combinedScale via the outer transform — the two
  // SCORE_HUD_INTERNAL_OFFSET*combinedScale terms cancel algebraically,
  // leaving a constant 5 CSS px left edge for the inner content, independent
  // of combinedScale. hudRightEdge = 5 + (real rendered content div width).
  // The content div's OWN width is SCORE_HUD_NATURAL_WIDTH_STAGE_PX (=300,
  // stage-local px — must NOT include SCORE_HUD_INTERNAL_OFFSET, which is a
  // position offset on the div, not part of its own width) scaled by
  // stageScale*hudScale.
  const naturalHudVisualWidthCssPx = SCORE_HUD_NATURAL_WIDTH_STAGE_PX * stageScale
  return SCORE_HUD_LEFT_INSET_CSS_PX + naturalHudVisualWidthCssPx * hudScale
}

const TARGET_GAP_MIN_CSS_PX = 4.5
const TARGET_GAP_MAX_CSS_PX = 5.5

for (const width of [315, 320, 359, 360]) {
  const gap = topSeatPanelLeftEdgeCssPx(width, STAGE_SCALE) - hudRightEdgeCssPx(width, STAGE_SCALE)
  check(
    `[B] width=${width}px: theoretical gap between HUD right edge and top-seat panel left edge is ≈5px (computed: ${gap.toFixed(2)}px, target ${TARGET_GAP_MIN_CSS_PX}-${TARGET_GAP_MAX_CSS_PX}px)`,
    gap >= TARGET_GAP_MIN_CSS_PX && gap <= TARGET_GAP_MAX_CSS_PX,
  )
  const { hudScale } = getScoreHudMobileGeometry({ viewportWidthCssPx: width, stageScale: STAGE_SCALE, isMobileLayout: true })
  check(`[B] width=${width}px: hudScale <= 1 (never grows the HUD beyond its natural size)`, hudScale <= 1)
}

check(
  '[B] width=361px: hudScale is exactly 1 (breakpoint contract honored even though the panel-only envelope naturally clears 5px slightly above 361px)',
  (() => {
    const { hudScale } = getScoreHudMobileGeometry({ viewportWidthCssPx: 361, stageScale: STAGE_SCALE, isMobileLayout: true })
    return hudScale === 1
  })(),
)

for (const width of [375, 390, 412]) {
  check(
    `[B] width=${width}px: hudScale is exactly 1`,
    getScoreHudMobileGeometry({ viewportWidthCssPx: width, stageScale: STAGE_SCALE, isMobileLayout: true }).hudScale === 1,
  )
}

// ─── C) Source/wiring checks ────────────────────────────────────────────────

const renderScoreHudSrc = readSourceNormalized(resolve(PROJECT_ROOT, 'src/app/activeRoom/renderScoreHud.ts'))
const geometrySrc = readSourceNormalized(resolve(PROJECT_ROOT, 'src/app/activeRoom/scoreHudMobileGeometry.ts'))

check(
  '[C] renderScoreHud.ts imports getRealViewportWidthCssPx (the same proven CSS viewport width source as bottom-hand mobile geometry)',
  /import\s*\{[^}]*getRealViewportWidthCssPx[^}]*\}\s*from\s*['"].*viewportStage['"]/.test(renderScoreHudSrc),
)
check(
  '[C] renderScoreHud.ts does not read screen.width, devicePixelRatio, or window.outerWidth for HUD scale',
  !/screen\.width|devicePixelRatio|outerWidth/.test(renderScoreHudSrc),
)
check(
  '[C] renderScoreHud.ts computes hudScale synchronously (no requestAnimationFrame/setTimeout/Promise/ResizeObserver around it)',
  !/requestAnimationFrame|setTimeout|ResizeObserver|new Promise/.test(renderScoreHudSrc),
)
check(
  '[C] renderScoreHud.ts applies combinedScale (stageScale*hudScale) to BOTH the top/left offset and the transform:scale — not just one of them (would desync the anchor point)',
  /top:\$\{5 - SCORE_HUD_INTERNAL_OFFSET \* combinedScale\}px/.test(renderScoreHudSrc) &&
    /left:\$\{5 - SCORE_HUD_INTERNAL_OFFSET \* combinedScale\}px/.test(renderScoreHudSrc) &&
    /transform:scale\(\$\{combinedScale\}\)/.test(renderScoreHudSrc),
)
check(
  '[C] renderScoreHud.ts still scales the HUD as a single transform (no independent font-size/width overrides tied to hudScale)',
  !/hudScale\}(px|em|rem)/.test(renderScoreHudSrc) && !/fontSize.*hudScale|font-size:\$\{.*hudScale/.test(renderScoreHudSrc),
)
check(
  '[C] renderScoreHud.ts z-index remains 8 (Score HUD stacking level unchanged)',
  /z-index:8;/.test(renderScoreHudSrc),
)
check(
  '[C] scoreHudMobileGeometry.ts never reads window/document (no DOM access)',
  !/\bwindow\.|\bdocument\./.test(geometrySrc),
)
check(
  '[C] scoreHudMobileGeometry.ts has no requestAnimationFrame/ResizeObserver/async/Promise/setTimeout in executable code (comments may still document their absence in prose)',
  (() => {
    const codeOnly = geometrySrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    return !/requestAnimationFrame|ResizeObserver|\basync\s|\bawait\s|\bPromise\b|setTimeout/.test(codeOnly)
  })(),
)
check(
  '[C] scoreHudMobileGeometry.ts does not render markup (no template strings with HTML tags)',
  !/<div|<span|<img/.test(geometrySrc),
)
check(
  '[C] renderScoreHud.ts content/scoring logic (ourScore/theirScore/bidSummary) is untouched by the hudScale wiring — still comes from getScoreForLocalPerspective/formatBidType',
  /getScoreForLocalPerspective\(game, localSeat\)/.test(renderScoreHudSrc) &&
    /formatBidType\(winningBid\)/.test(renderScoreHudSrc),
)
check(
  '[C] renderScoreHud.ts does not change data-active-room-score-hud, bubble overlay z-index, or trick-card/flying-card z-index (not this file\'s concern, and not touched)',
  !/data-seat-bubbles-layer|data-seat-panels-host|z-index:9000|z-index:9001/.test(renderScoreHudSrc),
)
check(
  '[C] scoreHudMobileGeometry.ts natural HUD width constant is 300 (the content div\'s OWN width, NOT offset+width — a prior bug used 18+300=318 here, which desynced hudScale from the real rendered content width and caused a ~8px measured gap instead of 5px) — matches renderScoreHud.ts\'s width:300px content div',
  /export const SCORE_HUD_NATURAL_WIDTH_STAGE_PX = 300/.test(geometrySrc) &&
    /width:300px;/.test(renderScoreHudSrc) &&
    /const SCORE_HUD_INTERNAL_OFFSET = 18/.test(renderScoreHudSrc),
)
check(
  '[C] scoreHudMobileGeometry.ts border/shadow allowance is 0 (geometrically proven — border is already in getBoundingClientRect(), shadow has offset-x=0/spread=0)',
  /const TOP_SEAT_PANEL_BORDER_SHADOW_ALLOWANCE_CSS_PX = 0$/m.test(geometrySrc),
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exitCode = 1
