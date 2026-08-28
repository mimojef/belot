import { PerformanceObserver } from 'node:perf_hooks'

// GC forensic metrics — feature-detected (не приемаме, че 'gc' entryType е
// поддържан на production Node runtime-а; repo-то не гарантира версия).
// Пази само count/totalDurationMs/maxDurationMs — без heap snapshots, без
// force-ван GC, без --expose-gc, без нова dependency.
//
// DUAL-WINDOW ARCHITECTURE (виж final fix pass брифа §1/§4) — всяко GC
// събитие се брои едновременно в ДВА напълно независими accumulator-а:
//   - oneSecond: reset-ва се точно веднъж на всеки 1s forensic sample tick.
//   - tenSecond: reset-ва се точно веднъж на всеки 10s bucket tick.
// Преди тази промяна snapshotAndReset() никога не се викаше в production —
// peek() връщаше process-uptime-cumulative данни (FALSE ATTRIBUTION RISK).

export type GcStatsSnapshot = {
  // false = GC observation не е налично на този runtime (feature-detect
  // failed) — UI трябва да показва "—", НЕ "0" (виж diagnostic fix брифа).
  available: boolean
  count: number
  totalDurationMs: number
  maxDurationMs: number
}

function zeroSnapshot(available: boolean): GcStatsSnapshot {
  return { available, count: 0, totalDurationMs: 0, maxDurationMs: 0 }
}

export type GcMetrics = {
  isAvailable(): boolean
  // Completed one-second forensic window. Reset-ва САМО oneSecond state.
  snapshotOneSecondAndReset(): GcStatsSnapshot
  // Completed ten-second forensic window (= стария snapshotAndReset()).
  // Reset-ва САМО tenSecond state.
  snapshotTenSecondAndReset(): GcStatsSnapshot
  /** Alias за snapshotTenSecondAndReset(), запазен за source-compat. */
  snapshotAndReset(): GcStatsSnapshot
  // Non-destructive read на tenSecond window — НЕ използвай за spike
  // forensic context (виж review findings, FALSE ATTRIBUTION RISK).
  peek(): GcStatsSnapshot
  stop(): void
}

export function createGcMetrics(): GcMetrics {
  let oneSecondCount = 0
  let oneSecondTotalDurationMs = 0
  let oneSecondMaxDurationMs = 0
  let tenSecondCount = 0
  let tenSecondTotalDurationMs = 0
  let tenSecondMaxDurationMs = 0
  let observer: PerformanceObserver | null = null
  let available = false

  try {
    // Feature-detect: 'gc' entryType е налична само на определени Node
    // версии/builds. Ако observe() хвърли (неподдържан entryType), падаме
    // обратно към "not available" без да чупим monitoring bootstrap-а.
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        oneSecondCount += 1
        oneSecondTotalDurationMs += entry.duration
        if (entry.duration > oneSecondMaxDurationMs) oneSecondMaxDurationMs = entry.duration

        tenSecondCount += 1
        tenSecondTotalDurationMs += entry.duration
        if (entry.duration > tenSecondMaxDurationMs) tenSecondMaxDurationMs = entry.duration
      }
    })
    observer.observe({ entryTypes: ['gc'] })
    available = true
  } catch {
    observer = null
    available = false
  }

  return {
    isAvailable() {
      return available
    },
    snapshotOneSecondAndReset() {
      const result: GcStatsSnapshot = {
        available,
        count: oneSecondCount,
        totalDurationMs: oneSecondTotalDurationMs,
        maxDurationMs: oneSecondMaxDurationMs,
      }
      oneSecondCount = 0
      oneSecondTotalDurationMs = 0
      oneSecondMaxDurationMs = 0
      return result
    },
    snapshotTenSecondAndReset() {
      const result: GcStatsSnapshot = {
        available,
        count: tenSecondCount,
        totalDurationMs: tenSecondTotalDurationMs,
        maxDurationMs: tenSecondMaxDurationMs,
      }
      tenSecondCount = 0
      tenSecondTotalDurationMs = 0
      tenSecondMaxDurationMs = 0
      return result
    },
    snapshotAndReset() {
      const result: GcStatsSnapshot = {
        available,
        count: tenSecondCount,
        totalDurationMs: tenSecondTotalDurationMs,
        maxDurationMs: tenSecondMaxDurationMs,
      }
      tenSecondCount = 0
      tenSecondTotalDurationMs = 0
      tenSecondMaxDurationMs = 0
      return result
    },
    peek() {
      return { available, count: tenSecondCount, totalDurationMs: tenSecondTotalDurationMs, maxDurationMs: tenSecondMaxDurationMs }
    },
    stop() {
      try {
        observer?.disconnect()
      } catch {
        // best-effort
      }
    },
  }
}

export function emptyGcStatsSnapshot(): GcStatsSnapshot {
  return zeroSnapshot(false)
}
