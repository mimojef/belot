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
  const end = controllerSrc.indexOf('\n    }', idx)
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

check('[baseline] createSvaraLobbyController destroy() is pure DOM cleanup too', () => {
  const idx = svaraLobbySrc.indexOf('destroy() { options.root.innerHTML = \'\' }')
  assert(idx !== -1, 'destroy() must be the simple innerHTML-clearing form, with nothing else attached')
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

// ─── Pure behavioral replica — isomorphic mirror of the revision guard ─────

type Harness = {
  lastRevision: { matchId: string; revision: number } | null
  appliedSnapshots: Array<{ matchId: string; revision: number }>
}
function createHarness(): Harness { return { lastRevision: null, appliedSnapshots: [] } }

// Mirror of the `if (message.type === 'svara_match_snapshot')` branch.
function applySnapshot(h: Harness, matchId: string, revision: number): boolean {
  if (h.lastRevision && h.lastRevision.matchId === matchId && h.lastRevision.revision >= revision) return false
  h.lastRevision = { matchId, revision }
  h.appliedSnapshots.push({ matchId, revision })
  return true
}
// Mirror of the `if (message.type === 'svara_table_left')` branch.
function leaveTable(h: Harness): void { h.lastRevision = null }

check('[U1] never overwrites with an equal/older revision for the SAME matchId', () => {
  const h = createHarness()
  assert(applySnapshot(h, 'm1', 1), 'first snapshot must apply')
  assert(applySnapshot(h, 'm1', 2), 'newer revision must apply')
  assert(!applySnapshot(h, 'm1', 2), 'duplicate-resend of the SAME revision must be rejected')
  assert(!applySnapshot(h, 'm1', 1), 'an older revision arriving late must be rejected')
  assertEqual(h.appliedSnapshots.length, 2, 'exactly 2 snapshots should have actually applied')
})

check('[U1] a different matchId is never blocked by another table\'s tracked revision', () => {
  const h = createHarness()
  applySnapshot(h, 'm1', 50)
  assert(applySnapshot(h, 'm2', 1), 'a brand-new table starting at revision 1 must apply even though m1 is tracked at revision 50')
})

check('[U5] leaving resets the guard, so the NEXT snapshot for that matchId is never compared against a stale pre-leave revision', () => {
  const h = createHarness()
  applySnapshot(h, 'm1', 10)
  leaveTable(h)
  // Whatever revision the next commitment to this matchId starts at (the
  // guard makes no assumption either way), it must not be rejected against
  // the revision tracked from BEFORE the leave.
  assert(applySnapshot(h, 'm1', 1), 'the first snapshot after a leave must always apply, regardless of the pre-leave revision')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
