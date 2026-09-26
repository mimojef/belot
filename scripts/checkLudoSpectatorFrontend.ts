// Deterministic проверка на Ludo Spectator Mode Phase 2 (frontend "Гледай").
// Реален behavioral test за чисти, DOM-free render функции
// (renderLudoBottomBar/renderLudoGameEndPopup — import-нати и извикани
// directno), комбиниран със source-text review + pure behavioral replica на
// lifecycle guard-овете в createLobbyFlowController.ts/createLudoFlowController.ts
// (масивни файлове, coupled с реален browser DOM/WebSocket — createLudoFlowController()
// вика document.createElement() на самия си constructor, затова директна
// instantiation не е възможна в plain Node script; mirror на established
// checkLudoGamesListRefreshOnReturn.ts/checkLudoMoveHintsRemoved.ts стил от
// същата сесия — source review + isomorphic pure replica, а не Playwright).
//
// Покрива (виж task-а "Ludo Spectator Mode Phase 2" т.10):
//   [H1]  renderLudoBottomBar('spectator') label е "Назад", НЕ "Изход"
//   [H2]  renderLudoBottomBar('player')/default label остава "Изход" (regression guard)
//   [H3]  renderLudoBottomBar('spectator') НЯМА emoji бутон
//   [H4]  renderLudoBottomBar('player') ПРОДЪЛЖАВА да има emoji бутон (regression guard)
//   [H5]  renderLudoGameEndPopup spectator variant показва неутрален "Победител: X" текст
//   [H6]  renderLudoGameEndPopup participant variant остава "Вие сте победител/Вие загубихте" (regression guard)
//   [S1]  "Гледай" бутон в createLudoLobbyController.ts съществува САМО за kind==='playing'
//   [S2]  "Гледай" click подава ТОЧНИЯ game.matchId през options.onWatch
//   [S3]  createLobbyFlowController.ts's spectator mount подава localColor:undefined explicit (НЕ participant `?? 'red'` fallback-а)
//   [S4]  подава viewMode:'spectator' explicit
//   [S5]  createLudoFlowController.ts's canRollDice/legalMoves са isSpectator-gated
//   [S6]  spectator authoritative.onRollRequest/onMoveRequest/onReclaimRequest са defensive no-ops
//   [S7]  "Назад" (spectator) вика requestExit() directно, БЕЗ openExitConfirmPopup()
//   [S8]  spectator onExit пътят вика unwatch (НЕ onLudoMatchLeave/leave_ludo_match)
//   [S9]  ludo_spectator_game_state handler reuse-ва СЪЩИЯ applyAuthoritativeSnapshot() като participant (споделен pipeline)
//   [S10] 'connected' (reconnect) handler-ът explicit ре-изпраща watch за активен spectator intent
//   [S11] participant openLudoGameOverlay() остава напълно непроменен (`?? 'red'`, без viewMode)
//   [T1]  Pure replica: double-click "Гледай" -> точно 1 watch заявка
//   [T2]  Pure replica: switch към друг match -> unwatch стария, watch новия
//   [T3]  Pure replica: "Назад" -> unwatch + reset intent
//   [T4]  Pure replica: stale snapshot response СЛЕД "Назад" не може да reopen-не/update-не spectator screen
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderLudoBottomBar } from '../src/app/games/ludo/renderLudoBottomBar'
import { renderLudoGameEndPopup } from '../src/app/games/ludo/renderLudoGameEndPopup'

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
function assertArrayEqual(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const lobbyControllerSrc = readSourceFile('../src/app/lobby/createLobbyFlowController.ts')
const ludoFlowControllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
const ludoLobbyControllerSrc = readSourceFile('../src/app/games/ludo/createLudoLobbyController.ts')

console.log('\n=== checkLudoSpectatorFrontend ===\n')

// ─── H1-H4: renderLudoBottomBar — реален behavioral test ──────────────────

check('[H1] renderLudoBottomBar("spectator") label е "Назад"', () => {
  const html = renderLudoBottomBar('spectator')
  assert(html.includes('>Назад<'), 'spectator bottom bar трябва да показва "Назад"')
  assert(!html.includes('>Изход<'), 'spectator bottom bar НЕ трябва да показва "Изход"')
})
check('[H2] renderLudoBottomBar("player")/default label остава "Изход" (regression guard)', () => {
  const htmlExplicit = renderLudoBottomBar('player')
  const htmlDefault = renderLudoBottomBar()
  for (const html of [htmlExplicit, htmlDefault]) {
    assert(html.includes('>Изход<'), 'participant bottom bar трябва да продължи да показва "Изход"')
    assert(!html.includes('>Назад<'), 'participant bottom bar не трябва да показва "Назад"')
  }
})
check('[H3] renderLudoBottomBar("spectator") НЯМА emoji бутон', () => {
  const html = renderLudoBottomBar('spectator')
  assert(!html.includes('data-ludo-emoji-button'), 'spectator bottom bar не трябва да съдържа emoji бутона')
})
check('[H4] renderLudoBottomBar("player") ПРОДЪЛЖАВА да има emoji бутон (regression guard)', () => {
  const html = renderLudoBottomBar('player')
  assert(html.includes('data-ludo-emoji-button="1"'), 'participant bottom bar трябва да запази emoji бутона')
})
check('[H4b] Settings бутонът остава за ДВАТА режима', () => {
  assert(renderLudoBottomBar('spectator').includes('data-ludo-settings-button="1"'), 'spectator трябва да пази settings бутона')
  assert(renderLudoBottomBar('player').includes('data-ludo-settings-button="1"'), 'participant трябва да пази settings бутона')
})

// ─── H5-H6: renderLudoGameEndPopup — реален behavioral test ───────────────

check('[H5] renderLudoGameEndPopup spectator variant показва неутрален "Победител: X" текст', () => {
  const html = renderLudoGameEndPopup(false, null, 'Иван')
  assert(html.includes('Победител: Иван'), 'spectator variant трябва да показва неутрален победител текст')
  assert(!html.includes('Вие сте победител') && !html.includes('Вие загубихте'), 'spectator variant НЕ трябва да съдържа лично "Вие" framing')
  assert(!html.includes('Печелите'), 'spectator variant никога не трябва да показва prize line')
})
check('[H5b] renderLudoGameEndPopup spectator variant с winner=null показва неутрално "Играта приключи."', () => {
  const html = renderLudoGameEndPopup(false, null, null)
  assert(html.includes('Играта приключи.'), 'spectator variant без winner трябва да покаже неутрален текст')
})
check('[H6] renderLudoGameEndPopup participant variant остава "Вие сте победител/Вие загубихте" (regression guard)', () => {
  const winHtml = renderLudoGameEndPopup(true, 5000)
  const loseHtml = renderLudoGameEndPopup(false, null)
  assert(winHtml.includes('Вие сте победител в играта!'), 'participant win текст трябва да остане непроменен')
  assert(winHtml.includes('Печелите 5'), 'participant prize line трябва да остане непроменен')
  assert(loseHtml.includes('Вие загубихте играта.'), 'participant lose текст трябва да остане непроменен')
})

// ─── S1-S2: "Гледай" бутон source review ───────────────────────────────────

check('[S1] "Гледай" бутон съществува САМО за kind===\'playing\' game cards', () => {
  assert(ludoLobbyControllerSrc.includes("data-ludo-watch-match="), 'трябва да съществува data-ludo-watch-match маркер')
  const fnStart = ludoLobbyControllerSrc.indexOf('function gameCardHtml(')
  assert(fnStart !== -1, 'gameCardHtml трябва да съществува')
  const fnEnd = ludoLobbyControllerSrc.indexOf('\n  }', fnStart)
  const fnBody = ludoLobbyControllerSrc.slice(fnStart, fnEnd)
  assert(
    fnBody.includes("kind === 'playing'\n      ? `<button type=\"button\" data-ludo-watch-match="),
    '"Гледай" бутонът трябва да е условно рендиран само за kind===\'playing\'',
  )
  assert(!fnBody.includes("kind === 'finished'\n      ? `<button type=\"button\" data-ludo-watch-match="), '"Гледай" не трябва да се появява за finished клона')
})
check('[S2] "Гледай" click подава ТОЧНИЯ game.matchId през options.onWatch', () => {
  assert(
    ludoLobbyControllerSrc.includes("data-ludo-watch-match=\"${esc(game.matchId)}\""),
    'бутонът трябва да носи game.matchId (escaped) в data атрибута',
  )
  assert(
    ludoLobbyControllerSrc.includes("options.root.querySelectorAll<HTMLElement>('[data-ludo-watch-match]').forEach((el) => el.addEventListener('click', () => options.onWatch(el.dataset.ludoWatchMatch!)))"),
    'wire() трябва да чете data-ludo-watch-match и да вика options.onWatch с точно тази стойност',
  )
  assert(ludoLobbyControllerSrc.includes('onWatch: (matchId: string) => void'), 'Options типът трябва да декларира onWatch')
})

// ─── S3-S6: spectator mount source review ──────────────────────────────────

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start === -1) throw new Error(`signature not found: ${signature}`)
  const end = src.indexOf('\n  }', start)
  return src.slice(start, end)
}

check('[S3] Spectator mount подава localColor:undefined explicit (НЕ participant `?? \'red\'` fallback-а)', () => {
  const body = extractFunctionBody(lobbyControllerSrc, 'async function mountLudoSpectatorController(')
  assert(body.includes('localColor: undefined,'), 'mountLudoSpectatorController трябва explicit да подава localColor: undefined')
  // Търсим РЕАЛНИЯ code pattern на participant fallback-а (пълния израз, не
  // голия "?? 'red'" substring, който самите doc коментари тук също
  // споменават в прозата си, за да обяснят какво НЕ правим).
  assert(
    !body.includes("snapshot.players.find((player) => player.profileId === localProfileId)?.color ?? 'red'"),
    'mountLudoSpectatorController НЕ трябва да преизползва participant-ския profileId-lookup fallback израз',
  )
})
check('[S4] Spectator mount подава viewMode:\'spectator\' explicit', () => {
  const body = extractFunctionBody(lobbyControllerSrc, 'async function mountLudoSpectatorController(')
  assert(body.includes("viewMode: 'spectator',"), 'mountLudoSpectatorController трябва explicit да подава viewMode: \'spectator\'')
})
check('[S5] createLudoFlowController.ts: canRollDice и legalMoves са isSpectator-gated', () => {
  assert(ludoFlowControllerSrc.includes('const isSpectator = options.viewMode === \'spectator\''), 'isSpectator const трябва да съществува')
  assert(
    /canRollDice:\s*\n\s*!isSpectator &&/.test(ludoFlowControllerSrc),
    'canRollDice трябва да започва с !isSpectator && guard',
  )
  assert(
    ludoFlowControllerSrc.includes('legalMoves: isSpectator || isAnimatingMove ? [] :'),
    'legalMoves трябва да е [] за spectator, независимо от engine legalMoves',
  )
})
check('[S6] Spectator authoritative.onRollRequest/onMoveRequest/onReclaimRequest са defensive no-ops', () => {
  const body = extractFunctionBody(lobbyControllerSrc, 'async function mountLudoSpectatorController(')
  assert(body.includes('onRollRequest: () => {},'), 'spectator onRollRequest трябва да е no-op')
  assert(body.includes('onMoveRequest: () => {},'), 'spectator onMoveRequest трябва да е no-op')
  assert(body.includes('onReclaimRequest: () => {},'), 'spectator onReclaimRequest трябва да е no-op')
  // Emoji изобщо не се подава (undefined) — hidden бутон + без wiring.
  assert(!body.includes('onEmojiReactionSend:'), 'spectator authoritative options не трябва да включва onEmojiReactionSend')
})

// ─── S7-S8: "Назад" -> unwatch, НЕ leave/forfeit ──────────────────────────

check('[S7] Spectator exit button click вика requestExit() directно, БЕЗ openExitConfirmPopup()', () => {
  const start = ludoFlowControllerSrc.indexOf("options.root.querySelector('[data-ludo-exit-button=\"1\"]')")
  assert(start !== -1, 'exit button click handler трябва да съществува')
  const end = ludoFlowControllerSrc.indexOf('})', start)
  const body = ludoFlowControllerSrc.slice(start, end)
  assert(body.includes('if (isSpectator) requestExit()'), 'spectator клонът трябва да вика requestExit() directно')
  assert(body.includes('else openExitConfirmPopup()'), 'participant клонът трябва да остане openExitConfirmPopup()')
})
check('[S8] Spectator onExit пътят вика unwatch (НЕ onLudoMatchLeave/leave_ludo_match)', () => {
  const body = extractFunctionBody(lobbyControllerSrc, 'async function mountLudoSpectatorController(')
  const onExitStart = body.indexOf('onExit: () => {')
  assert(onExitStart !== -1, 'spectator onExit callback трябва да съществува')
  const onExitBody = body.slice(onExitStart, body.indexOf('},', onExitStart))
  assert(onExitBody.includes('closeLudoSpectatorOverlay()'), 'spectator onExit трябва да вика closeLudoSpectatorOverlay()')
  assert(!onExitBody.includes('onLudoMatchLeave'), 'spectator onExit НЕ трябва да вика onLudoMatchLeave (participant forfeit path)')

  const closeBody = extractFunctionBody(lobbyControllerSrc, 'function closeLudoSpectatorOverlay(')
  assert(closeBody.includes('options.onLudoUnwatchMatch?.('), 'closeLudoSpectatorOverlay трябва да вика onLudoUnwatchMatch')
  assert(!closeBody.includes('onLudoMatchLeave') && !closeBody.includes('leave_ludo_match'), 'closeLudoSpectatorOverlay никога не трябва да вика leave/forfeit пътя')
})

// ─── S9-S10: shared pipeline reuse + reconnect ────────────────────────────

check('[S9] ludo_spectator_game_state handler reuse-ва СЪЩИЯ applyAuthoritativeSnapshot() като participant', () => {
  const handlerStart = lobbyControllerSrc.indexOf("if (message.type === 'ludo_spectator_game_state') {")
  assert(handlerStart !== -1, 'ludo_spectator_game_state handler трябва да съществува')
  const handlerEnd = lobbyControllerSrc.indexOf('\n    }', handlerStart)
  const handlerBody = lobbyControllerSrc.slice(handlerStart, handlerEnd)
  assert(handlerBody.includes('_ludoController.applyAuthoritativeSnapshot(message.snapshot, null)'), 'live update трябва да минава през СЪЩИЯ applyAuthoritativeSnapshot() метод като participant')
  assert(handlerBody.includes('void mountLudoSpectatorController(message.snapshot)'), 'initial snapshot трябва да mount-ва фрешен controller (seed, не replay)')
  // Staleness guard — първата реална проверка в handler-а.
  assert(handlerBody.includes('if (_ludoSpectatorMatchId !== message.snapshot.matchId) return true'), 'handler-ът трябва да отхвърля snapshot-и за matchId, различен от текущия watch intent')
})
check('[S10] \'connected\' (reconnect) handler-ът explicit ре-изпраща watch за активен spectator intent', () => {
  const connectedStart = lobbyControllerSrc.indexOf("if (message.type === 'connected') {")
  assert(connectedStart !== -1, 'connected handler трябва да съществува')
  const connectedEnd = lobbyControllerSrc.indexOf('\n      return true', connectedStart)
  const connectedBody = lobbyControllerSrc.slice(connectedStart, connectedEnd)
  assert(
    connectedBody.includes('if (_ludoSpectatorMatchId !== null) options.onLudoWatchMatch?.(_ludoSpectatorMatchId)'),
    'connected handler-ът трябва explicit да ре-изпрати watch_ludo_match за активния spectator intent',
  )
})

// ─── S11: participant flow остава непроменен ──────────────────────────────

check('[S11] Participant openLudoGameOverlay() остава напълно непроменен (`?? \'red\'`, без viewMode)', () => {
  const body = extractFunctionBody(lobbyControllerSrc, 'async function openLudoGameOverlay(')
  assert(body.includes("?? 'red'"), 'participant flow трябва да пази established `?? \'red\'` fallback-а')
  assert(!body.includes('viewMode:'), 'participant flow НЕ трябва да подава viewMode (default \'player\' в createLudoFlowController.ts)')
  assert(body.includes('onRollRequest: (matchId, revision) => {'), 'participant onRollRequest трябва да остане функционален callback, не no-op')
})

// ─── T1-T4: pure behavioral replica на lifecycle guard-овете ──────────────
//
// Isomorphic mirror на _ludoSpectatorMatchId-based guard логиката (виж
// openLudoSpectatorOverlay/closeLudoSpectatorOverlay/ludo_spectator_game_state
// handler-а по-горе, source-verified в S3/S4/S8/S9) — доказва самата
// lifecycle логика чрез pure harness, без реален DOM/WebSocket.

type SpectatorHarness = {
  spectatorMatchId: string | null
  controllerMountedFor: string | null
  watchRequestsSent: string[]
  unwatchRequestsSent: string[]
}
function createHarness(): SpectatorHarness {
  return { spectatorMatchId: null, controllerMountedFor: null, watchRequestsSent: [], unwatchRequestsSent: [] }
}
function mockCloseSpectatorOverlay(h: SpectatorHarness): void {
  if (h.spectatorMatchId !== null) h.unwatchRequestsSent.push(h.spectatorMatchId)
  h.spectatorMatchId = null
  h.controllerMountedFor = null
}
function mockOpenSpectatorOverlay(h: SpectatorHarness, matchId: string): void {
  if (h.spectatorMatchId === matchId) return
  if (h.spectatorMatchId !== null) mockCloseSpectatorOverlay(h)
  h.spectatorMatchId = matchId
  h.watchRequestsSent.push(matchId)
}
function mockReceiveSpectatorSnapshot(h: SpectatorHarness, matchId: string): void {
  if (h.spectatorMatchId !== matchId) return // stale guard — исentical на handler-а
  if (h.controllerMountedFor === null) h.controllerMountedFor = matchId
  // live update иначе (controllerMountedFor вече === matchId) — no-op в mock-а
}

check('[T1] Double-click "Гледай" -> точно 1 watch заявка', () => {
  const h = createHarness()
  mockOpenSpectatorOverlay(h, 'match-A')
  mockOpenSpectatorOverlay(h, 'match-A')
  assertEqual(h.watchRequestsSent.length, 1, 'трябва да е изпратена точно 1 watch заявка')
  assertEqual(h.watchRequestsSent[0], 'match-A', 'заявката трябва да е за match-A')
})
check('[T2] Switch към друг match -> unwatch стария, watch новия', () => {
  const h = createHarness()
  mockOpenSpectatorOverlay(h, 'match-A')
  mockReceiveSpectatorSnapshot(h, 'match-A')
  mockOpenSpectatorOverlay(h, 'match-B')
  assertArrayEqual(h.unwatchRequestsSent, ['match-A'], 'match-A трябва да бъде unwatch-нат при switch')
  assertArrayEqual(h.watchRequestsSent, ['match-A', 'match-B'], 'match-B трябва да бъде watch-нат')
  assertEqual(h.spectatorMatchId, 'match-B', 'текущият intent трябва да е match-B')
})
check('[T3] "Назад" -> unwatch + reset intent', () => {
  const h = createHarness()
  mockOpenSpectatorOverlay(h, 'match-A')
  mockReceiveSpectatorSnapshot(h, 'match-A')
  mockCloseSpectatorOverlay(h)
  assertArrayEqual(h.unwatchRequestsSent, ['match-A'], '"Назад" трябва да изпрати unwatch за match-A')
  assertEqual(h.spectatorMatchId, null, 'intent трябва да е нулиран')
  assertEqual(h.controllerMountedFor, null, 'controller reference трябва да е нулиран')
})
check('[T4] Stale snapshot response СЛЕД "Назад" не може да reopen-не/update-не spectator screen', () => {
  const h = createHarness()
  mockOpenSpectatorOverlay(h, 'match-A')
  mockCloseSpectatorOverlay(h) // "Назад" ПРЕДИ initial snapshot изобщо да пристигне
  // Stale response за match-A пристига КЪСНО, СЛЕД като вече сме напуснали.
  mockReceiveSpectatorSnapshot(h, 'match-A')
  assertEqual(h.controllerMountedFor, null, 'stale response НЕ трябва да mount-не/update-не контролер СЛЕД explicit close')
  assertEqual(h.spectatorMatchId, null, 'intent трябва да остане null')
})
check('[T4b] Stale response за match-A СЛЕД switch към match-B не засяга match-B screen-а', () => {
  const h = createHarness()
  mockOpenSpectatorOverlay(h, 'match-A')
  mockOpenSpectatorOverlay(h, 'match-B') // switch преди match-A response да пристигне
  mockReceiveSpectatorSnapshot(h, 'match-A') // stale — идва СЛЕД switch-а
  assertEqual(h.controllerMountedFor, null, 'stale match-A response не трябва да mount-не нищо (текущият intent е match-B)')
  mockReceiveSpectatorSnapshot(h, 'match-B') // легитимният response за текущия intent
  assertEqual(h.controllerMountedFor, 'match-B', 'легитимният match-B response трябва да mount-не коректно')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
