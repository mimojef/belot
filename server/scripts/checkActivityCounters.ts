import { createActivityCounters, emptyActivityCountersSnapshot } from '../src/monitoring/activityCounters.js'

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

console.log('\n[1] Fresh counters start at zero')
{
  const counters = createActivityCounters()
  const snap = counters.peek()
  assertEqual(snap.lobbyChatMessages, 0, 'lobbyChatMessages starts at 0')
  assertEqual(snap.gameplayBidAccepted, 0, 'gameplayBidAccepted starts at 0')
  assertEqual(snap.matchmakingJoin, 0, 'matchmakingJoin starts at 0')
  assertEqual(snap.tournamentRegistration, 0, 'tournamentRegistration starts at 0')
  assertEqual(Object.keys(snap.wsInboundByType).length, 0, 'wsInboundByType starts empty')
  assertEqual(Object.keys(snap.httpRequestsByCategory).length, 0, 'httpRequestsByCategory starts empty')
}

console.log('\n[2] Scalar increments — O(1), independent counters')
{
  const counters = createActivityCounters()
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('officialSupportMessages')
  counters.incrementGame('gameplayBidAccepted')
  const snap = counters.peek()
  assertEqual(snap.lobbyChatMessages, 2, 'lobbyChatMessages incremented twice')
  assertEqual(snap.officialSupportMessages, 1, 'officialSupportMessages incremented once')
  assertEqual(snap.gameplayBidAccepted, 1, 'gameplayBidAccepted incremented once')
  assertEqual(snap.directChatFriendMessages, 0, 'unrelated counter untouched')
}

console.log('\n[3] All chat subsystem counters are independent (§A разграничение)')
{
  const counters = createActivityCounters()
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('directChatFriendMessages')
  counters.incrementChat('directChatPikaTeamMessages')
  counters.incrementChat('directChatVipDmMessages')
  counters.incrementChat('officialSupportMessages')
  counters.incrementChat('privateRoomChatMessages')
  counters.incrementChat('guestContactMessages')
  const snap = counters.peek()
  assertEqual(snap.lobbyChatMessages, 1, 'lobbyChatMessages')
  assertEqual(snap.directChatFriendMessages, 1, 'directChatFriendMessages')
  assertEqual(snap.directChatPikaTeamMessages, 1, 'directChatPikaTeamMessages (distinct from officialSupport)')
  assertEqual(snap.directChatVipDmMessages, 1, 'directChatVipDmMessages')
  assertEqual(snap.officialSupportMessages, 1, 'officialSupportMessages (distinct from directChatPikaTeam)')
  assertEqual(snap.privateRoomChatMessages, 1, 'privateRoomChatMessages')
  assertEqual(snap.guestContactMessages, 1, 'guestContactMessages')
}

console.log('\n[4] WS inbound/outbound by type — bounded Record, fixed-cardinality keys')
{
  const counters = createActivityCounters()
  counters.incrementWsInbound('submit_bid_action')
  counters.incrementWsInbound('submit_bid_action')
  counters.incrementWsInbound('submit_play_card')
  counters.incrementWsOutbound('room_snapshot')
  const snap = counters.peek()
  assertEqual(snap.wsInboundByType['submit_bid_action'], 2, 'submit_bid_action counted twice')
  assertEqual(snap.wsInboundByType['submit_play_card'], 1, 'submit_play_card counted once')
  assertEqual(snap.wsOutboundByType['room_snapshot'], 1, 'room_snapshot outbound counted once')
}

console.log('\n[5] HTTP category counter')
{
  const counters = createActivityCounters()
  counters.incrementHttpCategory('topics')
  counters.incrementHttpCategory('topics')
  counters.incrementHttpCategory('admin')
  const snap = counters.peek()
  assertEqual(snap.httpRequestsByCategory['topics'], 2, 'topics category counted twice')
  assertEqual(snap.httpRequestsByCategory['admin'], 1, 'admin category counted once')
}

console.log('\n[6] snapshotAndReset — returns current values THEN resets to zero')
{
  const counters = createActivityCounters()
  counters.incrementChat('lobbyChatMessages')
  counters.incrementWsInbound('submit_bid_action')
  const snap1 = counters.snapshotAndReset()
  assertEqual(snap1.lobbyChatMessages, 1, 'first snapshot reflects the increment')
  assertEqual(snap1.wsInboundByType['submit_bid_action'], 1, 'first snapshot reflects WS increment')

  const snap2 = counters.peek()
  assertEqual(snap2.lobbyChatMessages, 0, 'reset to 0 after snapshotAndReset')
  assertEqual(Object.keys(snap2.wsInboundByType).length, 0, 'wsInboundByType cleared after snapshotAndReset')
}

console.log('\n[7] snapshotAndReset does not mutate previously returned snapshots (independent copies)')
{
  const counters = createActivityCounters()
  counters.incrementChat('lobbyChatMessages')
  const snap1 = counters.snapshotAndReset()
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('lobbyChatMessages')
  const snap2 = counters.snapshotAndReset()
  assertEqual(snap1.lobbyChatMessages, 1, 'snap1 unaffected by later increments')
  assertEqual(snap2.lobbyChatMessages, 2, 'snap2 reflects only its own window')
}

console.log('\n[8] Bucket cycle simulation — 10s worth of mixed events, reset, next bucket starts clean')
{
  const counters = createActivityCounters()
  for (let i = 0; i < 5; i++) counters.incrementGame('gameplayPlayAccepted')
  for (let i = 0; i < 3; i++) counters.incrementChat('lobbyChatMessages')
  counters.incrementRooms('matchmakingJoin')
  counters.incrementTournament('tournamentMatchResult')

  const bucket1 = counters.snapshotAndReset()
  assertEqual(bucket1.gameplayPlayAccepted, 5, 'bucket1 gameplayPlayAccepted')
  assertEqual(bucket1.lobbyChatMessages, 3, 'bucket1 lobbyChatMessages')
  assertEqual(bucket1.matchmakingJoin, 1, 'bucket1 matchmakingJoin')
  assertEqual(bucket1.tournamentMatchResult, 1, 'bucket1 tournamentMatchResult')

  const bucket2 = counters.peek()
  assertEqual(bucket2.gameplayPlayAccepted, 0, 'bucket2 starts clean')
  assertEqual(bucket2.lobbyChatMessages, 0, 'bucket2 starts clean')
}

console.log('\n[9] emptyActivityCountersSnapshot — matches shape of a fresh counters instance')
{
  const empty = emptyActivityCountersSnapshot()
  const fresh = createActivityCounters().peek()
  assertEqual(JSON.stringify(empty), JSON.stringify(fresh), 'emptyActivityCountersSnapshot matches fresh counters snapshot shape/values')
}

console.log('\n[10] No unbounded memory growth — repeated increments of the SAME bounded key do not grow object size')
{
  const counters = createActivityCounters()
  for (let i = 0; i < 10_000; i++) {
    counters.incrementWsInbound('submit_bid_action')
  }
  const snap = counters.peek()
  assertEqual(Object.keys(snap.wsInboundByType).length, 1, 'only one key exists after 10k increments of the same type')
  assertEqual(snap.wsInboundByType['submit_bid_action'], 10_000, 'count is accurate')
}

console.log('\n[11] DUAL-WINDOW: a single increment lands in BOTH the 1s and the 10s window simultaneously')
{
  const counters = createActivityCounters()
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('lobbyChatMessages')

  const oneSecond = counters.snapshotOneSecondAndReset()
  assertEqual(oneSecond.lobbyChatMessages, 2, 'oneSecond window sees both increments')

  const tenSecond = counters.peek()
  assertEqual(tenSecond.lobbyChatMessages, 2, 'tenSecond window ALSO sees both increments (independent accumulator, not shared state)')
}

console.log('\n[12] DUAL-WINDOW: resetting the 1s window does NOT reset the 10s window')
{
  const counters = createActivityCounters()
  counters.incrementGame('gameplayBidAccepted')
  counters.incrementGame('gameplayBidAccepted')
  counters.incrementGame('gameplayBidAccepted')

  const oneSecond1 = counters.snapshotOneSecondAndReset()
  assertEqual(oneSecond1.gameplayBidAccepted, 3, 'first 1s snapshot sees all 3 increments')

  const oneSecond2 = counters.snapshotOneSecondAndReset()
  assertEqual(oneSecond2.gameplayBidAccepted, 0, '1s window is reset after its own snapshotOneSecondAndReset()')

  const tenSecond = counters.peek()
  assertEqual(tenSecond.gameplayBidAccepted, 3, '10s window STILL has all 3 — untouched by the 1s reset')
}

console.log('\n[13] DUAL-WINDOW: resetting the 10s window does NOT reset the 1s window')
{
  const counters = createActivityCounters()
  counters.incrementRooms('matchmakingJoin')
  counters.incrementRooms('matchmakingJoin')

  const tenSecond1 = counters.snapshotTenSecondAndReset()
  assertEqual(tenSecond1.matchmakingJoin, 2, 'first 10s snapshot sees both increments')

  const tenSecond2 = counters.snapshotTenSecondAndReset()
  assertEqual(tenSecond2.matchmakingJoin, 0, '10s window is reset after its own snapshotTenSecondAndReset()')

  // Increment happened BEFORE either reset — 1s window should still carry it,
  // since 1s reset was never called.
  const oneSecond = counters.snapshotOneSecondAndReset()
  assertEqual(oneSecond.matchmakingJoin, 2, '1s window STILL has both — untouched by the 10s reset')
}

console.log('\n[14] DUAL-WINDOW: exact spike context regression — activity BEFORE the current 1s window is NOT attributed to a later spike sample')
{
  const counters = createActivityCounters()
  // Simulate activity that happened in a PRIOR completed 1s tick.
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('lobbyChatMessages')
  counters.incrementChat('lobbyChatMessages')
  const priorWindow = counters.snapshotOneSecondAndReset()
  assertEqual(priorWindow.lobbyChatMessages, 3, 'prior window correctly captured its own 3 messages')

  // Nothing happens in the NEXT 1s tick (the "spike" tick) — this simulates
  // a CPU spike sample where NO activity occurred during that exact second.
  const spikeWindow = counters.snapshotOneSecondAndReset()
  assertEqual(spikeWindow.lobbyChatMessages, 0, 'spike-tick window is genuinely empty — the 3 prior messages are NOT re-attributed to it (no false attribution)')
}

console.log('\n[15] DUAL-WINDOW: activity that happens WITHIN the exact 1s window IS correctly attributed to it')
{
  const counters = createActivityCounters()
  counters.snapshotOneSecondAndReset() // clear any residual state from a prior window

  counters.incrementGame('gameplayPlayAccepted')
  counters.incrementGame('gameplayPlayAccepted')
  const spikeWindow = counters.snapshotOneSecondAndReset()
  assertEqual(spikeWindow.gameplayPlayAccepted, 2, 'activity that occurred inside this exact window is correctly captured')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
