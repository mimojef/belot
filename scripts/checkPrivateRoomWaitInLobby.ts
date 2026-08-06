/**
 * checkPrivateRoomWaitInLobby.ts
 *
 * Source-level regression checks за "Изчакай в лоби" функционалността
 * (потребител в чакаща частна маса се връща в лобито БЕЗ да напуска масата).
 * Jsdom не е налична зависимост в проекта — следвайки установения стил
 * (checkGiftNotificationModalFix.ts, checkPlayingHandCardIdentityFix.ts),
 * реалният source се проверява текстово/структурно.
 *
 * КОРЕКЦИЯ: първоначалната имплементация показваше глобална, постоянна
 * "Чакаш в частна маса — N/4" лента (src/ui/notifications/
 * privateRoomWaitingStrip.ts) — ръчният тест показа, че тя пречи (закрива
 * live chat и на desktop, и на mobile) и беше премахната ИЗЦЯЛО. Новото
 * поведение: НИКАКВО глобално известие — вместо това, натискането на
 * "Частни маси" (единен navigation handler — navigateToPrivateRooms(),
 * споделен от desktop/mobile lobby картата и всеки external caller) отваря
 * директно текущата чакалня, ако потребителят вече е неин член.
 *
 * Покрива 12-те насочени сценария от коригирания task spec:
 *  [1]  "Изчакай в лоби" не изпраща leave_private_room.
 *  [2]  След него state.myPrivateRoom остава (membership непроменен).
 *  [3]  В DOM/source-а няма private-room waiting strip — нито desktop, нито
 *       mobile вариант.
 *  [4]  Няма fixed waiting елемент (нито в main.ts, нито другаде), който
 *       може да закрива desktop или mobile live chat.
 *  [5]  При myPrivateRoom !== null "Частни маси" отваря direct
 *       private-room-waiting (не списъка).
 *  [6]  Не се изпраща повторен join/create при "Частни маси" → чакалня.
 *  [7]  При myPrivateRoom === null "Частни маси" отваря нормалния списък
 *       (непроменено старо поведение).
 *  [8]  Възстановеното след reconnect membership (state.myPrivateRoom) се
 *       използва директно от "Частни маси" — без допълнителна client-side
 *       "резервация" или отделен flag.
 *  [9]  Conflict popup → "Върни се" отваря чакалнята, без повторен join.
 *  [10] private_room_full стартира активната игра — глобален dispatcher,
 *       работи независимо от текущия SPA екран ("lobby" включително).
 *  [11] expired/closed/left изчистват state.myPrivateRoom.
 *  [12] Поведението е идентично за desktop и mobile — единствен
 *       navigation handler, единствен DOM selector, wire-нат веднъж.
 *
 * Плюс запазени conflict-guard проверки (matchmaking / join-друга-маса /
 * create-друга-маса / invite-accept, докато вече чакаш) от
 * предишната версия — непроменени от тази корекция.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

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

function readSourceNormalized(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path, 'utf8')
    return true
  } catch {
    return false
  }
}

console.log('\ncheckPrivateRoomWaitInLobby\n')

const controllerSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'),
)
const waitingScreenSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/lobby/renderPrivateRoomWaitingScreen.ts'),
)
const lobbyScreenSrc = readSourceNormalized(
  resolve(PROJECT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'),
)
const mainSrc = readSourceNormalized(resolve(PROJECT_ROOT, 'src/main.ts'))

// ─── [1]+[2] "Изчакай в лоби" button handler ────────────────────────────────

const waitInLobbyHandlerMatch = controllerSrc.match(
  /\[data-private-waiting-wait-in-lobby-button="1"\]'\)\s*\n\s*\?\.addEventListener\('click', \(\) => \{([\s\S]*?)\n {6}\}\)/,
)
check('[setup] "Изчакай в лоби" click handler located', waitInLobbyHandlerMatch !== null)

if (waitInLobbyHandlerMatch !== null) {
  const body = waitInLobbyHandlerMatch[1]
  check(
    '[1] "Изчакай в лоби" handler does NOT call options.onPrivateRoomLeave (no leave/cancel command sent)',
    !/options\.onPrivateRoomLeave/.test(body),
  )
  check(
    '[1b] "Изчакай в лоби" handler does not reference leave_private_room anywhere in its body',
    !/leave_private_room/.test(body),
  )
  check(
    '[2] "Изчакай в лоби" handler does NOT clear state.myPrivateRoom (membership preserved across navigation)',
    !/state\.myPrivateRoom\s*=\s*null/.test(body),
  )
  check(
    '[2b] "Изчакай в лоби" handler navigates by setting state.currentScreen = \'lobby\'',
    /state\.currentScreen\s*=\s*'lobby'/.test(body),
  )
  check(
    '[2c] "Изчакай в лоби" handler stops the waiting-screen countdown/chat lifecycle via the existing leavePrivateRoomWaitingScreen() helper (reused, not duplicated)',
    /leavePrivateRoomWaitingScreen\(\)/.test(body),
  )
}

// The button itself must exist in the waiting-screen markup, alongside
// (not replacing) the existing "Напусни" button.
check(
  '[1c] renderPrivateRoomWaitingScreen.ts renders a "Изчакай в лоби" button (data-private-waiting-wait-in-lobby-button)',
  /data-private-waiting-wait-in-lobby-button="1"[^>]*>Изчакай в лоби</.test(waitingScreenSrc),
)
check(
  '[setup] "Напусни" button still present, unchanged label',
  /data-private-waiting-leave-button="1"[^>]*>Напусни</.test(waitingScreenSrc),
)

// ─── [3] No waiting strip anywhere — desktop or mobile ──────────────────────

check(
  '[3a] src/ui/notifications/privateRoomWaitingStrip.ts no longer exists',
  !fileExists(resolve(PROJECT_ROOT, 'src/ui/notifications/privateRoomWaitingStrip.ts')),
)
check(
  '[3b] no source file anywhere references privateRoomWaitingStrip / createPrivateRoomWaitingStrip',
  !/privateRoomWaitingStrip|createPrivateRoomWaitingStrip/.test(controllerSrc) &&
    !/privateRoomWaitingStrip|createPrivateRoomWaitingStrip/.test(mainSrc) &&
    !/privateRoomWaitingStrip|createPrivateRoomWaitingStrip/.test(lobbyScreenSrc) &&
    !/privateRoomWaitingStrip|createPrivateRoomWaitingStrip/.test(waitingScreenSrc),
)
check(
  '[3c] the strip-only callback option (onPrivateRoomWaitingStateChange) no longer exists anywhere',
  !/onPrivateRoomWaitingStateChange/.test(controllerSrc) && !/onPrivateRoomWaitingStateChange/.test(mainSrc),
)
check(
  '[3d] the strip-only sync helper (syncPrivateRoomWaitingStrip) no longer exists',
  !/syncPrivateRoomWaitingStrip/.test(controllerSrc),
)

// ─── [4] No fixed global waiting element anywhere (desktop or mobile) ──────

check(
  '[4a] main.ts no longer creates a "global-private-room-waiting-strip" container (the one position:fixed element that could sit over live chat)',
  !/global-private-room-waiting-strip/.test(mainSrc),
)
check(
  '[4b] main.ts no longer mounts/unmounts anything private-room-waiting-strip related (no leftover container variable, no orphaned onReturnClick wiring)',
  !/privateRoomWaitingStripContainer/.test(mainSrc),
)
check(
  '[4c] render()/private_room_full no longer carry an explicit strip-notify call (the one-off exception that used to bypass render())',
  !/onPrivateRoomWaitingStateChange\?\.\(null\)/.test(controllerSrc),
)

// ─── [5]+[6]+[7] Unified "Частни маси" navigation handler ──────────────────

const navigateFnMatch = controllerSrc.match(
  /function navigateToPrivateRooms\(\): void \{([\s\S]*?)\n {2}\}/,
)
check('[setup] navigateToPrivateRooms() implementation located', navigateFnMatch !== null)

if (navigateFnMatch !== null) {
  const body = navigateFnMatch[1]
  check(
    '[5] navigateToPrivateRooms() opens the waiting room directly (delegates to returnToPrivateRoomWaiting()) when state.myPrivateRoom !== null — not the list',
    /if \(state\.myPrivateRoom !== null\) \{\s*\n\s*returnToPrivateRoomWaiting\(\)\s*\n\s*return\s*\n\s*\}/.test(body),
  )
  check(
    '[6] the myPrivateRoom !== null branch does NOT call onPrivateRoomJoin/onPrivateRoomCreate (no re-join, no duplicate membership) — it returns before reaching the list-open logic below',
    /returnToPrivateRoomWaiting\(\)\s*\n\s*return\s*\n\s*\}\s*\n\s*state\.currentScreen = 'private-rooms'/.test(body),
  )
  check(
    '[7] when state.myPrivateRoom === null, navigateToPrivateRooms() falls through to the ORIGINAL list-open behavior (currentScreen=\'private-rooms\', privateRoomsTab=\'all\', options.onPrivateRoomsOpen)',
    /state\.currentScreen = 'private-rooms'/.test(body) &&
      /state\.privateRoomsTab = 'all'/.test(body) &&
      /options\.onPrivateRoomsOpen\?\.\(\)/.test(body),
  )
}

const returnFnMatch = controllerSrc.match(
  /function returnToPrivateRoomWaiting\(\): void \{([\s\S]*?)\n {2}\}/,
)
check('[setup] returnToPrivateRoomWaiting() implementation located', returnFnMatch !== null)
if (returnFnMatch !== null) {
  const body = returnFnMatch[1]
  check(
    '[6b] returnToPrivateRoomWaiting() itself never calls onPrivateRoomJoin/onPrivateRoomCreate either (belt-and-suspenders: no re-join no matter which function is inspected)',
    !/onPrivateRoomJoin/.test(body) && !/onPrivateRoomCreate/.test(body),
  )
}

// ─── [12] Single handler, single DOM entry point — same for desktop+mobile ─

check(
  '[12a] exactly ONE "Частни маси" DOM selector (data-lobby-private-rooms-card) is wired to a click listener — desktop and mobile render branches share the identical attribute, so this one wiring covers both',
  (controllerSrc.match(/data-lobby-private-rooms-card="1"'\)/g) ?? []).length === 0 &&
    /data-lobby-private-rooms-card="1"\]'\)\s*\n\s*\?\.addEventListener\('click', options\.onPrivateRoomsOpen\)/.test(lobbyScreenSrc),
)
check(
  '[12b] the desktop card markup uses data-lobby-private-rooms-card="1"',
  /data-lobby-private-rooms-card="1" style="/.test(lobbyScreenSrc),
)
check(
  '[12c] the mobile card markup uses the SAME data-lobby-private-rooms-card="1" attribute (not a separate selector needing its own guard)',
  /<button type="button" data-lobby-private-rooms-card="1"/.test(lobbyScreenSrc),
)
check(
  '[12d] the internal onPrivateRoomsOpen handler (fired by that one click wiring) delegates to the single navigateToPrivateRooms() function — no duplicated inline logic to keep in sync',
  /onPrivateRoomsOpen: \(\) => navigateToPrivateRooms\(\)/.test(controllerSrc),
)
check(
  '[12e] the externally-exposed public method (used by e.g. the private-room-created notification\'s "enter private rooms" action) is the SAME function, not a second implementation',
  /navigateToPrivateRooms,\n/.test(controllerSrc) &&
    (controllerSrc.match(/function navigateToPrivateRooms\(\): void/g) ?? []).length === 1,
)
check(
  '[12f] main.ts\'s "enter private rooms" caller (private-room-created notification) goes through the same public navigateToPrivateRooms(), unaffected by this change',
  /onEnterPrivateRooms: \(\) => \{\s*\n\s*lobby\?\.navigateToPrivateRooms\(\)\s*\n\s*\}/.test(mainSrc),
)

// ─── [8] Reload/reconnect membership feeds the SAME handler ────────────────

check(
  '[8a] private_room_updated only force-navigates to the waiting screen when isNewRoom && privateRoomJoinInFlight (an explicit create/join this session) — a passive reconnect resync must NOT yank the user off their current screen and must NOT show any notification (none exists anymore)',
  /const shouldForceWaitingScreen = isNewRoom && state\.privateRoomJoinInFlight/.test(controllerSrc),
)
check(
  '[8b] regardless of shouldForceWaitingScreen, private_room_updated ALWAYS assigns state.myPrivateRoom = message.room — so a passive reconnect resync still updates the value navigateToPrivateRooms() reads',
  /state\.myPrivateRoom = message\.room/.test(controllerSrc),
)
check(
  '[8c] resyncPrivateRoomMembership() (the reconnect/reload trigger — see checkPrivateRoomReconnectClientResync.ts) is unconditional, so it also works right after a hard refresh when state.myPrivateRoom is still null in-memory',
  /function resyncPrivateRoomMembership\(\): void \{\s*\n\s*options\.onPrivateRoomsOpen\?\.\(\)\s*\n\s*\}/.test(controllerSrc),
)
check(
  '[8d] navigateToPrivateRooms() reads state.myPrivateRoom fresh on every call (no separate cached/duplicated "am I waiting" flag to keep in sync with reconnect)',
  navigateFnMatch !== null && /if \(state\.myPrivateRoom !== null\)/.test(navigateFnMatch[1]),
)

// ─── [9] Conflict popup → "Върни се" opens the waiting room, no re-join ────

check(
  '[9] the conflict popup\'s return button is wired to onPrivateRoomConflictReturnClick, which calls returnToPrivateRoomWaiting() (not a fresh join)',
  /onPrivateRoomConflictReturnClick: \(\) => \{\s*\n\s*state\.privateRoomConflictPromptOpen = false\s*\n\s*returnToPrivateRoomWaiting\(\)/.test(controllerSrc),
)
check(
  '[9b] the conflict popup shows the exact required copy "Вече чакаш в частна маса." with a "Върни се" button',
  /Вече чакаш в частна маса\.<\/div>/.test(lobbyScreenSrc) &&
    />Върни се<\/button>/.test(lobbyScreenSrc),
)

// ─── [10] private_room_full starts the active game from any screen ────────

check(
  '[10a] main.ts dispatches lobby.handleServerMessage unconditionally (not gated on lobby\'s internal currentScreen) — private_room_full reaches the handler no matter which SPA screen (players/leaderboards/shop/lobby) is currently visible',
  /if \(!activeRoom\.hasActiveRoom\(\) && !_isResetPasswordPath\) \{\s*\n\s*lobby\.handleServerMessage\(message\)\s*\n\s*\}/.test(mainSrc),
)
check(
  '[10b] private_room_full handler calls options.onMatchFound unconditionally on screen (auto-transfer works from any screen, including \'lobby\' reached via "Изчакай в лоби")',
  /if \(message\.type === 'private_room_full'\) \{[\s\S]{0,700}options\.onMatchFound\(\{/.test(controllerSrc),
)

// ─── [11] expired/closed/left clear state.myPrivateRoom ────────────────────

check(
  '[11a] private_room_left clears state.myPrivateRoom',
  /if \(message\.type === 'private_room_left'\) \{[\s\S]{0,120}state\.myPrivateRoom = null/.test(controllerSrc),
)
check(
  '[11b] private_room_expired clears state.myPrivateRoom',
  /if \(message\.type === 'private_room_expired'\) \{[\s\S]{0,220}state\.myPrivateRoom = null/.test(controllerSrc),
)
check(
  '[11c] private_room_closed (host closed the table — the "removed" path) clears state.myPrivateRoom',
  /if \(message\.type === 'private_room_closed'\) \{[\s\S]{0,220}state\.myPrivateRoom = null/.test(controllerSrc),
)
check(
  '[11d] private_room_full also clears state.myPrivateRoom (match started — no longer "waiting")',
  /if \(message\.type === 'private_room_full'\) \{[\s\S]{0,80}state\.myPrivateRoom = null/.test(controllerSrc),
)

// ─── Conflict guards (unchanged by this correction, still verified) ───────

check(
  '[G1] onSearchClick blocks with the conflict prompt instead of auto-leaving the private room to start matchmaking',
  /onSearchClick: \(\) => \{[\s\S]{0,160}state\.myPrivateRoom !== null\) \{\s*\n\s*state\.privateRoomConflictPromptOpen = true/.test(controllerSrc),
)
check(
  '[G2] onPrivateRoomCreate blocks (as the FIRST check) when already a member, before any stake/level/balance check runs',
  /onPrivateRoomCreate: \(stake, isLocked, waitMinutes\) => \{\s*\n\s*if \(state\.myPrivateRoom !== null\) \{/.test(controllerSrc),
)
check(
  '[G3] onPrivateRoomJoin blocks when already a member (extracted into handlePrivateRoomJoin — also directly, publicly callable as controller.joinPrivateRoom, mirroring the existing startMatchmaking precedent)',
  /function handlePrivateRoomJoin\(privateRoomId: string\): void \{\s*\n\s*if \(state\.myPrivateRoom !== null\) \{/.test(controllerSrc) &&
    /onPrivateRoomJoin: handlePrivateRoomJoin,/.test(controllerSrc) &&
    /joinPrivateRoom: handlePrivateRoomJoin,/.test(controllerSrc),
)
check(
  '[G4] onPrivateRoomInviteAccept blocks when already a member (accepting an invite is joining another private room)',
  /onPrivateRoomInviteAccept: \(inviteId\) => \{\s*\n\s*if \(state\.myPrivateRoom !== null\) \{/.test(controllerSrc),
)
check(
  '[G5] none of the conflict guards call options.onPrivateRoomLeave (no automatic leave of the current table)',
  !/openPrivateRoomConflictPrompt\(\)[\s\S]{0,30}options\.onPrivateRoomLeave/.test(controllerSrc),
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
