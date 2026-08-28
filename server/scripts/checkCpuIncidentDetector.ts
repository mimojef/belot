import {
  createCpuIncidentDetector,
  emptyForensicBucket,
  createForensicRingBuffer,
  type ForensicBucket,
} from '../src/monitoring/cpuIncidentDetector.js'
import { CPU_INCIDENT_THRESHOLDS, CPU_INCIDENT_SAMPLING } from '../src/monitoring/cpuIncidentTypes.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${String(actual)}, expected ${String(expected)})`)
}

function makeBucket(bucketStartMs: number, cpu: number): ForensicBucket {
  const b = emptyForensicBucket(bucketStartMs)
  return { ...b, processCpuAvg: cpu, processCpuMax: cpu }
}

const BUCKET_MS = CPU_INCIDENT_SAMPLING.bucketMs

// ═══════════════════════════════════════════════════════════════════════════
// A) EXTREME SPIKE
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[A1] 99% single sample — does NOT create extreme spike')
{
  const detector = createCpuIncidentDetector()
  detector.observeCpuSample({ sampledAtMs: 1000, processCpuPercent: 99 }, [])
  // Flush a normal bucket so any expired-spike-closing logic runs.
  detector.observeBucket(makeBucket(10_000, 50), [])
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 0, 'no incident created for a 99% sample')
}

console.log('\n[A2] 100% single sample — DOES create extreme spike')
{
  const detector = createCpuIncidentDetector()
  detector.observeCpuSample({ sampledAtMs: 1000, processCpuPercent: 100 }, [])
  // Advance far enough that the spike is considered expired and gets closed.
  detector.observeBucket(makeBucket(1000 + CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs + 1000, 50), [])
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'exactly one incident created for a 100% sample')
  assertEqual(closed[0]?.detectionType, 'extreme_spike', 'detectionType is extreme_spike')
}

console.log('\n[A3] 105.9% for ~1 second is preserved as a short-duration incident')
{
  const detector = createCpuIncidentDetector()
  detector.observeCpuSample({ sampledAtMs: 5000, processCpuPercent: 105.9 }, [])
  detector.observeBucket(makeBucket(5000 + CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs + 1000, 50), [])
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'incident recorded')
  assertEqual(closed[0]?.startedAtMs, 5000, 'startedAtMs matches the single sample time')
  assertEqual(closed[0]?.endedAtMs, 5000, 'endedAtMs equals startedAtMs — true short duration preserved (not padded)')
  assertEqual(closed[0]?.rawSpikeSamples.length, 1, 'exactly one raw 1s sample retained')
  assertEqual(closed[0]?.rawSpikeSamples[0]?.processCpuPercent, 105.9, 'raw sample value preserved exactly')
}

console.log('\n[A4] Consecutive >=100% samples MERGE into the same spike')
{
  const detector = createCpuIncidentDetector()
  detector.observeCpuSample({ sampledAtMs: 1000, processCpuPercent: 101 }, [])
  detector.observeCpuSample({ sampledAtMs: 2000, processCpuPercent: 103 }, [])
  detector.observeCpuSample({ sampledAtMs: 3000, processCpuPercent: 102 }, [])
  detector.observeBucket(makeBucket(3000 + CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs + 1000, 50), [])
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'exactly one merged incident, not three separate ones')
  assertEqual(closed[0]?.startedAtMs, 1000, 'startedAtMs is the first sample')
  assertEqual(closed[0]?.endedAtMs, 3000, 'endedAtMs is the last sample')
  assertEqual(closed[0]?.rawSpikeSamples.length, 3, 'all three raw samples retained')
}

console.log('\n[A5] Gap <5s between extreme samples MERGES; gap >=5s does NOT merge')
{
  const detector = createCpuIncidentDetector()
  detector.observeCpuSample({ sampledAtMs: 0, processCpuPercent: 100 }, [])
  // 4999ms gap — still within extremeSpikeMergeGapMs (5000ms) → merge
  detector.observeCpuSample({ sampledAtMs: 4999, processCpuPercent: 100 }, [])
  detector.observeBucket(makeBucket(4999 + CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs + 1000, 50), [])
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'samples within the merge gap produce ONE incident')
  assertEqual(closed[0]?.rawSpikeSamples.length, 2, 'both samples retained in the merged incident')
}

console.log('\n[A6] Gap >=5s between extreme samples creates TWO separate incidents')
{
  const detector = createCpuIncidentDetector()
  detector.observeCpuSample({ sampledAtMs: 0, processCpuPercent: 100 }, [])
  // 6000ms gap — beyond extremeSpikeMergeGapMs (5000ms) → new incident
  detector.observeCpuSample({ sampledAtMs: 6000, processCpuPercent: 100 }, [])
  detector.observeBucket(makeBucket(6000 + CPU_INCIDENT_THRESHOLDS.extremeSpikeMergeGapMs + 1000, 50), [])
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 2, 'two separate incidents when the gap exceeds the merge threshold')
}

// ═══════════════════════════════════════════════════════════════════════════
// B) SUSTAINED HIGH
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[B1] Brief high CPU (single 10s bucket >=90%, then drops) does NOT create a sustained incident')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(50) // normal
  push(95) // one bucket over incidentPercent — NOT sustained (needs >=20s = 2 buckets)
  push(50) // drops back immediately
  push(50)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 0, 'single-bucket spike does not create a sustained incident')
}

console.log('\n[B2] Sustained >=90% for >=20s (2 consecutive buckets) DOES create an incident')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(50)
  push(95) // incident start
  push(95) // 20s sustained
  push(95)
  // Recovery: drop below 70%, sustained for >=20s (2 buckets) — this transitions
  // the internal state back to 'normal', which enqueues the incident for
  // post-buffer collection (preIncidentBufferBuckets more buckets needed
  // before it actually lands in drainClosedIncidents — see finalizeIncident).
  push(50)
  push(50)
  push(50)
  for (let i = 0; i < CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets; i++) push(45)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'sustained incident created and closed after recovery + post-buffer window')
  assertEqual(closed[0]?.detectionType, 'sustained_high', 'detectionType is sustained_high')
}

console.log('\n[B3] Recovery hysteresis — CPU must stay below recoveryPercent for the full min duration')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(50)
  push(95)
  push(95) // sustained incident begins (20s)
  push(65) // dips below recovery threshold (70%)
  push(92) // but bounces back up before recovery duration elapses — still incident
  push(92)
  push(65) // now genuinely recovering
  push(65) // sustained recovery (20s) — enqueued for post-buffer
  for (let i = 0; i < CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets; i++) push(45)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'incident closes only after a genuine sustained recovery, not a brief dip')
}

console.log('\n[B3b] A brief dip below recovery followed by bounce-back does NOT shorten the incident window')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(50)
  push(95)
  push(95)
  push(65) // brief dip — resets recovery timer conceptually, but bounces back next tick
  push(92) // still incident — recoveryEnteredAtMs cleared
  const stateAfterBounce = detector.getState()
  assertEqual(stateAfterBounce, 'incident', 'a brief dip that bounces back stays in incident state, not recovery')
}

console.log('\n[B4] Flapping around the threshold (79→81→79→82→78) does NOT spam incidents')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  // All values are between warningPercent(80) and well below incidentPercent(90) —
  // flapping around 80 should never reach 'incident' state at all.
  push(79)
  push(81)
  push(79)
  push(82)
  push(78)
  push(79)
  push(81)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 0, 'flapping around the warning threshold creates zero incidents')
}

console.log('\n[B5] Pre-incident buffer — closed incident retains buckets from before the incident started')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  // 5 buckets of pre-context before the incident starts.
  push(40)
  push(41)
  push(42)
  push(43)
  push(44)
  push(95) // incident starts
  push(95)
  push(50)
  push(50)
  for (let i = 0; i < CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets; i++) push(45)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'incident closed')
  assert((closed[0]?.preBuffer.length ?? 0) > 0, 'pre-incident buffer is non-empty')
  const preCpus = closed[0]?.preBuffer.map((b) => b.processCpuAvg) ?? []
  assert(preCpus.includes(44) || preCpus.includes(43), 'pre-buffer contains buckets immediately preceding the incident')
}

console.log('\n[B6] Post-incident buffer — closed incident retains buckets after recovery')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(95)
  push(95) // incident (20s)
  push(50)
  push(50) // recovery (20s) — incident closes here, post-buffer collection begins
  // Feed additional buckets so the post-buffer collection window completes.
  for (let i = 0; i < CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets; i++) {
    push(45 + i)
  }
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'incident closed exactly once')
  assert((closed[0]?.postBuffer.length ?? 0) > 0, 'post-incident buffer is non-empty')
}

// ═══════════════════════════════════════════════════════════════════════════
// C) MERGE — extreme spike inside/around a sustained incident
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[C1] Extreme spike during an active sustained incident merges into sustained_with_spike')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(95)
  // A 1s extreme spike sample lands squarely inside the sustained window.
  detector.observeCpuSample({ sampledAtMs: t + 1000, processCpuPercent: 110 }, ring.toArray())
  push(96)
  push(50)
  push(50)
  for (let i = 0; i < CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets; i++) push(45)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'exactly one merged incident, not two separate ones')
  assertEqual(closed[0]?.detectionType, 'sustained_with_spike', 'detectionType upgraded to sustained_with_spike')
  assert((closed[0]?.rawSpikeSamples.length ?? 0) > 0, 'the merged incident carries the raw 1s spike sample')
}

console.log('\n[C2] No spike near a sustained incident stays sustained_high (no false merge)')
{
  const detector = createCpuIncidentDetector()
  const ring = createForensicRingBuffer()
  let t = 0
  const push = (cpu: number) => {
    const b = makeBucket(t, cpu)
    ring.push(b)
    detector.observeBucket(b, ring.toArray())
    t += BUCKET_MS
  }
  push(95)
  push(95)
  push(50)
  push(50)
  for (let i = 0; i < CPU_INCIDENT_SAMPLING.preIncidentBufferBuckets; i++) push(45)
  const closed = detector.drainClosedIncidents()
  assertEqual(closed.length, 1, 'one incident')
  assertEqual(closed[0]?.detectionType, 'sustained_high', 'stays sustained_high without a spike present')
}

// ═══════════════════════════════════════════════════════════════════════════
// D) Ring buffer
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[D1] Ring buffer is fixed-size — bounded at capacity, no unbounded growth')
{
  const ring = createForensicRingBuffer(5)
  for (let i = 0; i < 50; i++) {
    ring.push(makeBucket(i * BUCKET_MS, 50))
  }
  assertEqual(ring.toArray().length, 5, 'ring buffer stays at fixed capacity after 50 pushes')
}

console.log('\n[D2] Ring buffer evicts oldest entries first (FIFO)')
{
  const ring = createForensicRingBuffer(3)
  ring.push(makeBucket(0, 1))
  ring.push(makeBucket(BUCKET_MS, 2))
  ring.push(makeBucket(2 * BUCKET_MS, 3))
  ring.push(makeBucket(3 * BUCKET_MS, 4))
  const arr = ring.toArray()
  assertEqual(arr.length, 3, 'still 3 entries')
  assertEqual(arr[0]?.processCpuAvg, 2, 'oldest (cpu=1) was evicted, cpu=2 is now first')
  assertEqual(arr[2]?.processCpuAvg, 4, 'most recent entry is last')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
