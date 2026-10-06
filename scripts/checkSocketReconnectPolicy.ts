/**
 * checkSocketReconnectPolicy.ts
 *
 * Phase 3B.2 (D2) — pure unit + source-review regression за WebSocket
 * close/open reconnect политиката (src/app/network/socketReconnectPolicy.ts,
 * изпълнявана от main.ts onClose/onOpen и offline overlay-я).
 *
 *   [R1] participant / lobby: решенията са ИДЕНТИЧНИ с предишния inline код
 *        в main.ts (exhaustive equivalence matrix, spectator флагове off)
 *   [R2] spectator disconnect -> 'belot-spectator-reconnect' (без forced reload);
 *        offline recovery НЕ насрочва lobby reload за spectator
 *   [R3] spectator reconnect -> 'belot-spectator-rewatch' (re-watch същата маса),
 *        дори ако shouldReloadLobbyOnReconnect е бил сетнат
 *   [R4] spectator reconnect никога не е resume/reload решение; изгубена сесия ->
 *        'belot-spectator-session-lost' (затваря view-а, продължава като lobby)
 *   [R5] source review main.ts: spectator onClose клонът е ПРЕДИ
 *        showOfflineConnectionOverlay; rewatch клонът не вика resume_room/
 *        requestActiveRoomResume/forceOfflineLobbyReload; offline overlay
 *        recovery е gate-нат през shouldOfflineRecoveryForceLobbyReload
 *   [R6] source review main.ts (D8): server-driven termination и manual Exit
 *        teardown-ват activeRoom ПРЕДИ lobby render/navigation
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  decideSocketCloseAction,
  decideSocketOpenAction,
  shouldOfflineRecoveryForceLobbyReload,
} from '../src/app/network/socketReconnectPolicy'

let passed = 0
let failed = 0
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\ncheckSocketReconnectPolicy\n')

// Точно копие на решенията на предишния inline main.ts код (преди 3B.2).
function legacyClose(hasActiveRoom: boolean): string {
  return hasActiveRoom ? 'active-room-reconnect' : 'lobby-reconnect'
}
function legacyOpen(input: { zombie: boolean; shouldReload: boolean; hasActiveRoom: boolean }): string {
  if (input.zombie && input.hasActiveRoom) return 'zombie-bid-resume'
  if (input.shouldReload) return 'forced-lobby-reload'
  if (input.hasActiveRoom) return 'active-room-resume'
  return 'lobby'
}

const bools = [false, true]

await check('[R1] participant/lobby close+open decisions are identical to the legacy inline policy', () => {
  for (const hasActiveRoom of bools) {
    const close = decideSocketCloseAction({ isBelotSpectatorSessionActive: false, hasActiveRoom })
    assert(close === legacyClose(hasActiveRoom), `close hasActiveRoom=${hasActiveRoom}: ${close}`)
    for (const zombie of bools) {
      for (const shouldReload of bools) {
        const open = decideSocketOpenAction({
          isZombieBidReconnectInFlight: zombie,
          isBelotSpectatorReconnectInFlight: false,
          spectatingBelotRoomId: null,
          shouldReloadLobbyOnReconnect: shouldReload,
          hasActiveRoom,
        })
        const expected = legacyOpen({ zombie, shouldReload, hasActiveRoom })
        assert(open === expected, `open zombie=${zombie} reload=${shouldReload} room=${hasActiveRoom}: ${open} !== ${expected}`)
      }
    }
  }
  assert(shouldOfflineRecoveryForceLobbyReload(false) === true, 'non-spectator offline recovery keeps the forced reload')
})

await check('[R2] spectator disconnect -> reconnect without forced lobby reload', () => {
  for (const hasActiveRoom of bools) {
    assert(
      decideSocketCloseAction({ isBelotSpectatorSessionActive: true, hasActiveRoom }) === 'belot-spectator-reconnect',
      `spectator close must not take the reload path (hasActiveRoom=${hasActiveRoom})`,
    )
  }
  assert(shouldOfflineRecoveryForceLobbyReload(true) === false, 'offline recovery must not force a reload for a spectator')
})

await check('[R3] spectator reconnect -> re-watch the same room, even if a reload flag was set', () => {
  for (const shouldReload of bools) {
    for (const hasActiveRoom of bools) {
      const open = decideSocketOpenAction({
        isZombieBidReconnectInFlight: false,
        isBelotSpectatorReconnectInFlight: true,
        spectatingBelotRoomId: 'room-1',
        shouldReloadLobbyOnReconnect: shouldReload,
        hasActiveRoom,
      })
      assert(open === 'belot-spectator-rewatch', `reload=${shouldReload} room=${hasActiveRoom}: ${open}`)
    }
  }
})

await check('[R4] spectator reconnect never resumes/reloads; lost session -> session-lost', () => {
  const lost = decideSocketOpenAction({
    isZombieBidReconnectInFlight: false,
    isBelotSpectatorReconnectInFlight: true,
    spectatingBelotRoomId: null,
    shouldReloadLobbyOnReconnect: true,
    hasActiveRoom: true,
  })
  assert(lost === 'belot-spectator-session-lost', `got ${lost}`)
})

const here = dirname(fileURLToPath(import.meta.url))
const mainSource = await readFile(join(here, '..', 'src', 'main.ts'), 'utf8')
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}
function sliceBetween(source: string, start: string, end: string): string {
  const a = source.indexOf(start)
  assert(a !== -1, `marker not found: ${start}`)
  const b = source.indexOf(end, a + start.length)
  assert(b !== -1, `end marker not found after ${start}: ${end}`)
  return source.slice(a, b)
}

await check('[R5] main.ts wiring: spectator close/open branches bypass forced reload and resume_room', () => {
  const onClose = stripComments(sliceBetween(mainSource, 'onClose: () => {', 'onMessage:'))
  const spectatorCloseAt = onClose.indexOf("closeDecision === 'belot-spectator-reconnect'")
  const overlayAt = onClose.indexOf('showOfflineConnectionOverlay()')
  assert(spectatorCloseAt !== -1 && overlayAt !== -1 && spectatorCloseAt < overlayAt, 'spectator close branch must run before the overlay schedules a reload')
  const spectatorCloseBranch = onClose.slice(spectatorCloseAt, overlayAt)
  assert(!/shouldReloadLobbyOnReconnect\s*=\s*true/.test(spectatorCloseBranch), 'spectator close must not set the reload flag')

  const rewatch = stripComments(sliceBetween(mainSource, "openDecision === 'belot-spectator-rewatch'", "openDecision === 'belot-spectator-session-lost'"))
  assert(!/requestActiveRoomResume|resumeRoom|resume_room|forceOfflineLobbyReload/.test(rewatch), 'rewatch branch must never resume or reload')
  assert(/shouldReloadLobbyOnReconnect\s*=\s*false/.test(rewatch), 'rewatch branch clears the reload flag')

  const overlay = stripComments(sliceBetween(mainSource, 'function initOfflineOverlay()', 'function showLandingOverlay('))
  assert(/shouldOfflineRecoveryForceLobbyReload\(isBelotSpectatorSessionActive\(\)\)/.test(overlay), 'offline overlay recovery must be spectator-gated')
  assert(/addEventListener\('online', handleBrowserOnline\)/.test(overlay), "'online' must go through the spectator-aware handler")
})

await check('[R6] main.ts (D8): activeRoom teardown happens BEFORE the lobby renders/navigates', () => {
  const finishStart = mainSource.indexOf('function finishBelotSpectatorView(')
  assert(finishStart !== -1, 'finishBelotSpectatorView must exist')
  const finish = stripComments(mainSource.slice(finishStart, finishStart + 600))
  const exitAt = finish.indexOf('activeRoom.exitSpectatorView()')
  const lobbyAt = finish.indexOf('lobby.handleServerMessage(message)')
  assert(exitAt !== -1 && lobbyAt !== -1 && exitAt < lobbyAt, 'server-driven termination must exit the view before the lobby handles the message')
  const routing = stripComments(sliceBetween(mainSource, "message.type === 'belot_spectate_ended' || message.type === 'belot_spectate_denied'", 'return'))
  assert(/finishBelotSpectatorView\(message\)/.test(routing), 'ended/denied must route through finishBelotSpectatorView')
  const manualExit = stripComments(sliceBetween(mainSource, 'onSpectatorExitRequested:', '},'))
  const manualExitAt = manualExit.indexOf('activeRoom.exitSpectatorView()')
  const unwatchAt = manualExit.indexOf('unwatchBelotSpectatorRoom()')
  assert(manualExitAt !== -1 && unwatchAt !== -1 && manualExitAt < unwatchAt, 'manual Exit must tear down before navigating')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
