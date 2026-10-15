// Свара — анимационен прототип: споделен модел на движението.
//
// Хореографията е ЧИСТО данни: всяко движение (SvaraMove) носи пълното
// начално и крайно състояние на спрайта. sampleSvaraTrack() е ЕДИНСТВЕНИЯТ
// източник на траекторията — DOM/WAAPI renderer-ът я семплира в keyframes,
// PixiJS renderer-ът я вика на всеки кадър. Така двата renderer-а показват
// идентично движение и сравнението между тях е честно.
//
// Етап 2А.1 — характер на движението (ориентир: видеозапис на Belot.bg,
// без копиране на код/графика): кратки полети (~250–450 ms), асиметричен
// профил на „височината“ (бързо вдигане към зрителя, връх около 35–40% от
// полета, „падане“ върху масата с ненулева скорост), дълбочина чрез мащаб и
// сянка, леко извита траектория, наклон с пресилване и успокояване.

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

export type SvaraEasingName = 'linear' | 'outCubic' | 'outQuart' | 'inOutCubic' | 'inOutQuad' | 'outBack' | 'outBackSoft'

export type SvaraMove = {
  id: string
  from: SvaraSpriteState
  to: SvaraSpriteState
  delayMs: number
  durationMs: number
  /** Прогрес на позицията (ускорение/забавяне на пътя). */
  easing: SvaraEasingName
  /** Прогрес на наклона — outBack* дава леко пресилване и успокояване. */
  rotationEasing: SvaraEasingName
  /** Странично извиване като част от разстоянието (+ = наляво от посоката). */
  curve: number
  /** Връх на „височината“ 0..1 — мащаб (до +40%) и сянка. */
  lift: number
  /** Момент (0..1 от времето) на най-високата точка. */
  liftPeak: number
  /** Видимо вдигане нагоре на екрана във върха (px). */
  raisePx: number
  /** Допълнително завъртане във върха (градуси). */
  spinDeg: number
  /** Малък отскок при кацане (част от lift); 0 = без. */
  bounce: number
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
  /** Текуща височина 0..1 — за сянката (0 = лежи на масата). */
  height: number
}

/** Максимално уголемяване във върха при lift=1 (видеото: ~1.4×). */
export const SVARA_DEPTH_SCALE = 0.4

export const SVARA_EASINGS: Record<SvaraEasingName, (t: number) => number> = {
  linear: (t) => t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  outQuart: (t) => 1 - (1 - t) ** 4,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  outBack: (t) => {
    const c1 = 1.4
    const c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
  outBackSoft: (t) => {
    const c1 = 0.8
    const c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t)

const BOUNCE_SPAN = 0.2

/**
 * Профил на височината по линейното време t: синусово вдигане до liftPeak,
 * после „падане“ (косинус) с ненулева скорост при удара; при bounce>0
 * последните 20% от времето са малък втори отскок.
 */
export function svaraHeightProfile(move: Pick<SvaraMove, 'liftPeak' | 'bounce'>, t: number): number {
  const tt = clamp01(t)
  const mainEnd = move.bounce > 0 ? 1 - BOUNCE_SPAN : 1
  if (tt >= mainEnd) {
    if (move.bounce <= 0) return 0
    return move.bounce * Math.sin(Math.PI * ((tt - mainEnd) / BOUNCE_SPAN))
  }
  const local = tt / mainEnd
  const peak = Math.min(0.9, Math.max(0.1, move.liftPeak))
  return local <= peak
    ? Math.sin((Math.PI / 2) * (local / peak))
    : Math.cos((Math.PI / 2) * ((local - peak) / (1 - peak)))
}

/** t ∈ [0,1] — линейно време на движението (без delay). */
export function sampleSvaraMove(move: SvaraMove, t: number): SvaraSampledState {
  const tt = clamp01(t)
  const e = SVARA_EASINGS[move.easing](tt)
  const er = SVARA_EASINGS[move.rotationEasing](tt)
  const { from, to } = move
  const height = move.lift * svaraHeightProfile(move, tt)

  // Квадратична Безие крива: контролната точка е изместена встрани от
  // правата (curve) — така двата края съвпадат точно с from/to.
  const dx = to.x - from.x
  const dy = to.y - from.y
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const cx = midX - dy * move.curve
  const cy = midY + dx * move.curve
  const u = 1 - e
  const x = u * u * from.x + 2 * u * e * cx + e * e * to.x
  const y = u * u * from.y + 2 * u * e * cy + e * e * to.y - move.raisePx * (move.lift > 0 ? height / move.lift : 0)

  const flips = from.faceUp !== to.faceUp
  const scale = lerp(from.scale, to.scale, e) * (1 + SVARA_DEPTH_SCALE * height)
  const flipProgress = SVARA_EASINGS.inOutCubic(tt)
  return {
    x,
    y,
    rotation: lerp(from.rotation, to.rotation, er) + move.spinDeg * Math.sin(Math.PI * tt),
    scaleX: flips ? scale * Math.max(0.02, Math.abs(Math.cos(Math.PI * flipProgress))) : scale,
    scaleY: scale,
    alpha: lerp(from.alpha, to.alpha, e),
    faceUp: flips ? (flipProgress < 0.5 ? from.faceUp : to.faceUp) : to.faceUp,
    height,
  }
}

/** Линейният момент (0..1), в който обръщаща се карта сменя лицето си. */
export function findSvaraFlipMoment(): number {
  return 0.5 // inOutCubic е симетрична → лицето се сменя точно в средата
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
    height: 0,
  }
}

export function getSvaraMoveEndMs(move: SvaraMove): number {
  return move.delayMs + move.durationMs
}

// ── Пътечки: последователни движения на един спрайт в една фаза ──────────

export type SvaraTrack = {
  id: string
  /** Сортирани по delayMs, без застъпване. */
  moves: SvaraMove[]
  startMs: number
  endMs: number
}

export function buildSvaraTracks(moves: SvaraMove[]): SvaraTrack[] {
  const byId = new Map<string, SvaraMove[]>()
  for (const move of moves) {
    const list = byId.get(move.id)
    if (list) list.push(move)
    else byId.set(move.id, [move])
  }
  return [...byId.entries()].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => a.delayMs - b.delayMs)
    return { id, moves: sorted, startMs: sorted[0]!.delayMs, endMs: Math.max(...sorted.map(getSvaraMoveEndMs)) }
  })
}

/** Активното движение в момента timeMs (от началото на фазата) или null при пауза. */
export function findSvaraTrackMove(track: SvaraTrack, timeMs: number): { move: SvaraMove; index: number } | null {
  for (let i = track.moves.length - 1; i >= 0; i -= 1) {
    if (timeMs >= track.moves[i]!.delayMs) return { move: track.moves[i]!, index: i }
  }
  return null
}

/** Състоянието на спрайта в момента timeMs (от началото на фазата). */
export function sampleSvaraTrack(track: SvaraTrack, timeMs: number): SvaraSampledState {
  const active = findSvaraTrackMove(track, timeMs)
  if (!active) return stateToSampled(track.moves[0]!.from)
  const { move } = active
  const t = (timeMs - move.delayMs) / move.durationMs
  return t >= 1 ? stateToSampled(move.to) : sampleSvaraMove(move, t)
}
