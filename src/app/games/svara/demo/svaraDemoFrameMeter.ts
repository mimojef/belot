// Лек измерител на кадрите за анимационния прототип. Работи САМО между
// start() и stop() (по време на пускане) — при неподвижна маса няма rAF.
//
// Мери кадрите на main нишката (requestAnimationFrame). При DOM/WAAPI
// transform/opacity анимациите се изпълняват на compositor нишката, така че
// числото е консервативна оценка за тях; при PixiJS то е реалното темпо на
// рисуване.

export type SvaraFrameStats = {
  frames: number
  durationMs: number
  avgFps: number
  p95FrameMs: number
  maxFrameMs: number
  /** Кадри над 25 ms (≈ пропуснат vsync при 60 Hz). */
  longFrames: number
  /** Момент (ms от start()) на края на първите до 10 дълги кадъра. */
  longFrameAtMs: number[]
}

export type SvaraFrameMeter = {
  start(): void
  stop(): SvaraFrameStats | null
}

export function summarizeSvaraFrameDeltas(deltas: number[], durationMs: number, frameEndsAtMs: number[] = []): SvaraFrameStats | null {
  if (deltas.length === 0 || durationMs <= 0) return null
  const sorted = [...deltas].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
  return {
    frames: deltas.length,
    durationMs,
    avgFps: (deltas.length * 1000) / durationMs,
    p95FrameMs: p95,
    maxFrameMs: sorted[sorted.length - 1]!,
    longFrames: deltas.filter((d) => d > 25).length,
    longFrameAtMs: deltas.flatMap((d, i) => (d > 25 && frameEndsAtMs[i] !== undefined ? [Math.round(frameEndsAtMs[i]!)] : [])).slice(0, 10),
  }
}

export function createSvaraFrameMeter(): SvaraFrameMeter {
  let handle: number | null = null
  let startedAt = 0
  let last = 0
  let deltas: number[] = []
  let ends: number[] = []

  const loop = (now: number) => {
    if (last > 0) {
      deltas.push(now - last)
      ends.push(now - startedAt)
    }
    last = now
    handle = requestAnimationFrame(loop)
  }

  return {
    start() {
      if (handle !== null) cancelAnimationFrame(handle)
      deltas = []
      ends = []
      last = 0
      startedAt = performance.now()
      handle = requestAnimationFrame(loop)
    },
    stop() {
      if (handle === null) return null
      cancelAnimationFrame(handle)
      handle = null
      return summarizeSvaraFrameDeltas(deltas, performance.now() - startedAt, ends)
    },
  }
}
