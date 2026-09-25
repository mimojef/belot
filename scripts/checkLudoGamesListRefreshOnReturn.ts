// Deterministic проверка на "Ludo games-list lifecycle fix" (виж task-а
// "Продължаваме с implementation на одобрения Ludo games-list lifecycle
// fix") — затваря доказания от одита gap: `ludo_games_list` broadcast може
// да бъде изгубен, докато `_ludoLobbyController === null` (destroy-нат при
// `ludo_game_started`), и при връщане към lobby-то (natural finish ИЛИ
// explicit "Изход") нямаше гарантиран fresh `request_ludo_games_list`.
//
// Source-text проверки (createLobbyFlowController.ts, без browser/DOM) +
// pure behavioral harness, реimplement-ващ ТОЧНО branching логиката на
// ensureLudoLobbyControllerAndRefreshGames()/openLudoLobbyOverlay() —
// mirror на established checkLudoPawnExitBaseSound.ts/
// checkLudoCapturePresentation.ts стил (source review + pure replica
// harness, без Playwright). Пълна DOM instantiation на
// createLobbyFlowController() не е практична за unit ниво (масивен файл с
// множество browser-only зависимости) — source-text assertions гарантират,
// че replica-та остава isomorphic на реалния код.
//
// Покрива:
//   T1. Natural finish -> OK -> точно един guaranteed fresh
//       request_ludo_games_list.
//   T2. _ludoLobbyController === null през целия мач + изгубен finished
//       broadcast -> при връщане fresh request възстановява just-finished
//       мача от authoritative server state (DB записът никога не е бил
//       засегнат от изгубения broadcast).
//   T3. Controller вече е alive (напр. случаен reconciliation remount по
//       време на мача) -> explicit refresh, БЕЗ нов controller instance и
//       БЕЗ duplicate request.
//   T4. Две застъпващи се извиквания на openLudoLobbyOverlay() преди
//       dynamic import да приключи -> точно ЕДИН controller instance
//       (доказва _isOpeningLudoLobbyOverlay TOCTOU guard-а).
//   T5. ludo_match_left (explicit "Изход"/forfeit) -> same guaranteed fresh
//       refresh като T1.
//   T6. Regression guard: 2-часовият Ludo finished visibility contract
//       (LUDO_FINISHED_VISIBILITY_HOURS) е непроменен от този fix.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

// Нормализира CRLF -> LF при четене — виж established rationale в
// checkLudoCapturePresentation.ts (Windows checkout core.autocrlf).
function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const CONTROLLER_PATH = '../src/app/lobby/createLobbyFlowController.ts'
const SERVER_INDEX_PATH = '../server/src/index.ts'
const LUDO_ROOM_MATCH_STORE_PATH = '../server/src/db/ludoRoomMatchStore.ts'

const controllerSrc = readSourceFile(CONTROLLER_PATH)
const serverIndexSrc = readSourceFile(SERVER_INDEX_PATH)
const ludoRoomMatchStoreSrc = readSourceFile(LUDO_ROOM_MATCH_STORE_PATH)

console.log('\n=== checkLudoGamesListRefreshOnReturn ===\n')

// ─── Source-text baseline: helper-ът съществува с очакваната форма ────────

check('[baseline] ensureLudoLobbyControllerAndRefreshGames() съществува с точния if/else branching', () => {
  assert(
    controllerSrc.includes('function ensureLudoLobbyControllerAndRefreshGames(): void {'),
    'липсва ensureLudoLobbyControllerAndRefreshGames() функцията',
  )
  const fnStart = controllerSrc.indexOf('function ensureLudoLobbyControllerAndRefreshGames(): void {')
  const fnEnd = controllerSrc.indexOf('\n  }', fnStart)
  const fnBody = controllerSrc.slice(fnStart, fnEnd)
  assert(fnBody.includes('if (_ludoLobbyController) {'), 'трябва да проверява дали _ludoLobbyController вече съществува')
  assert(fnBody.includes('options.onLudoGamesOpen?.()'), 'ако controller-ът съществува, трябва explicit да вика options.onLudoGamesOpen?.()')
  assert(fnBody.includes('void openLudoLobbyOverlay()'), 'ако controller-ът НЕ съществува, трябва да вика openLudoLobbyOverlay()')
})

check('[baseline] openLudoLobbyOverlay() guard-ва с _isOpeningLudoLobbyOverlay СИНХРОННО преди първия await', () => {
  assert(controllerSrc.includes('let _isOpeningLudoLobbyOverlay = false'), 'липсва _isOpeningLudoLobbyOverlay флагът')
  const fnStart = controllerSrc.indexOf('async function openLudoLobbyOverlay(): Promise<void> {')
  assert(fnStart !== -1, 'openLudoLobbyOverlay() трябва да съществува')
  const fnEnd = controllerSrc.indexOf('\n  }', fnStart)
  const fnBody = controllerSrc.slice(fnStart, fnEnd)
  const guardIdx = fnBody.indexOf('if (_ludoLobbyController || _isOpeningLudoLobbyOverlay || !isLudoFeatureEnabled()) return')
  const setIdx = fnBody.indexOf('_isOpeningLudoLobbyOverlay = true')
  const firstAwaitIdx = fnBody.indexOf('await import(')
  const finallyIdx = fnBody.indexOf('_isOpeningLudoLobbyOverlay = false')
  assert(guardIdx !== -1, 'трябва да guard-ва с _isOpeningLudoLobbyOverlay в началния if')
  assert(setIdx !== -1 && firstAwaitIdx !== -1, 'трябва да сетне флага и да съдържа await import(...)')
  assert(guardIdx < setIdx && setIdx < firstAwaitIdx, 'check-and-set трябва да е СИНХРОНЕН, преди първия await (guard < set < await)')
  assert(finallyIdx !== -1 && finallyIdx > firstAwaitIdx, 'флагът трябва да се освобождава СЛЕД await-а (в finally)')
  assert(fnBody.includes('} finally {'), 'освобождаването трябва да е в finally блок, гарантиран дори при ранен return/exception')
})

check('[baseline] onGameEndAcknowledged и ludo_match_left извикват ensureLudoLobbyControllerAndRefreshGames()', () => {
  const ackStart = controllerSrc.indexOf('onGameEndAcknowledged: (matchId) => {')
  assert(ackStart !== -1, 'onGameEndAcknowledged трябва да съществува')
  // Търсим closing "},\n" на СЪЩОТО ниво на индентация като property
  // декларацията (6 spaces) — не голото "},", което лъжливо match-ва
  // "history.pushState({}, '', '/games')"-ото "},".
  const ackEnd = controllerSrc.indexOf('\n      },', ackStart)
  const ackBody = controllerSrc.slice(ackStart, ackEnd)
  assert(ackBody.includes('ensureLudoLobbyControllerAndRefreshGames()'), 'onGameEndAcknowledged трябва да вика ensureLudoLobbyControllerAndRefreshGames()')

  const leftStart = controllerSrc.indexOf("if (message.type === 'ludo_match_left') {")
  assert(leftStart !== -1, 'ludo_match_left handler-ът трябва да съществува')
  const leftEnd = controllerSrc.indexOf('\n    }', leftStart)
  const leftBody = controllerSrc.slice(leftStart, leftEnd)
  assert(leftBody.includes('ensureLudoLobbyControllerAndRefreshGames()'), 'ludo_match_left трябва да вика ensureLudoLobbyControllerAndRefreshGames()')
})

// ─── Pure behavioral replica — isomorphic mirror на реалната branching логика ───
//
// harness симулира само релевантните moving parts: наличие на controller,
// in-flight "opening" флаг, брой реално създадени controller instance-и, и
// изпратените "request_ludo_games_list" заявки. "DB"-то е отделен, никога-не-
// губещ-данни authoritative масив, точно както реалния ludo_room_matches —
// broadcast push-овете могат да се "изгубят" (no-op докато controller===null),
// но authoritative read (buildLudoGamesListMessage()) винаги връща вярното
// състояние, независимо от изгубени push-ове.

type Harness = {
  controller: { id: number; finishedGames: string[] } | null
  isOpening: boolean
  createdControllerCount: number
  requestsSent: number
  dbFinishedMatchIds: string[]
}

function createHarness(): Harness {
  return { controller: null, isOpening: false, createdControllerCount: 0, requestsSent: 0, dbFinishedMatchIds: [] }
}

// Mirror на buildLudoGamesListMessage() — authoritative read от "DB",
// изобщо не се влияе от изгубени по-рано broadcast-ове.
function authoritativeFinishedGames(harness: Harness): string[] {
  return [...harness.dbFinishedMatchIds]
}

// Mirror на createLudoLobbyController()'s own init (render(); onRefresh();
// onRefreshGames()) — деляна fixture, контролирана отвън чрез importGate, за
// да симулираме T4-race прозореца между "мина guard-а" и "приключи import()".
function mockOpenLudoLobbyOverlay(harness: Harness, importGate: Promise<void>): Promise<void> {
  if (harness.controller || harness.isOpening) return Promise.resolve()
  harness.isOpening = true
  return importGate
    .then(() => {
      // Same повторна проверка като реалния код СЛЕД await import(...)
      // ("if (!liveMountRoot || _ludoLobbyController || ...) return").
      if (harness.controller) return
      harness.createdControllerCount += 1
      harness.controller = { id: harness.createdControllerCount, finishedGames: authoritativeFinishedGames(harness) }
      harness.requestsSent += 1 // onRefreshGames() вътре в constructor-а
    })
    .finally(() => {
      harness.isOpening = false
    })
}

function mockEnsureLudoLobbyControllerAndRefreshGames(harness: Harness, importGate: Promise<void>): Promise<void> {
  if (harness.controller) {
    harness.requestsSent += 1
    harness.controller.finishedGames = authoritativeFinishedGames(harness)
    return Promise.resolve()
  }
  return mockOpenLudoLobbyOverlay(harness, importGate)
}

// Mirror на _ludoLobbyController?.setGames(...) при входящ broadcast —
// no-op, ако controller-ът е null (точно доказаният lifecycle gap).
function mockApplyIncomingBroadcast(harness: Harness): void {
  if (!harness.controller) return
  harness.controller.finishedGames = authoritativeFinishedGames(harness)
}

await check('[T1] Natural finish -> OK -> точно ЕДИН guaranteed fresh request_ludo_games_list', async () => {
  const harness = createHarness()
  // Controller вече destroy-нат при ludo_game_started (established, непроменено поведение).
  harness.controller = null
  // onGameEndAcknowledged -> ensureLudoLobbyControllerAndRefreshGames()
  await mockEnsureLudoLobbyControllerAndRefreshGames(harness, Promise.resolve())
  assertEqual(harness.requestsSent, 1, 'трябва да е изпратена точно 1 заявка')
  assertEqual(harness.createdControllerCount, 1, 'трябва да е създаден точно 1 нов controller')
  assert(harness.controller !== null, 'controller-ът трябва да съществува след връщането')
})

await check('[T2] Изгубен finished broadcast докато controller===null -> fresh request възстановява мача от authoritative state', async () => {
  const harness = createHarness()
  harness.controller = null // destroy-нат при match start, останал null през целия мач
  harness.dbFinishedMatchIds = [] // DB все още няма finished запис в началото

  // По средата на мача — несвързан broadcast с празен finished списък, no-op (controller null).
  mockApplyIncomingBroadcast(harness)

  // Мачът приключва: DB записът е верен (recordMatchFinished вече е минал
  // server-side), НО broadcast-ът за него също е изгубен (controller все още null).
  harness.dbFinishedMatchIds = ['match-just-finished']
  mockApplyIncomingBroadcast(harness) // изгубен push — no-op, controller остава null

  assert(harness.controller === null, 'sanity: controller трябва да е все още null точно преди връщането')

  // Играчът кликва OK -> onGameEndAcknowledged -> guaranteed fresh refresh.
  await mockEnsureLudoLobbyControllerAndRefreshGames(harness, Promise.resolve())

  assert(harness.controller !== null, 'controller трябва да е създаден при връщането')
  assert(
    harness.controller!.finishedGames.includes('match-just-finished'),
    'just-finished мачът трябва да е възстановен от authoritative DB read, въпреки изгубения broadcast',
  )
  assertEqual(harness.requestsSent, 1, 'трябва да е изпратена точно 1 заявка (fresh pull, не replay на изгубения broadcast)')
})

await check('[T3] Controller вече alive -> explicit refresh, БЕЗ нов controller и БЕЗ duplicate request', async () => {
  const harness = createHarness()
  // Симулира случаен reconciliation remount по време на мача (лъки timing) —
  // controller вече съществува ПРЕДИ onGameEndAcknowledged да се извика.
  await mockOpenLudoLobbyOverlay(harness, Promise.resolve())
  assertEqual(harness.createdControllerCount, 1, 'sanity: controller трябва вече да съществува')
  const existingControllerId = harness.controller!.id
  const requestsBeforeReturn = harness.requestsSent

  await mockEnsureLudoLobbyControllerAndRefreshGames(harness, Promise.resolve())

  assertEqual(harness.createdControllerCount, 1, 'НЕ трябва да се създава втори controller instance')
  assertEqual(harness.controller!.id, existingControllerId, 'трябва да остане СЪЩИЯТ controller instance (same reference/id)')
  assertEqual(harness.requestsSent, requestsBeforeReturn + 1, 'трябва да е изпратена точно 1 ДОПЪЛНИТЕЛНА explicit заявка (не 0, не 2)')
})

await check('[T4] Две застъпващи се извиквания на openLudoLobbyOverlay() преди import да приключи -> точно ЕДИН controller', async () => {
  const harness = createHarness()
  let releaseImport: () => void = () => {}
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve
  })

  // И двете извиквания стартират, ДОКАТО importGate все още е pending —
  // и двете минават "if (_ludoLobbyController || _isOpeningLudoLobbyOverlay)"
  // guard-а по различно време спрямо синхронния _isOpeningLudoLobbyOverlay=true.
  const call1 = mockOpenLudoLobbyOverlay(harness, importGate)
  assertEqual(harness.isOpening, true, 'първото извикване трябва синхронно да сетне isOpening=true ПРЕДИ да върне control')
  const call2 = mockOpenLudoLobbyOverlay(harness, importGate) // трябва да е guard-нато веднага (isOpening вече true)

  assertEqual(harness.createdControllerCount, 0, 'sanity: все още никой controller не е създаден (import pending)')

  releaseImport()
  await Promise.all([call1, call2])

  assertEqual(harness.createdControllerCount, 1, 'трябва да се създаде ТОЧНО ЕДИН controller, независимо от двете застъпващи се извиквания')
  assertEqual(harness.requestsSent, 1, 'трябва да е изпратена точно 1 заявка (от единствения реално създаден controller)')
})

await check('[T5] ludo_match_left (explicit "Изход"/forfeit) -> same guaranteed fresh refresh', async () => {
  const harness = createHarness()
  harness.controller = null
  harness.dbFinishedMatchIds = [] // forfeit преди естествен край — обикновено няма finished запис за ТОЗИ мач

  await mockEnsureLudoLobbyControllerAndRefreshGames(harness, Promise.resolve())

  assertEqual(harness.requestsSent, 1, 'трябва да е изпратена точно 1 заявка при връщане след explicit "Изход"')
  assertEqual(harness.createdControllerCount, 1, 'трябва да е създаден точно 1 нов controller')
})

// ─── T6: 2-часовият visibility window contract е непроменен ───────────────

check('[T6] Regression guard: LUDO_FINISHED_VISIBILITY_HOURS остава 2, DB/store логиката е недокосната', () => {
  assert(
    serverIndexSrc.includes('const LUDO_FINISHED_VISIBILITY_HOURS = 2'),
    'LUDO_FINISHED_VISIBILITY_HOURS трябва да остане точно 2 (непроменен от този frontend-only fix)',
  )
  assert(
    ludoRoomMatchStoreSrc.includes("WHERE status = 'finished' AND finished_at >= datetime('now', '-${visibilityHours} hours')"),
    'listFinishedMatches SQL WHERE filter-ът трябва да остане непроменен',
  )
  assert(
    !ludoRoomMatchStoreSrc.includes('DELETE FROM ludo_room_matches'),
    'store-ът трябва да остане "никога не трие редове" — fix-ът е чисто frontend lifecycle, не backend/DB',
  )
  // Frontend fix-ът не трябва изобщо да реферира visibility window-а/DB детайли.
  assert(
    !controllerSrc.includes('LUDO_FINISHED_VISIBILITY_HOURS'),
    'frontend fix-ът не трябва да реферира LUDO_FINISHED_VISIBILITY_HOURS изобщо — visibility window остава изцяло backend read-path filter',
  )
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
