// Свара — обща визуална сцена: хореография.
//
// Параметрите на движенията са изнесени ДОСЛОВНО от анимационното демо
// (премахнато): същите продължителности, easing функции, траектории (curve),
// височина (lift/liftPeak/raisePx), завъртане (spinDeg) и отскок. Истинската
// игра строи движенията само чрез тези функции.
//
// `jitter` се вика в постоянен ред (първо крайното завъртане, после кривата,
// после spin), за да е движението детерминистично при еднакъв seed.

import type { SvaraEasingName, SvaraMove, SvaraSpriteState } from '../demo/svaraDemoMotion'
import { svaraChipOnStack, svaraOwnRevealCardState, svaraSeatFanState, type SvaraPoint, type SvaraSceneLayout, type SvaraSeatLayout } from './svaraSceneLayout'

export type SvaraJitter = (amount: number) => number

export type SvaraMoveInput = Omit<SvaraMove, 'from' | 'rotationEasing' | 'curve' | 'raisePx' | 'spinDeg' | 'bounce' | 'liftPeak'>
  & Partial<Pick<SvaraMove, 'rotationEasing' | 'curve' | 'raisePx' | 'spinDeg' | 'bounce' | 'liftPeak'>>

/** Попълва стойностите по подразбиране на демото. */
export function completeSvaraMove(input: SvaraMoveInput, from: SvaraSpriteState): SvaraMove {
  return { rotationEasing: input.easing, curve: 0, raisePx: 0, spinDeg: 0, bounce: 0, liftPeak: 0.38, ...input, from }
}

/** Превръща входове в движения с from = текущото състояние (вкл. по-ранни движения на същия спрайт). */
export function resolveSvaraMoves(inputs: SvaraMoveInput[], current: Record<string, SvaraSpriteState>): { moves: SvaraMove[]; states: Record<string, SvaraSpriteState> } {
  const running = { ...current }
  const moves = [...inputs].sort((a, b) => a.delayMs - b.delayMs).map((input) => {
    const move = completeSvaraMove(input, running[input.id]!)
    running[input.id] = move.to
    return move
  })
  return { moves, states: running }
}

// ── Времена на демото ───────────────────────────────────────────────────────
export const SVARA_SCENE_TIMING = {
  dealFlightMs: 360,
  dealRespreadMs: 230,
  dealRespreadLeadMs: 90,
  /** Демо: 80 ms пауза + 110 ms между картите. */
  demoDealStartMs: 80,
  demoDealStaggerMs: 110,
  revealFlightMs: 460,
  revealStaggerMs: 95,
  betFlightMs: 440,
  betChipStaggerMs: 85,
  betSeatStaggerMs: 300,
  svarkaHopMs: 320,
  gatherMs: 320,
  gatherStaggerMs: 55,
  transferMs: 560,
  transferStaggerMs: 52,
  transferLeadMs: 140,
  /** Изчезване на останалото тесте след последната кацнала карта. */
  deckFadeMs: 200,
  /** Прибиране на картите към (скритото) тесте. */
  collectCardsMs: 320,
  collectCardsStaggerMs: 40,
} as const

// ── Карти ───────────────────────────────────────────────────────────────────

/** Полет на карта от тестето към ветрилото на мястото (count = картите след кацането). */
export function svaraDealCardMove(layout: SvaraSceneLayout, seat: SvaraSeatLayout, id: string, slot: number, count: number, z: number, delayMs: number): SvaraMoveInput {
  return {
    id,
    to: svaraSeatFanState(layout, seat, slot, count, z),
    delayMs,
    durationMs: SVARA_SCENE_TIMING.dealFlightMs,
    easing: 'outQuart',
    rotationEasing: 'outBackSoft',
    curve: (seat.index % 2 === 0 ? 1 : -1) * 0.1,
    lift: 0.55,
    liftPeak: 0.36,
    raisePx: layout.cardHeight * 0.22,
    spinDeg: (seat.index === 1 || seat.index === 2 ? -1 : 1) * 10,
  }
}

/** Пренареждане на вече кацнала карта, когато пристига нова (ветрилото се разтваря). */
export function svaraRespreadMove(layout: SvaraSceneLayout, seat: SvaraSeatLayout, id: string, slot: number, count: number, z: number, launchMs: number): SvaraMoveInput {
  return {
    id,
    to: svaraSeatFanState(layout, seat, slot, count, z),
    delayMs: launchMs + SVARA_SCENE_TIMING.dealFlightMs - SVARA_SCENE_TIMING.dealRespreadLeadMs,
    durationMs: SVARA_SCENE_TIMING.dealRespreadMs,
    easing: 'outCubic',
    lift: 0.06,
  }
}

/** Обръщане на собствените карти: вдигане, обръщане във въздуха, голямо ветрило. */
export function svaraOwnRevealMove(layout: SvaraSceneLayout, id: string, slot: number, z: number, delayMs = slot * SVARA_SCENE_TIMING.revealStaggerMs): SvaraMoveInput {
  return {
    id,
    to: svaraOwnRevealCardState(layout, slot, z),
    delayMs,
    durationMs: SVARA_SCENE_TIMING.revealFlightMs,
    easing: 'inOutCubic' as SvaraEasingName,
    rotationEasing: 'outBackSoft' as SvaraEasingName,
    lift: 0.45,
    liftPeak: 0.45,
    raisePx: layout.cardHeight * 0.3,
    spinDeg: (slot - 1) * 6,
  }
}

/** Обръщане на място (чужда ръка при сравняване/„Покажи“) — същите параметри като собственото. */
export function svaraFlipInPlaceMove(layout: SvaraSceneLayout, id: string, at: SvaraSpriteState, slot: number, delayMs = slot * SVARA_SCENE_TIMING.revealStaggerMs): SvaraMoveInput {
  return {
    id,
    to: { ...at, faceUp: true },
    delayMs,
    durationMs: SVARA_SCENE_TIMING.revealFlightMs,
    easing: 'inOutCubic',
    rotationEasing: 'outBackSoft',
    lift: 0.45,
    liftPeak: 0.45,
    raisePx: layout.cardHeight * 0.3,
    spinDeg: (slot - 1) * 6,
  }
}

/** Прибиране на карта към позицията на (скритото) тесте, с избледняване. */
export function svaraCollectCardMove(layout: SvaraSceneLayout, id: string, index: number, faceUp: boolean, jitter: SvaraJitter, delayMs = index * SVARA_SCENE_TIMING.collectCardsStaggerMs): SvaraMoveInput {
  return {
    id,
    to: { x: layout.deck.x, y: layout.deck.y, rotation: -4 + jitter(6), scale: layout.cardUnit, alpha: 0, z: 60 + index, faceUp },
    delayMs,
    durationMs: SVARA_SCENE_TIMING.collectCardsMs,
    easing: 'inOutCubic',
    curve: jitter(0.08),
    lift: 0.12,
  }
}

/** Плавно изчезване (тесте след раздаването, остатък от банката). */
export function svaraFadeMove(id: string, from: SvaraSpriteState, delayMs: number, durationMs: number, alpha = 0): SvaraMoveInput {
  return { id, to: { ...from, alpha }, delayMs, durationMs, easing: 'outCubic', lift: 0 }
}

// ── Чипове ──────────────────────────────────────────────────────────────────

/** Чип от купчинката на играча към малката купчинка на мястото в банката. */
export function svaraBetChipMove(layout: SvaraSceneLayout, id: string, potStack: SvaraPoint, level: number, z: number, delayMs: number, jitter: SvaraJitter): SvaraMoveInput {
  return {
    id,
    to: svaraChipOnStack(potStack, level, layout, z, jitter(18)),
    delayMs,
    durationMs: SVARA_SCENE_TIMING.betFlightMs,
    easing: 'outCubic',
    rotationEasing: 'outBackSoft',
    curve: jitter(0.12),
    lift: 0.65,
    liftPeak: 0.4,
    raisePx: layout.chipSize * 1.1,
    spinDeg: jitter(70),
    bounce: 0.12,
  }
}

/** „СВАРА!“ — чиповете в банката леко подскачат на място. */
export function svaraSvarkaHopMove(layout: SvaraSceneLayout, id: string, at: SvaraSpriteState, idx: number, perSeat: number): SvaraMoveInput {
  return {
    id,
    to: { ...at },
    delayMs: 160 + (idx % perSeat) * 40 + Math.floor(idx / perSeat) * 25,
    durationMs: SVARA_SCENE_TIMING.svarkaHopMs,
    easing: 'linear',
    lift: 0.18,
    liftPeak: 0.4,
    raisePx: layout.chipSize * 0.35,
  }
}

/** Събиране на банката в две купчинки преди изплащането. */
export function svaraGatherChipMove(layout: SvaraSceneLayout, id: string, idx: number, perSeat: number, jitter: SvaraJitter): SvaraMoveInput {
  return {
    id,
    to: svaraChipOnStack({ x: layout.potGather.x + (idx % 2 === 0 ? -1 : 1) * layout.chipSize * 0.56, y: layout.potGather.y }, Math.floor(idx / 2), layout, 400 + idx, jitter(10)),
    delayMs: Math.floor(idx / perSeat) * SVARA_SCENE_TIMING.gatherStaggerMs,
    durationMs: SVARA_SCENE_TIMING.gatherMs,
    easing: 'inOutCubic',
    curve: jitter(0.08),
    lift: 0.12,
  }
}

/** Каскадно прибиране на чип към купчинката на победителя (остава там). */
export function svaraTransferChipMove(layout: SvaraSceneLayout, id: string, winnerStack: SvaraPoint, level: number, z: number, delayMs: number, jitter: SvaraJitter): SvaraMoveInput {
  return {
    id,
    to: svaraChipOnStack(winnerStack, level, layout, z, jitter(14)),
    delayMs,
    durationMs: SVARA_SCENE_TIMING.transferMs,
    easing: 'inOutCubic',
    rotationEasing: 'outBackSoft',
    curve: 0.14,
    lift: 0.6,
    liftPeak: 0.45,
    raisePx: layout.chipSize * 1.4,
    spinDeg: jitter(60),
    bounce: 0.1,
  }
}

/** Момент на начало на каскадата спрямо началото на събирането (демо: 320 + 3×55 + 140). */
export function svaraTransferStartMs(gatherGroups: number): number {
  return SVARA_SCENE_TIMING.gatherMs + Math.max(0, gatherGroups - 1) * SVARA_SCENE_TIMING.gatherStaggerMs + SVARA_SCENE_TIMING.transferLeadMs
}
