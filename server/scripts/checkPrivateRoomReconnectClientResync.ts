/**
 * checkPrivateRoomReconnectClientResync.ts
 *
 * Source-level regression check за клиентската половина на private-room
 * reconnect race поправката (виж checkPrivateRoomReconnectRaceGuard.ts за
 * server-side поведението).
 *
 * Браузърният WebSocket `onOpen` reconnect flow (src/main.ts) не може да се
 * изпълни от Node-only WS тест — тук е нужен реален браузър. Затова
 * поправката се проверява на source ниво, по същия установен модел като
 * checkGiftLimitFrontend.ts checks [10]-[13]:
 *
 *  [1] createLobbyFlowController.ts излага resyncPrivateRoomMembership в
 *      публичния controller interface.
 *  [2] имплементацията ѝ извиква options.onPrivateRoomsOpen?.() (единственият
 *      познат тригер за server-side reconnectMember(), виж request_private_
 *      rooms_list handler-а в server/src/index.ts) — БЕЗУСЛОВНО (виж task
 *      spec "Изчакай в лоби" §9: reload/reconnect трябва да възстанови
 *      membership-а дори когато state.myPrivateRoom вече е null in-memory
 *      след hard refresh, затова гейт-а върху него беше премахнат нарочно).
 *  [3] main.ts WS onOpen handler-ът реално вика lobby.resyncPrivateRoomMembership()
 *      — не само дефинирана, но и wired-ната функция.
 *  [4] извикването е в SAME branch като forceLobbyChatResubscribeIfOnLobbyScreen()
 *      (т.е. само след успешен reconnect към чист/lobby state, не по време
 *      на activeRoom resume и не на _isResetPasswordPath) — не дублира и не
 *      противоречи на съществуващия activeRoom.hasActiveRoom() / lobby chat
 *      resubscribe контракт.
 *  [5] resyncPrivateRoomMembership() се появява ПРЕДИ requestPwaUpdateApplyAttempt()
 *      (запазва реда на onOpen ефектите, без да го чупи).
 *  [6] private_room_updated handler-ът, който получава сървърния отговор на
 *      този resync, НЕ прехвърля насила екрана към чакалнята за пасивен
 *      resync (само за explicit create/join/invite-accept тази сесия) — виж
 *      checkPrivateRoomWaitInLobby.ts checks [8a]-[8c] за пълната проверка.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

console.log('\ncheckPrivateRoomReconnectClientResync\n')

function readSourceNormalized(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

const controllerSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'),
)
const mainSrc = readSourceNormalized(resolve(PROJECT_ROOT, 'src/main.ts'))

// [1] Public interface exposes the method.
check(
  '[1] LobbyFlowController interface declares resyncPrivateRoomMembership: () => void',
  /resyncPrivateRoomMembership:\s*\(\)\s*=>\s*void/.test(controllerSrc),
)

// [2] Implementation: unconditional, calls onPrivateRoomsOpen.
const implMatch = controllerSrc.match(
  /function resyncPrivateRoomMembership\(\)[^{]*\{([\s\S]*?)\n  \}/,
)
check('[2a] resyncPrivateRoomMembership() implementation exists', implMatch !== null)
if (implMatch !== null) {
  const body = implMatch[1]
  check(
    '[2b] implementation is UNCONDITIONAL — no state.myPrivateRoom gate (hard refresh loses that in-memory flag entirely, so gating on it would defeat reload recovery)',
    !/state\.myPrivateRoom\s*!==\s*null/.test(body) && !/if\s*\(/.test(body),
  )
  check(
    '[2c] implementation calls options.onPrivateRoomsOpen?.() — the same production trigger request_private_rooms_list uses',
    /options\.onPrivateRoomsOpen\?\.\(\)/.test(body),
  )
}

// The function must also be returned from the controller factory so callers
// in main.ts can actually reach it (declaring it privately would silently
// no-op from the outside).
check(
  '[2d] resyncPrivateRoomMembership is returned from the controller factory (reachable from main.ts, not just declared internally)',
  /return\s*\{[\s\S]*?resyncPrivateRoomMembership,[\s\S]*?\}/.test(controllerSrc) ||
    /^\s*resyncPrivateRoomMembership,\s*$/m.test(controllerSrc),
)

// [3]+[4]+[5] main.ts onOpen wiring.
const onOpenMatch = mainSrc.match(/onOpen:\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \},\n  onClose:/)
check('[3a] main.ts createGameServerClient onOpen handler located', onOpenMatch !== null)

if (onOpenMatch !== null) {
  const onOpenBody = onOpenMatch[1]

  check(
    '[3b] onOpen calls lobby.resyncPrivateRoomMembership()',
    /lobby\.resyncPrivateRoomMembership\(\)/.test(onOpenBody),
  )

  const forceResubIdx = onOpenBody.indexOf('lobby.forceLobbyChatResubscribeIfOnLobbyScreen()')
  const resyncIdx = onOpenBody.indexOf('lobby.resyncPrivateRoomMembership()')
  const pwaApplyIdx = onOpenBody.indexOf('requestPwaUpdateApplyAttempt()')

  check(
    '[4] resync call sits in the same "clean reconnect" branch as forceLobbyChatResubscribeIfOnLobbyScreen (after activeRoom.hasActiveRoom() early-return, inside the same !_isResetPasswordPath block)',
    forceResubIdx !== -1 && resyncIdx !== -1 && resyncIdx > forceResubIdx,
  )

  check(
    '[5] resync call happens before requestPwaUpdateApplyAttempt() (onOpen effect ordering preserved)',
    resyncIdx !== -1 && pwaApplyIdx !== -1 && resyncIdx < pwaApplyIdx,
  )

  // Guard against accidentally placing the call inside the activeRoom.hasActiveRoom()
  // early-return branch, which would wrongly fire it during active-game resume.
  const activeRoomBranchMatch = onOpenBody.match(
    /if \(activeRoom\.hasActiveRoom\(\)\) \{([\s\S]*?)\n {4}\}/,
  )
  check(
    '[6] resync call is NOT inside the activeRoom.hasActiveRoom() resume branch (must not fire during active-game reconnect)',
    activeRoomBranchMatch !== null &&
      !activeRoomBranchMatch[1].includes('resyncPrivateRoomMembership'),
  )
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
