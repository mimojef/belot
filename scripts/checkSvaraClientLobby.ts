// Deterministic unit-ниво проверка на Свара клиентското WebSocket свързване
// (Етап 2Б.3.7.2), без реален сървър/браузър — mirror на established
// checkLudoGamesListRefreshOnReturn.ts стил: source-text baseline проверки
// върху createLobbyFlowController.ts/createSvaraLobbyController.ts +
// isomorphic pure-logic replica на ключовата branching логика, за случаите
// (revision staleness, duplicate-command result, own-table auto-detect),
// които не изискват реален DOM/WS, но трябва да са детерминистично
// верифицирани извън тежкия checkSvaraClientRealIntegration.ts.
//
// Покрива (виж заданието §15):
//   U1. _svaraLastSnapshotRevision guard — никога не презаписва с
//       равна/по-стара ревизия за СЪЩАТА маса; различна маса/по-нова
//       ревизия винаги минава.
//   U2. svara_command_result (duplicate/applied) никога не прескача/чупи
//       dispatch-а — винаги връща true, без допълнителен UI side-effect
//       отвъд diagnostics (source review).
//   U3. closeSvaraLobbyOverlay()/destroy() никога не изпраща
//       leave_svara_table/submit_svara_command — чист DOM cleanup (source
//       review, доказва "без автоматичен exit при unmount").
//   U4. setTables() own-table auto-detect: разпознава собствена
//       чакаща/активна маса от общия списък и request-ва table state само
//       за НЕ-lobby фаза; не презаписва вече съществуваща myTable.
//   U5. svara_table_left занулява revision guard-а (следваща маса със
//       СЪЩОТО matchId не остава блокирана от стар tracked revision).
//   U6. (2Б.3.7.3 REGRESSION, намерена и поправена чрез реална browser QA)
//       snapshot, пристигнал ПРЕДИ controller-ът да се mount-не (автоматичния
//       reconnect push), никога не блокира permanentно идентичен следващ
//       snapshot след mount; unmount/remount цикъл (Демо<->Истинска игра)
//       не оставя новия controller instance "гладен" заради tracked
//       revision от ПРЕДИШНИЯ (вече destroy-нат) instance.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: string): void { failed++; console.error(`  FAIL  ${label}: ${reason}`) }
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err instanceof Error ? err.message : String(err)) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const controllerSrc = readSourceFile('../src/app/lobby/createLobbyFlowController.ts')
const svaraLobbySrc = readSourceFile('../src/app/games/svara/createSvaraLobbyController.ts')

console.log('\n=== checkSvaraClientLobby ===\n')

// ─── Source-text baseline ──────────────────────────────────────────────────

check('[baseline] svara_match_snapshot handler guards with _svaraLastSnapshotRevision BEFORE forwarding to the controller', () => {
  const idx = controllerSrc.indexOf("if (message.type === 'svara_match_snapshot') {")
  assert(idx !== -1, 'svara_match_snapshot handler must exist')
  const end = controllerSrc.indexOf('\n      return true', idx)
  const body = controllerSrc.slice(idx, end)
  assert(body.includes('_svaraLastSnapshotRevision.revision >= message.revision'), 'must reject equal/older revision for the same matchId')
  assert(body.includes('_svaraLastSnapshotRevision.matchId === message.matchId'), 'staleness guard must be scoped per matchId')
  const guardIdx = body.indexOf('_svaraLastSnapshotRevision.revision >= message.revision')
  const forwardIdx = body.indexOf('_svaraLobbyController?.setSnapshot(message)')
  assert(guardIdx !== -1 && forwardIdx !== -1 && guardIdx < forwardIdx, 'staleness check must happen BEFORE forwarding to the controller')
})

check('[baseline] svara_table_left resets the revision guard', () => {
  const idx = controllerSrc.indexOf("if (message.type === 'svara_table_left') {")
  assert(idx !== -1, 'svara_table_left handler must exist')
  const end = controllerSrc.indexOf('\n    }', idx)
  const body = controllerSrc.slice(idx, end)
  assert(body.includes('_svaraLastSnapshotRevision = null'), 'leaving a table must reset the stale-snapshot guard')
  assert(body.includes('_svaraLobbyController?.setMyTable(null)'), 'leaving a table must clear myTable in the controller')
})

check('[baseline] svara_command_result handler always returns true without extra UI side-effects (no bet/gameplay buttons in this sub-stage)', () => {
  const idx = controllerSrc.indexOf("if (message.type === 'svara_command_result') {")
  assert(idx !== -1, 'svara_command_result handler must exist')
  const end = controllerSrc.indexOf('\n    }', idx)
  const body = controllerSrc.slice(idx, end)
  assert(body.includes('return true'), 'must return true (acknowledge the message)')
  assert(!body.includes('_svaraLobbyController?.setMyTable') && !body.includes('_svaraLobbyController?.setSnapshot'), 'svara_command_result must not itself mutate table/snapshot state — that comes from the separate table_updated/match_snapshot pushes')
})

check('[baseline] closeSvaraLobbyOverlay() is pure DOM cleanup — never sends leave_svara_table or any command', () => {
  const idx = controllerSrc.indexOf('function closeSvaraLobbyOverlay(): void {')
  assert(idx !== -1, 'closeSvaraLobbyOverlay must exist')
  const end = controllerSrc.indexOf('\n  }', idx)
  const body = controllerSrc.slice(idx, end)
  assert(!/onSvaraTableLeave|leaveSvaraTable|onLeave/.test(body), 'unmounting the overlay must NEVER trigger a leave command — see task §9 "никога automatic exit"')
  assert(body.includes('_svaraLobbyController?.destroy()') && body.includes('_svaraLobbyController = null'), 'must only destroy the DOM subtree and clear the reference')
})

check('[baseline] createSvaraLobbyController destroy() only releases CLIENT resources (tick interval, fullscreen listener/state) — never sends any command', () => {
  const idx = svaraLobbySrc.indexOf('destroy() {', svaraLobbySrc.indexOf('return {'))
  assert(idx !== -1, 'destroy() must exist on the returned controller object')
  const end = svaraLobbySrc.indexOf('\n    },', idx)
  const body = svaraLobbySrc.slice(idx, end)
  assert(body.includes("options.root.innerHTML = ''"), 'must clear the mounted DOM subtree')
  assert(body.includes('clearInterval(tickTimer)'), 'must stop the countdown-ring tick interval (задание §15 — clean client-resource release on unmount)')
  assert(body.includes("document.removeEventListener('fullscreenchange'"), 'must remove the document-level fullscreenchange listener to avoid leaking it across mount/unmount cycles')
  assert(!/options\.on[A-Z]/.test(body), 'destroy() must never call any options.onXxx callback — unmount releases only client resources, never participation in the server match (задание §15)')
})

check('[baseline] setTables() auto-detects an owned table and requests fresh state only for non-lobby phase', () => {
  const idx = svaraLobbySrc.indexOf('setTables(next: SvaraPublicTable[]) {')
  assert(idx !== -1, 'setTables must exist')
  const end = svaraLobbySrc.indexOf('\n    },', idx)
  const body = svaraLobbySrc.slice(idx, end)
  assert(body.includes('if (myTable === null)'), 'must only auto-detect when no table is already tracked (never silently override an explicit join/leave transition)')
  assert(body.includes("p.status !== 'exited'"), 'must ignore exited seats when detecting own participation')
  assert(body.includes("owned.phase !== 'lobby'") && body.includes('options.onRequestTableState(owned.matchId)'), 'must proactively fetch the match snapshot for a restored non-lobby table instead of waiting for a manual refresh click')
})

check('[baseline] svara_match_snapshot/svara_match_timing are cached UNCONDITIONALLY (_svaraLastSnapshot/_svaraLastTiming), independent of controller mount state (2Б.3.7.3 real-browser QA fix)', () => {
  const snapIdx = controllerSrc.indexOf("if (message.type === 'svara_match_snapshot') {")
  assert(snapIdx !== -1, 'svara_match_snapshot handler must exist')
  const snapEnd = controllerSrc.indexOf('\n      return true', snapIdx)
  const snapBody = controllerSrc.slice(snapIdx, snapEnd)
  assert(snapBody.includes('_svaraLastSnapshot = message'), 'must cache the raw snapshot unconditionally — a later remount replays this cache instead of depending on a fresh round-trip arriving in time')
  assert(snapBody.includes('_svaraLobbyController?.setSnapshot(message)'), 'must still forward (optional chaining) to a currently-mounted controller')

  const timingIdx = controllerSrc.indexOf("if (message.type === 'svara_match_timing') {")
  assert(timingIdx !== -1, 'svara_match_timing handler must exist')
  const timingEnd = controllerSrc.indexOf('\n      return true', timingIdx)
  const timingBody = controllerSrc.slice(timingIdx, timingEnd)
  assert(timingBody.includes('_svaraLastTiming = message'), 'must cache the raw timing unconditionally too')
})

check('[baseline] openSvaraLobbyOverlay() replays the cached snapshot/timing into a freshly mounted controller — doesn\'t wait for a new round-trip', () => {
  const idx = controllerSrc.indexOf('async function openSvaraLobbyOverlay(): Promise<void> {')
  assert(idx !== -1, 'openSvaraLobbyOverlay must exist')
  const end = controllerSrc.indexOf('\n    } finally {', idx)
  const body = controllerSrc.slice(idx, end)
  const constructIdx = body.indexOf('_svaraLobbyController = createSvaraLobbyController({')
  const replaySnapshotIdx = body.indexOf('_svaraLobbyController.setSnapshot(_svaraLastSnapshot)')
  const replayTimingIdx = body.indexOf('_svaraLobbyController.setTiming(_svaraLastTiming)')
  assert(constructIdx !== -1, 'must construct the controller')
  assert(replaySnapshotIdx !== -1 && replaySnapshotIdx > constructIdx, 'must replay the cached snapshot right after construction — this is THE fix for the proven real-browser race: frequent UNRELATED full-root re-renders elsewhere in the giant lobby state force the Svara controller to remount more often than a fresh request_svara_table_state round-trip can complete, permanently starving it of a snapshot without this replay')
  assert(replayTimingIdx !== -1 && replayTimingIdx > constructIdx, 'must replay the cached timing too')
})

check('[baseline] ALL call sites that destroy _svaraLobbyController go through closeSvaraLobbyOverlay() — never a bare .destroy() (2Б.3.7.3 real-browser QA fix: a second, bypassing call site caused the exact same starvation bug)', () => {
  // closeSvaraLobbyOverlay() itself legitimately calls .destroy() once —
  // every OTHER call site in the file must delegate to it instead of
  // duplicating the destroy+null logic (which previously forgot to reset
  // _svaraLastSnapshotRevision, see git history of this file).
  const directDestroyCalls = controllerSrc.match(/_svaraLobbyController\??\.destroy\(\)/g) ?? []
  assertEqual(directDestroyCalls.length, 1, `expected exactly 1 "_svaraLobbyController.destroy()" call site (inside closeSvaraLobbyOverlay itself), found ${directDestroyCalls.length} — a second direct call site (e.g. the reconciliation re-mount guard) must call closeSvaraLobbyOverlay() instead`)
  const idx = controllerSrc.indexOf('function closeSvaraLobbyOverlay(): void {')
  const callIdx = controllerSrc.indexOf('_svaraLobbyController?.destroy()')
  assert(idx !== -1 && callIdx > idx && callIdx < idx + 200, 'the one destroy() call must be inside closeSvaraLobbyOverlay() itself')
  // And the reconciliation re-mount guard must call closeSvaraLobbyOverlay(),
  // not reimplement destroy+null inline (the exact bug this test guards).
  // Two такива guard-а съществуват (Ludo + Свара) — вземаме ПОСЛЕДНИЯ, за
  // да сме сигурни, че проверяваме Svara-специфичния, не Ludo-вия.
  const reconciliationGuardIdx = controllerSrc.lastIndexOf("if (mountRoot && mountRoot.childElementCount === 0) {")
  assert(reconciliationGuardIdx !== -1, 'the Svara re-mount reconciliation guard must exist')
  const reconciliationGuardEnd = controllerSrc.indexOf('\n          }', reconciliationGuardIdx)
  const reconciliationGuardBody = controllerSrc.slice(reconciliationGuardIdx, reconciliationGuardEnd)
  assert(reconciliationGuardBody.includes('closeSvaraLobbyOverlay()'), 'the re-mount guard must delegate to closeSvaraLobbyOverlay() so the revision tracker/cache are reset consistently')
})

check('[baseline] closeSvaraLobbyOverlay() resets the revision tracker AND the cached snapshot/timing for the matched-left table', () => {
  const idx = controllerSrc.indexOf('function closeSvaraLobbyOverlay(): void {')
  const end = controllerSrc.indexOf('\n  }', idx)
  const body = controllerSrc.slice(idx, end)
  assert(body.includes('_svaraLastSnapshotRevision = null'), 'unmounting the controller must reset the tracked revision for the next mount')
})

check('[baseline] svara_table_left clears the snapshot/timing CACHE too, not just the revision tracker — otherwise a future table could replay stale data from the just-left match', () => {
  const idx = controllerSrc.indexOf("if (message.type === 'svara_table_left') {")
  const end = controllerSrc.indexOf('\n    }', idx)
  const body = controllerSrc.slice(idx, end)
  assert(body.includes('_svaraLastSnapshot = null'), 'leaving a table must clear the cached snapshot')
  assert(body.includes('_svaraLastTiming = null'), 'leaving a table must clear the cached timing')
})

check('[baseline] renderSvaraActiveTable.ts defensively verifies snapshot.matchId === table.matchId before using it — never trusts cached/replayed data blindly for the wrong table', () => {
  const activeTableSrc = readSourceFile('../src/app/games/svara/table/renderSvaraActiveTable.ts')
  assert(activeTableSrc.includes('input.snapshot.matchId === table.matchId'), 'must guard snapshot usage against a matchId mismatch (defense-in-depth for the cache/replay mechanism above)')
  assert(activeTableSrc.includes('input.timing.matchId === table.matchId'), 'must guard timing usage against a matchId mismatch too')
})

// ─── Pure behavioral replica — isomorphic mirror of the FINAL cache+replay
// design (2Б.3.7.3). Real-browser QA proved TWO escalating issues with an
// earlier "only track revision when mounted" design: (a) a second, bypassing
// .destroy() call site (the reconciliation re-mount guard) never reset the
// tracker, and (b) — the deeper one — completely UNRELATED full-root
// re-renders elsewhere in the giant lobby state force the Svara controller
// to remount MORE OFTEN than a fresh request_svara_table_state round-trip
// can complete, so depending on a round-trip after every remount starves it
// indefinitely. The fix: cache every snapshot/timing UNCONDITIONALLY
// (independent of mount state) and REPLAY the cache into any freshly
// mounted controller immediately, with no round-trip dependency. ─────────

type Harness = {
  cachedSnapshot: { matchId: string; revision: number } | null // _svaraLastSnapshot
  lastRevision: { matchId: string; revision: number } | null // _svaraLastSnapshotRevision
  controllerMounted: boolean
  appliedToControllerLog: Array<{ matchId: string; revision: number }> // what the live controller actually received via setSnapshot
}
function createHarness(): Harness {
  return { cachedSnapshot: null, lastRevision: null, controllerMounted: false, appliedToControllerLog: [] }
}

// Mirror of the `if (message.type === 'svara_match_snapshot')` branch.
function receiveSnapshot(h: Harness, matchId: string, revision: number): boolean {
  if (h.lastRevision && h.lastRevision.matchId === matchId && h.lastRevision.revision >= revision) return false
  h.cachedSnapshot = { matchId, revision }
  h.lastRevision = { matchId, revision }
  if (h.controllerMounted) h.appliedToControllerLog.push({ matchId, revision })
  return true
}
// Mirror of the `if (message.type === 'svara_table_left')` branch — clears
// BOTH the revision tracker and the cache (a future table must never replay
// data from the just-left match).
function leaveTable(h: Harness): void { h.lastRevision = null; h.cachedSnapshot = null }
// Mirror of closeSvaraLobbyOverlay() — note: the cache is intentionally
// PRESERVED across unmount (only leaveTable/svara_table_left clears it).
function unmountController(h: Harness): void { h.controllerMounted = false; h.lastRevision = null }
// Mirror of openSvaraLobbyOverlay()'s immediate cache replay.
function mountController(h: Harness): void {
  h.controllerMounted = true
  if (h.cachedSnapshot) {
    h.lastRevision = { ...h.cachedSnapshot }
    h.appliedToControllerLog.push({ ...h.cachedSnapshot })
  }
}

check('[U1] never overwrites with an equal/older revision for the SAME matchId', () => {
  const h = createHarness()
  mountController(h)
  assert(receiveSnapshot(h, 'm1', 1), 'first snapshot must apply')
  assert(receiveSnapshot(h, 'm1', 2), 'newer revision must apply')
  assert(!receiveSnapshot(h, 'm1', 2), 'duplicate-resend of the SAME revision must be rejected')
  assert(!receiveSnapshot(h, 'm1', 1), 'an older revision arriving late must be rejected')
  assertEqual(h.appliedToControllerLog.length, 2, 'exactly 2 snapshots should have actually reached the controller')
})

check('[U1] a different matchId is never blocked by another table\'s tracked revision', () => {
  const h = createHarness()
  mountController(h)
  receiveSnapshot(h, 'm1', 50)
  assert(receiveSnapshot(h, 'm2', 1), 'a brand-new table starting at revision 1 must apply even though m1 is tracked at revision 50')
})

check('[U5] leaving resets the guard AND the cache, so the NEXT snapshot for that matchId is never compared against — or confused with — stale pre-leave data', () => {
  const h = createHarness()
  mountController(h)
  receiveSnapshot(h, 'm1', 10)
  leaveTable(h)
  assertEqual(h.cachedSnapshot, null, 'cache must be cleared on leave')
  // Whatever revision the next commitment to this matchId starts at (the
  // guard makes no assumption either way), it must not be rejected against
  // the revision tracked from BEFORE the leave.
  assert(receiveSnapshot(h, 'm1', 1), 'the first snapshot after a leave must always apply, regardless of the pre-leave revision')
})

check('[U6] REGRESSION (2Б.3.7.3 real-browser QA find): a snapshot arriving BEFORE the controller mounts (automatic reconnect push) is cached and REPLAYED the instant the controller mounts — no dependency on a fresh round-trip', () => {
  const h = createHarness()
  // Automatic svaraLobby.reconnect() push arrives immediately on connect,
  // often BEFORE the controller's dynamic import() has resolved.
  const appliedBeforeMount = receiveSnapshot(h, 'm1', 5)
  assert(appliedBeforeMount, 'receiveSnapshot itself still succeeds (caches it) even though nothing is mounted yet')
  assertEqual(h.appliedToControllerLog.length, 0, 'nothing should have reached a live controller yet — none is mounted')

  // Controller mounts: must replay the cache IMMEDIATELY, with no new
  // message needing to arrive at all.
  mountController(h)
  assertEqual(h.appliedToControllerLog.length, 1, 'mounting must immediately replay the cached snapshot into the controller — this is the exact bug: the old design waited for a fresh round-trip, which a SECOND remount (before the round-trip resolved) could starve indefinitely')
  assertEqual(JSON.stringify(h.appliedToControllerLog[0]), JSON.stringify({ matchId: 'm1', revision: 5 }), 'the replayed data must match the cached snapshot exactly')
})

check('[U6] REGRESSION: repeated remount cycles with NO new incoming snapshot (e.g. frequent unrelated full-root re-renders force-remounting the Svara controller) still always leave the LATEST controller instance correctly populated', () => {
  const h = createHarness()
  mountController(h)
  receiveSnapshot(h, 'm1', 9)
  assertEqual(h.appliedToControllerLog.length, 1, 'sanity: first snapshot applied')
  // Simulate several rapid unmount/remount cycles with no new snapshot
  // arriving in between (exactly what an unrelated-re-render storm does).
  for (let i = 0; i < 5; i += 1) {
    unmountController(h)
    mountController(h)
  }
  assertEqual(h.appliedToControllerLog.length, 6, 'each of the 5 remounts must replay the cache again (1 initial + 5 remounts), never leaving a controller instance without the data')
  assertEqual(JSON.stringify(h.lastRevision), JSON.stringify({ matchId: 'm1', revision: 9 }), 'the tracked revision must still correctly reflect the cached snapshot after the churn')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
