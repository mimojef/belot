/**
 * checkLudoTurnTimeouts.ts
 *
 * Regression test за task-а "Ludo turn timeouts" — ROLL timeout намален от
 * 10s на 5s, MOVE timeout остава 15s (непроменено). Покрива:
 *
 *   [A1] Fresh match — authoritative roll deadline е ТОЧНО
 *        LUDO_SERVER_ROLL_TIMEOUT_MS (5000ms), не стария 10000
 *   [A2] LUDO_SERVER_ROLL_TIMEOUT_MS === 5_000 (explicit value guard)
 *   [A3] LUDO_SERVER_MOVE_TIMEOUT_MS === 15_000 (regression guard — остава
 *        непроменено)
 *   [A4] След успешен roll -> awaiting_move_selection deadline е ТОЧНО
 *        LUDO_SERVER_MOVE_TIMEOUT_MS (15000ms)
 *   [A5] Extra roll след 6 (роля -> move -> turnPhase обратно
 *        waiting_for_roll за СЪЩИЯ цвят) получава ФРЕШ 5000ms roll deadline,
 *        не carry-over от предишния
 *   [A6] Reconnect/resync (reconnect()/requestState()) пази ОСТАВАЩОТО
 *        server време (absolute deadlineAt), не рестартира пълен
 *        5000ms/15000ms timer
 *
 *   [B1] Source review — client-ovият LUDO_ROLL_TIMEOUT_MS
 *        (orchestrator/ludoOrchestratorTypes.ts) е точно 5_000
 *   [B2] Source review — client-ovият LUDO_MOVE_TIMEOUT_MS е точно 15_000
 *
 *   [C1] Cross-check: server LUDO_SERVER_ROLL_TIMEOUT_MS (реален import)
 *        === client LUDO_ROLL_TIMEOUT_MS (source-review extracted) —
 *        динамично сравнение, не два hardcoded очаквани числа, за да
 *        хване бъдещо тихо разминаване, дори ако само единия файл бъде
 *        променен
 *   [C2] Същото за MOVE timeout-а
 *
 *   [D1] Source review — renderLudoPlayerPanel.ts's countdown animation-и
 *        (mobile ring + desktop fill) използват dynamically parametrized
 *        `${turnCountdownMs}ms`, НЕ hardcoded literal ms стойност — доказва,
 *        че визуалната анимация автоматично следва константата, без нужда
 *        от отделна CSS синхронизация
 *
 * Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createLudoMatchRuntime,
  LUDO_SERVER_ROLL_TIMEOUT_MS,
  LUDO_SERVER_MOVE_TIMEOUT_MS,
  type LudoMatchSnapshot,
} from '../src/game/ludoMatchRuntime.js'
import type { LudoGameState } from '../src/game/ludoEngine/ludoEngineTypes.js'
import type { LudoRoom } from '../src/game/ludoRoomsStore.js'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}

// createMatch(room, matchId, precomputed?) изисква matchId ЯВНО (виж
// ludoMatchRuntime.ts) — profileToMatch.set(profileId, match.matchId)
// разчита на реален matchId, за да работи reconnect()/requestState()
// коректно (roll()/move() случайно "работят" дори с matchId===undefined,
// защото caller-ът directno reuse-ва same-undefined стойността от
// createMatch()-овия резултат — известен, отделен, pre-existing test-only
// пропуск в друг check script, недокоснат тук).
let roomSerial = 0
function room(): LudoRoom {
  roomSerial += 1
  return {
    id: `room-${roomSerial}`, stake: 100, playerCount: 2, manualStart: false,
    hostProfileId: 'p1', createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: 'p1', displayName: 'Player 1', avatarUrl: null },
      { connectionId: 'c2', profileId: 'p2', displayName: 'Player 2', avatarUrl: null },
    ],
  }
}
function freshMatchId(): string {
  roomSerial += 1
  return `match-${roomSerial}`
}

// Red вече има едно пионче на track-а (slot 0) — гарантира, че произволен
// не-6 die (тук 3) реално произвежда legal move към 'awaiting_move_
// selection', вместо "всички пионки вкъщи, 3 няма legal move" edge case.
function redOnTrackState(): LudoGameState {
  return {
    turnOrder: ['red', 'yellow'], activeColor: 'red', turnPhase: 'waiting_for_roll', diceValue: null,
    legalMoves: [], status: 'in_progress', winnerColor: null, turnVersion: 0, pendingExtraRoll: false,
    pieces: [
      { color: 'red', slot: 0, position: { kind: 'track', trackIndex: 0 } },
      { color: 'red', slot: 1, position: { kind: 'home', slot: 1 } },
      { color: 'red', slot: 2, position: { kind: 'home', slot: 2 } },
      { color: 'red', slot: 3, position: { kind: 'home', slot: 3 } },
      { color: 'yellow', slot: 0, position: { kind: 'home', slot: 0 } },
      { color: 'yellow', slot: 1, position: { kind: 'home', slot: 1 } },
      { color: 'yellow', slot: 2, position: { kind: 'home', slot: 2 } },
      { color: 'yellow', slot: 3, position: { kind: 'home', slot: 3 } },
    ],
  }
}

console.log('\ncheckLudoTurnTimeouts\n')

// ═══════════════════════════════════════════════════════════════════════
// A1-A6: real server runtime behavior
// ═══════════════════════════════════════════════════════════════════════
console.log('=== A1-A6: server authoritative deadline behavior ===')

check('[A2] LUDO_SERVER_ROLL_TIMEOUT_MS === 5_000', () => {
  assert.equal(LUDO_SERVER_ROLL_TIMEOUT_MS, 5_000)
})

check('[A3] LUDO_SERVER_MOVE_TIMEOUT_MS === 15_000 (непроменено)', () => {
  assert.equal(LUDO_SERVER_MOVE_TIMEOUT_MS, 15_000)
})

check('[A1] Fresh match — roll deadline е точно LUDO_SERVER_ROLL_TIMEOUT_MS (5000ms)', () => {
  let now = 100_000
  const runtime = createLudoMatchRuntime({
    now: () => now,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: () => {},
  })
  const started = runtime.createMatch(room(), freshMatchId())
  assert.equal(started.state.turnPhase, 'waiting_for_roll')
  assert.equal(started.deadlineAt! - started.serverNow, LUDO_SERVER_ROLL_TIMEOUT_MS, 'roll deadline трябва да е точно 5000ms, не старите 10000ms')
  runtime.destroy()
})

check('[A4] След успешен roll -> move deadline е точно LUDO_SERVER_MOVE_TIMEOUT_MS (15000ms)', () => {
  let now = 200_000
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    now: () => now,
    randomDie: () => 3,
    randomTwoPlayerCreatorColor: () => 'red',
    initialStateFactory: () => redOnTrackState(),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  assert.equal(runtime.roll(started.matchId, 'p1', 0).ok, true)
  const afterRoll = snapshots.at(-1)!
  assert.equal(afterRoll.state.turnPhase, 'awaiting_move_selection')
  assert.equal(afterRoll.deadlineAt! - afterRoll.serverNow, LUDO_SERVER_MOVE_TIMEOUT_MS, 'move deadline трябва да е точно 15000ms')
  runtime.destroy()
})

check('[A5] Extra roll след 6 (move -> turnPhase обратно waiting_for_roll за СЪЩИЯ цвят) получава ФРЕШ 5000ms roll deadline', () => {
  let now = 300_000
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    now: () => now,
    randomDie: () => 6,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  assert.equal(runtime.roll(started.matchId, 'p1', 0).ok, true)
  const afterRoll = snapshots.at(-1)!
  assert.equal(afterRoll.state.diceValue, 6)
  // Изтича известно "мислене" време преди move-а — доказва, че следващият
  // roll deadline е ФРЕШ 5000ms от МОМЕНТА на move-а, не carry-over от
  // предишния (вече изтекъл частично) roll deadline.
  now += 4_000
  const legalSlot = afterRoll.state.legalMoves[0]!.slot
  assert.equal(runtime.move(started.matchId, 'p1', afterRoll.revision, legalSlot).ok, true)
  const afterMove = snapshots.at(-1)!
  assert.equal(afterMove.state.activeColor, 'red', 'extra roll след 6 остава за СЪЩИЯ цвят')
  assert.equal(afterMove.state.turnPhase, 'waiting_for_roll', 'extra roll връща turnPhase обратно към waiting_for_roll')
  assert.equal(afterMove.deadlineAt! - afterMove.serverNow, LUDO_SERVER_ROLL_TIMEOUT_MS, 'extra-roll deadline-ът трябва да е ФРЕШ пълен 5000ms, не остатък от предишния')
  runtime.destroy()
})

check('[A6] Reconnect/resync пази ОСТАВАЩОТО server време, не рестартира пълен timer', () => {
  let now = 400_000
  const runtime = createLudoMatchRuntime({
    now: () => now,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: () => {},
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const elapsedMs = 1_700
  now += elapsedMs
  const reconnected = runtime.reconnect('p1', 'new-connection-id')!
  assert.equal(reconnected.deadlineAt, started.deadlineAt, 'reconnect пази СЪЩИЯ absolute deadline (не рестартира)')
  assert.equal(reconnected.deadlineAt! - reconnected.serverNow, LUDO_SERVER_ROLL_TIMEOUT_MS - elapsedMs, 'оставащото време трябва да отразява реално изминалото, не пълен fresh timer')
  const requested = runtime.requestState('p1')!
  assert.equal(requested.deadlineAt! - requested.serverNow, LUDO_SERVER_ROLL_TIMEOUT_MS - elapsedMs, 'requestState() (spectator/resume path) показва СЪЩОТО оставащо време')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// B1-B2, C1-C2, D1: source review (client frontend файлове)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== B1-B2/C1-C2/D1: client source review + cross-check ===')

const projectRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length) ?? resolve(process.cwd(), '..'))
const orchestratorTypesPath = resolve(projectRoot, 'src/app/games/ludo/orchestrator/ludoOrchestratorTypes.ts')
const orchestratorTypesSrc = readFileSync(orchestratorTypesPath, 'utf8')
const playerPanelPath = resolve(projectRoot, 'src/app/games/ludo/pieces/renderLudoPlayerPanel.ts')
const playerPanelSrc = readFileSync(playerPanelPath, 'utf8')

function extractConstMs(src: string, constName: string): number | null {
  const match = new RegExp(`export const ${constName} = ([0-9_]+)`).exec(src)
  if (!match) return null
  return Number(match[1]!.replace(/_/g, ''))
}

const clientRollTimeoutMs = extractConstMs(orchestratorTypesSrc, 'LUDO_ROLL_TIMEOUT_MS')
const clientMoveTimeoutMs = extractConstMs(orchestratorTypesSrc, 'LUDO_MOVE_TIMEOUT_MS')

check('[B1] Client LUDO_ROLL_TIMEOUT_MS === 5_000', () => {
  assert.equal(clientRollTimeoutMs, 5_000)
})

check('[B2] Client LUDO_MOVE_TIMEOUT_MS === 15_000 (непроменено)', () => {
  assert.equal(clientMoveTimeoutMs, 15_000)
})

check('[C1] Server и client ROLL timeout стойностите НЕ са се разминали', () => {
  assert.equal(clientRollTimeoutMs, LUDO_SERVER_ROLL_TIMEOUT_MS, `client=${clientRollTimeoutMs} трябва да съвпада с server=${LUDO_SERVER_ROLL_TIMEOUT_MS}`)
})

check('[C2] Server и client MOVE timeout стойностите НЕ са се разминали', () => {
  assert.equal(clientMoveTimeoutMs, LUDO_SERVER_MOVE_TIMEOUT_MS, `client=${clientMoveTimeoutMs} трябва да съвпада с server=${LUDO_SERVER_MOVE_TIMEOUT_MS}`)
})

check('[D1] renderLudoPlayerPanel.ts countdown animation-ите (ring + fill) използват dynamic ${turnCountdownMs}ms, НЕ hardcoded literal', () => {
  const ringMatch = /animation:ludo-seat-countdown-ring-drain \$\{turnCountdownMs\}ms linear forwards;/.test(playerPanelSrc)
  const fillMatch = /animation:ludo-seat-countdown-drain \$\{turnCountdownMs\}ms linear forwards;/.test(playerPanelSrc)
  assert.ok(ringMatch, 'mobile countdown ring трябва да ползва динамичен ${turnCountdownMs}ms')
  assert.ok(fillMatch, 'desktop countdown fill трябва да ползва динамичен ${turnCountdownMs}ms')
})

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1
