// Свара — анимационен прототип: layout и хореография (само демо данни).
//
// Без игрова логика, без реални играчи/жълтици/залози. Всичко е
// детерминистично (seeded), за да може всяко пускане и всеки renderer да
// изглеждат еднакво и демото да се проверява автоматично.
//
// Етап 2А.1: раздаване с пренареждане на ветрилото при всяка нова карта,
// обръщане с „вдигане“, чипове от купчинката на играча към малки купчинки
// в банката (коректна сума), събиране на банката и каскадно прибиране към
// победителя, където чиповете остават видими (без изчезване/удвояване).

import type { SvaraChipColor, SvaraEasingName, SvaraMove, SvaraSpriteDef, SvaraSpriteState } from './svaraDemoMotion'

export type SvaraSeatIndex = 0 | 1 | 2 | 3

export type SvaraPoint = { x: number; y: number }

export type SvaraSeatLayout = {
  index: SvaraSeatIndex
  avatar: SvaraPoint
  /** Единичен вектор от мястото към центъра. */
  inward: SvaraPoint
  /** Единичен вектор по „ветрилото“ на картите. */
  tangent: SvaraPoint
  /** Ротация на картите на мястото (градуси). */
  cardRotation: number
  /** Купчинката чипове на играча (основа). */
  chipStack: SvaraPoint
}

export type SvaraDemoLayout = {
  width: number
  height: number
  isPortrait: boolean
  avatarSize: number
  cardWidth: number
  cardHeight: number
  chipSize: number
  /** Вертикално отместване между чиповете в купчинка. */
  chipStep: number
  deck: SvaraPoint
  pot: SvaraPoint
  /** Малките купчинки в банката — по една на място. */
  potStacks: SvaraPoint[]
  /** Къде стои надписът на банката (център на надписа). */
  potLabel: SvaraPoint
  /** Къде се събира банката преди прибирането (основа на купчинката). */
  potGather: SvaraPoint
  /** Мащаб на картите на мястото (страничните на телефон са по-малки). */
  handScale: number[]
  revealScale: number
  seats: SvaraSeatLayout[]
}

export type SvaraDemoPhaseName = 'deal' | 'reveal' | 'bet' | 'svarka' | 'collect'

export type SvaraDemoEvent =
  | { atMs: number; kind: 'sound'; sound: 'deal' | 'land' | 'chips' }
  | { atMs: number; kind: 'pot'; value: number }
  | { atMs: number; kind: 'winner'; seat: SvaraSeatIndex; amount: number }

export type SvaraDemoPhase = {
  name: SvaraDemoPhaseName
  moves: SvaraMove[]
  /** Звуци, сума на банката, ефект за победа — в ms от началото на фазата. */
  events: SvaraDemoEvent[]
  holdAfterMs: number
  showSvarkaBanner: boolean
  /** Демо стойност на банката след фазата (без валута). */
  potAfter: number
  winnerSeat: SvaraSeatIndex | null
}

export type SvaraSceneStates = Record<string, SvaraSpriteState>

export type SvaraDemoScript = {
  layout: SvaraDemoLayout
  sprites: SvaraSpriteDef[]
  initial: SvaraSceneStates
  phases: SvaraDemoPhase[]
  /** Състояние след всяка фаза (statesAfter[i] = след phases[i]). */
  statesAfter: SvaraSceneStates[]
  /** Демо стойност на всеки чип (за проверка на сумата). */
  chipValues: Record<string, number>
}

export const SVARA_DEMO_CARD_BACK_SRC = '/images/cards/card-back.webp'
export const SVARA_DEMO_AVATAR_SRCS = [
  '/assets/avatars/male/male-avatar-01.webp',
  '/assets/avatars/female/female-avatar-02.webp',
  '/assets/avatars/male/male-avatar-03.webp',
  '/assets/avatars/female/female-avatar-04.webp',
] as const
export const SVARA_DEMO_SEAT_NAMES = ['Ти', 'Демо 1', 'Демо 2', 'Демо 3'] as const
export const SVARA_DEMO_SOUND_SRCS = {
  deal: '/audio/card-sfx/card-move.mp3',
  land: '/audio/card-sfx/card-on-table.mp3',
  chips: '/audio/game-sounds/coins.mp3',
} as const
export const SVARA_CHIP_VALUES: Record<SvaraChipColor, number> = { red: 10, blue: 25, green: 50 }

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const
const CHIP_COLORS: SvaraChipColor[] = ['red', 'blue', 'green']
const CHIPS_PER_SEAT = 5
const CHIPS_BET_PER_SEAT = 3
const CARDS_PER_SEAT = 3
const DECK_SIZE = 32
const DEAL_SEAT_ORDER: SvaraSeatIndex[] = [1, 2, 3, 0]
const WINNER_SEAT: SvaraSeatIndex = 0
const REVEAL_SCALE = 1.32
const PORTRAIT_SIDE_HAND_SCALE = 0.78

export const svaraCardFaceSrc = (rank: string, suit: string) => `/images/cards/${suit}/${rank}_${suit}_300x420.webp`

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function createRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function computeSvaraDemoLayout(width: number, height: number): SvaraDemoLayout {
  const w = Math.max(240, width)
  const h = Math.max(240, height)
  const isPortrait = h > w * 0.9
  const avatarSize = clamp(Math.min(w, h) * 0.14, 44, 84)
  const cardWidth = clamp(Math.min(w * 0.125, h * 0.13), 38, 96)
  const cardHeight = cardWidth * 1.4
  const chipSize = clamp(cardWidth * 0.5, 22, 46)
  const chipStep = chipSize * 0.13
  const cx = w / 2
  const cy = h / 2
  const edge = avatarSize * 0.62 + 6

  const seatBase: Array<{ avatar: SvaraPoint; inward: SvaraPoint; cardRotation: number }> = [
    { avatar: { x: cx, y: h - edge }, inward: { x: 0, y: -1 }, cardRotation: 0 },
    { avatar: { x: edge, y: cy }, inward: { x: 1, y: 0 }, cardRotation: 90 },
    { avatar: { x: cx, y: edge }, inward: { x: 0, y: 1 }, cardRotation: 180 },
    { avatar: { x: w - edge, y: cy }, inward: { x: -1, y: 0 }, cardRotation: -90 },
  ]

  // Портрет: тестето и банката са в централна колона (страничните ръце са
  // по-малки и не навлизат в нея). Хоризонтално: банката е над центъра,
  // за да не я застъпват обърнатите карти на играча.
  // Хоризонтално: средата на пролуката между долния ръб на горната ръка и
  // горния ръб на обърнатите карти.
  const topHandBottom = edge + avatarSize * 0.5 + cardHeight * 1.14
  const revealTop = h - edge - avatarSize * 0.5 - cardHeight * REVEAL_SCALE * 1.1
  const midY = (topHandBottom + revealTop) / 2
  const deck = isPortrait ? { x: cx, y: cy - cardHeight * 0.7 } : { x: cx - Math.max(cardWidth * 1.9, w * 0.17), y: midY }
  const pot = isPortrait ? { x: cx, y: cy + cardHeight * 0.45 } : { x: cx + cardWidth * 0.5, y: midY }
  const gx = chipSize * 0.66
  const gy = chipSize * 0.4
  // Купчинките в банката: по една за всяко място (seat 0..3).
  const potStacks = [
    { x: pot.x + gx, y: pot.y + gy },
    { x: pot.x - gx, y: pot.y + gy },
    { x: pot.x - gx, y: pot.y - gy },
    { x: pot.x + gx, y: pot.y - gy },
  ]

  return {
    width: w,
    height: h,
    isPortrait,
    avatarSize,
    cardWidth,
    cardHeight,
    chipSize,
    chipStep,
    deck,
    pot,
    potStacks,
    potLabel: isPortrait ? { x: pot.x, y: pot.y + gy + chipSize * 0.5 + 14 } : { x: pot.x + chipSize * 1.55 + 62, y: pot.y },
    potGather: isPortrait ? { x: pot.x, y: pot.y + chipSize * 0.35 } : { x: pot.x, y: pot.y + chipSize * 0.2 },
    handScale: [1, isPortrait ? PORTRAIT_SIDE_HAND_SCALE : 1, 1, isPortrait ? PORTRAIT_SIDE_HAND_SCALE : 1],
    revealScale: REVEAL_SCALE,
    seats: seatBase.map((seat, index) => {
      const tangent = { x: -seat.inward.y, y: seat.inward.x }
      const side = avatarSize * 0.98
      return {
        index: index as SvaraSeatIndex,
        avatar: seat.avatar,
        inward: seat.inward,
        tangent,
        cardRotation: seat.cardRotation,
        chipStack: { x: seat.avatar.x - tangent.x * side, y: seat.avatar.y - tangent.y * side + chipSize * 0.2 },
      }
    }),
  }
}

/** Позиция на карта slot в ветрило от count карти на мястото. */
function seatFanState(layout: SvaraDemoLayout, seat: SvaraSeatLayout, slot: number, count: number, z: number): SvaraSpriteState {
  const offset = slot - (count - 1) / 2
  const scale = layout.handScale[seat.index] ?? 1
  const reach = layout.avatarSize * 0.5 + layout.cardHeight * scale * 0.64
  const spread = layout.cardWidth * scale * 0.52
  const tuck = Math.abs(offset) * layout.cardHeight * scale * 0.03
  return {
    x: seat.avatar.x + seat.inward.x * (reach - tuck) + seat.tangent.x * offset * spread,
    y: seat.avatar.y + seat.inward.y * (reach - tuck) + seat.tangent.y * offset * spread,
    rotation: seat.cardRotation + offset * 8,
    scale,
    alpha: 1,
    z,
    faceUp: false,
  }
}

function ownRevealCardState(layout: SvaraDemoLayout, slot: number, z: number): SvaraSpriteState {
  const seat = layout.seats[0]!
  const offset = slot - 1
  const scale = layout.revealScale
  const reach = layout.avatarSize * 0.5 + layout.cardHeight * scale * 0.6
  return {
    x: seat.avatar.x + offset * layout.cardWidth * scale * 0.6,
    y: seat.avatar.y - reach + Math.abs(offset) * layout.cardHeight * 0.06,
    rotation: offset * 7,
    scale,
    alpha: 1,
    z,
    faceUp: true,
  }
}

function chipOnStack(point: SvaraPoint, level: number, layout: SvaraDemoLayout, z: number, rotation: number): SvaraSpriteState {
  return { x: point.x, y: point.y - level * layout.chipStep, rotation, scale: 1, alpha: 1, z, faceUp: false }
}

type MoveInput = Omit<SvaraMove, 'from' | 'rotationEasing' | 'curve' | 'raisePx' | 'spinDeg' | 'bounce' | 'liftPeak'> & Partial<Pick<SvaraMove, 'rotationEasing' | 'curve' | 'raisePx' | 'spinDeg' | 'bounce' | 'liftPeak'>>

export function buildSvaraDemoScript(width: number, height: number): SvaraDemoScript {
  const layout = computeSvaraDemoLayout(width, height)
  const random = createRandom(20261015)
  const jitter = (amount: number) => (random() - 0.5) * 2 * amount

  // ── Тесте: картите на мястото на играча (seat 0) са три аса; останалите
  // са детерминистично разбъркани. deckFaces[i] е картата на позиция i в
  // тестето (31 = най-горна).
  const ownFaces = [svaraCardFaceSrc('A', 'spades'), svaraCardFaceSrc('A', 'hearts'), svaraCardFaceSrc('A', 'diamonds')]
  const rest = SUITS.flatMap((suit) => RANKS.map((rank) => svaraCardFaceSrc(rank, suit))).filter((src) => !ownFaces.includes(src))
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  const deckFaces: string[] = new Array(DECK_SIZE)
  let restIndex = 0
  for (let k = 0; k < DEAL_SEAT_ORDER.length * CARDS_PER_SEAT; k += 1) {
    const seat = DEAL_SEAT_ORDER[k % DEAL_SEAT_ORDER.length]!
    const slot = Math.floor(k / DEAL_SEAT_ORDER.length)
    deckFaces[DECK_SIZE - 1 - k] = seat === 0 ? ownFaces[slot]! : rest[restIndex++]!
  }
  for (let i = 0; i < DECK_SIZE; i += 1) deckFaces[i] ??= rest[restIndex++]!

  const sprites: SvaraSpriteDef[] = []
  const initial: SvaraSceneStates = {}
  const chipValues: Record<string, number> = {}

  // Лице се зарежда само за картите, които се обръщат (собствените три) —
  // както в реалната игра клиентът няма да знае скритите карти.
  const dealtIndex = (k: number) => DECK_SIZE - 1 - k
  const ownDealOrder = Array.from({ length: CARDS_PER_SEAT }, (_, slot) => slot * DEAL_SEAT_ORDER.length + DEAL_SEAT_ORDER.indexOf(0))
  const revealedDeckIndexes = new Set(ownDealOrder.map(dealtIndex))
  for (let i = 0; i < DECK_SIZE; i += 1) {
    const id = `card-${i}`
    sprites.push({ id, kind: 'card', faceSrc: revealedDeckIndexes.has(i) ? deckFaces[i]! : null })
    initial[id] = { x: layout.deck.x + (i % 3) * 0.25, y: layout.deck.y - i * 0.3, rotation: -4 + (i % 5) * 0.3, scale: 1, alpha: 1, z: i, faceUp: false }
  }

  // Купчинките на играчите: 5 чипа; горните 3 отиват в банката.
  const seatChipIds: string[][] = []
  for (const seat of layout.seats) {
    const ids: string[] = []
    for (let j = 0; j < CHIPS_PER_SEAT; j += 1) {
      const id = `chip-${seat.index}-${j}`
      const color = CHIP_COLORS[(seat.index + j) % CHIP_COLORS.length]!
      sprites.push({ id, kind: 'chip', color })
      chipValues[id] = SVARA_CHIP_VALUES[color]
      initial[id] = chipOnStack(seat.chipStack, j, layout, 200 + seat.index * 20 + j, jitter(12))
      ids.push(id)
    }
    seatChipIds.push(ids)
  }

  const phases: SvaraDemoPhase[] = []
  const statesAfter: SvaraSceneStates[] = []
  let current: SvaraSceneStates = { ...initial }

  const pushPhase = (phase: Omit<SvaraDemoPhase, 'moves' | 'events'>, inputs: MoveInput[], events: SvaraDemoEvent[] = []) => {
    // from на всяко движение = състоянието преди него (вкл. по-ранни
    // движения на същия спрайт в тази фаза).
    const running: SvaraSceneStates = { ...current }
    const sorted = [...inputs].sort((a, b) => a.delayMs - b.delayMs)
    const moves: SvaraMove[] = sorted.map((input) => {
      const move: SvaraMove = {
        rotationEasing: input.easing,
        curve: 0,
        raisePx: 0,
        spinDeg: 0,
        bounce: 0,
        liftPeak: 0.38,
        ...input,
        from: running[input.id]!,
      }
      running[input.id] = move.to
      return move
    })
    phases.push({ ...phase, moves, events: [...events].sort((a, b) => a.atMs - b.atMs) })
    statesAfter.push(running)
    current = running
  }

  // 1. Раздаване — една по една, кръгово. При пристигане на нова карта
  // ветрилото на мястото се пренарежда плавно (както ръката във видеото).
  const DEAL_STAGGER = 110
  const DEAL_FLIGHT = 360
  const dealMoves: MoveInput[] = []
  const dealEvents: SvaraDemoEvent[] = []
  const seatCards: string[][] = [[], [], [], []]
  const cardZ = new Map<string, number>()
  for (let k = 0; k < DEAL_SEAT_ORDER.length * CARDS_PER_SEAT; k += 1) {
    const seatIndex = DEAL_SEAT_ORDER[k % DEAL_SEAT_ORDER.length]!
    const seat = layout.seats[seatIndex]!
    const id = `card-${dealtIndex(k)}`
    const launch = 80 + k * DEAL_STAGGER
    const cards = seatCards[seatIndex]!
    const count = cards.length + 1
    dealMoves.push({
      id,
      to: seatFanState(layout, seat, count - 1, count, 100 + k),
      delayMs: launch,
      durationMs: DEAL_FLIGHT,
      easing: 'outQuart',
      rotationEasing: 'outBackSoft',
      curve: (seatIndex % 2 === 0 ? 1 : -1) * 0.1,
      lift: 0.55,
      liftPeak: 0.36,
      raisePx: layout.cardHeight * 0.22,
      spinDeg: (seatIndex === 1 || seatIndex === 2 ? -1 : 1) * 10,
    })
    // Пренареждане на вече пристигналите карти на това място.
    cards.forEach((existingId, slot) => {
      dealMoves.push({
        id: existingId,
        to: seatFanState(layout, seat, slot, count, cardZ.get(existingId)!),
        delayMs: launch + DEAL_FLIGHT - 90,
        durationMs: 230,
        easing: 'outCubic',
        lift: 0.06,
      })
    })
    cards.push(id)
    cardZ.set(id, 100 + k)
    dealEvents.push({ atMs: launch, kind: 'sound', sound: 'deal' })
  }
  pushPhase({ name: 'deal', holdAfterMs: 220, showSvarkaBanner: false, potAfter: 0, winnerSeat: null }, dealMoves, dealEvents)

  // 2. Обръщане на собствените три карти — вдигане, обръщане във въздуха,
  // кацане в по-голямо ветрило пред играча.
  const ownCardIds = ownDealOrder.map((k) => `card-${dealtIndex(k)}`)
  pushPhase(
    { name: 'reveal', holdAfterMs: 380, showSvarkaBanner: false, potAfter: 0, winnerSeat: null },
    ownCardIds.map((id, slot) => ({
      id,
      to: ownRevealCardState(layout, slot, 150 + slot),
      delayMs: slot * 95,
      durationMs: 460,
      easing: 'inOutCubic' as SvaraEasingName,
      rotationEasing: 'outBackSoft' as SvaraEasingName,
      lift: 0.45,
      liftPeak: 0.45,
      raisePx: layout.cardHeight * 0.3,
      spinDeg: (slot - 1) * 6,
    })),
    ownCardIds.map((_, slot) => ({ atMs: slot * 95 + 400, kind: 'sound' as const, sound: 'land' as const })),
  )

  // 3. Залози: горните 3 чипа от всяка купчинка един по един към малка
  // купчинка в банката; сумата расте при кацането на всеки чип.
  const betMoves: MoveInput[] = []
  const betEvents: SvaraDemoEvent[] = []
  const BET_FLIGHT = 440
  let potRunning = 0
  const landings: Array<{ atMs: number; value: number }> = []
  DEAL_SEAT_ORDER.forEach((seatIndex, order) => {
    const ids = seatChipIds[seatIndex]!
    const stack = layout.potStacks[seatIndex]!
    for (let j = 0; j < CHIPS_BET_PER_SEAT; j += 1) {
      const id = ids[CHIPS_PER_SEAT - 1 - j]!
      const delay = 100 + order * 300 + j * 85
      betMoves.push({
        id,
        to: chipOnStack(stack, j, layout, 300 + order * 10 + j, jitter(18)),
        delayMs: delay,
        durationMs: BET_FLIGHT,
        easing: 'outCubic',
        rotationEasing: 'outBackSoft',
        curve: jitter(0.12),
        lift: 0.65,
        liftPeak: 0.4,
        raisePx: layout.chipSize * 1.1,
        spinDeg: jitter(70),
        bounce: 0.12,
      })
      landings.push({ atMs: delay + BET_FLIGHT * 0.8, value: chipValues[id]! })
    }
    betEvents.push({ atMs: 100 + order * 300 + BET_FLIGHT * 0.8, kind: 'sound', sound: 'chips' })
  })
  for (const landing of landings.sort((a, b) => a.atMs - b.atMs)) {
    potRunning += landing.value
    betEvents.push({ atMs: landing.atMs, kind: 'pot', value: potRunning })
  }
  const potTotal = potRunning
  pushPhase({ name: 'bet', holdAfterMs: 260, showSvarkaBanner: false, potAfter: potTotal, winnerSeat: null }, betMoves, betEvents)

  // 4. „СВАРКА“ — банерът; купчинките в банката леко „подскачат“.
  const potChipIds = betMoves.map((move) => move.id)
  pushPhase(
    { name: 'svarka', holdAfterMs: 900, showSvarkaBanner: true, potAfter: potTotal, winnerSeat: null },
    potChipIds.map((id, idx) => ({
      id,
      to: { ...current[id]! },
      delayMs: 160 + (idx % CHIPS_BET_PER_SEAT) * 40 + Math.floor(idx / CHIPS_BET_PER_SEAT) * 25,
      durationMs: 320,
      easing: 'linear' as SvaraEasingName,
      lift: 0.18,
      liftPeak: 0.4,
      raisePx: layout.chipSize * 0.35,
    })),
  )

  // 5. Прибиране: (а) купчинките се събират в две равни купчинки в банката;
  // (б) чиповете каскадно (отгоре надолу) летят към купчинката на
  // победителя и остават там — нищо не изчезва и не се удвоява.
  const collectMoves: MoveInput[] = []
  const collectEvents: SvaraDemoEvent[] = []
  const GATHER = 320
  potChipIds.forEach((id, idx) => {
    collectMoves.push({
      id,
      to: chipOnStack({ x: layout.potGather.x + (idx % 2 === 0 ? -1 : 1) * layout.chipSize * 0.56, y: layout.potGather.y }, Math.floor(idx / 2), layout, 400 + idx, jitter(10)),
      delayMs: Math.floor(idx / CHIPS_BET_PER_SEAT) * 55,
      durationMs: GATHER,
      easing: 'inOutCubic',
      curve: jitter(0.08),
      lift: 0.12,
    })
  })
  const winner = layout.seats[WINNER_SEAT]!
  const winnerBase = CHIPS_PER_SEAT - CHIPS_BET_PER_SEAT
  const TRANSFER = 560
  const TRANSFER_STAGGER = 52
  const transferStart = GATHER + 3 * 55 + 140
  const transferOrder = [...potChipIds].reverse() // отгоре надолу
  transferOrder.forEach((id, n) => {
    collectMoves.push({
      id,
      to: chipOnStack(winner.chipStack, winnerBase + n, layout, 500 + n, jitter(14)),
      delayMs: transferStart + n * TRANSFER_STAGGER,
      durationMs: TRANSFER,
      easing: 'inOutCubic',
      rotationEasing: 'outBackSoft',
      curve: 0.14,
      lift: 0.6,
      liftPeak: 0.45,
      raisePx: layout.chipSize * 1.4,
      spinDeg: jitter(60),
      bounce: 0.1,
    })
  })
  let potLeft = potTotal
  transferOrder.forEach((id, n) => {
    potLeft -= chipValues[id]!
    collectEvents.push({ atMs: transferStart + n * TRANSFER_STAGGER + 60, kind: 'pot', value: potLeft })
  })
  const arrival = transferStart + (transferOrder.length - 1) * TRANSFER_STAGGER + TRANSFER
  collectEvents.push({ atMs: transferStart + TRANSFER * 0.8, kind: 'sound', sound: 'chips' })
  collectEvents.push({ atMs: arrival - 40, kind: 'winner', seat: WINNER_SEAT, amount: potTotal })
  pushPhase({ name: 'collect', holdAfterMs: 650, showSvarkaBanner: false, potAfter: 0, winnerSeat: WINNER_SEAT }, collectMoves, collectEvents)

  return { layout, sprites, initial, phases, statesAfter, chipValues }
}

export function getSvaraDemoFinalStates(script: SvaraDemoScript): SvaraSceneStates {
  return script.statesAfter[script.statesAfter.length - 1] ?? script.initial
}

export function getSvaraPhaseDurationMs(phase: SvaraDemoPhase): number {
  const movesEnd = Math.max(0, ...phase.moves.map((m) => m.delayMs + m.durationMs))
  const eventsEnd = Math.max(0, ...phase.events.map((e) => e.atMs))
  return Math.max(movesEnd, eventsEnd)
}
