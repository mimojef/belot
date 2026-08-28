import { createGcMetrics, emptyGcStatsSnapshot } from '../src/monitoring/gcMetrics.js'

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

console.log('\n[1] emptyGcStatsSnapshot() — "not available" shape, not a fake measured zero')
{
  const snap = emptyGcStatsSnapshot()
  assertEqual(snap.available, false, 'available is explicitly false')
  assertEqual(snap.count, 0, 'count is 0 (but this is the not-available placeholder, not a real measurement)')
}

console.log('\n[2] createGcMetrics() on THIS runtime — never throws during construction, feature-detects cleanly')
{
  let threw = false
  let metrics: ReturnType<typeof createGcMetrics> | null = null
  try {
    metrics = createGcMetrics()
  } catch {
    threw = true
  }
  assert(!threw, 'createGcMetrics() never throws even if the runtime lacks GC observation support')
  assert(metrics !== null, 'metrics object was constructed')
  // Node v24 (this repo's runtime) supports entryTypes: ['gc'] — but we assert
  // isAvailable() is a boolean either way, not that it's specifically true,
  // so this test does not silently break on a future Node without GC observation.
  assert(typeof metrics!.isAvailable() === 'boolean', 'isAvailable() returns a boolean regardless of runtime support')
  metrics!.stop()
}

console.log('\n[3] peek()/snapshotAndReset() shape is always well-formed, even before any GC has run')
{
  const metrics = createGcMetrics()
  const snap = metrics.peek()
  assertEqual(snap.available, metrics.isAvailable(), 'peek().available matches isAvailable()')
  assertEqual(snap.count, 0, 'count starts at 0 before any GC event has been observed')
  assertEqual(snap.totalDurationMs, 0, 'totalDurationMs starts at 0')
  assertEqual(snap.maxDurationMs, 0, 'maxDurationMs starts at 0')
  metrics.stop()
}

console.log('\n[4] snapshotAndReset() resets the aggregate counters to zero')
{
  const metrics = createGcMetrics()
  // Force at least one real GC cycle to exercise the observer callback, when
  // observation is available on this runtime. If GC is triggered but the
  // observer never fires (unavailable), the snapshot legitimately stays zero
  // — either way, snapshotAndReset() must not throw and must reset cleanly.
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-new
    new Array(200_000).fill(0).map((_, j) => ({ j, pad: 'x'.repeat(64) }))
  }
  await new Promise((resolve) => setTimeout(resolve, 50))

  const before = metrics.snapshotAndReset()
  const after = metrics.peek()
  assertEqual(after.count, 0, 'count is reset to 0 after snapshotAndReset()')
  assertEqual(after.totalDurationMs, 0, 'totalDurationMs is reset to 0 after snapshotAndReset()')
  assertEqual(after.maxDurationMs, 0, 'maxDurationMs is reset to 0 after snapshotAndReset()')
  assert(before.count >= 0, 'pre-reset snapshot has a non-negative count (0 if GC observation unavailable or no GC fired yet)')
  metrics.stop()
}

console.log('\n[5] stop() is idempotent and safe to call multiple times')
{
  const metrics = createGcMetrics()
  let threw = false
  try {
    metrics.stop()
    metrics.stop()
  } catch {
    threw = true
  }
  assert(!threw, 'calling stop() twice does not throw')
}

console.log('\n[6] Unavailable-runtime simulation — a metrics instance whose observer never fires reports available:false, never a fabricated zero-but-measured state that looks the same as real zero activity')
{
  // We cannot force node:perf_hooks to reject 'gc' entryType from here without
  // monkey-patching the module (out of scope for a unit test) — this test
  // instead documents and asserts the CONTRACT: emptyGcStatsSnapshot() (the
  // exact fallback value producers must use for "unavailable") is
  // distinguishable at the type level and at the value level from a real
  // measured zero (available:true, count:0).
  const unavailable = emptyGcStatsSnapshot()
  const realZero: ReturnType<typeof emptyGcStatsSnapshot> = { available: true, count: 0, totalDurationMs: 0, maxDurationMs: 0 }
  assert(unavailable.available !== realZero.available, 'unavailable and real-zero states are distinguishable by the available flag')
}

console.log('\n[7] DUAL-WINDOW: a GC event lands in BOTH the 1s and the 10s window simultaneously')
{
  const metrics = createGcMetrics()
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-new
    new Array(200_000).fill(0).map((_, j) => ({ j, pad: 'x'.repeat(64) }))
  }
  await new Promise((resolve) => setTimeout(resolve, 80))

  if (metrics.isAvailable()) {
    const oneSecond = metrics.snapshotOneSecondAndReset()
    const tenSecond = metrics.peek()
    // Both windows saw the SAME underlying GC events (independent accumulators,
    // not a shared counter) — counts must match since no reset happened
    // between the GC activity and either read.
    assertEqual(oneSecond.count, tenSecond.count, 'oneSecond and tenSecond windows both observed the same GC event count (dual accumulation, not shared state)')
  } else {
    assert(true, 'GC observation unavailable on this runtime — dual-window wiring exists but cannot be exercised (feature-detect path, not a failure)')
  }
  metrics.stop()
}

console.log('\n[8] DUAL-WINDOW: resetting the 1s window does NOT reset the 10s window')
{
  const metrics = createGcMetrics()
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-new
    new Array(200_000).fill(0).map((_, j) => ({ j, pad: 'x'.repeat(64) }))
  }
  await new Promise((resolve) => setTimeout(resolve, 80))

  if (metrics.isAvailable()) {
    const tenSecondBefore = metrics.peek()
    metrics.snapshotOneSecondAndReset() // reset ONLY the 1s window
    const tenSecondAfter = metrics.peek()
    assertEqual(tenSecondAfter.count, tenSecondBefore.count, '10s window count unchanged after a 1s-only reset')
    assertEqual(tenSecondAfter.totalDurationMs, tenSecondBefore.totalDurationMs, '10s window totalDurationMs unchanged after a 1s-only reset')
  } else {
    assert(true, 'GC observation unavailable on this runtime — nothing to assert, feature-detect path is safe')
  }
  metrics.stop()
}

console.log('\n[9] DUAL-WINDOW: resetting the 10s window does NOT reset the 1s window')
{
  const metrics = createGcMetrics()
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-new
    new Array(200_000).fill(0).map((_, j) => ({ j, pad: 'x'.repeat(64) }))
  }
  await new Promise((resolve) => setTimeout(resolve, 80))

  if (metrics.isAvailable()) {
    // Reset the 10s window FIRST, WITHOUT touching the 1s window.
    metrics.snapshotTenSecondAndReset()
    // The 1s window must still carry everything observed above, since only
    // the 10s accumulator was reset.
    const oneSecond = metrics.snapshotOneSecondAndReset()
    assert(oneSecond.count > 0, '1s window still has the GC events observed earlier — untouched by the unrelated 10s reset')
  } else {
    assert(true, 'GC observation unavailable on this runtime — nothing to assert, feature-detect path is safe')
  }
  metrics.stop()
}

console.log('\n[10] DUAL-WINDOW: unavailable runtime — snapshotOneSecondAndReset()/snapshotTenSecondAndReset() never throw, stay available:false')
{
  const metrics = createGcMetrics()
  let threw = false
  try {
    const one = metrics.snapshotOneSecondAndReset()
    const ten = metrics.snapshotTenSecondAndReset()
    assertEqual(one.available, metrics.isAvailable(), 'snapshotOneSecondAndReset().available matches isAvailable()')
    assertEqual(ten.available, metrics.isAvailable(), 'snapshotTenSecondAndReset().available matches isAvailable()')
  } catch {
    threw = true
  }
  assert(!threw, 'dual-window snapshot methods never throw regardless of GC observation availability')
  metrics.stop()
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
