// Свара — анимационен прототип (Етап 2А): споделен модел на движението.
//
// Хореографията е ЧИСТО данни: всяко движение (SvaraMove) носи пълното
// начално и крайно състояние на спрайта. sampleSvaraMove() е ЕДИНСТВЕНИЯТ
// източник на траекторията — DOM/WAAPI renderer-ът я семплира в keyframes,
// PixiJS renderer-ът я вика на всеки кадър. Така двата renderer-а показват
// идентично движение и сравнението между тях е честно.

export type SvaraSpriteState = {
  x: number
  y: number
  /** Градуси. */
  rotation: number
  scale: number
  alpha: number
  z: number
  /** Само за карти. */
  faceUp: boolean
}

export type SvaraChipColor = 'red' | 'blue' | 'green'

export type SvaraSpriteDef =
  /** faceSrc е null за карти, които никога не се обръщат (лицето не се зарежда). */
  | { id: string; kind: 'card'; faceSrc: string | null }
  | { id: string; kind: 'chip'; color: SvaraChipColor }

export type SvaraEasingName = 'outCubic' | 'inOutCubic' | 'outBack' | 'inCubic'

export type SvaraMove = {
  id: string
  from: SvaraSpriteState
  to: SvaraSpriteState
  delayMs: number
  durationMs: number
  easing: SvaraEasingName
  /** Височина на дъгата (px) — параболичен „скок“ над правата линия. */
  liftPx: number
  /** Допълнителен мащаб в средата на полета (1 = без). */
  liftScale: number
}

export type SvaraSampledState = {
  x: number
  y: number
  rotation: number
  /** Мащаб по X, вкл. обръщането на картата (|cos|). */
  scaleX: number
  scaleY: number
  alpha: number
  faceUp: boolean
}

export const SVARA_EASINGS: Record<SvaraEasingName, (t: number) => number> = {
  outCubic: (t) => 1 - (1 - t) ** 3,
  inCubic: (t) => t ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t) => {
    const c1 = 1.25
    const c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** t ∈ [0,1] — линейно време на движението (без delay). */
export function sampleSvaraMove(move: SvaraMove, t: number): SvaraSampledState {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  const e = SVARA_EASINGS[move.easing](clamped)
  // Параболична дъга и „повдигане“ — върх при e=0.5, нула в краищата.
  const bump = 4 * e * (1 - e)
  const { from, to } = move
  const flips = from.faceUp !== to.faceUp
  const scale = lerp(from.scale, to.scale, e) * (1 + (move.liftScale - 1) * bump)
  return {
    x: lerp(from.x, to.x, e),
    y: lerp(from.y, to.y, e) - move.liftPx * bump,
    rotation: lerp(from.rotation, to.rotation, e),
    scaleX: flips ? scale * Math.max(0.02, Math.abs(Math.cos(Math.PI * e))) : scale,
    scaleY: scale,
    alpha: lerp(from.alpha, to.alpha, e),
    faceUp: flips ? (e < 0.5 ? from.faceUp : to.faceUp) : to.faceUp,
  }
}

/** Линейният момент (0..1), в който обръщаща се карта сменя лицето си. */
export function findSvaraFlipMoment(move: SvaraMove): number {
  const ease = SVARA_EASINGS[move.easing]
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2
    if (ease(mid) < 0.5) lo = mid
    else hi = mid
  }
  return hi
}

export function stateToSampled(state: SvaraSpriteState): SvaraSampledState {
  return {
    x: state.x,
    y: state.y,
    rotation: state.rotation,
    scaleX: state.scale,
    scaleY: state.scale,
    alpha: state.alpha,
    faceUp: state.faceUp,
  }
}

export function getSvaraMoveEndMs(move: SvaraMove): number {
  return move.delayMs + move.durationMs
}
