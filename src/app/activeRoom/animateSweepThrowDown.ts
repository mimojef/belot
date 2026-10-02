import type { Seat } from '../network/createGameServerClient'
import { getWinnerAnchor } from './animateTrickCollection'
import {
  getHandFanOffset,
  HAND_FAN_EDGE_DROP,
  HAND_FAN_REFERENCE_CARD_WIDTH,
  HAND_FAN_ROTATION_STEP,
  HAND_FAN_SPACING,
} from './handFanGeometry'

export type SweepThrowDownCardLike = {
  id: string
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
  rank: '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
}

export type SweepRevealRow = {
  seat: Seat
  // seat from the local player's perspective — decides where the seat's
  // revealed fan stays and which way it is pulled toward the center
  visualSeat: Seat
  // in the order the cards should fan out
  cards: SweepThrowDownCardLike[]
}

export type AnimateSweepThrowDownOptions = {
  rows: SweepRevealRow[]
  claimantSeat: Seat
  // 1600×900 stage element; its on-screen rect gives the same stageScale the
  // normal played cards use, so revealed cards match them exactly
  getStageElement: () => HTMLElement | null
  stageWidth: number
  stageHeight: number
  // normal played-card size in stage units (TRICK_W/TRICK_H)
  cardWidth: number
  cardHeight: number
  renderCardFaceHtml: (card: SweepThrowDownCardLike) => string
  // the real card elements of a seat's hand fan, in fan order (left → right)
  getSeatFanCardElements: (seat: Seat) => HTMLElement[]
  // fallback start point when a seat has no visible fan
  getSeatAnchorElement: (seat: Seat) => HTMLElement | null
  getCollectTargetElement: () => HTMLElement | null
  collectVisualSeat: Seat
  onCaptionShow: () => void
  onCaptionHide: () => void
  onRevealComplete: () => void
  onComplete: () => void
}

// "Долу картите" presentation timeline (after the server accepted the sweep):
//   caption + sound → claimant's fan closes into a pile → the pile flies to the
//   center and fans out again face-up → short beat → the other three fans close
//   → each opens again face-up next to its own seat, pulled a bit toward the
//   center → hold → one-pile collection.
// SERVER_TIMING_CONFIG.sweepResolutionAutoAdvanceMs (server/src/game/
// serverTimingConfig.ts) mirrors this budget so the server doesn't advance to
// scoring while the animation is still running.
export const SWEEP_CAPTION_VISIBLE_MS = 1500
export const SWEEP_FAN_CLOSE_MS = 180
export const SWEEP_FAN_FLIGHT_MS = 320
// the claimant's fan lies alone in the center before the other hands open
export const SWEEP_CLAIMANT_LANDED_BEAT_MS = 1000
export const SWEEP_REVEAL_HOLD_MS = 1500
export const SWEEP_COLLECT_GATHER_MS = 180
export const SWEEP_COLLECT_FLY_MS = 560
export const SWEEP_FINAL_PAUSE_MS = 50

export function getSweepPresentationDurationMs(): number {
  return (
    SWEEP_CAPTION_VISIBLE_MS +
    // claimant: close + flight, then the other fans: close + flight
    2 * (SWEEP_FAN_CLOSE_MS + SWEEP_FAN_FLIGHT_MS) +
    SWEEP_CLAIMANT_LANDED_BEAT_MS +
    SWEEP_REVEAL_HOLD_MS +
    SWEEP_COLLECT_GATHER_MS +
    SWEEP_COLLECT_FLY_MS +
    SWEEP_FINAL_PAUSE_MS
  )
}

// Center fan layout (the claimant's cards; supports several rows) in stage
// units: rows of up to 7 normal-size cards, each row a hand fan (same formula
// as the real hands) centered on the table.
// Rows overlap vertically but every card's corner index stays visible; cards
// are never scaled down.
export const SWEEP_REVEAL_MAX_ROW_WIDTH = 1040
export const SWEEP_REVEAL_MAX_BLOCK_HEIGHT = 640
// Wider than the hand's 62/195 so the revealed cards stay easy to read.
const SWEEP_REVEAL_FAN_SPACING_RATIO = 0.62
const SWEEP_REVEAL_CARD_GAP = 16
const SWEEP_REVEAL_SIDE_ROW_SHIFT = 48
const SWEEP_REVEAL_ROW_ORDER: Seat[] = ['top', 'left', 'right', 'bottom']
const OVERLAY_Z_INDEX = 9500

export type SweepRevealSlot = {
  seat: Seat
  cardIndex: number
  rowIndex: number
  centerX: number
  centerY: number
  rotate: number
  zIndex: number
}

export function computeSweepRevealLayout(params: {
  rows: Array<{ seat: Seat; visualSeat: Seat; cardCount: number }>
  cardWidth: number
  cardHeight: number
  centerX: number
  centerY: number
}): SweepRevealSlot[] {
  const { cardWidth, cardHeight, centerX, centerY } = params
  const rows = params.rows
    .filter((row) => row.cardCount > 0)
    .sort(
      (a, b) =>
        SWEEP_REVEAL_ROW_ORDER.indexOf(a.visualSeat) - SWEEP_REVEAL_ROW_ORDER.indexOf(b.visualSeat),
    )
  const rowCount = rows.length
  const stepY = rowCount <= 1
    ? 0
    : Math.min(cardHeight + SWEEP_REVEAL_CARD_GAP, (SWEEP_REVEAL_MAX_BLOCK_HEIGHT - cardHeight) / (rowCount - 1))

  const slots: SweepRevealSlot[] = []
  rows.forEach((row, rowIndex) => {
    const count = row.cardCount
    const spacing = count <= 1
      ? 0
      : Math.min(cardWidth * SWEEP_REVEAL_FAN_SPACING_RATIO, (SWEEP_REVEAL_MAX_ROW_WIDTH - cardWidth) / (count - 1))
    const shiftX = row.visualSeat === 'left'
      ? -SWEEP_REVEAL_SIDE_ROW_SHIFT
      : row.visualSeat === 'right'
        ? SWEEP_REVEAL_SIDE_ROW_SHIFT
        : 0
    const rowCenterY = centerY + (rowIndex - (rowCount - 1) / 2) * stepY

    for (let cardIndex = 0; cardIndex < count; cardIndex += 1) {
      const fan = getHandFanOffset(cardIndex, count, {
        spacing,
        edgeDropMax: HAND_FAN_EDGE_DROP,
        rotationStep: HAND_FAN_ROTATION_STEP,
        edgeDropScale: cardWidth / HAND_FAN_REFERENCE_CARD_WIDTH,
      })
      slots.push({
        seat: row.seat,
        cardIndex,
        rowIndex,
        centerX: centerX + shiftX + fan.x,
        centerY: rowCenterY + fan.y,
        rotate: fan.rotate,
        zIndex: rowIndex * 10 + cardIndex + 1,
      })
    }
  })

  return slots
}

// Screen-space pose of a card element whose layout box is cardWidth×cardHeight.
export type CardPose = { x: number; y: number; rotate: number; scale: number }

// How far (stage units) the other players' revealed fans are pulled from
// their normal hand position toward the table center.
export const SWEEP_SEAT_FAN_PULL = 110

const SEAT_PULL_DIRECTION: Record<Seat, { x: number; y: number }> = {
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
}

// The other players' reveal keeps their real hand fan: same positions,
// angles, overlap and direction, just scaled (around the fan's own center)
// to the normal played-card size and pulled a bit toward the table center.
// An upside-down fan (the top seat) keeps its shape but each card is turned
// upright so the faces read normally; `flipped` tells the caller to reverse
// the card order / stacking so the corner indices stay visible.
export function computeSeatFanRevealPoses(params: {
  fan: CardPose[]
  visualSeat: Seat
  targetScale: number
  pullPx: number
}): { poses: CardPose[]; flipped: boolean } {
  const { fan, visualSeat, targetScale, pullPx } = params
  if (fan.length === 0) return { poses: [], flipped: false }
  const center = averagePoint(fan)
  const flipped = Math.abs(normalizeAngle(averageRotation(fan))) > 135
  const direction = SEAT_PULL_DIRECTION[visualSeat]
  const poses = fan.map((pose) => {
    const ratio = pose.scale > 0 ? targetScale / pose.scale : 1
    return {
      x: center.x + direction.x * pullPx + (pose.x - center.x) * ratio,
      y: center.y + direction.y * pullPx + (pose.y - center.y) * ratio,
      rotate: normalizeAngle(pose.rotate + (flipped ? 180 : 0)),
      scale: targetScale,
    }
  })
  return { poses, flipped }
}

// Stacking policy (all cards are siblings in one overlay, so z-index alone
// decides): the claimant's center fan is the lowest layer, every other
// player's revealed seat fan is above it — on small screens a side fan may
// overlap the center fan and must stay visible on top.
export const SWEEP_CLAIMANT_FAN_Z_BASE = 10
export const SWEEP_SEAT_FAN_Z_BASE = 100

export function getSweepFanCardZIndex(params: {
  isClaimant: boolean
  rowIndex: number
  index: number
  count: number
  flipped: boolean
}): number {
  const { isClaimant, rowIndex, index, count, flipped } = params
  const base = isClaimant ? SWEEP_CLAIMANT_FAN_Z_BASE : SWEEP_SEAT_FAN_Z_BASE + rowIndex * 10
  return base + (flipped ? count - 1 - index : index) + 1
}

const SEAT_FAN_BASE_ROTATION: Record<Seat, number> = { bottom: 0, top: 180, left: 90, right: -90 }

// Fallback when a seat's fan is not on screen: the same normal hand fan
// (getHandFanOffset) built around the seat anchor with the seat's rotation.
export function synthesizeSeatFanPoses(params: {
  count: number
  center: { x: number; y: number }
  visualSeat: Seat
  cardWidth: number
  scale: number
}): CardPose[] {
  const { count, center, visualSeat, cardWidth, scale } = params
  const screenCardWidth = cardWidth * scale
  const base = SEAT_FAN_BASE_ROTATION[visualSeat]
  const radians = (base * Math.PI) / 180
  return Array.from({ length: count }, (_, index) => {
    const fan = getHandFanOffset(index, count, {
      spacing: (HAND_FAN_SPACING / HAND_FAN_REFERENCE_CARD_WIDTH) * screenCardWidth,
      edgeDropMax: HAND_FAN_EDGE_DROP,
      rotationStep: HAND_FAN_ROTATION_STEP,
      edgeDropScale: screenCardWidth / HAND_FAN_REFERENCE_CARD_WIDTH,
    })
    return {
      x: center.x + fan.x * Math.cos(radians) - fan.y * Math.sin(radians),
      y: center.y + fan.x * Math.sin(radians) + fan.y * Math.cos(radians),
      rotate: base + fan.rotate,
      scale,
    }
  })
}

// Close → fly → re-fan: the pile moves as a whole first, the fan opens up
// progressively on the way (spread ~ u²), and halfway through the card turns
// over (scaleX dips to almost 0 while the face fades in).
export function computeFanFlightPose(
  u: number,
  params: { pile: CardPose; target: CardPose; groupTarget: { x: number; y: number }; flip: boolean },
): CardPose & { scaleX: number } {
  const { pile, target, groupTarget, flip } = params
  const travel = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2
  const spread = u * u
  const groupX = pile.x + (groupTarget.x - pile.x) * travel
  const groupY = pile.y + (groupTarget.y - pile.y) * travel
  const flipDistance = Math.abs(u - 0.5) / 0.1
  const scaleX = flip && flipDistance < 1 ? 0.08 + 0.92 * flipDistance : 1
  return {
    x: groupX + (target.x - groupTarget.x) * spread,
    y: groupY + (target.y - groupTarget.y) * spread,
    rotate: pile.rotate + (target.rotate - pile.rotate) * spread,
    scale: pile.scale + (target.scale - pile.scale) * travel,
    scaleX,
  }
}

const FAN_FLIGHT_SAMPLES = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function finishAnimation(animation: Animation): Promise<void> {
  return new Promise((resolve) => {
    animation.onfinish = () => resolve()
    animation.oncancel = () => resolve()
  })
}

type StageFrame = { left: number; top: number; scale: number }

function resolveStageFrame(stageElement: HTMLElement | null, stageWidth: number, stageHeight: number): StageFrame {
  const rect = stageElement?.getBoundingClientRect() ?? null
  if (rect && rect.width > 0 && rect.height > 0) {
    return { left: rect.left, top: rect.top, scale: rect.width / stageWidth }
  }
  const scale = Math.min(window.innerWidth / stageWidth, window.innerHeight / stageHeight)
  return {
    left: (window.innerWidth - stageWidth * scale) / 2,
    top: (window.innerHeight - stageHeight * scale) / 2,
    scale,
  }
}

function parseAngleDeg(value: string): number {
  const match = /(-?[\d.]+)(deg|rad|turn)\s*$/.exec(value.trim())
  if (!match) return 0
  const amount = Number.parseFloat(match[1]!)
  if (match[2] === 'rad') return (amount * 180) / Math.PI
  if (match[2] === 'turn') return amount * 360
  return amount
}

// Measures where a real fan card is on screen: center, accumulated rotation
// (own transform + the fan wrapper's `rotate` + the panel transforms) and
// accumulated scale, so the animated clone starts exactly on top of it.
function measureScreenPose(element: HTMLElement, cardWidth: number): CardPose | null {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  let rotate = 0
  let scale = 1
  for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (style.transform && style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform)
      rotate += (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI
      scale *= Math.hypot(matrix.a, matrix.b)
    }
    if (style.rotate && style.rotate !== 'none') {
      rotate += parseAngleDeg(style.rotate)
    }
    if (style.scale && style.scale !== 'none') {
      scale *= Number.parseFloat(style.scale) || 1
    }
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    rotate,
    scale: (element.offsetWidth * scale) / cardWidth,
  }
}

function poseTransform(pose: CardPose, cardWidth: number, cardHeight: number, scaleX = 1): string {
  return (
    `translate(${pose.x - cardWidth / 2}px,${pose.y - cardHeight / 2}px) ` +
    `rotate(${pose.rotate}deg) scale(${pose.scale * scaleX},${pose.scale})`
  )
}

type AnimatedCard = {
  element: HTMLElement
  face: HTMLElement
  hasBack: boolean
  source: HTMLElement | null
  start: CardPose | null
  pile: CardPose
  target: CardPose
  zIndex: number
}

type SeatGroup = {
  seat: Seat
  cards: AnimatedCard[]
  groupTarget: { x: number; y: number }
}

function createAnimatedCardElement(params: {
  overlay: HTMLElement
  source: HTMLElement | null
  faceHtml: string
  cardWidth: number
  cardHeight: number
  zIndex: number
}): { element: HTMLElement; face: HTMLElement; hasBack: boolean } {
  const { overlay, source, faceHtml, cardWidth, cardHeight, zIndex } = params
  const element = document.createElement('div')
  element.setAttribute('data-sweep-reveal-card', '1')
  element.style.position = 'fixed'
  element.style.left = '0'
  element.style.top = '0'
  element.style.width = `${cardWidth}px`
  element.style.height = `${cardHeight}px`
  element.style.transformOrigin = '50% 50%'
  element.style.willChange = 'transform, opacity'
  element.style.pointerEvents = 'none'
  element.style.zIndex = String(zIndex)
  element.style.visibility = 'hidden'

  // A face-up source (the local hand) keeps showing its face; a face-down
  // panel fan shows its real card back until the mid-flight flip.
  const hasBack = source !== null && !source.matches('[data-card-id]')
  if (hasBack) {
    const back = document.createElement('div')
    back.style.position = 'absolute'
    back.style.inset = '0'
    back.style.borderRadius = '16px'
    back.style.overflow = 'hidden'
    back.style.border = '1px solid rgba(255,255,255,0.24)'
    back.style.boxShadow = '0 8px 18px rgba(0,0,0,0.22)'
    back.innerHTML = source.innerHTML
    element.appendChild(back)
  }

  const face = document.createElement('div')
  face.style.position = 'absolute'
  face.style.inset = '0'
  face.style.opacity = hasBack ? '0' : '1'
  face.innerHTML = faceHtml
  element.appendChild(face)

  overlay.appendChild(element)
  return { element, face, hasBack }
}

function averagePoint(poses: CardPose[]): { x: number; y: number } {
  const total = poses.reduce((acc, pose) => ({ x: acc.x + pose.x, y: acc.y + pose.y }), { x: 0, y: 0 })
  return { x: total.x / poses.length, y: total.y / poses.length }
}

function averageRotation(poses: CardPose[]): number {
  return poses.reduce((acc, pose) => acc + pose.rotate, 0) / poses.length
}

function normalizeAngle(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

// A face-up fan (the local hand) knows which element is which card — keep
// the cards in the order they are actually fanned, so each card flies from
// its own spot and the center fan keeps the same order.
function orderCardsLikeFan(
  cards: SweepThrowDownCardLike[],
  sources: HTMLElement[],
): SweepThrowDownCardLike[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  const ordered = sources
    .map((source) => byId.get(source.dataset.cardId ?? ''))
    .filter((card): card is SweepThrowDownCardLike => card !== undefined)
  if (ordered.length !== cards.length) return cards
  return ordered
}

async function closeFan(group: SeatGroup, cardWidth: number, cardHeight: number): Promise<void> {
  const animations = group.cards.map((card) => {
    card.source?.style.setProperty('visibility', 'hidden')
    card.element.style.visibility = 'visible'
    const from = card.start ?? card.pile
    return card.element.animate(
      [
        { transform: poseTransform(from, cardWidth, cardHeight) },
        { transform: poseTransform(card.pile, cardWidth, cardHeight) },
      ],
      { duration: SWEEP_FAN_CLOSE_MS, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'forwards' },
    )
  })
  await Promise.all(animations.map(finishAnimation))
}

async function flyAndReFan(group: SeatGroup, cardWidth: number, cardHeight: number): Promise<void> {
  const animations = group.cards.flatMap((card) => {
    const frames = FAN_FLIGHT_SAMPLES.map((u) => {
      const pose = computeFanFlightPose(u, {
        pile: card.pile,
        target: card.target,
        groupTarget: group.groupTarget,
        flip: card.hasBack,
      })
      return { offset: u, transform: poseTransform(pose, cardWidth, cardHeight, pose.scaleX) }
    })
    const flight = card.element.animate(frames, { duration: SWEEP_FAN_FLIGHT_MS, easing: 'linear', fill: 'forwards' })
    if (!card.hasBack) {
      return [flight]
    }
    const faceFlip = card.face.animate(
      [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: 0.49 },
        { opacity: 1, offset: 0.51 },
        { opacity: 1, offset: 1 },
      ],
      { duration: SWEEP_FAN_FLIGHT_MS, easing: 'linear', fill: 'forwards' },
    )
    return [flight, faceFlip]
  })
  await Promise.all(animations.map(finishAnimation))
}

// One shared pile: every revealed card gathers to the middle of the block,
// then the whole pile flies to the claimant together (same anchor and
// shrink/fade as animateTrickCollection's normal trick collection).
async function collectAsOnePile(params: {
  cards: AnimatedCard[]
  cardWidth: number
  cardHeight: number
  targetElement: HTMLElement | null
  collectVisualSeat: Seat
}): Promise<void> {
  const { cards, cardWidth, cardHeight, targetElement, collectVisualSeat } = params
  if (cards.length === 0) return
  const center = averagePoint(cards.map((card) => card.target))
  const scale = cards[0]!.target.scale
  const piled = cards.map((card, index) => ({
    card,
    pose: { x: center.x + (index - (cards.length - 1) / 2) * 0.8, y: center.y + index * 0.6, rotate: 0, scale },
  }))

  await Promise.all(
    piled.map(({ card, pose }) =>
      finishAnimation(
        card.element.animate(
          [
            { transform: poseTransform(card.target, cardWidth, cardHeight) },
            { transform: poseTransform(pose, cardWidth, cardHeight) },
          ],
          { duration: SWEEP_COLLECT_GATHER_MS, easing: 'cubic-bezier(0.22,0.61,0.36,1)', fill: 'forwards' },
        ),
      ),
    ),
  )

  const targetRect = targetElement?.getBoundingClientRect() ?? null
  if (!targetRect || (targetRect.width === 0 && targetRect.height === 0)) return
  const anchor = getWinnerAnchor(targetRect, collectVisualSeat)

  await Promise.all(
    piled.map(({ card, pose }) => {
      const dx = anchor.x - center.x
      const dy = anchor.y - center.y
      const landing = { ...pose, x: pose.x + dx, y: pose.y + dy }
      return finishAnimation(
        card.element.animate(
          [
            { transform: poseTransform(pose, cardWidth, cardHeight), opacity: 1, offset: 0 },
            { transform: poseTransform({ ...landing, scale: scale * 0.76 }, cardWidth, cardHeight), opacity: 1, offset: 0.82 },
            { transform: poseTransform({ ...landing, scale: scale * 0.56 }, cardWidth, cardHeight), opacity: 0, offset: 1 },
          ],
          { duration: SWEEP_COLLECT_FLY_MS, easing: 'cubic-bezier(0.2,0.8,0.2,1)', fill: 'forwards' },
        ),
      )
    }),
  )
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.setAttribute('data-sweep-throw-down-overlay', '1')
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = String(OVERLAY_Z_INDEX)
  overlay.style.overflow = 'visible'
  document.body.appendChild(overlay)
  return overlay
}

// "Долу картите" presentation: caption → the claimant's real hand fan closes
// into a pile, flies to the table center and fans out again face-up (normal
// played-card size) → the other three fans close and open again face-up at
// their own seats, pulled a bit inward → hold → every revealed card gathers
// into one pile that flies to the claimant.
export async function animateSweepThrowDown(options: AnimateSweepThrowDownOptions): Promise<void> {
  const { rows, stageWidth, stageHeight, cardWidth, cardHeight } = options
  const overlay = createOverlay()
  const hiddenSources: HTMLElement[] = []

  try {
    options.onCaptionShow()
    await wait(SWEEP_CAPTION_VISIBLE_MS)
    options.onCaptionHide()

    const frame = resolveStageFrame(options.getStageElement(), stageWidth, stageHeight)
    const stageCenter = {
      x: frame.left + (stageWidth / 2) * frame.scale,
      y: frame.top + (stageHeight / 2) * frame.scale,
    }

    const groups: SeatGroup[] = rows.flatMap((sourceRow, rowIndex) => {
      if (sourceRow.cards.length === 0) return []
      const isClaimant = sourceRow.seat === options.claimantSeat
      const sources = options.getSeatFanCardElements(sourceRow.seat)
      const orderedCards = orderCardsLikeFan(sourceRow.cards, sources)
      const count = orderedCards.length
      const measured = orderedCards.map((_, index) => {
        const source = sources[index] ?? null
        return source ? measureScreenPose(source, cardWidth) : null
      })
      const hasRealFan = measured.every((pose) => pose !== null)
      // The seat's normal hand fan on screen — measured, or rebuilt with the
      // shared fan formula around the seat anchor when it is not visible.
      const anchorRect = options.getSeatAnchorElement(sourceRow.seat)?.getBoundingClientRect() ?? null
      const fan: CardPose[] = hasRealFan
        ? (measured as CardPose[])
        : synthesizeSeatFanPoses({
            count,
            center: anchorRect
              ? { x: anchorRect.left + anchorRect.width / 2, y: anchorRect.top + anchorRect.height / 2 }
              : stageCenter,
            visualSeat: sourceRow.visualSeat,
            cardWidth,
            scale: frame.scale,
          })

      // Claimant → one fan in the table center. Everyone else → their own
      // fan face-up, kept at their seat and pulled a bit toward the center.
      let targets: CardPose[]
      let flipped = false
      if (isClaimant) {
        targets = computeSweepRevealLayout({
          rows: [{ seat: sourceRow.seat, visualSeat: sourceRow.visualSeat, cardCount: count }],
          cardWidth,
          cardHeight,
          centerX: stageWidth / 2,
          centerY: stageHeight / 2,
        }).map((slot) => ({
          x: frame.left + slot.centerX * frame.scale,
          y: frame.top + slot.centerY * frame.scale,
          rotate: slot.rotate,
          scale: frame.scale,
        }))
      } else {
        const reveal = computeSeatFanRevealPoses({
          fan,
          visualSeat: sourceRow.visualSeat,
          targetScale: frame.scale,
          pullPx: SWEEP_SEAT_FAN_PULL * frame.scale,
        })
        targets = reveal.poses
        flipped = reveal.flipped
      }

      const pileCenter = averagePoint(fan)
      const pileRotate = normalizeAngle(averageRotation(fan))
      const pileScale = fan[0]!.scale
      const cards = fan.map((_, index) => {
        // An upright-turned (flipped) fan reads right-to-left by index, so the
        // cards are assigned and stacked in reverse to keep it readable.
        const card = flipped ? orderedCards[count - 1 - index]! : orderedCards[index]!
        const zIndex = getSweepFanCardZIndex({ isClaimant, rowIndex, index, count, flipped })
        const source = hasRealFan ? sources[index] ?? null : null
        if (source) hiddenSources.push(source)
        const { element, face, hasBack } = createAnimatedCardElement({
          overlay,
          source,
          faceHtml: options.renderCardFaceHtml(card),
          cardWidth,
          cardHeight,
          zIndex,
        })
        const pileOffset = index - (count - 1) / 2
        const pile: CardPose = {
          x: pileCenter.x + pileOffset * 1.2,
          y: pileCenter.y + Math.abs(pileOffset) * 0.6,
          rotate: pileRotate,
          scale: pileScale,
        }
        return {
          element,
          face,
          hasBack,
          source,
          start: hasRealFan ? measured[index] ?? null : null,
          pile,
          target: targets[index]!,
          zIndex,
        }
      })
      return [{ seat: sourceRow.seat, cards, groupTarget: averagePoint(targets) }]
    })

    await waitForNextFrame()

    const claimantGroups = groups.filter((group) => group.seat === options.claimantSeat)
    const otherGroups = groups.filter((group) => group.seat !== options.claimantSeat)

    await Promise.all(claimantGroups.map((group) => closeFan(group, cardWidth, cardHeight)))
    await Promise.all(claimantGroups.map((group) => flyAndReFan(group, cardWidth, cardHeight)))
    await wait(SWEEP_CLAIMANT_LANDED_BEAT_MS)
    await Promise.all(otherGroups.map((group) => closeFan(group, cardWidth, cardHeight)))
    await Promise.all(otherGroups.map((group) => flyAndReFan(group, cardWidth, cardHeight)))

    options.onRevealComplete()
    await wait(SWEEP_REVEAL_HOLD_MS)

    await collectAsOnePile({
      cards: groups.flatMap((group) => group.cards),
      cardWidth,
      cardHeight,
      targetElement: options.getCollectTargetElement(),
      collectVisualSeat: options.collectVisualSeat,
    })

    overlay.replaceChildren()
    await wait(SWEEP_FINAL_PAUSE_MS)
  } finally {
    hiddenSources.forEach((source) => source.style.removeProperty('visibility'))
    overlay.remove()
    options.onComplete()
  }
}
