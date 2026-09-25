// Deterministic проверка на "пионка излиза от базата" звука (нов
// pawn-exit-base.mp3 asset) — играе се ИЗКЛЮЧИТЕЛНО на gameplay действието
// home -> track (пионка реално напуска базата/двора след валиден ход при
// хвърлена 6 и се поставя на стартовото си поле), НЕ при нормално
// движение/стъпване върху стартовото поле от друга пионка, и НЕ е закачен
// към координатата/индекса на самата клетка.
//
// Source-text проверки (playLudoMoveRouteOverlay.ts/createLudoFlowController.ts,
// без browser/DOM) + pure behavioral harness, реimplement-ващ ТОЧНО
// priority-decision-а от реалния route loop — mirror на established
// checkLudoCapturePresentation.ts стил (source review + pure replica
// harness, без Playwright).
//
// Покрива:
//   T1. Новият звук е добавен като собствен asset/constant/play helper,
//       reuse-вайки централния playLudoSound() gate ('gameplay' категория,
//       same established pattern като pawn-step/star-landing/etc.).
//   T2. Trigger-ът е options.isLeavingBase (явен gameplay signal, подаден от
//       caller-а), НЕ проверка на конкретен cellId/index — доказва §"НЕ го
//       връзвай към координатата на стартовото поле".
//   T3. И двата реални call site-а (performMoveSequence -> локален ход,
//       presentAuthoritativeMove -> authoritative echo/opponent ход) подават
//       isLeavingBase: sourceIsHome, reuse-вайки established
//       `parseLudoCellId(fromCellId).kind === 'home'` изчисление — не ново/
//       дублирано home detection.
//   T4. buildLudoMoveRoute() гарантира точно 1 route стъпка за home->track
//       (без междинни клетки) — isLeavingBase проверката на stepIndex===0 е
//       coherent с това: винаги е и последната стъпка едновременно.
//   T5. Приоритетът е: isGameWinningMove > isLeavingBase > triangle-entry >
//       star-landing > pawn-step — дори ако собственото стартово поле е
//       canonical safe/star cell, exit-base звукът печели над star-landing.
//   T6. Reconnect/tab-hidden catch-up (snapToAuthoritativeSnapshot) НИКОГА
//       не вика playLudoMoveRouteOverlay — структурно изключва replay на
//       звука при resync/render.
//   T7. Same-snapshot revision guard (applyAuthoritativeTransition) пази
//       presentAuthoritativeMove от повторно изпълнение за вече-presented
//       revision — защита срещу duplicate звук при повторна доставка на
//       същия snapshot.
//   T8. Поведенчески: 4-те изисквани сценария (base->start след 6 веднъж;
//       нормален ход завършващ на стартовото поле без звука; нормално
//       преминаване/стъпване през стартовото поле без звука; multi-step
//       route с isLeavingBase не пуска звука на средни стъпки).
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
function check(label: string, fn: () => void): void {
  try {
    fn()
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

const OVERLAY_PATH = '../src/app/games/ludo/pieces/playLudoMoveRouteOverlay.ts'
const CONTROLLER_PATH = '../src/app/games/ludo/createLudoFlowController.ts'
const ROUTE_PATH = '../src/app/games/ludo/board/ludoMoveRoute.ts'

const overlaySrc = readSourceFile(OVERLAY_PATH)
const controllerSrc = readSourceFile(CONTROLLER_PATH)
const routeSrc = readSourceFile(ROUTE_PATH)

console.log('\n=== checkLudoPawnExitBaseSound ===\n')

// ─── T1: асет/constant/play helper, established playLudoSound() gate ──────

check('[T1] pawn-exit-base.mp3 asset + play helper reuse-ва централния playLudoSound gate ("gameplay" категория)', () => {
  assert(overlaySrc.includes("const PAWN_EXIT_BASE_SOUND_SRC = '/audio/ludo/pawn-exit-base.mp3'"), 'липсва PAWN_EXIT_BASE_SOUND_SRC constant-а')
  assert(overlaySrc.includes('function playLudoPawnExitBaseSound(): void {'), 'липсва playLudoPawnExitBaseSound() helper функцията')
  const fnStart = overlaySrc.indexOf('function playLudoPawnExitBaseSound(): void {')
  const fnBody = overlaySrc.slice(fnStart, overlaySrc.indexOf('\n}', fnStart))
  assert(fnBody.includes("playLudoSound(PAWN_EXIT_BASE_SOUND_SRC, 'gameplay')"), 'helper-ът трябва да вика playLudoSound(..., "gameplay"), established pattern')
})

// ─── T2: trigger е explicit gameplay signal, НЕ cellId/index проверка ─────

check('[T2] Trigger-ът е options.isLeavingBase (явен signal), НЕ проверка на cellId/index на destination клетката', () => {
  assert(overlaySrc.includes('isLeavingBase?: boolean'), 'LudoMoveRouteOverlayOptions трябва да декларира isLeavingBase?: boolean')
  // Търсим РЕАЛНАТА условна проверка (не doc коментара по-горе, който също
  // споменава "options.isLeavingBase" в прозата си) — точният израз с
  // затваряща скоба, каквато се среща само в реалния if/else-if клон.
  const conditionMarker = 'stepIndex === 0 && options.isLeavingBase)'
  const callIdx = overlaySrc.indexOf(conditionMarker)
  assert(callIdx !== -1, `route loop-ът трябва да съдържа реалната проверка "${conditionMarker}"`)
  const conditionLineStart = overlaySrc.lastIndexOf('\n', callIdx)
  const conditionLineEnd = overlaySrc.indexOf('\n', callIdx)
  const conditionLine = overlaySrc.slice(conditionLineStart, conditionLineEnd)
  assert(!conditionLine.includes('cellId') && !conditionLine.includes('LUDO_SAFE_CELL_ID_SET'), 'проверката НЕ трябва да реферира cellId/LUDO_SAFE_CELL_ID_SET — trigger-ът е действието, не координатата')
})

// ─── T3: и двата call site-а reuse-ват established sourceIsHome ───────────

check('[T3] performMoveSequence и presentAuthoritativeMove подават isLeavingBase: sourceIsHome (reuse, не ново home detection)', () => {
  const occurrences = (controllerSrc.match(/isLeavingBase: sourceIsHome,/g) ?? []).length
  assertEqual(occurrences, 2, 'трябва да съществуват точно 2 call site-а (performMoveSequence + presentAuthoritativeMove), всеки подаващ isLeavingBase: sourceIsHome')

  const sourceIsHomeDeclarations = (controllerSrc.match(/const sourceIsHome = parseLudoCellId\(fromCellId\)\.kind === 'home'/g) ?? []).length
  assertEqual(sourceIsHomeDeclarations, 2, 'sourceIsHome трябва да остане established изчисление (по едно на всеки от двата move-presentation пътя), не ново/трето')
})

// ─── T4: home->track route е точно 1 стъпка, без междинни клетки ──────────

check('[T4] buildLudoMoveRoute(home, track) връща route с точно 1 елемент (без междинни клетки)', () => {
  assert(
    routeSrc.includes('home -> track (излизане от базата) — единичен скок, няма междинни'),
    'route builder-ът трябва да документира home->track като единичен скок',
  )
  assert(/return \[toCellId\]/.test(routeSrc), 'home->track клонът трябва да връща [toCellId] — точно 1 елемент')
})

// ─── T5: приоритет спрямо triangle-entry/star-landing/pawn-step ───────────

check('[T5] Приоритет: isGameWinningMove > isLeavingBase > triangle-entry > star-landing > pawn-step', () => {
  // Търсим РЕАЛНИТЕ if/else-if условия (не doc коментарите по-горе в
  // файла, които също споменават същите идентификатори в прозата си).
  const winIdx = overlaySrc.indexOf('if (isFinalStep && options.isGameWinningMove)')
  const leaveIdx = overlaySrc.indexOf('stepIndex === 0 && options.isLeavingBase)')
  const triangleIdx = overlaySrc.indexOf('isFinalStep && isCenterTriangleCell(cellId)')
  const starIdx = overlaySrc.indexOf('isFinalStep && LUDO_SAFE_CELL_ID_SET.has(cellId)')
  assert(
    winIdx !== -1 && leaveIdx !== -1 && triangleIdx !== -1 && starIdx !== -1 &&
    winIdx < leaveIdx && leaveIdx < triangleIdx && triangleIdx < starIdx,
    `клоновете трябва да са в established priority ред (win < leave-base < triangle < star), намерени позиции: ${JSON.stringify({ winIdx, leaveIdx, triangleIdx, starIdx })}`,
  )
})

// ─── T6: reconnect/tab-hidden catch-up никога не вика overlay-а ───────────

check('[T6] snapToAuthoritativeSnapshot (reconnect/tab-hidden resync) НИКОГА не вика playLudoMoveRouteOverlay', () => {
  const fnStart = controllerSrc.indexOf('function snapToAuthoritativeSnapshot(snapshot: LudoGameStateSnapshot): void {')
  assert(fnStart !== -1, 'snapToAuthoritativeSnapshot трябва да съществува')
  const fnEnd = controllerSrc.indexOf('\n  }', fnStart)
  const fnBody = controllerSrc.slice(fnStart, fnEnd)
  assert(!fnBody.includes('playLudoMoveRouteOverlay'), 'silent catch-up пътят не трябва да пуска move route overlay/звук изобщо — само engineState/render()')
  assert(fnBody.includes('engineState = snapshot.state'), 'catch-up-ът трябва directно да презапише engineState (без presentation)')
})

// ─── T7: revision guard пази срещу повторна обработка на СЪЩИЯ snapshot ───

check('[T7] applyAuthoritativeTransition пропуска вече-presented revision (защита срещу duplicate звук при повторна доставка)', () => {
  assert(
    controllerSrc.includes('if (snapshot.revision <= authoritativeRevision) return'),
    'трябва да съществува revision-gate guard-ът, който пази presentAuthoritativeMove от повторно изпълнение за вече обработен snapshot',
  )
})

// ─── T8: поведенчески — 4-те изисквани сценария ────────────────────────────

check('[T8] Поведенчески: pure replica на priority decision-а дава правилния звук за 4-те изисквани сценария', () => {
  // ТОЧНО mirror на реалния route loop-ов if/else-if chain (виж [T5] по-горе
  // за source-text доказателство, че редът съвпада).
  type Sound = 'end-game' | 'exit-base' | 'triangle-entry' | 'star-landing' | 'pawn-step'
  function decideSound(params: {
    stepIndex: number
    isFinalStep: boolean
    isGameWinningMove: boolean
    isLeavingBase: boolean
    isCenterTriangleCell: boolean
    isSafeCell: boolean
  }): Sound {
    if (params.isFinalStep && params.isGameWinningMove) return 'end-game'
    if (params.stepIndex === 0 && params.isLeavingBase) return 'exit-base'
    if (params.isFinalStep && params.isCenterTriangleCell) return 'triangle-entry'
    if (params.isFinalStep && params.isSafeCell) return 'star-landing'
    return 'pawn-step'
  }

  // Сценарий 1: base -> start след 6 (единствена route стъпка, isLeavingBase
  // подадено explicit) -> exit-base звукът, дори собственото start поле да Е
  // canonical safe/star cell (isSafeCell:true тук нарочно, за да докаже
  // priority-а над star-landing).
  assertEqual(
    decideSound({ stepIndex: 0, isFinalStep: true, isGameWinningMove: false, isLeavingBase: true, isCenterTriangleCell: false, isSafeCell: true }),
    'exit-base',
    'base->start след 6 трябва да пусне exit-base звука, дори ако destination-ът е safe/star cell',
  )

  // Сценарий 2: нормален track->track ход, чиято ЕДИНСТВЕНА/финална стъпка
  // Е чуждото/собственото start поле (canonical safe cell), НО isLeavingBase
  // е false (пионката идва от track, не от home) -> established star-landing,
  // НЕ exit-base. Доказва "не го връзвай към координатата" — same cellId,
  // различен резултат заради различния gameplay action.
  assertEqual(
    decideSound({ stepIndex: 0, isFinalStep: true, isGameWinningMove: false, isLeavingBase: false, isCenterTriangleCell: false, isSafeCell: true }),
    'star-landing',
    'нормален ход, завършващ на стартовото (safe) поле, БЕЗ да излиза от базата, трябва да остане established star-landing',
  )

  // Сценарий 3: нормално многостъпково движение, което ПРЕМИНАВА през
  // стартовото поле на средна (не финална) стъпка -> established pawn-step
  // на тази междинна стъпка, никога exit-base (isLeavingBase е false за
  // целия route, тъй като move-ът е track->track, не home->track).
  assertEqual(
    decideSound({ stepIndex: 1, isFinalStep: false, isGameWinningMove: false, isLeavingBase: false, isCenterTriangleCell: false, isSafeCell: true }),
    'pawn-step',
    'преминаване през стартовото поле по средата на по-дълъг ход трябва да остане established pawn-step',
  )

  // Сценарий 4 (defensive/future-proof): дори ако isLeavingBase остане true
  // за целия route (не би трябвало да се случи реално — home->track route е
  // винаги точно 1 стъпка, виж [T4]), само stepIndex===0 получава exit-base;
  // всяка следваща стъпка пада обратно към established решението.
  assertEqual(
    decideSound({ stepIndex: 1, isFinalStep: true, isGameWinningMove: false, isLeavingBase: true, isCenterTriangleCell: false, isSafeCell: false }),
    'pawn-step',
    'isLeavingBase не трябва да влияе на стъпки след самото напускане (stepIndex!==0)',
  )
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
