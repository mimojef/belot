// Свара — обща визуална сцена: оформление.
//
// ЕДИН източник на геометрията за демото И за истинската игра (изнесено от
// demo/svaraDemoScript.ts без промяна на формулите): размер на масата,
// аватари, ветрила, тесте, банка, купчинки чипове, голямо ветрило на
// обърнатите собствени карти.
//
// Местата са по визуален слот. Индексите 0..3 са в реда на демото
// (0 долу, 1 ляво, 2 горе, 3 дясно), за да остане демото непроменено; за
// 2 и 3 играчи истинската игра ползва само заетите слотове.

import type { SvaraSpriteState } from '../demo/svaraDemoMotion'

export type SvaraSeatIndex = 0 | 1 | 2 | 3
export type SvaraSceneSlot = 'bottom' | 'left' | 'top' | 'right'
/** Ред на слотовете по индекс на мястото в сцената (както в демото). */
export const SVARA_SCENE_SLOTS: readonly SvaraSceneSlot[] = ['bottom', 'left', 'top', 'right']

export type SvaraPoint = { x: number; y: number }

export type SvaraSeatLayout = {
  index: SvaraSeatIndex
  slot: SvaraSceneSlot
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

export type SvaraSceneLayout = {
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
  /** Малките купчинки в банката — по една на място (индекс на мястото). */
  potStacks: SvaraPoint[]
  /** Къде стои надписът на банката (център на надписа). */
  potLabel: SvaraPoint
  /** Къде се събира банката преди прибирането (основа на купчинката). */
  potGather: SvaraPoint
  /** Мащаб на картите на мястото (страничните на телефон са по-малки). */
  handScale: number[]
  revealScale: number
  /** Винаги 4 места по индекс 0..3 (виж SVARA_SCENE_SLOTS). */
  seats: SvaraSeatLayout[]
}

export const SVARA_SCENE_REVEAL_SCALE = 1.32
const PORTRAIT_SIDE_HAND_SCALE = 0.78

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function svaraSceneSeatIndexOf(slot: SvaraSceneSlot): SvaraSeatIndex {
  return SVARA_SCENE_SLOTS.indexOf(slot) as SvaraSeatIndex
}

export function computeSvaraSceneLayout(width: number, height: number): SvaraSceneLayout {
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
  const revealTop = h - edge - avatarSize * 0.5 - cardHeight * SVARA_SCENE_REVEAL_SCALE * 1.1
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
    revealScale: SVARA_SCENE_REVEAL_SCALE,
    seats: seatBase.map((seat, index) => {
      const tangent = { x: -seat.inward.y, y: seat.inward.x }
      const side = avatarSize * 0.98
      return {
        index: index as SvaraSeatIndex,
        slot: SVARA_SCENE_SLOTS[index]!,
        avatar: seat.avatar,
        inward: seat.inward,
        tangent,
        cardRotation: seat.cardRotation,
        chipStack: { x: seat.avatar.x - tangent.x * side, y: seat.avatar.y - tangent.y * side + chipSize * 0.2 },
      }
    }),
  }
}

// ── Състояния на спрайтовете (формулите на демото) ──────────────────────────

/** Карта от тестето на позиция i (0 = най-долна). */
export function svaraDeckCardState(layout: SvaraSceneLayout, i: number): SvaraSpriteState {
  return { x: layout.deck.x + (i % 3) * 0.25, y: layout.deck.y - i * 0.3, rotation: -4 + (i % 5) * 0.3, scale: 1, alpha: 1, z: i, faceUp: false }
}

/** Позиция на карта slot в ветрило от count карти на мястото. */
export function svaraSeatFanState(layout: SvaraSceneLayout, seat: SvaraSeatLayout, slot: number, count: number, z: number): SvaraSpriteState {
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

/** Голямото ветрило на обърнатите собствени карти (долното място). */
export function svaraOwnRevealCardState(layout: SvaraSceneLayout, slot: number, z: number): SvaraSpriteState {
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

export function svaraChipOnStack(point: SvaraPoint, level: number, layout: SvaraSceneLayout, z: number, rotation: number): SvaraSpriteState {
  return { x: point.x, y: point.y - level * layout.chipStep, rotation, scale: 1, alpha: 1, z, faceUp: false }
}
