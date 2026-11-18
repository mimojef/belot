// Свара — анимационен прототип: примерни данни и последователност на демото.
//
// Без игрова логика, без реални играчи/жълтици/залози. Всичко е
// детерминистично (seeded), за да може всяко пускане и всеки renderer да
// изглеждат еднакво и демото да се проверява автоматично.
//
// Геометрията и движенията идват от ОБЩАТА визуална сцена (../scene/) —
// същата, която рисува и истинската игра. Тук остават само примерните данни
// (тесте, три аса, победител) и редът на фазите: раздаване (тестето изчезва
// след последната карта), обръщане, залози, „СВАРКА“, прибиране към победителя.

import type { SvaraChipColor, SvaraSpriteDef, SvaraSpriteState } from './svaraDemoMotion'
import {
  completeSvaraMove, svaraBetChipMove, svaraDealCardMove, svaraFadeMove, svaraGatherChipMove, svaraOwnRevealMove,
  svaraRespreadMove, svaraSvarkaHopMove, svaraTransferChipMove, svaraTransferStartMs, SVARA_SCENE_TIMING, type SvaraMoveInput,
} from '../scene/svaraSceneChoreography'
import { computeSvaraSceneLayout, svaraChipOnStack, svaraDeckCardState, type SvaraSceneLayout, type SvaraSeatIndex } from '../scene/svaraSceneLayout'
import type { SvaraMove } from './svaraDemoMotion'

export type { SvaraPoint, SvaraSeatIndex, SvaraSeatLayout } from '../scene/svaraSceneLayout'
/** Оформлението на демото е общото оформление на сцената. */
export type SvaraDemoLayout = SvaraSceneLayout

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

export const svaraCardFaceSrc = (rank: string, suit: string) => `/images/cards/${suit}/${rank}_${suit}_300x420.webp`

/** Обратна съвместимост: оформлението на демото = оформлението на сцената. */
export const computeSvaraDemoLayout = computeSvaraSceneLayout

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

export function buildSvaraDemoScript(width: number, height: number): SvaraDemoScript {
  const layout = computeSvaraSceneLayout(width, height)
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
    initial[id] = svaraDeckCardState(layout, i)
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
      initial[id] = svaraChipOnStack(seat.chipStack, j, layout, 200 + seat.index * 20 + j, jitter(12))
      ids.push(id)
    }
    seatChipIds.push(ids)
  }

  const phases: SvaraDemoPhase[] = []
  const statesAfter: SvaraSceneStates[] = []
  let current: SvaraSceneStates = { ...initial }

  const pushPhase = (phase: Omit<SvaraDemoPhase, 'moves' | 'events'>, inputs: SvaraMoveInput[], events: SvaraDemoEvent[] = []) => {
    // from на всяко движение = състоянието преди него (вкл. по-ранни
    // движения на същия спрайт в тази фаза).
    const running: SvaraSceneStates = { ...current }
    const sorted = [...inputs].sort((a, b) => a.delayMs - b.delayMs)
    const moves: SvaraMove[] = sorted.map((input) => {
      const move = completeSvaraMove(input, running[input.id]!)
      running[input.id] = move.to
      return move
    })
    phases.push({ ...phase, moves, events: [...events].sort((a, b) => a.atMs - b.atMs) })
    statesAfter.push(running)
    current = running
  }

  // 1. Раздаване — една по една, кръгово. При пристигане на нова карта
  // ветрилото на мястото се пренарежда плавно (както ръката във видеото).
  const dealMoves: SvaraMoveInput[] = []
  const dealEvents: SvaraDemoEvent[] = []
  const seatCards: string[][] = [[], [], [], []]
  const cardZ = new Map<string, number>()
  let lastLanding = 0
  for (let k = 0; k < DEAL_SEAT_ORDER.length * CARDS_PER_SEAT; k += 1) {
    const seatIndex = DEAL_SEAT_ORDER[k % DEAL_SEAT_ORDER.length]!
    const seat = layout.seats[seatIndex]!
    const id = `card-${dealtIndex(k)}`
    const launch = SVARA_SCENE_TIMING.demoDealStartMs + k * SVARA_SCENE_TIMING.demoDealStaggerMs
    const cards = seatCards[seatIndex]!
    const count = cards.length + 1
    dealMoves.push(svaraDealCardMove(layout, seat, id, count - 1, count, 100 + k, launch))
    cards.forEach((existingId, slot) => dealMoves.push(svaraRespreadMove(layout, seat, existingId, slot, count, cardZ.get(existingId)!, launch)))
    cards.push(id)
    cardZ.set(id, 100 + k)
    dealEvents.push({ atMs: launch, kind: 'sound', sound: 'deal' })
    lastLanding = launch + SVARA_SCENE_TIMING.dealFlightMs
  }
  // Останалото тесте изчезва плавно след последната кацнала карта (карти,
  // дебелина и сянка) — сукното остава свободно за наддаването.
  for (let i = 0; i < DECK_SIZE - DEAL_SEAT_ORDER.length * CARDS_PER_SEAT; i += 1) {
    dealMoves.push(svaraFadeMove(`card-${i}`, current[`card-${i}`]!, lastLanding, SVARA_SCENE_TIMING.deckFadeMs))
  }
  pushPhase({ name: 'deal', holdAfterMs: 220, showSvarkaBanner: false, potAfter: 0, winnerSeat: null }, dealMoves, dealEvents)

  // 2. Обръщане на собствените три карти — вдигане, обръщане във въздуха,
  // кацане в по-голямо ветрило пред играча.
  const ownCardIds = ownDealOrder.map((k) => `card-${dealtIndex(k)}`)
  pushPhase(
    { name: 'reveal', holdAfterMs: 380, showSvarkaBanner: false, potAfter: 0, winnerSeat: null },
    ownCardIds.map((id, slot) => svaraOwnRevealMove(layout, id, slot, 150 + slot)),
    ownCardIds.map((_, slot) => ({ atMs: slot * SVARA_SCENE_TIMING.revealStaggerMs + 400, kind: 'sound' as const, sound: 'land' as const })),
  )

  // 3. Залози: горните 3 чипа от всяка купчинка един по един към малка
  // купчинка в банката; сумата расте при кацането на всеки чип.
  const betMoves: SvaraMoveInput[] = []
  const betEvents: SvaraDemoEvent[] = []
  const BET_FLIGHT = SVARA_SCENE_TIMING.betFlightMs
  let potRunning = 0
  const landings: Array<{ atMs: number; value: number }> = []
  DEAL_SEAT_ORDER.forEach((seatIndex, order) => {
    const ids = seatChipIds[seatIndex]!
    const stack = layout.potStacks[seatIndex]!
    for (let j = 0; j < CHIPS_BET_PER_SEAT; j += 1) {
      const id = ids[CHIPS_PER_SEAT - 1 - j]!
      const delay = 100 + order * SVARA_SCENE_TIMING.betSeatStaggerMs + j * SVARA_SCENE_TIMING.betChipStaggerMs
      betMoves.push(svaraBetChipMove(layout, id, stack, j, 300 + order * 10 + j, delay, jitter))
      landings.push({ atMs: delay + BET_FLIGHT * 0.8, value: chipValues[id]! })
    }
    betEvents.push({ atMs: 100 + order * SVARA_SCENE_TIMING.betSeatStaggerMs + BET_FLIGHT * 0.8, kind: 'sound', sound: 'chips' })
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
    potChipIds.map((id, idx) => svaraSvarkaHopMove(layout, id, current[id]!, idx, CHIPS_BET_PER_SEAT)),
  )

  // 5. Прибиране: (а) купчинките се събират в две равни купчинки в банката;
  // (б) чиповете каскадно (отгоре надолу) летят към купчинката на
  // победителя и остават там — нищо не изчезва и не се удвоява.
  const collectMoves: SvaraMoveInput[] = []
  const collectEvents: SvaraDemoEvent[] = []
  potChipIds.forEach((id, idx) => collectMoves.push(svaraGatherChipMove(layout, id, idx, CHIPS_BET_PER_SEAT, jitter)))
  const winner = layout.seats[WINNER_SEAT]!
  const winnerBase = CHIPS_PER_SEAT - CHIPS_BET_PER_SEAT
  const TRANSFER = SVARA_SCENE_TIMING.transferMs
  const TRANSFER_STAGGER = SVARA_SCENE_TIMING.transferStaggerMs
  const transferStart = svaraTransferStartMs(DEAL_SEAT_ORDER.length)
  const transferOrder = [...potChipIds].reverse() // отгоре надолу
  transferOrder.forEach((id, n) => {
    collectMoves.push(svaraTransferChipMove(layout, id, winner.chipStack, winnerBase + n, 500 + n, transferStart + n * TRANSFER_STAGGER, jitter))
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
