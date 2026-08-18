/**
 * checkLafcheClientCapMath.ts
 *
 * EMERGENCY hotfix — минимален, бърз (без DB/browser dependency) numeric
 * proof на client-side cap алгоритъма, wired в createLobbyFlowController.ts
 * (capLafcheMessagesIfNeeded) / renderTopicsScreen.ts (renderTopicMessageStream
 * slice) / renderLobbyScreen.ts (appendTopicMessageNode eviction) — и трите
 * следват ТОЧНО тази последователност: sort newest-first (mirror на
 * sortTopicMessagesByActivity comparator-а, статично проверен в
 * checkLafcheNoOlderPagination.ts [F]) → `.slice(0, LIMIT)`. Тук доказваме
 * самата аритметика с >200 synthetic messages: резултатът никога не
 * надвишава LIMIT, и запазените ids са ТОЧНО newest N (по activity, после
 * seq tie-break) — не произволен range.
 *
 * Не спавва сървър/browser/DB — чист in-memory unit proof, за скорост
 * (emergency deploy prioritization).
 */

const LAFCHE_MESSAGE_HISTORY_LIMIT = 200

type SyntheticMessage = { messageId: string; lastActivityAt: number; seq: number }

// Mirror на createLobbyFlowController.ts sortTopicMessagesByActivity
// comparator-а (b - a, descending/newest-first, seq tie-break).
function sortNewestFirst(messages: SyntheticMessage[]): SyntheticMessage[] {
  return [...messages].sort((a, b) => {
    const delta = b.lastActivityAt - a.lastActivityAt
    if (delta !== 0) return delta
    return b.seq - a.seq
  })
}

// Mirror на capLafcheMessagesIfNeeded/renderTopicMessageStream slice логиката.
function capToLimit(messages: SyntheticMessage[]): SyntheticMessage[] {
  const sorted = sortNewestFirst(messages)
  return sorted.length > LAFCHE_MESSAGE_HISTORY_LIMIT ? sorted.slice(0, LAFCHE_MESSAGE_HISTORY_LIMIT) : sorted
}

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

console.log('\n=== Lafche client cap math (emergency hotfix, LIMIT=200) ===\n')

// 250 synthetic messages, seq 0..249, lastActivityAt monotonic increasing
// (по-висок seq = по-нова активност) — mirror на реалния insertion/activity
// ред в production.
const synthetic: SyntheticMessage[] = Array.from({ length: 250 }, (_, i) => ({
  messageId: `msg-${i}`,
  lastActivityAt: 1_000_000 + i,
  seq: i,
}))

const capped = capToLimit(synthetic)

check('[1] >200 input (250) → state <= 200 след cap', () => {
  assert(capped.length <= LAFCHE_MESSAGE_HISTORY_LIMIT, `expected <= ${LAFCHE_MESSAGE_HISTORY_LIMIT}, got ${capped.length}`)
  assert(capped.length === LAFCHE_MESSAGE_HISTORY_LIMIT, `expected exactly ${LAFCHE_MESSAGE_HISTORY_LIMIT} (250 > limit case), got ${capped.length}`)
})

check('[2] Newest 200 запазени (msg-50..msg-249, seq DESC), oldest 50 (msg-0..msg-49) отрязани', () => {
  const cappedIds = new Set(capped.map((m) => m.messageId))
  for (let i = 50; i < 250; i++) {
    assert(cappedIds.has(`msg-${i}`), `newest message msg-${i} трябва да е retained`)
  }
  for (let i = 0; i < 50; i++) {
    assert(!cappedIds.has(`msg-${i}`), `oldest message msg-${i} трябва да е cut`)
  }
})

check('[3] Резултатът е реално newest-first подреден (index 0 = msg-249, най-новото)', () => {
  assert(capped[0]!.messageId === 'msg-249', `expected capped[0] to be msg-249 (newest), got ${capped[0]!.messageId}`)
  assert(capped[capped.length - 1]!.messageId === 'msg-50', `expected last retained to be msg-50 (200th newest), got ${capped[capped.length - 1]!.messageId}`)
})

check('[4] Точно на границата (200 input) → без cutting, всички 200 запазени', () => {
  const exact = Array.from({ length: 200 }, (_, i) => ({ messageId: `e-${i}`, lastActivityAt: i, seq: i }))
  const result = capToLimit(exact)
  assert(result.length === 200, `expected exactly 200, got ${result.length}`)
})

check('[5] Под лимита (150 input) → без cutting, всички 150 запазени', () => {
  const under = Array.from({ length: 150 }, (_, i) => ({ messageId: `u-${i}`, lastActivityAt: i, seq: i }))
  const result = capToLimit(under)
  assert(result.length === 150, `expected exactly 150 (no cutting under limit), got ${result.length}`)
})

check('[6] Simulated realtime append (201-во single-message merge отгоре на 200 вече cap-нати) — новото се появява, старото пада', () => {
  const base = capToLimit(synthetic) // вече 200, newest msg-50..msg-249
  const withNew = capToLimit([...base, { messageId: 'msg-new', lastActivityAt: 2_000_000, seq: 999 }])
  assert(withNew.length === 200, `expected still exactly 200 after +1 realtime merge, got ${withNew.length}`)
  assert(withNew.some((m) => m.messageId === 'msg-new'), 'the new realtime message must be present')
  assert(!withNew.some((m) => m.messageId === 'msg-50'), 'the previously-oldest-retained message (msg-50) must now be evicted to make room')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
