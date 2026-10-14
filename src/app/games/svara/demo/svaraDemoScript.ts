// Свара — анимационен прототип: layout и хореография (само демо данни).
//
// Без игрова логика, без реални играчи/жълтици/залози. Всичко е
// детерминистично (seeded), за да може всяко пускане и всеки renderer да
// изглеждат еднакво и демото да се проверява автоматично.

import type { SvaraChipColor, SvaraMove, SvaraSpriteDef, SvaraSpriteState } from './svaraDemoMotion'

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
}

export type SvaraDemoLayout = {
  width: number
  height: number
  isPortrait: boolean
  avatarSize: number
  cardWidth: number
  cardHeight: number
  chipSize: number
  deck: SvaraPoint
  pot: SvaraPoint
  seats: SvaraSeatLayout[]
}

export type SvaraDemoPhaseName = 'deal' | 'reveal' | 'bet' | 'svarka' | 'collect'

export type SvaraDemoPhase = {
  name: SvaraDemoPhaseName
  moves: SvaraMove[]
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
}

export const SVARA_DEMO_CARD_BACK_SRC = '/images/cards/card-back.webp'
export const SVARA_DEMO_AVATAR_SRCS = [
  '/assets/avatars/male/male-avatar-01.webp',
  '/assets/avatars/female/female-avatar-02.webp',
  '/assets/avatars/male/male-avatar-03.webp',
  '/assets/avatars/female/female-avatar-04.webp',
] as const
export const SVARA_DEMO_SEAT_NAMES = ['Ти', 'Демо 1', 'Демо 2', 'Демо 3'] as const

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const
const CHIP_COLORS: SvaraChipColor[] = ['red', 'blue', 'green']
const CHIPS_PER_SEAT = 3
const CARDS_PER_SEAT = 3
const DECK_SIZE = 32
const DEAL_SEAT_ORDER: SvaraSeatIndex[] = [1, 2, 3, 0]
const WINNER_SEAT: SvaraSeatIndex = 0
const CHIP_DEMO_VALUE = 10

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
  const avatarSize = clamp(Math.min(w, h) * 0.13, 40, 76)
  const cardWidth = clamp(Math.min(w * 0.105, h * 0.1), 32, 72)
  const cardHeight = cardWidth * 1.4
  const chipSize = cardWidth * 0.46
  const cx = w / 2
  const cy = h / 2
  const edge = avatarSize * 0.62 + 6

  const seatBase: Array<{ avatar: SvaraPoint; inward: SvaraPoint; cardRotation: number }> = [
    { avatar: { x: cx, y: h - edge }, inward: { x: 0, y: -1 }, cardRotation: 0 },
    { avatar: { x: edge, y: cy }, inward: { x: 1, y: 0 }, cardRotation: 90 },
    { avatar: { x: cx, y: edge }, inward: { x: 0, y: 1 }, cardRotation: 180 },
    { avatar: { x: w - edge, y: cy }, inward: { x: -1, y: 0 }, cardRotation: -90 },
  ]

  return {
    width: w,
    height: h,
    isPortrait,
    avatarSize,
    cardWidth,
    cardHeight,
    chipSize,
    deck: isPortrait ? { x: cx, y: cy - cardHeight * 0.72 } : { x: cx - Math.max(cardWidth * 1.7, w * 0.15), y: cy },
    pot: isPortrait ? { x: cx, y: cy + cardHeight * 0.45 } : { x: cx + cardWidth * 0.35, y: cy },
    seats: seatBase.map((seat, index) => ({
      index: index as SvaraSeatIndex,
      avatar: seat.avatar,
      inward: seat.inward,
      // Тангентата е inward, завъртян на -90°.
      tangent: { x: -seat.inward.y, y: seat.inward.x },
      cardRotation: seat.cardRotation,
    })),
  }
}

function seatHandCardState(layout: SvaraDemoLayout, seat: SvaraSeatLayout, slot: number, z: number): SvaraSpriteState {
  const offset = slot - 1
  const reach = layout.avatarSize * 0.5 + layout.cardHeight * 0.7
  return {
    x: seat.avatar.x + seat.inward.x * reach + seat.tangent.x * offset * layout.cardWidth * 0.5,
    y: seat.avatar.y + seat.inward.y * reach + seat.tangent.y * offset * layout.cardWidth * 0.5,
    rotation: seat.cardRotation + offset * 9,
    scale: 1,
    alpha: 1,
    z,
    faceUp: false,
  }
}

const REVEAL_SCALE = 1.45

function ownRevealCardState(layout: SvaraDemoLayout, slot: number, z: number): SvaraSpriteState {
  const seat = layout.seats[0]!
  const offset = slot - 1
  const reach = layout.avatarSize * 0.5 + layout.cardHeight * REVEAL_SCALE * 0.6
  return {
    x: seat.avatar.x + offset * layout.cardWidth * REVEAL_SCALE * 0.62,
    y: seat.avatar.y - reach + Math.abs(offset) * layout.cardHeight * 0.05,
    rotation: offset * 7,
    scale: REVEAL_SCALE,
    alpha: 1,
    z,
    faceUp: true,
  }
}

function seatChipStackPoint(layout: SvaraDemoLayout, seat: SvaraSeatLayout): SvaraPoint {
  const side = layout.avatarSize * 0.95
  return {
    x: seat.avatar.x - seat.tangent.x * side,
    y: seat.avatar.y - seat.tangent.y * side,
  }
}

export function buildSvaraDemoScript(width: number, height: number): SvaraDemoScript {
  const layout = computeSvaraDemoLayout(width, height)
  const random = createRandom(20261014)

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

  // Лице се зарежда само за картите, които се обръщат (собствените три) —
  // както в реалната игра клиентът няма да знае скритите карти.
  const revealedDeckIndexes = new Set(Array.from({ length: CARDS_PER_SEAT }, (_, slot) => DECK_SIZE - 1 - (slot * DEAL_SEAT_ORDER.length + DEAL_SEAT_ORDER.indexOf(0))))
  for (let i = 0; i < DECK_SIZE; i += 1) {
    const id = `card-${i}`
    sprites.push({ id, kind: 'card', faceSrc: revealedDeckIndexes.has(i) ? deckFaces[i]! : null })
    initial[id] = {
      x: layout.deck.x,
      y: layout.deck.y - i * 0.3,
      rotation: -4,
      scale: 1,
      alpha: 1,
      z: i,
      faceUp: false,
    }
  }

  for (const seat of layout.seats) {
    const stack = seatChipStackPoint(layout, seat)
    for (let j = 0; j < CHIPS_PER_SEAT; j += 1) {
      const id = `chip-${seat.index}-${j}`
      sprites.push({ id, kind: 'chip', color: CHIP_COLORS[(seat.index + j) % CHIP_COLORS.length]! })
      initial[id] = {
        x: stack.x,
        y: stack.y - j * layout.chipSize * 0.14,
        rotation: 0,
        scale: 1,
        alpha: 1,
        z: 200 + seat.index * 10 + j,
        faceUp: false,
      }
    }
  }

  const phases: SvaraDemoPhase[] = []
  const statesAfter: SvaraSceneStates[] = []
  let current: SvaraSceneStates = { ...initial }

  const pushPhase = (phase: Omit<SvaraDemoPhase, 'moves'>, moves: Array<Omit<SvaraMove, 'from'>>) => {
    const resolved = moves.map((move) => ({ ...move, from: current[move.id]! }))
    const next = { ...current }
    for (const move of resolved) next[move.id] = move.to
    phases.push({ ...phase, moves: resolved })
    statesAfter.push(next)
    current = next
  }

  // 1. Раздаване — по една карта, кръгово, 3 обиколки.
  pushPhase(
    { name: 'deal', holdAfterMs: 250, showSvarkaBanner: false, potAfter: 0, winnerSeat: null },
    Array.from({ length: DEAL_SEAT_ORDER.length * CARDS_PER_SEAT }, (_, k) => {
      const seatIndex = DEAL_SEAT_ORDER[k % DEAL_SEAT_ORDER.length]!
      const slot = Math.floor(k / DEAL_SEAT_ORDER.length)
      return {
        id: `card-${DECK_SIZE - 1 - k}`,
        to: seatHandCardState(layout, layout.seats[seatIndex]!, slot, 100 + k),
        delayMs: k * 115,
        durationMs: 470,
        easing: 'outCubic' as const,
        liftPx: layout.cardHeight * 0.32,
        liftScale: 1.07,
      }
    }),
  )

  // 2. Обръщане на собствените три карти.
  const ownCardIds = [...revealedDeckIndexes].map((index) => `card-${index}`)
  pushPhase(
    { name: 'reveal', holdAfterMs: 350, showSvarkaBanner: false, potAfter: 0, winnerSeat: null },
    ownCardIds.map((id, slot) => ({
      id,
      to: ownRevealCardState(layout, slot, 150 + slot),
      delayMs: slot * 120,
      durationMs: 560,
      easing: 'inOutCubic' as const,
      liftPx: layout.cardHeight * 0.22,
      liftScale: 1.04,
    })),
  )

  // 3. Чипове към централната банка.
  const potScatter = layout.chipSize * (layout.isPortrait ? 0.9 : 1.1)
  const betMoves: Array<Omit<SvaraMove, 'from'>> = []
  DEAL_SEAT_ORDER.forEach((seatIndex, order) => {
    for (let j = 0; j < CHIPS_PER_SEAT; j += 1) {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random()) * potScatter
      betMoves.push({
        id: `chip-${seatIndex}-${j}`,
        to: {
          x: layout.pot.x + Math.cos(angle) * radius,
          y: layout.pot.y + Math.sin(angle) * radius * 0.75,
          rotation: (random() - 0.5) * 50,
          scale: 1,
          alpha: 1,
          z: 300 + betMoves.length,
          faceUp: false,
        },
        delayMs: order * 260 + j * 80,
        durationMs: 430,
        easing: 'outCubic',
        liftPx: layout.chipSize * 1.6,
        liftScale: 1.12,
      })
    }
  })
  const potTotal = betMoves.length * CHIP_DEMO_VALUE
  pushPhase({ name: 'bet', holdAfterMs: 220, showSvarkaBanner: false, potAfter: potTotal, winnerSeat: null }, betMoves)

  // 4. „СВАРКА“ — чиповете се подреждат в три купчинки под банера.
  const chipIds = betMoves.map((move) => move.id)
  pushPhase(
    { name: 'svarka', holdAfterMs: 950, showSvarkaBanner: true, potAfter: potTotal, winnerSeat: null },
    chipIds.map((id, idx) => ({
      id,
      to: {
        x: layout.pot.x + ((idx % 3) - 1) * layout.chipSize * 1.15,
        y: layout.pot.y - Math.floor(idx / 3) * layout.chipSize * 0.14,
        rotation: 0,
        scale: 1,
        alpha: 1,
        z: 400 + idx,
        faceUp: false,
      },
      delayMs: idx * 28,
      durationMs: 380,
      easing: 'outBack' as const,
      liftPx: layout.chipSize * 0.5,
      liftScale: 1.05,
    })),
  )

  // 5. Прибиране на банката към победителя.
  const winner = layout.seats[WINNER_SEAT]!
  pushPhase(
    { name: 'collect', holdAfterMs: 0, showSvarkaBanner: false, potAfter: 0, winnerSeat: WINNER_SEAT },
    chipIds.map((id, idx) => ({
      id,
      to: {
        x: winner.avatar.x,
        y: winner.avatar.y,
        rotation: 0,
        scale: 0.55,
        alpha: 0,
        z: 500 + idx,
        faceUp: false,
      },
      delayMs: idx * 45,
      durationMs: 560,
      easing: 'inOutCubic' as const,
      liftPx: layout.chipSize * 2,
      liftScale: 1.1,
    })),
  )

  return { layout, sprites, initial, phases, statesAfter }
}

export function getSvaraDemoFinalStates(script: SvaraDemoScript): SvaraSceneStates {
  return script.statesAfter[script.statesAfter.length - 1] ?? script.initial
}
