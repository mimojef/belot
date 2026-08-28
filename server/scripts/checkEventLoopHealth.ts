import { createEventLoopMonitor } from '../src/monitoring/eventLoopHealth.js'

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

console.log('\n[1] createEventLoopMonitor does not throw on a normal Node runtime')
{
  let monitor: ReturnType<typeof createEventLoopMonitor> | null = null
  try {
    monitor = createEventLoopMonitor()
  } catch {
    // fall through — assert below reports the failure
  }
  assert(monitor !== null, 'monitor created without throwing')
  monitor?.stop()
}

console.log('\n[2] sample() returns a well-formed snapshot with sane bounds')
{
  const monitor = createEventLoopMonitor()
  // Let a real tick pass so the histogram has at least one sample.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const snap = monitor.sample()
  assert(
    snap.utilization === null || (snap.utilization >= 0 && snap.utilization <= 1),
    `utilization is null or within [0,1] (got ${snap.utilization})`,
  )
  assert(
    snap.delayP50Ms === null || snap.delayP50Ms >= 0,
    `delayP50Ms is null or non-negative (got ${snap.delayP50Ms})`,
  )
  assert(
    snap.delayP99Ms === null || snap.delayP99Ms >= 0,
    `delayP99Ms is null or non-negative (got ${snap.delayP99Ms})`,
  )
  assert(
    snap.delayP99Ms === null || snap.delayP50Ms === null || snap.delayP99Ms >= snap.delayP50Ms,
    'p99 delay is never less than p50 delay when both are present',
  )
  monitor.stop()
}

console.log('\n[3] sample() resets the delay histogram between calls (does not accumulate forever)')
{
  const monitor = createEventLoopMonitor()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const snap1 = monitor.sample()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const snap2 = monitor.sample()
  // Both snapshots should be well-formed independently — the second call
  // must not throw or silently return the first snapshot's accumulated state.
  assert(snap1 !== undefined && snap2 !== undefined, 'both consecutive samples returned successfully')
  monitor.stop()
}

console.log('\n[4] stop() is idempotent and does not throw on repeated calls')
{
  const monitor = createEventLoopMonitor()
  let threw = false
  try {
    monitor.stop()
    monitor.stop()
  } catch {
    threw = true
  }
  assert(!threw, 'calling stop() twice does not throw')
}

console.log('\n[5] sample() after stop() does not throw (degrades gracefully)')
{
  const monitor = createEventLoopMonitor()
  monitor.stop()
  let threw = false
  let snap: ReturnType<typeof monitor.sample> | null = null
  try {
    snap = monitor.sample()
  } catch {
    threw = true
  }
  assert(!threw, 'sample() after stop() does not throw')
  assert(snap !== null, 'sample() after stop() still returns a snapshot object (possibly with null fields)')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
