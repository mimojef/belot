/**
 * checkLudoSpectatorAuthorization.ts
 *
 * SECURITY regression за Ludo Spectator Mode Phase 1 (виж task-а "Ludo
 * Spectator Mode Phase 1: backend infrastructure") — доказва, че spectator
 * mode НЕ разчита само на скрити frontend бутони. Директен unit test върху
 * ludoMatchRuntime.ts (mirror на established checkLudoAuthoritativeRuntime.ts
 * стил — реален runtime instance, mock room/state, БЕЗ HTTP/WS/spawn-нат
 * сървър, затова напълно независим от registration secret configuration).
 *
 * Модел: "spectator" = произволен профил, който НИКОГА не е добавен в
 * room.players при match creation — точно това е и реалният spectator през
 * watch_ludo_match (виж index.ts): subscription Map-овете
 * (ludoSpectatorMatchIdByConnectionId/ludoSpectatorsByMatchId) са напълно
 * отделни от ludoMatchRuntime-a и НИКОГА не пипат match.players/
 * profileToMatch. Затова "непознат за runtime-а профил с валиден matchId" е
 * точният, реален security модел на spectator-а от гледна точка на
 * ludoMatchRuntime.ts.
 *
 * Покрива:
 *   [S1] roll()    — spectator/non-participant profileId с валиден matchId
 *                    -> ludo_match_not_participant, match state непроменен
 *   [S2] move()    — същото
 *   [S3] reclaim() — същото
 *   [S4] leave()   — същото (forfeit path)
 *   [S5] Валиден participant продължава да roll-ва нормално (regression
 *        guard — доказва, че security guard-ът не е свръх-рестриктивен)
 *   [S6] Spectator profileId никога не се появява в match.players/
 *        profileToMatch, дори след опит за gameplay action
 *   [S7] Source review: watch_ludo_match/unwatch_ludo_match handler-ите в
 *        index.ts никога не викат createMatch/mutating ludoMatchRuntime
 *        методи — единствения извикан метод е read-only snapshotForMatch()
 *   [S8] Source review: profileToMatch/match.players/validate() в
 *        ludoMatchRuntime.ts са байт-идентични на реда, използван за roll/
 *        move/reclaim/leave — Phase 1 НЕ ги е променил
 *
 * Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLudoMatchRuntime, type LudoMatchSnapshot } from '../src/game/ludoMatchRuntime.js'
import type { LudoRoom } from '../src/game/ludoRoomsStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

console.log('\n=== checkLudoSpectatorAuthorization ===\n')

// ─── Runtime harness (mirror на checkLudoAuthoritativeRuntime.ts) ─────────

let roomSerial = 0
function room(size: 2 | 4): LudoRoom {
  roomSerial += 1
  return {
    id: `room-${roomSerial}`, stake: 100, playerCount: size, manualStart: false,
    hostProfileId: 'p1', createdAt: 1,
    players: Array.from({ length: size }, (_, index) => ({
      connectionId: `c${index + 1}`, profileId: `p${index + 1}`,
      displayName: `Player ${index + 1}`, avatarUrl: null,
    })),
  }
}

// Профил, който НИКОГА не е добавен в room.players — реалният spectator
// security модел (виж doc коментара горе).
const SPECTATOR_PROFILE_ID = 'spectator-profile-never-in-room'

function createScenario() {
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => 4,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  const started = runtime.createMatch(room(2))
  return { runtime, started, snapshots }
}

// ─── [S1]-[S4]: spectator/non-participant отхвърлен за ВСЯКА state-changing команда ───

check('[S1] roll() отхвърля spectator/non-participant с валиден matchId', () => {
  const { runtime, started } = createScenario()
  const result = runtime.roll(started.matchId, SPECTATOR_PROFILE_ID, started.revision)
  assertEqual(result.ok, false, 'roll() трябва да е отхвърлен')
  assert(!result.ok && result.code === 'ludo_match_not_participant', `очакван code=ludo_match_not_participant, получен: ${JSON.stringify(result)}`)
  // Match state-ът е напълно непроменен (validate() reject-ва БЕЗ мутация).
  assertEqual(runtime.getMatch(started.matchId)!.revision, started.revision, 'revision не трябва да напредва след отхвърлен roll')
  runtime.destroy()
})

check('[S2] move() отхвърля spectator/non-participant с валиден matchId', () => {
  const { runtime, started } = createScenario()
  const result = runtime.move(started.matchId, SPECTATOR_PROFILE_ID, started.revision, 0)
  assertEqual(result.ok, false, 'move() трябва да е отхвърлен')
  assert(!result.ok && result.code === 'ludo_match_not_participant', `очакван code=ludo_match_not_participant, получен: ${JSON.stringify(result)}`)
  assertEqual(runtime.getMatch(started.matchId)!.revision, started.revision, 'revision не трябва да напредва след отхвърлен move')
  runtime.destroy()
})

check('[S3] reclaim() отхвърля spectator/non-participant с валиден matchId', () => {
  const { runtime, started } = createScenario()
  const result = runtime.reclaim(started.matchId, SPECTATOR_PROFILE_ID, started.revision)
  assertEqual(result.ok, false, 'reclaim() трябва да е отхвърлен')
  assert(!result.ok && result.code === 'ludo_match_not_participant', `очакван code=ludo_match_not_participant, получен: ${JSON.stringify(result)}`)
  runtime.destroy()
})

check('[S4] leave() (forfeit) отхвърля spectator/non-participant с валиден matchId', () => {
  const { runtime, started } = createScenario()
  const result = runtime.leave(started.matchId, SPECTATOR_PROFILE_ID)
  assertEqual(result.ok, false, 'leave() трябва да е отхвърлен')
  assert(!result.ok && result.code === 'ludo_match_not_participant', `очакван code=ludo_match_not_participant, получен: ${JSON.stringify(result)}`)
  // Match-ът продължава нормално — forfeit опитът на spectator не е засегнал
  // истинските участници (leftColors остава празен).
  assertEqual(runtime.getMatch(started.matchId)!.state.leftColors.length, 0, 'leftColors не трябва да се промени от отхвърлен spectator leave')
  runtime.destroy()
})

// ─── [S5]: валиден participant продължава да работи нормално ─────────────

check('[S5] Валиден participant (p1) продължава да roll-ва нормално (regression guard)', () => {
  const { runtime, started } = createScenario()
  const result = runtime.roll(started.matchId, 'p1', started.revision)
  assertEqual(result.ok, true, 'p1 (реален participant, на ход) трябва да може да хвърли зар')
  runtime.destroy()
})

// ─── [S6]: spectator никога не влиза в match.players/profileToMatch ───────

check('[S6] Spectator profileId никога не се появява в match.players, дори след опит за action', () => {
  const { runtime, started } = createScenario()
  runtime.roll(started.matchId, SPECTATOR_PROFILE_ID, started.revision)
  runtime.move(started.matchId, SPECTATOR_PROFILE_ID, started.revision, 0)
  runtime.reclaim(started.matchId, SPECTATOR_PROFILE_ID, started.revision)
  runtime.leave(started.matchId, SPECTATOR_PROFILE_ID)
  const match = runtime.getMatch(started.matchId)!
  assert(
    !match.players.some((p) => p.profileId === SPECTATOR_PROFILE_ID),
    'spectator profileId не трябва да се появи в match.players след никой от опитите',
  )
  // requestState()/reconnect() за spectator профила също остават null —
  // profileToMatch никога не е получил запис за него.
  assertEqual(runtime.requestState(SPECTATOR_PROFILE_ID), null, 'requestState() за spectator трябва да е null (не е в profileToMatch)')
  assertEqual(runtime.reconnect(SPECTATOR_PROFILE_ID, 'fake-connection'), null, 'reconnect() за spectator трябва да е null (не е в profileToMatch)')
  runtime.destroy()
})

// ─── [S7]-[S8]: source review — Phase 1 не е пипал validation логиката ────

function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const indexSrc = readSourceFile('../src/index.ts')
const runtimeSrc = readSourceFile('../src/game/ludoMatchRuntime.ts')

check('[S7] watch_ludo_match/unwatch_ludo_match handler-ите в index.ts никога не викат createMatch/mutating методи', () => {
  const watchStart = indexSrc.indexOf("if (message.type === 'watch_ludo_match') {")
  assert(watchStart !== -1, 'watch_ludo_match handler трябва да съществува')
  const watchEnd = indexSrc.indexOf("if (message.type === 'unwatch_ludo_match') {")
  assert(watchEnd !== -1, 'unwatch_ludo_match handler трябва да съществува')
  const unwatchStart = watchEnd
  const unwatchEnd = indexSrc.indexOf("if (message.type === 'send_ludo_emoji_reaction') {")
  assert(unwatchEnd !== -1 && unwatchEnd > unwatchStart, 'send_ludo_emoji_reaction handler трябва да съществува след unwatch_ludo_match')

  const watchBody = indexSrc.slice(watchStart, watchEnd)
  const unwatchBody = indexSrc.slice(unwatchStart, unwatchEnd)
  const combined = watchBody + unwatchBody

  for (const forbidden of ['ludoMatchRuntime.createMatch', 'ludoMatchRuntime.roll(', 'ludoMatchRuntime.move(', 'ludoMatchRuntime.reclaim(', 'ludoMatchRuntime.leave(', 'ludoMatchRuntime.reconnect(', 'ludoMatchRuntime.disconnect(', 'ludoMatchRuntime.restoreMatch']) {
    assert(!combined.includes(forbidden), `watch/unwatch handler-ите не трябва да викат ${forbidden} — spectator subscription е чисто read-only`)
  }
  assert(watchBody.includes('ludoMatchRuntime.snapshotForMatch('), 'watch_ludo_match трябва да чете match-а през read-only snapshotForMatch()')
  assert(watchBody.includes('ludoSpectatorMatchIdByConnectionId') && watchBody.includes('ludoSpectatorsByMatchId'), 'watch_ludo_match трябва да пипа само spectator subscription Map-овете, не runtime state')
})

check('[S8] ludoMatchRuntime.ts participant validation (profileToMatch/match.players/validate) е недокоснат от Phase 1', () => {
  // Точните established guard изрази — байт-идентични на текущия production
  // код (виж ludoMatchRuntime.ts:231-240) — доказва, че Phase 1 backend
  // работата не е пипнала нито ред от authorization логиката.
  assert(runtimeSrc.includes("const player = match.players.find((item) => item.profileId === profileId)"), 'validate() participant lookup трябва да остане непроменен')
  assert(runtimeSrc.includes("if (!player) return { ok: false, code: 'ludo_match_not_participant'"), 'validate() non-participant rejection трябва да остане непроменен')
  assert(runtimeSrc.includes('const profileToMatch = new Map<string, string>()'), 'profileToMatch трябва да остане Map<profileId, matchId>, недокоснат')
  // Нито един нов spectator-свързан идентификатор не трябва да прониква в
  // ludoMatchRuntime.ts — цялата spectator инфраструктура живее изключително
  // в index.ts, извън runtime модула.
  assert(!runtimeSrc.includes('spectator') && !runtimeSrc.includes('Spectator'), 'ludoMatchRuntime.ts не трябва да съдържа НИКАКВА spectator-специфична логика (Phase 1 е изцяло извън този файл)')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
