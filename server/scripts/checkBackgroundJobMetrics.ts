import { createBackgroundJobMetrics, emptyBackgroundJobStatsSnapshot } from '../src/monitoring/backgroundJobMetrics.js'

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

console.log('\n[1] emptyBackgroundJobStatsSnapshot — all 8 named jobs start at zero')
{
  const snap = emptyBackgroundJobStatsSnapshot()
  const names = Object.keys(snap)
  assertEqual(names.length, 8, 'exactly 8 fixed-cardinality job names, no dynamic registry')
  for (const name of names) {
    const stat = snap[name as keyof typeof snap]
    assertEqual(stat.count, 0, `${name}.count starts at 0`)
    assertEqual(stat.totalDurationMs, 0, `${name}.totalDurationMs starts at 0`)
    assertEqual(stat.maxDurationMs, 0, `${name}.maxDurationMs starts at 0`)
  }
}

console.log('\n[2] recordSync — count increments, totalDurationMs sums, maxDurationMs tracks the peak')
{
  let nowValue = 0
  const metrics = createBackgroundJobMetrics(() => nowValue)

  nowValue = 0
  metrics.recordSync('matchmakingTick', () => {
    nowValue = 10
  })
  nowValue = 10
  metrics.recordSync('matchmakingTick', () => {
    nowValue = 35
  })

  const snap = metrics.peek()
  assertEqual(snap.matchmakingTick.count, 2, 'count incremented twice')
  assertEqual(snap.matchmakingTick.totalDurationMs, 35, 'totalDurationMs sums both durations (10 + 25)')
  assertEqual(snap.matchmakingTick.maxDurationMs, 25, 'maxDurationMs tracks the larger of the two durations')
}

console.log('\n[3] recordSync — behavior is transparent: return value and thrown errors pass through unchanged')
{
  const metrics = createBackgroundJobMetrics()
  const returned = metrics.recordSync('topicPoll', () => 42)
  assertEqual(returned, 42, 'recordSync returns exactly what the wrapped function returns')

  let threw = false
  try {
    metrics.recordSync('topicPoll', () => {
      throw new Error('boom')
    })
  } catch (error) {
    threw = true
    assertEqual((error as Error).message, 'boom', 'the original error propagates unchanged')
  }
  assert(threw, 'recordSync does not swallow exceptions')
  // count is 2 here: the first recordSync('topicPoll', () => 42) above already recorded once.
  assertEqual(metrics.peek().topicPoll.count, 2, 'duration is still recorded even when the job throws (finally-block semantics)')
}

console.log('\n[4] recordAsync — measures the full await duration, propagates resolved value and rejection')
{
  const metrics = createBackgroundJobMetrics()
  const resolved = await metrics.recordAsync('gameRuntimeTick', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'ok'
  })
  assertEqual(resolved, 'ok', 'recordAsync returns the resolved value unchanged')
  assert(metrics.peek().gameRuntimeTick.count === 1, 'async job recorded exactly once')
  assert(metrics.peek().gameRuntimeTick.totalDurationMs >= 0, 'duration is a non-negative number')

  let rejected = false
  try {
    await metrics.recordAsync('gameRuntimeTick', async () => {
      throw new Error('async boom')
    })
  } catch (error) {
    rejected = true
    assertEqual((error as Error).message, 'async boom', 'the original rejection propagates unchanged')
  }
  assert(rejected, 'recordAsync does not swallow rejections')
  assertEqual(metrics.peek().gameRuntimeTick.count, 2, 'duration recorded even when the async job rejects')
}

console.log('\n[5] record — direct duration recording (for jobs that measure themselves elsewhere)')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('lobbyChatPoll', 12)
  metrics.record('lobbyChatPoll', 8)
  const snap = metrics.peek()
  assertEqual(snap.lobbyChatPoll.count, 2, 'count incremented for each direct record() call')
  assertEqual(snap.lobbyChatPoll.totalDurationMs, 20, 'totalDurationMs sums (12 + 8)')
  assertEqual(snap.lobbyChatPoll.maxDurationMs, 12, 'maxDurationMs is the larger of the two')
}

console.log('\n[6] peek() does NOT reset counters (non-destructive read)')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('matchmakingTick', 5)
  const first = metrics.peek()
  const second = metrics.peek()
  assertEqual(first.matchmakingTick.count, 1, 'first peek sees the recorded stat')
  assertEqual(second.matchmakingTick.count, 1, 'second peek still sees it — peek() did not reset')
}

console.log('\n[7] snapshotAndReset() returns the current stats AND resets them to zero')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('tournamentCoordinatorTick', 100)
  const snap = metrics.snapshotAndReset()
  assertEqual(snap.tournamentCoordinatorTick.count, 1, 'snapshotAndReset returns the stat that was recorded before it was called')
  const afterReset = metrics.peek()
  assertEqual(afterReset.tournamentCoordinatorTick.count, 0, 'stats are zero immediately after snapshotAndReset')
}

console.log('\n[8] Fixed cardinality — jobs are isolated, recording one name never affects another')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('monitoringHistoryPersist', 7)
  const snap = metrics.peek()
  assertEqual(snap.monitoringHistoryPersist.count, 1, 'the recorded job name has count 1')
  assertEqual(snap.monitoringHistoryPurge.count, 0, 'an unrelated job name stays untouched')
  assertEqual(snap.tournamentSchedulerTick.count, 0, 'another unrelated job name stays untouched')
}

console.log('\n[9] DUAL-WINDOW: record() writes to BOTH the 1s and the 10s window simultaneously')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('matchmakingTick', 42)

  const oneSecond = metrics.snapshotOneSecondAndReset()
  assertEqual(oneSecond.matchmakingTick.count, 1, 'oneSecond window sees the record()')
  assertEqual(oneSecond.matchmakingTick.totalDurationMs, 42, 'oneSecond window has the correct duration')

  const tenSecond = metrics.peek()
  assertEqual(tenSecond.matchmakingTick.count, 1, 'tenSecond window ALSO sees the record() — independent accumulator')
  assertEqual(tenSecond.matchmakingTick.totalDurationMs, 42, 'tenSecond window has the correct duration too')
}

console.log('\n[10] DUAL-WINDOW: resetting the 1s window does NOT reset the 10s window')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('gameRuntimeTick', 10)
  metrics.record('gameRuntimeTick', 20)

  const oneSecond1 = metrics.snapshotOneSecondAndReset()
  assertEqual(oneSecond1.gameRuntimeTick.count, 2, 'first 1s snapshot sees both records')

  const oneSecond2 = metrics.snapshotOneSecondAndReset()
  assertEqual(oneSecond2.gameRuntimeTick.count, 0, '1s window reset after its own snapshot')

  const tenSecond = metrics.peek()
  assertEqual(tenSecond.gameRuntimeTick.count, 2, '10s window STILL has both records — untouched by the 1s reset')
  assertEqual(tenSecond.gameRuntimeTick.totalDurationMs, 30, '10s window total duration still correct')
}

console.log('\n[11] DUAL-WINDOW: resetting the 10s window does NOT reset the 1s window')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('topicPoll', 5)

  const tenSecond1 = metrics.snapshotTenSecondAndReset()
  assertEqual(tenSecond1.topicPoll.count, 1, 'first 10s snapshot sees the record')

  const tenSecond2 = metrics.snapshotTenSecondAndReset()
  assertEqual(tenSecond2.topicPoll.count, 0, '10s window reset after its own snapshot')

  const oneSecond = metrics.snapshotOneSecondAndReset()
  assertEqual(oneSecond.topicPoll.count, 1, '1s window STILL has the record — untouched by the 10s reset')
}

console.log('\n[12] DUAL-WINDOW: independent maxDurationMs tracking per window')
{
  const metrics = createBackgroundJobMetrics()
  metrics.record('lobbyChatPoll', 100) // goes into both windows
  metrics.snapshotOneSecondAndReset() // reset ONLY the 1s window

  metrics.record('lobbyChatPoll', 5) // 1s window now has just this; 10s window has 100 AND 5

  const oneSecond = metrics.snapshotOneSecondAndReset()
  assertEqual(oneSecond.lobbyChatPoll.maxDurationMs, 5, '1s window max reflects only its own post-reset record')

  const tenSecond = metrics.peek()
  assertEqual(tenSecond.lobbyChatPoll.maxDurationMs, 100, '10s window max still reflects the larger of BOTH records (100, 5) since it was never reset')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
