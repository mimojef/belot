import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// Event loop health — отделно от CPU агрегатите (виж audit: processCpu −
// gameWorkerCpu remainder НЕ е "main thread CPU", защото пак включва libuv
// threadpool/GC/native threads). eventLoopUtilization/delay мерят директно
// здравето на самия event loop, не derived subtraction.

export type EventLoopHealthSnapshot = {
  utilization: number | null
  delayP50Ms: number | null
  delayP99Ms: number | null
}

// resolution=20ms — компромис между native sampling overhead и forensic
// резолюция; виж final audit §C. Node default е 10ms, но 10s bucket-ите
// вече агрегират delay статистиката, така че по-фина резолюция не носи
// допълнителна forensic стойност тук.
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20

type EventLoopUtilizationFn = typeof performance.eventLoopUtilization

export type EventLoopMonitor = {
  // Снимка от текущото натрупано състояние на histogram-а/ELU от последния
  // reset. Не хвърля дори ако API-то липсва на runtime-а — връща null полета.
  sample(): EventLoopHealthSnapshot
  stop(): void
}

export function createEventLoopMonitor(): EventLoopMonitor {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
  let eluBaseline: ReturnType<EventLoopUtilizationFn> | null = null
  const getElu: EventLoopUtilizationFn | null =
    typeof performance.eventLoopUtilization === 'function'
      ? performance.eventLoopUtilization.bind(performance)
      : null

  try {
    if (typeof monitorEventLoopDelay === 'function') {
      histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS })
      histogram.enable()
    }
  } catch {
    histogram = null
  }

  try {
    if (getElu !== null) {
      eluBaseline = getElu()
    }
  } catch {
    eluBaseline = null
  }

  function sample(): EventLoopHealthSnapshot {
    let utilization: number | null = null
    let delayP50Ms: number | null = null
    let delayP99Ms: number | null = null

    try {
      if (getElu !== null && eluBaseline !== null) {
        const curr = getElu(eluBaseline)
        utilization = curr.utilization
      }
    } catch {
      utilization = null
    }

    try {
      if (histogram !== null) {
        // percentile() връща наносекунди — конвертирай в ms.
        delayP50Ms = histogram.percentile(50) / 1e6
        delayP99Ms = histogram.percentile(99) / 1e6
        histogram.reset()
      }
    } catch {
      delayP50Ms = null
      delayP99Ms = null
    }

    return { utilization, delayP50Ms, delayP99Ms }
  }

  function stop(): void {
    try {
      histogram?.disable()
    } catch {
      // best-effort
    }
  }

  return { sample, stop }
}
