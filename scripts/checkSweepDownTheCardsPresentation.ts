// checkSweepDownTheCardsPresentation.ts
//
// "Долу картите" presentation (client):
//  A) Timeline: надпис 1500ms → ветрило на заявилия (свиване → полет/
//     разперване) → другите ветрила → 1500ms открити карти → общ куп;
//     server auto-advance budget-ът покрива целия client timeline.
//  B) Center layout (ветрилото на заявилия; функцията поддържа и няколко
//     реда): нормален размер, четими карти, в рамките на stage-а.
//  B2) Seat fans: другите трима остават със своето реално ветрило до
//     седалката — същата форма/ъгли, нормален размер, изнесено малко навътре;
//     горното ветрило е с изправени карти.
//  C) Fan geometry: общият getHandFanOffset дава същите стойности като
//     старите формули на ръката/панелите; центърът ползва същата формула.
//  D) Fan flight pose: тръгва от купа, завършва точно във финалната поза,
//     ветрилото се разперва по пътя, flip по средата само за обърнати карти.
//  F) Layering: центърът (заявилият) е най-долният слой, ветрилата до
//     седалките винаги са над него (mobile overlap).
//  G) Popup sizing: clamp() стойности при 320/360/390/393 px и desktop.
//  E) Source invariants: popup-ът чака края на trick collection-а; resolution
//     snapshot-ът не стартира нормална collection; ред на фазите; един общ
//     куп; normal TRICK_W/TRICK_H и общия card face markup.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeFanFlightPose,
  computeSeatFanRevealPoses,
  computeSweepRevealLayout,
  getSweepFanCardZIndex,
  getSweepPresentationDurationMs,
  SWEEP_CLAIMANT_LANDED_BEAT_MS,
  SWEEP_CAPTION_VISIBLE_MS,
  SWEEP_REVEAL_HOLD_MS,
  SWEEP_REVEAL_MAX_BLOCK_HEIGHT,
  synthesizeSeatFanPoses,
  type CardPose,
} from '../src/app/activeRoom/animateSweepThrowDown'
import { getHandFanOffset } from '../src/app/activeRoom/handFanGeometry'
import { SWEEP_OFFER_POPUP_SIZING } from '../src/app/activeRoom/renderSweepOfferPopup'
import { SERVER_TIMING_CONFIG } from '../server/src/game/serverTimingConfig'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

const STAGE_WIDTH = 1600
const STAGE_HEIGHT = 900
const TRICK_W = 170
const TRICK_H = 247
const MIN_VISIBLE_CORNER_PX = 60

type Seat = 'bottom' | 'right' | 'top' | 'left'

function layoutFor(cardsPerSeat: number, localSeat: Seat = 'bottom') {
  const order: Seat[] = ['bottom', 'right', 'top', 'left']
  const localIndex = order.indexOf(localSeat)
  const toVisual = (seat: Seat): Seat => order[(order.indexOf(seat) - localIndex + 4) % 4]!
  return computeSweepRevealLayout({
    rows: order.map((seat) => ({ seat, visualSeat: toVisual(seat), cardCount: cardsPerSeat })),
    cardWidth: TRICK_W,
    cardHeight: TRICK_H,
    centerX: STAGE_WIDTH / 2,
    centerY: STAGE_HEIGHT / 2,
  })
}

console.log('\nA) Timeline')

check('caption stays 1500ms before the first fan closes', () => {
  assert(SWEEP_CAPTION_VISIBLE_MS === 1500, `got ${SWEEP_CAPTION_VISIBLE_MS}`)
})

check('revealed cards stay face-up 1500ms before collection', () => {
  assert(SWEEP_REVEAL_HOLD_MS === 1500, `got ${SWEEP_REVEAL_HOLD_MS}`)
})

check('claimant fan lies alone in the center for 1000ms before the other hands open', () => {
  assert(SWEEP_CLAIMANT_LANDED_BEAT_MS === 1000, `got ${SWEEP_CLAIMANT_LANDED_BEAT_MS}`)
})

check('server auto-advance budget covers the whole client presentation', () => {
  const clientMs = getSweepPresentationDurationMs()
  const serverMs = SERVER_TIMING_CONFIG.sweepResolutionAutoAdvanceMs
  assert(serverMs >= clientMs, `server ${serverMs}ms < client ${clientMs}ms`)
  assert(serverMs - clientMs <= 1500, `server waits ${serverMs - clientMs}ms longer than needed`)
})

console.log('\nB) Reveal layout')

function rotatedHalfExtents(rotateDeg: number): { hx: number; hy: number } {
  const r = (Math.abs(rotateDeg) * Math.PI) / 180
  return {
    hx: (TRICK_W * Math.cos(r) + TRICK_H * Math.sin(r)) / 2,
    hy: (TRICK_W * Math.sin(r) + TRICK_H * Math.cos(r)) / 2,
  }
}

for (const cardsPerSeat of [2, 3, 5, 7]) {
  check(`${cardsPerSeat} cards per seat: every card gets its own slot`, () => {
    const slots = layoutFor(cardsPerSeat)
    assert(slots.length === cardsPerSeat * 4, `got ${slots.length}`)
    const keys = new Set(slots.map((s) => `${s.centerX.toFixed(2)}:${s.centerY.toFixed(2)}`))
    assert(keys.size === slots.length, 'two cards share the same position')
  })

  check(`${cardsPerSeat} cards per seat: corner index of every card stays visible`, () => {
    const slots = layoutFor(cardsPerSeat)
    for (const row of [0, 1, 2, 3]) {
      const xs = slots.filter((s) => s.rowIndex === row).map((s) => s.centerX).sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) {
        assert(xs[i]! - xs[i - 1]! >= MIN_VISIBLE_CORNER_PX, `row ${row}: step ${xs[i]! - xs[i - 1]!}px`)
      }
    }
    const rowTops = [0, 1, 2, 3].map((row) => Math.min(...slots.filter((s) => s.rowIndex === row).map((s) => s.centerY)))
    for (let i = 1; i < rowTops.length; i++) {
      assert(rowTops[i]! - rowTops[i - 1]! >= MIN_VISIBLE_CORNER_PX, `row step ${rowTops[i]! - rowTops[i - 1]!}px`)
    }
  })

  check(`${cardsPerSeat} cards per seat: full-size rotated fans fit inside the stage`, () => {
    const slots = layoutFor(cardsPerSeat)
    for (const slot of slots) {
      const { hx, hy } = rotatedHalfExtents(slot.rotate)
      assert(slot.centerX - hx >= 0 && slot.centerX + hx <= STAGE_WIDTH, `x out of stage: ${slot.centerX}`)
      assert(slot.centerY - hy >= 0 && slot.centerY + hy <= STAGE_HEIGHT, `y out of stage: ${slot.centerY}`)
    }
    const rowCenters = [...new Set(slots.filter((s) => s.cardIndex === 0).map((s) => s.centerY))]
    assert(rowCenters.length === 4, 'expected 4 rows')
    const ys = slots.map((s) => s.centerY)
    assert(Math.max(...ys) - Math.min(...ys) <= SWEEP_REVEAL_MAX_BLOCK_HEIGHT, 'rows spread beyond the block budget')
  })

  check(`${cardsPerSeat} cards per seat: each row is a symmetric hand fan`, () => {
    const slots = layoutFor(cardsPerSeat)
    for (const row of [0, 1, 2, 3]) {
      const rowSlots = slots.filter((s) => s.rowIndex === row).sort((a, b) => a.cardIndex - b.cardIndex)
      const n = rowSlots.length
      for (let i = 0; i < n; i++) {
        const mirror = rowSlots[n - 1 - i]!
        assert(near(rowSlots[i]!.rotate, -mirror.rotate), 'rotation not symmetric')
        assert(near(rowSlots[i]!.centerY, mirror.centerY), 'edge drop not symmetric')
        assert(near(rowSlots[i]!.rotate, (i - (n - 1) / 2) * 5), 'rotation step differs from the hand fan (5°)')
      }
    }
  })
}

check('rows follow the local perspective: top, left, right, bottom', () => {
  for (const localSeat of ['bottom', 'right', 'top', 'left'] as Seat[]) {
    const slots = layoutFor(3, localSeat)
    const order: Seat[] = ['bottom', 'right', 'top', 'left']
    const localIndex = order.indexOf(localSeat)
    const rowSeats = [0, 1, 2, 3].map((row) => slots.find((s) => s.rowIndex === row)!.seat)
    const visual = rowSeats.map((seat) => order[(order.indexOf(seat) - localIndex + 4) % 4])
    assert(
      JSON.stringify(visual) === JSON.stringify(['top', 'left', 'right', 'bottom']),
      `local ${localSeat}: ${JSON.stringify(visual)}`,
    )
  }
})

console.log('\nB2) Seat fans of the other players')

// A left-seat panel fan as it is on screen: wrapper rotate 90°, cards spread
// downward with the fan's own ±5° steps (shape from the real hand formula).
const leftFan = synthesizeSeatFanPoses({ count: 5, center: { x: 200, y: 450 }, visualSeat: 'left', cardWidth: TRICK_W, scale: 0.5 })
const topFan = synthesizeSeatFanPoses({ count: 5, center: { x: 800, y: 120 }, visualSeat: 'top', cardWidth: TRICK_W, scale: 0.5 })
const rightFan = synthesizeSeatFanPoses({ count: 5, center: { x: 1400, y: 450 }, visualSeat: 'right', cardWidth: TRICK_W, scale: 0.5 })
const PULL = 66
const TARGET_SCALE = 0.6

function centerOf(poses: CardPose[]) {
  return {
    x: poses.reduce((a, p) => a + p.x, 0) / poses.length,
    y: poses.reduce((a, p) => a + p.y, 0) / poses.length,
  }
}

check('the seat fan keeps its real shape (relative positions scaled to played-card size)', () => {
  const { poses } = computeSeatFanRevealPoses({ fan: leftFan, visualSeat: 'left', targetScale: TARGET_SCALE, pullPx: PULL })
  const from = centerOf(leftFan)
  const to = centerOf(poses)
  const ratio = TARGET_SCALE / 0.5
  leftFan.forEach((source, i) => {
    assert(near(poses[i]!.x - to.x, (source.x - from.x) * ratio), `x offset of card ${i}`)
    assert(near(poses[i]!.y - to.y, (source.y - from.y) * ratio), `y offset of card ${i}`)
    assert(near(poses[i]!.rotate, source.rotate), `rotation of card ${i} changed`)
    assert(near(poses[i]!.scale, TARGET_SCALE), 'not the normal played-card scale')
  })
})

check('each seat fan stays at its seat, pulled a bit toward the table center', () => {
  const cases: [string, CardPose[], 'top' | 'left' | 'right', { x: number; y: number }][] = [
    ['top', topFan, 'top', { x: 0, y: PULL }],
    ['left', leftFan, 'left', { x: PULL, y: 0 }],
    ['right', rightFan, 'right', { x: -PULL, y: 0 }],
  ]
  for (const [name, fan, seat, shift] of cases) {
    const { poses } = computeSeatFanRevealPoses({ fan, visualSeat: seat, targetScale: TARGET_SCALE, pullPx: PULL })
    const from = centerOf(fan)
    const to = centerOf(poses)
    assert(near(to.x - from.x, shift.x) && near(to.y - from.y, shift.y), `${name}: moved by ${to.x - from.x},${to.y - from.y}`)
  }
})

check('side fans keep their vertical orientation (≈ ±90°)', () => {
  const left = computeSeatFanRevealPoses({ fan: leftFan, visualSeat: 'left', targetScale: TARGET_SCALE, pullPx: PULL })
  const right = computeSeatFanRevealPoses({ fan: rightFan, visualSeat: 'right', targetScale: TARGET_SCALE, pullPx: PULL })
  assert(!left.flipped && !right.flipped, 'side fans must not be flipped')
  assert(left.poses.every((p) => Math.abs(p.rotate - 90) <= 15), 'left fan not around 90°')
  assert(right.poses.every((p) => Math.abs(p.rotate + 90) <= 15), 'right fan not around -90°')
})

check('the top fan keeps its shape but its cards are turned upright', () => {
  const { poses, flipped } = computeSeatFanRevealPoses({ fan: topFan, visualSeat: 'top', targetScale: TARGET_SCALE, pullPx: PULL })
  assert(flipped, 'top fan must be reported as flipped')
  assert(poses.every((p) => Math.abs(p.rotate) <= 15), 'top cards are not upright')
  const from = centerOf(topFan)
  const to = centerOf(poses)
  const ratio = TARGET_SCALE / 0.5
  topFan.forEach((source, i) => {
    assert(near(poses[i]!.x - to.x, (source.x - from.x) * ratio), `x offset of card ${i}`)
    assert(near(poses[i]!.y - to.y, (source.y - from.y) * ratio), `y offset of card ${i}`)
  })
})

check('fallback seat fan reproduces the normal hand fan at the seat', () => {
  const center = centerOf(leftFan)
  assert(near(center.y, 450 + centerOf(synthesizeSeatFanPoses({ count: 5, center: { x: 0, y: 0 }, visualSeat: 'left', cardWidth: TRICK_W, scale: 0.5 })).y), 'center drifted')
  const fan = getHandFanOffset(4, 5, { spacing: (62 / 195) * TRICK_W * 0.5, edgeDropMax: 34, rotationStep: 5, edgeDropScale: (TRICK_W * 0.5) / 195 })
  // rotated by 90°: fan x → screen y, fan y (edge drop) → screen -x
  assert(near(leftFan[4]!.y - 450, fan.x) && near(leftFan[4]!.x - 200, -fan.y), 'left fan geometry differs from the hand fan')
  assert(near(leftFan[4]!.rotate, 90 + fan.rotate), 'left fan rotation differs')
})

console.log('\nC) Fan geometry')

function legacyFan(index: number, count: number, spacing: number, dropMax: number, rotStep: number, scale: number) {
  const centered = index - (count - 1) / 2
  const maxCentered = Math.max(1, (count - 1) / 2)
  const edgeProgress = Math.abs(centered) / maxCentered
  const countProgress = Math.min(1, Math.max(0, (count - 1) / 7))
  return { x: centered * spacing * scale, y: edgeProgress * edgeProgress * dropMax * countProgress * scale, rotate: centered * rotStep }
}

check('shared getHandFanOffset reproduces the old hand/panel fan formulas', () => {
  const variants = [
    { spacing: 62, dropMax: 34, rotStep: 5, scale: 1 }, // desktop hand / panel
    { spacing: 42, dropMax: 20, rotStep: 3.4, scale: 1 }, // compact mobile panel
    { spacing: 70, dropMax: 34, rotStep: 5, scale: 0.8 }, // mobile bottom hand
  ]
  for (const v of variants) {
    for (let count = 1; count <= 8; count++) {
      for (let index = 0; index < count; index++) {
        const expected = legacyFan(index, count, v.spacing, v.dropMax, v.rotStep, v.scale)
        const actual = getHandFanOffset(index, count, {
          spacing: v.spacing * v.scale,
          edgeDropMax: v.dropMax,
          rotationStep: v.rotStep,
          edgeDropScale: v.scale,
        })
        assert(
          near(actual.x, expected.x) && near(actual.y, expected.y) && near(actual.rotate, expected.rotate),
          `mismatch at ${JSON.stringify(v)} count=${count} index=${index}`,
        )
      }
    }
  }
})

console.log('\nD) Fan flight pose')

const pile: CardPose = { x: 300, y: 800, rotate: 90, scale: 0.5 }
const groupTarget = { x: 800, y: 450 }
const targets: CardPose[] = [
  { x: 700, y: 470, rotate: -5, scale: 0.9 },
  { x: 800, y: 460, rotate: 0, scale: 0.9 },
  { x: 900, y: 470, rotate: 5, scale: 0.9 },
]

check('flight starts exactly at the closed pile', () => {
  for (const target of targets) {
    const pose = computeFanFlightPose(0, { pile, target, groupTarget, flip: true })
    assert(near(pose.x, pile.x) && near(pose.y, pile.y) && near(pose.rotate, pile.rotate) && near(pose.scale, pile.scale), 'u=0 is not the pile')
  }
})

check('flight ends exactly in the final fan pose (normal played-card scale)', () => {
  for (const target of targets) {
    const pose = computeFanFlightPose(1, { pile, target, groupTarget, flip: true })
    assert(near(pose.x, target.x) && near(pose.y, target.y) && near(pose.rotate, target.rotate) && near(pose.scale, target.scale), 'u=1 is not the target')
    assert(near(pose.scaleX, 1), 'card must land unflipped')
  }
})

check('the fan opens up progressively during the flight', () => {
  let previousSpread = -1
  for (const u of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const left = computeFanFlightPose(u, { pile, target: targets[0]!, groupTarget, flip: false })
    const right = computeFanFlightPose(u, { pile, target: targets[2]!, groupTarget, flip: false })
    const spread = right.x - left.x
    assert(spread >= previousSpread - 1e-9, `spread shrank at u=${u}`)
    previousSpread = spread
  }
  assert(near(previousSpread, 200), `final spread ${previousSpread}`)
})

check('face-down cards turn over mid-flight; face-up cards never flip', () => {
  const flipped = computeFanFlightPose(0.5, { pile, target: targets[1]!, groupTarget, flip: true })
  assert(flipped.scaleX < 0.2, `expected an edge-on card at u=0.5, scaleX=${flipped.scaleX}`)
  for (const u of [0, 0.2, 0.5, 0.8, 1]) {
    const pose = computeFanFlightPose(u, { pile, target: targets[1]!, groupTarget, flip: false })
    assert(near(pose.scaleX, 1), `face-up card flipped at u=${u}`)
  }
})

console.log('\nF) Layering')

check('every seat fan card stacks above every claimant center card', () => {
  for (const count of [2, 4, 7]) {
    const claimantMax = Math.max(
      ...Array.from({ length: count }, (_, index) =>
        getSweepFanCardZIndex({ isClaimant: true, rowIndex: 0, index, count, flipped: false })),
    )
    for (const rowIndex of [0, 1, 2, 3]) {
      for (const flipped of [false, true]) {
        for (let index = 0; index < count; index++) {
          const z = getSweepFanCardZIndex({ isClaimant: false, rowIndex, index, count, flipped })
          assert(z > claimantMax, `seat fan z ${z} <= claimant z ${claimantMax} (row ${rowIndex}, count ${count})`)
        }
      }
    }
  }
})

check('within a fan the stacking matches the hand (flipped fans reversed)', () => {
  const normal = [0, 1, 2].map((index) => getSweepFanCardZIndex({ isClaimant: false, rowIndex: 1, index, count: 3, flipped: false }))
  const flipped = [0, 1, 2].map((index) => getSweepFanCardZIndex({ isClaimant: false, rowIndex: 1, index, count: 3, flipped: true }))
  assert(normal[0]! < normal[1]! && normal[1]! < normal[2]!, 'normal fan must stack by index')
  assert(flipped[0]! > flipped[1]! && flipped[1]! > flipped[2]!, 'flipped fan must stack in reverse')
})

console.log('\nG) Popup sizing')

function evalCss(value: string, vw: number): number {
  const clamp = /^clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)$/.exec(value.trim())
  if (!clamp) throw new Error(`not a clamp(px, vw, px) value: ${value}`)
  return Math.max(Number(clamp[1]), Math.min(Number(clamp[3]), (Number(clamp[2]) * vw) / 100))
}
const sizing = SWEEP_OFFER_POPUP_SIZING
const paddingParts = sizing.dialogPadding.split(/\s+(?=clamp)/)

check('desktop popup keeps its previous size exactly', () => {
  const vw = 1280
  const expected: [string, number, number][] = [
    ['dialogWidth', evalCss(sizing.dialogWidth, vw), 360],
    ['titleFontSize', evalCss(sizing.titleFontSize, vw), 30],
    ['buttonMinHeight', evalCss(sizing.buttonMinHeight, vw), 56],
    ['declineFontSize', evalCss(sizing.declineFontSize, vw), 24],
    ['acceptFontSize', evalCss(sizing.acceptFontSize, vw), 22],
    ['buttonGap', evalCss(sizing.buttonGap, vw), 12],
    ['titleMarginBottom', evalCss(sizing.titleMarginBottom, vw), 20],
    ['backdropPadding', evalCss(sizing.backdropPadding, vw), 18],
    ['padding top', evalCss(paddingParts[0]!, vw), 22],
    ['padding sides', evalCss(paddingParts[1]!, vw), 18],
    ['padding bottom', evalCss(paddingParts[2]!, vw), 18],
  ]
  for (const [name, actual, want] of expected) assert(near(actual, want), `${name}: ${actual} != ${want}`)
})

for (const vw of [320, 360, 390, 393]) {
  check(`${vw}px phone: popup is compact, fits, readable, touch-friendly`, () => {
    const width = evalCss(sizing.dialogWidth, vw)
    const outer = evalCss(sizing.backdropPadding, vw)
    assert(width <= vw - 2 * outer, `overflows: ${width} + 2×${outer} > ${vw}`)
    assert(width <= vw * 0.72, `covers too much of the table: ${width}px of ${vw}px`)
    assert(evalCss(sizing.titleFontSize, vw) >= 22, 'title too small to read')
    assert(evalCss(sizing.titleFontSize, vw) < 30, 'title not reduced on phones')
    assert(evalCss(sizing.buttonMinHeight, vw) >= 44, 'buttons below 44px touch target')
    assert(evalCss(paddingParts[0]!, vw) < 22 && evalCss(paddingParts[1]!, vw) < 18, 'padding not reduced on phones')
  })
}

check('popup has no fixed pixel width and uses every sizing token', () => {
  const popupSource = readFileSync(join(process.cwd(), 'src/app/activeRoom/renderSweepOfferPopup.ts'), 'utf8')
  assert(!/[^-]width:\s*\d+px/.test(popupSource), 'fixed px width found')
  for (const key of Object.keys(sizing)) {
    assert(popupSource.includes(`sizing.${key}`), `sizing.${key} is not used`)
  }
})

console.log('\nE) Source invariants')

const root = process.cwd()
const renderSource = readFileSync(join(root, 'src/app/activeRoom/renderPlayingScreen.ts'), 'utf8')
const panelsSource = readFileSync(join(root, 'src/app/activeRoom/cutting/renderCuttingSeatPanels.ts'), 'utf8')
const animateSource = readFileSync(join(root, 'src/app/activeRoom/animateSweepThrowDown.ts'), 'utf8')

check('sweep popup is gated on the trick collection having finished', () => {
  assert(
    /shouldShowSweepOfferPopup =\s*sweepOffer !== null &&\s*!cache\.isTrickCollectionAnimating/.test(renderSource),
    'popup condition must include !cache.isTrickCollectionAnimating',
  )
})

check('resolution snapshot does not start a normal trick collection', () => {
  assert(
    /const canAnimateCompletedTrick =\s*sweepResolution === null &&/.test(renderSource),
    'canAnimateCompletedTrick must exclude sweepResolution',
  )
})

check('reveal uses the normal played-card size and face markup', () => {
  assert(/cardWidth: TRICK_W,\s*cardHeight: TRICK_H,/.test(renderSource), 'TRICK_W/TRICK_H not passed')
  assert(renderSource.includes('renderCardFaceHtml: renderTableCardFaceHtml'), 'face markup not shared')
  assert(renderSource.includes('${renderTableCardFaceHtml(play.card)}'), 'trick card does not use shared face')
})

check('hand, panel and center fans share one fan formula', () => {
  assert(/function getBottomHandOffset[\s\S]*?return getHandFanOffset\(/.test(renderSource), 'bottom hand not on getHandFanOffset')
  assert(/function getFanOffset[\s\S]*?return getHandFanOffset\(/.test(panelsSource), 'panel fan not on getHandFanOffset')
  assert(/computeSweepRevealLayout[\s\S]*?getHandFanOffset\(/.test(animateSource), 'center fans not on getHandFanOffset')
})

check('phase order: claimant closes → flies, then the others close → fly, then hold → one pile', () => {
  const order = [
    'claimantGroups.map((group) => closeFan(',
    'claimantGroups.map((group) => flyAndReFan(',
    'await wait(SWEEP_CLAIMANT_LANDED_BEAT_MS)',
    'otherGroups.map((group) => closeFan(',
    'otherGroups.map((group) => flyAndReFan(',
    'options.onRevealComplete()',
    'await wait(SWEEP_REVEAL_HOLD_MS)',
    'await collectAsOnePile(',
  ].map((needle) => {
    const index = animateSource.indexOf(needle)
    assert(index >= 0, `missing: ${needle}`)
    return index
  })
  for (let i = 1; i < order.length; i++) {
    assert(order[i]! > order[i - 1]!, 'phases out of order')
  }
})

check('all sweep cards share one overlay and take the layering policy z-index', () => {
  assert(/const zIndex = getSweepFanCardZIndex\(/.test(animateSource), 'z-index must come from getSweepFanCardZIndex')
  assert(/element\.style\.zIndex = String\(zIndex\)/.test(animateSource), 'card element must apply the z-index')
  assert(/overlay\.appendChild\(element\)/.test(animateSource), 'cards must be siblings in the single overlay')
})

check('only the claimant goes to the center; the others reveal at their seats', () => {
  assert(/if \(isClaimant\) \{\s*targets = computeSweepRevealLayout\(/.test(animateSource), 'claimant must use the center layout')
  assert(/\} else \{\s*const reveal = computeSeatFanRevealPoses\(/.test(animateSource), 'others must use computeSeatFanRevealPoses')
})

check('final collection is one pile flying to the claimant together', () => {
  assert(/async function collectAsOnePile[\s\S]*?getWinnerAnchor\(/.test(animateSource), 'pile target must reuse getWinnerAnchor')
  assert(!/staggerDelayMs|index \* SWEEP_/.test(animateSource), 'no per-card stagger allowed in the collection')
})

console.log('\nH) Audio routing (voice follows the claimant\'s gender)')

// Minimal browser fakes (same approach as checkGameSoundSettings.ts) so the
// real createGameAudioController runs and we can see which file it loads.
const createdAudioSources: string[] = []
class FakeAudioElement {
  src: string
  preload = ''
  volume = 1
  muted = false
  currentTime = 0
  duration = 1
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    createdAudioSources.push(src)
  }
  load(): void {}
  play(): Promise<void> { return Promise.resolve() }
  pause(): void {}
  addEventListener(): void {}
}
const fakeStorage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => fakeStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { fakeStorage.set(key, String(value)) },
  removeItem: (key: string) => { fakeStorage.delete(key) },
}
;(globalThis as any).Audio = FakeAudioElement
;(globalThis as any).document = { visibilityState: 'visible', hasFocus: () => true, addEventListener: () => {} }
;(globalThis as any).window = {
  addEventListener: () => {},
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: any) => clearTimeout(id),
}

const { createGameAudioController } = await import('../src/app/audio/createGameAudioController')

function downTheCardsSourceFor(gender: 'male' | 'female' | null | undefined): string | undefined {
  createdAudioSources.length = 0
  createGameAudioController().playDownTheCards(gender)
  return createdAudioSources.find((src) => src.includes('down-the-cards'))
}

check('male claimant → /audio/table-calls/down-the-cards.mp3', () => {
  const src = downTheCardsSourceFor('male')
  assert(src === '/audio/table-calls/down-the-cards.mp3', `got ${src}`)
})

check('female claimant → /audio/table-calls-women/down-the-cards.mp3', () => {
  const src = downTheCardsSourceFor('female')
  assert(src === '/audio/table-calls-women/down-the-cards.mp3', `got ${src}`)
})

check('unknown gender falls back to the male/default voice', () => {
  const src = downTheCardsSourceFor(null)
  assert(src === '/audio/table-calls/down-the-cards.mp3', `got ${src}`)
})

check('the gender passed is the CLAIMANT\'s (winnerSeat → getSeatGender)', () => {
  const controllerSource = readFileSync(join(process.cwd(), 'src/app/activeRoom/createActiveRoomFlowController.ts'), 'utf8')
  assert(renderSource.includes('onSweepCaptionShow?.(resolvedSweep.winnerSeat)'), 'caption must pass the claimant seat')
  assert(
    /onSweepCaptionShow: \(claimantSeat\) => \{\s*options\.gameAudio\?\.playDownTheCards\(getSeatGender\(claimantSeat\)\)/.test(controllerSource),
    'controller must play the voice with the claimant seat gender',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
