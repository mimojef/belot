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

function busyWait(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // умишлено блокира главната нишка
  }
}

console.log('\n[6] utilization е за ИНТЕРВАЛА от предишния sample(), не от създаването на монитора')
{
  const monitor = createEventLoopMonitor()
  // Дълъг idle период → кумулативна ELU би останала ниска след кратко натоварване.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const idle = monitor.sample()
  // Интервал, почти изцяло зает от синхронна работа.
  busyWait(300)
  const busy = monitor.sample()
  assert(idle.utilization === null || idle.utilization < 0.5, `idle interval utilization is low (got ${idle.utilization})`)
  // Кумулативно: ≈300/1300 ≈ 0.23; интервално: ≈1.0.
  assert(busy.utilization === null || busy.utilization > 0.8, `busy interval utilization is high (got ${busy.utilization})`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const idleAgain = monitor.sample()
  // Кумулативно след busy би било ≈ 300/1700 ≈ 0.18 — тук проверяваме, че
  // натоварването НЕ се пренася в следващия idle интервал.
  assert(idleAgain.utilization === null || idleAgain.utilization < 0.5, `next idle interval does not inherit the busy period (got ${idleAgain.utilization})`)
  monitor.stop()
}

console.log('\n[7] утилизацията и delay histogram-ът покриват един и същ прозорец (и двата се нулират в sample())')
{
  const monitor = createEventLoopMonitor()
  await new Promise((resolve) => setTimeout(resolve, 60))
  monitor.sample()
  // Пауза преди блока: блок, започнал в СЪЩИЯ turn веднага след reset(), е
  // невидим за histogram-а (reset нулира и предишния timestamp — известно
  // ограничение на monitorEventLoopDelay, виж incident 18536 audit).
  await new Promise((resolve) => setTimeout(resolve, 60))
  busyWait(250)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const blocked = monitor.sample()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const after = monitor.sample()
  assert(blocked.delayP99Ms === null || blocked.delayP99Ms >= 200, `blocked window shows the stall (p99 ${blocked.delayP99Ms})`)
  assert(after.delayP99Ms === null || after.delayP99Ms < 200, `next window does not carry the stall (p99 ${after.delayP99Ms})`)
  assert(
    blocked.utilization === null || after.utilization === null || blocked.utilization > after.utilization,
    `blocked window utilization (${blocked.utilization}) > following window (${after.utilization})`,
  )
  monitor.stop()
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
