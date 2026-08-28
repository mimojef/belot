import type { ActivityCountersSnapshot } from './activityCounters.js'
import { emptyActivityCountersSnapshot } from './activityCounters.js'
import {
  CPU_INCIDENT_THRESHOLDS,
  CPU_INCIDENT_SAMPLING,
  type CpuIncidentDetectionType,
  type ForensicBucket,
  type RawCpuSample,
  type IncidentState,
} from './cpuIncidentTypes.js'

// ─── Ring buffer (5 минути / 30 x 10s bucket-и) ────────────────────────────────

export type ForensicRingBuffer = {
  push(bucket: ForensicBucket): void
  toArray(): ForensicBucket[]
  lastN(n: number): ForensicBucket[]
}

export function createForensicRingBuffer(
  capacity: number = CPU_INCIDENT_SAMPLING.ringBufferBuckets,
): ForensicRingBuffer {
  const buf: ForensicBucket[] = []

  return {
    push(bucket) {
      buf.push(bucket)
      if (buf.length > capacity) buf.shift()
    },
    toArray() {
      return [...buf]
    },
    lastN(n) {
      return buf.slice(Math.max(0, buf.length - n))
    },
  }
}

// ─── Bucket accumulator — приема 1s CPU семпли, произвежда ForensicBucket
// на всеки 10s tick ─────────────────────────────────────────────────────────

export type Sample1s = {
  atMs: number
  processCpu: number | null
  serverCpu: number | null
  gameWorkerCpu: number | null
  nonGameWorkerProcessCpu: number | null
  eventLoopUtilization: number | null
  eventLoopDelayP50Ms: number | null
  eventLoopDelayP99Ms: number | null
  rssMb: number | null
  heapUsedMb: number | null
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((s, v) => s + v, 0) / values.length
}

function maxOf(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values)
}

export type BucketAccumulator = {
  addSample(sample: Sample1s): void
  flush(
    bucketStartMs: number,
    context: {
      onlinePlayers: number
      activeMatches: number
      wsConnections: number
      matchmakingWaiters: number
      activity: ActivityCountersSnapshot
    },
  ): ForensicBucket
}

export function createBucketAccumulator(): BucketAccumulator {
  let processCpuSamples: number[] = []
  let serverCpuSamples: number[] = []
  let gameWorkerCpuSamples: number[] = []
  let nonGameWorkerCpuSamples: number[] = []
  let eluSamples: number[] = []
  let delayP50Samples: number[] = []
  let delayP99Samples: number[] = []
  let rssSamples: number[] = []
  let heapSamples: number[] = []

  function reset(): void {
    processCpuSamples = []
    serverCpuSamples = []
    gameWorkerCpuSamples = []
    nonGameWorkerCpuSamples = []
    eluSamples = []
    delayP50Samples = []
    delayP99Samples = []
    rssSamples = []
    heapSamples = []
  }

  return {
    addSample(sample) {
      if (sample.processCpu !== null) processCpuSamples.push(sample.processCpu)
      if (sample.serverCpu !== null) serverCpuSamples.push(sample.serverCpu)
      if (sample.gameWorkerCpu !== null) gameWorkerCpuSamples.push(sample.gameWorkerCpu)
      if (sample.nonGameWorkerProcessCpu !== null) nonGameWorkerCpuSamples.push(sample.nonGameWorkerProcessCpu)
      if (sample.eventLoopUtilization !== null) eluSamples.push(sample.eventLoopUtilization)
      if (sample.eventLoopDelayP50Ms !== null) delayP50Samples.push(sample.eventLoopDelayP50Ms)
      if (sample.eventLoopDelayP99Ms !== null) delayP99Samples.push(sample.eventLoopDelayP99Ms)
      if (sample.rssMb !== null) rssSamples.push(sample.rssMb)
      if (sample.heapUsedMb !== null) heapSamples.push(sample.heapUsedMb)
    },
    flush(bucketStartMs, context) {
      const bucket: ForensicBucket = {
        bucketStartMs,
        processCpuAvg: avg(processCpuSamples),
        processCpuMax: maxOf(processCpuSamples),
        serverCpuAvg: avg(serverCpuSamples),
        serverCpuMax: maxOf(serverCpuSamples),
        gameWorkerCpuAvg: avg(gameWorkerCpuSamples),
        gameWorkerCpuMax: maxOf(gameWorkerCpuSamples),
        nonGameWorkerProcessCpuAvg: avg(nonGameWorkerCpuSamples),
        nonGameWorkerProcessCpuMax: maxOf(nonGameWorkerCpuSamples),
        eventLoopUtilizationMax: maxOf(eluSamples),
        eventLoopDelayP50Ms: avg(delayP50Samples),
        eventLoopDelayP99Ms: maxOf(delayP99Samples),
        rssMb: avg(rssSamples),
        heapUsedMb: avg(heapSamples),
        onlinePlayers: context.onlinePlayers,
        activeMatches: context.activeMatches,
        wsConnections: context.wsConnections,
        matchmakingWaiters: context.matchmakingWaiters,
        activity: context.activity,
      }
      reset()
      return bucket
    },
  }
}

export function emptyForensicBucket(bucketStartMs: number): ForensicBucket {
  return {
    bucketStartMs,
    processCpuAvg: null,
    processCpuMax: null,
    serverCpuAvg: null,
    serverCpuMax: null,
    gameWorkerCpuAvg: null,
    gameWorkerCpuMax: null,
    nonGameWorkerProcessCpuAvg: null,
    nonGameWorkerProcessCpuMax: null,
    eventLoopUtilizationMax: null,
    eventLoopDelayP50Ms: null,
    eventLoopDelayP99Ms: null,
    rssMb: null,
    heapUsedMb: null,
    onlinePlayers: 0,
    activeMatches: 0,
    wsConnections: 0,
    matchmakingWaiters: 0,
    activity: emptyActivityCountersSnapshot(),
  }
}

// ─── Incident record (затворен, готов за persist) ──────────────────────────────

export type ClosedIncident = {
  detectionType: CpuIncidentDetectionType
  startedAtMs: number
  endedAtMs: number
  rawSpikeSamples: RawCpuSample[]
  preBuffer: ForensicBucket[]
  duringBuckets: ForensicBucket[]
  postBuffer: ForensicBucket[]
}

// ─── EXTREME SPIKE tracker ──────────────────────────────────────────────────────
//
// Работи изцяло на 1s резолюция, независимо от sustained bucket state
// machine-а. Единичен семпъл >= extremeSpikePercent отваря/удължава spike;
// gap > extremeSpikeMergeGapMs без нов над-праг семпъл затваря го.

type OpenSpike = {
  startedAtMs: number
  lastSampleAtMs: number
  samples: RawCpuSample[]
  preBuffer: ForensicBucket[]
  mergedIntoSustained: boolean
}

export type ExtremeSpikeTracker = {
  observeSample(sample: RawCpuSample, recentBuckets: ForensicBucket[]): void
  // Извиква се от sustained state machine-а, когато sustained incident
  // стане active — ако има открит spike точно сега, се маркира за merge
  // (detectionType на sustained incident-а ще стане sustained_with_spike).
  isSpikeActiveNear(atMs: number, windowMs: number): boolean
  takeSamplesNear(atMs: number, windowMs: number): RawCpuSample[]
  // За periodic tick — затваря spike-ове, чийто gap е изтекъл, дори при липса
  // на нов CPU семпъл (напр. sampler спрян) — извиква се от observeBucket.
  closeExpired(nowMs: number): ClosedIncident[]
}

export function createExtremeSpikeTracker(): ExtremeSpikeTracker {
  let open: OpenSpike | null = null
  const closedQueue: ClosedIncident[] = []

  function closeCurrent(): void {
    if (open === null || open.mergedIntoSustained) {
      open = null
      return
    }
    closedQueue.push({
      detectionType: 'extreme_spike',
      startedAtMs: open.startedAtMs,
      endedAtMs: open.lastSampleAtMs,
      rawSpikeSamples: open.samples,
      preBuffer: open.preBuffer,
      duringBuckets: [],
      postBuffer: [],
    })
    open = null
  }

  return {
    observeSample(sample, recentBuckets) {
      if (sample.processCpuPercent >= CPU_INCIDENT_THRESHOLDS.extremeSpikePercent) {
        if (open !== null) {
          const gap = sample.sampledAtMs - open.lastSampleAtMs
          if (gap <= CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs) {
            open.lastSampleAtMs = sample.sampledAtMs
            open.samples.push(sample)
            return
          }
          // Gap твърде голям — затвори стария, отвори нов.
          closeCurrent()
        }
        open = {
          startedAtMs: sample.sampledAtMs,
          lastSampleAtMs: sample.sampledAtMs,
          samples: [sample],
          preBuffer: recentBuckets.slice(-CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets),
          mergedIntoSustained: false,
        }
        return
      }
      // Под прага — не прави нищо тук; затварянето при gap timeout се прави
      // от closeExpired(), викана периодично от bucket tick-а, за да не
      // разчитаме на честотата на under-threshold семпли.
    },
    isSpikeActiveNear(atMs, windowMs) {
      if (open === null) return false
      return Math.abs(atMs - open.lastSampleAtMs) <= windowMs || Math.abs(atMs - open.startedAtMs) <= windowMs
    },
    takeSamplesNear(atMs, windowMs) {
      if (open === null) return []
      if (Math.abs(atMs - open.lastSampleAtMs) <= windowMs || Math.abs(atMs - open.startedAtMs) <= windowMs) {
        open.mergedIntoSustained = true
        const samples = open.samples
        open = null
        return samples
      }
      return []
    },
    closeExpired(nowMs) {
      if (open !== null && !open.mergedIntoSustained) {
        const gap = nowMs - open.lastSampleAtMs
        if (gap > CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs) {
          closeCurrent()
        }
      }
      const result = [...closedQueue]
      closedQueue.length = 0
      return result
    },
  }
}

// ─── SUSTAINED HIGH state machine (bucket-aligned, 10s резолюция) ─────────────

type OpenSustained = {
  detectionType: 'sustained_high' | 'sustained_with_spike'
  incidentEnteredAtMs: number
  lastIncidentBucketAtMs: number
  recoveryEnteredAtMs: number | null
  preBuffer: ForensicBucket[]
  duringBuckets: ForensicBucket[]
  extraSpikeSamples: RawCpuSample[]
}

export type SustainedIncidentTracker = {
  observeBucket(
    bucket: ForensicBucket,
    recentBuckets: ForensicBucket[],
    spikeTracker: ExtremeSpikeTracker,
  ): void
  getState(): IncidentState
  drainClosedIncidents(): ClosedIncident[]
}

export function createSustainedIncidentTracker(): SustainedIncidentTracker {
  let state: IncidentState = 'normal'
  let open: OpenSustained | null = null
  const closedQueue: ClosedIncident[] = []
  // Постbuffer collection state.
  let pendingClose: OpenSustained | null = null
  let pendingPostBufferRemaining = 0

  function tryMergeSpike(bucketStartMs: number, spikeTracker: ExtremeSpikeTracker): void {
    if (open === null) return
    if (spikeTracker.isSpikeActiveNear(bucketStartMs, CPU_INCIDENT_THRESHOLDS.spikeToSustainedMergeWindowMs)) {
      const samples = spikeTracker.takeSamplesNear(
        bucketStartMs,
        CPU_INCIDENT_THRESHOLDS.spikeToSustainedMergeWindowMs,
      )
      if (samples.length > 0) {
        open.detectionType = 'sustained_with_spike'
        open.extraSpikeSamples.push(...samples)
      }
    }
  }

  // Кратък-gap merge между два ПОСЛЕДОВАТЕЛНИ sustained incident-а (напр.
  // CPU пада под recovery за 21s, после веднага пак се качва) НЕ се решава
  // тук в detector-а — detector-ът emit-ва closed incidents като discrete
  // събития веднага след post-buffer collection. Merge-ването на "gap <=30s"
  // случаи е отговорност на persistence слоя (cpuIncidentStore), който има
  // durable state (последния INSERT-нат incident ред) срещу който да сверява
  // — избягва фрагилен in-memory merge след като предният incident вече може
  // да е бил drain-нат и persisted от caller-а между двете затваряния.
  function enqueueForPostBuffer(incident: OpenSustained): void {
    pendingClose = incident
    pendingPostBufferRemaining = CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets
  }

  function observeBucket(
    bucket: ForensicBucket,
    recentBuckets: ForensicBucket[],
    spikeTracker: ExtremeSpikeTracker,
  ): void {
    // Пост-буфер събиране за скоро затворен incident (независимо от текущия
    // state — паралелен, отделен процес).
    if (pendingClose !== null) {
      pendingClose.duringBuckets.push(bucket)
      pendingPostBufferRemaining -= 1
      if (pendingPostBufferRemaining <= 0) {
        const postCount = Math.min(
          CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets,
          pendingClose.duringBuckets.length,
        )
        const postBuffer = pendingClose.duringBuckets.slice(-postCount)
        const duringBuckets = pendingClose.duringBuckets.slice(
          0,
          Math.max(0, pendingClose.duringBuckets.length - postCount),
        )
        const closed: ClosedIncident = {
          detectionType: pendingClose.detectionType,
          startedAtMs: pendingClose.incidentEnteredAtMs,
          endedAtMs: pendingClose.lastIncidentBucketAtMs,
          rawSpikeSamples: pendingClose.extraSpikeSamples,
          preBuffer: pendingClose.preBuffer,
          duringBuckets,
          postBuffer,
        }
        closedQueue.push(closed)
        pendingClose = null
      }
    }

    const cpu = bucket.processCpuAvg
    const bucketMs = bucket.bucketStartMs

    if (open !== null) {
      open.duringBuckets.push(bucket)
      tryMergeSpike(bucketMs, spikeTracker)
    }

    if (cpu === null) return

    switch (state) {
      case 'normal': {
        if (cpu >= CPU_INCIDENT_THRESHOLDS.incidentPercent) {
          state = 'incident'
          openIfNeeded(bucketMs, bucket, recentBuckets)
        } else if (cpu >= CPU_INCIDENT_THRESHOLDS.warningPercent) {
          state = 'warning'
        }
        return
      }
      case 'warning': {
        if (cpu >= CPU_INCIDENT_THRESHOLDS.incidentPercent) {
          state = 'incident'
          openIfNeeded(bucketMs, bucket, recentBuckets)
        } else if (cpu < CPU_INCIDENT_THRESHOLDS.warningPercent) {
          state = 'normal'
        }
        return
      }
      case 'incident': {
        if (open === null) {
          // Defensive — не би трябвало да се случи, но пази инвариант.
          openIfNeeded(bucketMs, bucket, recentBuckets)
        }
        if (cpu < CPU_INCIDENT_THRESHOLDS.recoveryPercent) {
          state = 'recovery'
          if (open !== null) open.recoveryEnteredAtMs = bucketMs
        } else if (open !== null) {
          open.lastIncidentBucketAtMs = bucketMs
        }
        return
      }
      case 'recovery': {
        if (cpu >= CPU_INCIDENT_THRESHOLDS.incidentPercent) {
          state = 'incident'
          if (open !== null) {
            open.recoveryEnteredAtMs = null
            open.lastIncidentBucketAtMs = bucketMs
          }
          return
        }
        if (open !== null && open.recoveryEnteredAtMs !== null) {
          // Същата bucket-start-vs-window-width корекция като finalizeIncident().
          const recoveryDuration = bucketMs - open.recoveryEnteredAtMs + CPU_INCIDENT_SAMPLING.bucketMs
          if (recoveryDuration >= CPU_INCIDENT_THRESHOLDS.recoveryMinDurationMs) {
            finalizeIncident()
            state = 'normal'
          }
        }
        return
      }
    }
  }

  function openIfNeeded(bucketMs: number, bucket: ForensicBucket, recentBuckets: ForensicBucket[]): void {
    if (open !== null) return
    open = {
      detectionType: 'sustained_high',
      incidentEnteredAtMs: bucketMs,
      lastIncidentBucketAtMs: bucketMs,
      recoveryEnteredAtMs: null,
      preBuffer: recentBuckets.slice(0, Math.max(0, recentBuckets.length - 1)).slice(
        -CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets,
      ),
      duringBuckets: [bucket],
      extraSpikeSamples: [],
    }
  }

  function finalizeIncident(): void {
    if (open === null) return
    // +bucketMs: incidentEnteredAtMs/lastIncidentBucketAtMs са bucket START
    // timestamps, не end timestamps — 2 последователни bucket-а над прага
    // (напр. t=50000 и t=60000, всеки с ширина 10s) покриват реален
    // прозорец от 20000ms ([50000,70000)), не 10000ms (разликата между
    // старт-овете им). Без тази корекция incidentMinDurationMs изисква на
    // практика 3 bucket-а вместо документираните 2 (20s).
    const durationMs = open.lastIncidentBucketAtMs - open.incidentEnteredAtMs + CPU_INCIDENT_SAMPLING.bucketMs
    if (durationMs < CPU_INCIDENT_THRESHOLDS.incidentMinDurationMs) {
      // Никога не е достигнал min sustained duration — discard.
      open = null
      return
    }
    enqueueForPostBuffer(open)
    open = null
  }

  return {
    observeBucket,
    getState() {
      return state
    },
    drainClosedIncidents() {
      const result = [...closedQueue]
      closedQueue.length = 0
      return result
    },
  }
}

// ─── Публичен detector — комбинира двата tracker-а ─────────────────────────────

export type CpuIncidentDetector = {
  observeCpuSample(sample: RawCpuSample, recentBuckets: ForensicBucket[]): void
  observeBucket(bucket: ForensicBucket, recentBuckets: ForensicBucket[]): void
  drainClosedIncidents(): ClosedIncident[]
  getState(): IncidentState
}

export function createCpuIncidentDetector(): CpuIncidentDetector {
  const spikeTracker = createExtremeSpikeTracker()
  const sustainedTracker = createSustainedIncidentTracker()
  // Per-instance queue за spike closures, drained заедно със sustained closures.
  const pendingSpikeClosures: ClosedIncident[] = []

  return {
    observeCpuSample(sample, recentBuckets) {
      spikeTracker.observeSample(sample, recentBuckets)
    },
    observeBucket(bucket, recentBuckets) {
      sustainedTracker.observeBucket(bucket, recentBuckets, spikeTracker)
      // Затвори expired spike-ове (независим tick, gap-based) — извиква се
      // тук защото bucket tick-ът (10s) е естественото periodic heartbeat.
      const expiredSpikes = spikeTracker.closeExpired(bucket.bucketStartMs)
      for (const spike of expiredSpikes) {
        pendingSpikeClosures.push(spike)
      }
    },
    drainClosedIncidents() {
      const sustainedClosed = sustainedTracker.drainClosedIncidents()
      const spikeClosed = [...pendingSpikeClosures]
      pendingSpikeClosures.length = 0
      return [...spikeClosed, ...sustainedClosed]
    },
    getState() {
      return sustainedTracker.getState()
    },
  }
}
