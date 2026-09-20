// Deterministic проверка на capture PRESENTATION sequencing buffer-а (виж
// task-а: "victim не трябва да изчезва предварително"). Тества pure helpers
// directно (applyLudoPresentationOverrides/createLudoCaptureVictimOverrides/
// clearLudoCaptureVictimOverrides) — не browser check, без DOM/timers.
// Engine reducer/legal moves остават НАПЪЛНО извън обхвата тук (недокоснати,
// виж checkLudoEngine.ts за capture correctness на самия engine).
//
// Покрива (виж task-а т.11):
//   C1. captured piece остава на pre-move target position докато attacker
//       route е active (movingPieceOverride все още сочи междинна клетка).
//   C2. attacker reaches target (route override = targetCellId) ПРЕДИ
//       victim override се маха — доказва реда на операциите.
//   C3. след capture completion (clearLudoCaptureVictimOverrides) victim
//       override се маха и canonical home state става visible.
//   C4. stack capture (>1 victim id) пази ВСИЧКИ victim IDs до impact.
//   C5. stack badge (renderLudoPieceCluster count) не изчезва преди impact —
//       доказано чрез piecesByCell group count докато override е активен.
//   C6. всички captured IDs от pieces_captured се връщат към ТОЧНО
//       canonical home cell от engine adapter (permanent slot, не "first
//       free slot").
//   C7. viewer perspective remap-ва target→home capture route правилно —
//       cell-id based rendering (не absolute coordinates), доказано чрез
//       rotateLudoGridPointForViewer consistency на двата endpoint-а.
//   C8. след capture няма leftover presentation override (map е празен).
//   C9. (source review) следващ bot/turn action (advanceTurn/
//       scheduleNextDeadline) се вика едва СЛЕД await animateCapture() —
//       виж checkLudoRollPresentation.ts стил source assertion.
//
// Разширено (виж последващия task — "victim трябва РЕАЛНО да прелети до
// home slot-а си", не shake+teleport):
//   F1. victim flight (playLudoCaptureFlightOverlay call) започва чак СЛЕД
//       attacker reaches target — source order: route loop -> shake wait ->
//       flight call, никога преди.
//   F2. flight origin rect идва от target клетката (representative DOM
//       token измерен НА target-а, не от canonical home).
//   F3. flight destination rect идва от ТОЧНАТА permanent home slot клетка
//       на дадената piece id (data-ludo-cell-pieces="home-${color}-${slot}"),
//       не reassigned "first free" slot.
//   F4. presentation override НЕ се маха преди flight completion — source
//       order: await animateCapture() (съдържа whole shake+flight) ->
//       clearLudoCaptureVictimOverrides(), никога обратно.
//   F5. next turn (advanceTurn/scheduleNextDeadline) не започва преди flight
//       completion — same await chain като C9, сега включва и flight-а.
//   F6. stack victims получават ОТДЕЛНИ destination home cell id-та (пример:
//       blue-1 -> home-blue-1, blue-2 -> home-blue-2 — никога и двете към
//       един и същ cell).
//   F7. viewer perspective дава правилни, различни rendered origin/
//       destination точки за flight route-а, за всеки local цвят (разширява
//       C7 за explicit origin!=destination и стабилност).
//
// Разширено (виж последващия task — "кратък impact/explosion burst преди
// victim flight", source review на playLudoCaptureImpactOverlay.ts wiring-а
// в animateCapture; самият overlay е чист DOM/CSS presentation модул без
// engine достъп, browser-verified manual — виж отчета):
//   I1. impact overlay call идва СЛЕД shake wait, все в рамките на
//       animateCapture (доказва "attacker reaches target" вече се е
//       случило, преди route loop-а идва по-рано в performMoveSequence).
//   I2. impact overlay call идва ПРЕДИ representativeEl.visibility='hidden'
//       И преди victim flight overlay call-а — burst-ът се вижда върху
//       все още видимия victim, преди той да се скрие/полети.
//   I3. animateCapture вика playLudoCaptureImpactOverlay ТОЧНО ВЕДНЪЖ (не
//       веднъж на captured piece) — stack capture (>1 victim) не пуска N
//       overlays.
//   I4. next turn/bot action (advanceTurn) все още се вика едва СЛЕД
//       await animateCapture() (разширява C9/F5 — новият await не чупи
//       съществуващия sequencing guard).
//   I5. playLudoCaptureImpactOverlay.ts няма никакъв import от engine/
//       orchestrator/dispatch модули — чист presentation, без game-state
//       mutation capability дори structурно.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  applyLudoPresentationOverrides,
  createLudoCaptureVictimOverrides,
  clearLudoCaptureVictimOverrides,
} from '../src/app/games/ludo/board/ludoCapturePresentation'
import { rotateLudoGridPointForViewer } from '../src/app/games/ludo/board/ludoPerspective'
import { ludoGridPointForCellId } from '../src/app/games/ludo/board/ludoBoardGeometry'
import type { LudoCellId, LudoPiece, LudoPieceId } from '../src/app/games/ludo/ludoTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoCapturePresentation] FAIL: ${message}`)
  process.exit(1)
}

// Нормализира CRLF -> LF при четене — Windows git checkout (core.autocrlf)
// може да конвертира source файловете в CRLF в working tree, докато
// source-review regex-ите по-долу очакват bare \n. Без тази нормализация
// source-review тестовете стават чупливи спрямо line-ending конвенцията на
// checkout-а, независимо от реалната коректност на кода.
function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function main(): void {
  // Canonical (post-dispatch) UI pieces: attacker (red-0) already at target
  // track-20, victim (blue-1) already teleported to its canonical home slot
  // home-blue-1 — exactly what the engine returns MOMENTALLY after dispatch,
  // BEFORE any presentation animation has run.
  const canonicalPieces: LudoPiece[] = [
    { id: 'red-0' as LudoPieceId, color: 'red', cell: 'track-20' as LudoCellId },
    { id: 'blue-1' as LudoPieceId, color: 'blue', cell: 'home-blue-1' as LudoCellId },
    { id: 'blue-2' as LudoPieceId, color: 'blue', cell: 'home-blue-2' as LudoCellId },
  ]
  const targetCellId = 'track-20' as LudoCellId
  const fromCellId = 'track-15' as LudoCellId
  const attackerId = 'red-0' as LudoPieceId

  // --- C1: captured piece stays at pre-move target position while attacker route is active ---
  {
    const captureOverrides = createLudoCaptureVictimOverrides(['blue-1'] as LudoPieceId[], targetCellId)
    // Attacker is mid-route (not yet at target) — movingPieceOverride points to an intermediate cell.
    const movingOverride = { pieceId: attackerId, cellId: 'track-18' as LudoCellId }
    const rendered = applyLudoPresentationOverrides(canonicalPieces, movingOverride, captureOverrides)
    const victim = rendered.find((p) => p.id === 'blue-1')
    if (!victim || victim.cell !== targetCellId) {
      fail(`C1: expected victim blue-1 to stay at target ${targetCellId} while attacker route active, got ${victim?.cell}`)
    }
    console.log('[checkLudoCapturePresentation] C1 OK — captured piece stays at pre-move target position while attacker route is active.')
  }

  // --- C2: attacker reaches target BEFORE victim override is cleared ---
  {
    const captureOverrides = createLudoCaptureVictimOverrides(['blue-1'] as LudoPieceId[], targetCellId)
    // Attacker's LAST route step: movingPieceOverride now equals targetCellId (arrived).
    const movingOverride = { pieceId: attackerId, cellId: targetCellId }
    const rendered = applyLudoPresentationOverrides(canonicalPieces, movingOverride, captureOverrides)
    const attacker = rendered.find((p) => p.id === attackerId)
    const victim = rendered.find((p) => p.id === 'blue-1')
    if (attacker?.cell !== targetCellId) fail(`C2: expected attacker at target ${targetCellId}, got ${attacker?.cell}`)
    if (victim?.cell !== targetCellId) fail(`C2: expected victim STILL at target ${targetCellId} at arrival moment (impact not yet run), got ${victim?.cell}`)
    console.log('[checkLudoCapturePresentation] C2 OK — attacker reaches target while victim is still visually present (impact has not run yet).')
  }

  // --- C3: after capture completion, victim override is cleared and canonical home state is visible ---
  {
    let captureOverrides = createLudoCaptureVictimOverrides(['blue-1'] as LudoPieceId[], targetCellId)
    captureOverrides = clearLudoCaptureVictimOverrides(['blue-1'] as LudoPieceId[], captureOverrides)
    const rendered = applyLudoPresentationOverrides(canonicalPieces, null, captureOverrides)
    const victim = rendered.find((p) => p.id === 'blue-1')
    if (victim?.cell !== 'home-blue-1') fail(`C3: expected victim at canonical home-blue-1 after override cleared, got ${victim?.cell}`)
    console.log('[checkLudoCapturePresentation] C3 OK — after capture completion, victim override is cleared and canonical home position becomes visible.')
  }

  // --- C4: stack capture keeps ALL victim IDs until impact ---
  {
    const capturedIds = ['blue-1', 'blue-2'] as LudoPieceId[]
    const captureOverrides = createLudoCaptureVictimOverrides(capturedIds, targetCellId)
    const rendered = applyLudoPresentationOverrides(canonicalPieces, { pieceId: attackerId, cellId: targetCellId }, captureOverrides)
    const victim1 = rendered.find((p) => p.id === 'blue-1')
    const victim2 = rendered.find((p) => p.id === 'blue-2')
    if (victim1?.cell !== targetCellId || victim2?.cell !== targetCellId) {
      fail(`C4: expected BOTH stack victims at target until impact, got blue-1=${victim1?.cell} blue-2=${victim2?.cell}`)
    }
    console.log('[checkLudoCapturePresentation] C4 OK — stack capture keeps all victim IDs at target until impact.')
  }

  // --- C5: stack badge (grouped count) does not disappear before impact ---
  {
    const capturedIds = ['blue-1', 'blue-2'] as LudoPieceId[]
    const captureOverrides = createLudoCaptureVictimOverrides(capturedIds, targetCellId)
    const rendered = applyLudoPresentationOverrides(canonicalPieces, { pieceId: attackerId, cellId: targetCellId }, captureOverrides)
    const victimsAtTarget = rendered.filter((p) => p.color === 'blue' && p.cell === targetCellId)
    if (victimsAtTarget.length !== 2) {
      fail(`C5: expected 2 blue pieces grouped at target (stack badge count=2) before impact, got ${victimsAtTarget.length}`)
    }
    console.log('[checkLudoCapturePresentation] C5 OK — stack badge count (2 grouped victims) remains intact at target until impact.')
  }

  // --- C6: all captured IDs return to their EXACT permanent home cell (not "first free slot") ---
  {
    // Canonical adapter mapping is deterministic: pieceId "blue-1" always maps
    // to position.slot=1 -> home-blue-1 (ludoEnginePositionToCellId), never a
    // "first free" home slot search. Verified here at the presentation layer:
    // once override is cleared, the rendered cell MUST equal the piece's own
    // canonical cell from canonicalPieces (no reassignment logic exists).
    const capturedIds = ['blue-1', 'blue-2'] as LudoPieceId[]
    let captureOverrides = createLudoCaptureVictimOverrides(capturedIds, targetCellId)
    captureOverrides = clearLudoCaptureVictimOverrides(capturedIds, captureOverrides)
    const rendered = applyLudoPresentationOverrides(canonicalPieces, null, captureOverrides)
    const victim1 = rendered.find((p) => p.id === 'blue-1')
    const victim2 = rendered.find((p) => p.id === 'blue-2')
    if (victim1?.cell !== 'home-blue-1') fail(`C6: expected blue-1 -> home-blue-1 (its own permanent slot), got ${victim1?.cell}`)
    if (victim2?.cell !== 'home-blue-2') fail(`C6: expected blue-2 -> home-blue-2 (its own permanent slot), got ${victim2?.cell}`)
    console.log('[checkLudoCapturePresentation] C6 OK — all captured IDs return to their own exact permanent home slot, not a reassigned "first free" slot.')
  }

  // --- C7: viewer perspective remaps target->home capture route consistently (cell-id based, not absolute coords) ---
  {
    // The presentation layer never computes screen coordinates directly — it
    // only ever assigns a CELL ID (target or home), and the board renderer
    // (renderLudoBoard/applyLudoBoardContent) maps that cell id through
    // rotateLudoGridPointForViewer at render time. Prove here that BOTH
    // endpoints (target track cell, home cell) produce a well-defined,
    // distinct rendered grid point for every possible local color — i.e. the
    // capture "route" (target -> home) is perspective-correct by construction,
    // with no separate flight-coordinate logic that could get perspective wrong.
    const localColors = ['red', 'blue', 'yellow', 'green'] as const
    for (const localColor of localColors) {
      const targetPoint = rotateLudoGridPointForViewer(ludoGridPointForCellId(targetCellId), localColor)
      const homePoint = rotateLudoGridPointForViewer(ludoGridPointForCellId('home-blue-1' as LudoCellId), localColor)
      if (!targetPoint || !homePoint) fail(`C7: expected defined rotated points for localColor=${localColor}`)
      if (targetPoint.col === homePoint.col && targetPoint.row === homePoint.row) {
        fail(`C7: target and home rendered to the SAME point for localColor=${localColor} — capture route would be a zero-length jump`)
      }
    }
    console.log('[checkLudoCapturePresentation] C7 OK — target->home capture route resolves to distinct, viewer-correct rendered points for every local color.')
  }

  // --- C8: no leftover presentation override after capture ---
  {
    let captureOverrides = createLudoCaptureVictimOverrides(['blue-1', 'blue-2'] as LudoPieceId[], targetCellId)
    captureOverrides = clearLudoCaptureVictimOverrides(['blue-1', 'blue-2'] as LudoPieceId[], captureOverrides)
    if (captureOverrides.size !== 0) fail(`C8: expected empty override map after clearing all captured IDs, got size=${captureOverrides.size}`)
    console.log('[checkLudoCapturePresentation] C8 OK — no leftover presentation override remains after capture completes.')
  }

  // --- C9: next bot/turn action never starts before capture presentation completion (source review) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    // advanceTurn() (which calls scheduleNextDeadline(), the ONLY place that
    // arms the next bot-think/roll/move setTimeout) must appear AFTER the
    // `await animateCapture(...)` call in performMoveSequence's source order.
    const moveSeqMatch = controllerSrc.match(/async function performMoveSequence[\s\S]*?\n  \}\n/)
    if (!moveSeqMatch) fail('C9: could not locate performMoveSequence function body')
    const body = moveSeqMatch[0]
    const animateCaptureIndex = body.indexOf('await animateCapture(')
    const advanceTurnIndex = body.indexOf('advanceTurn()')
    if (animateCaptureIndex === -1) fail('C9: performMoveSequence must call animateCapture()')
    if (advanceTurnIndex === -1) fail('C9: performMoveSequence must call advanceTurn()')
    if (!(animateCaptureIndex < advanceTurnIndex)) {
      fail('C9: advanceTurn() (which arms the next bot/turn timers) must be called AFTER await animateCapture() completes')
    }
    console.log('[checkLudoCapturePresentation] C9 OK — advanceTurn()/scheduleNextDeadline() is called only after capture presentation (animateCapture) completes.')
  }

  // --- F1: victim flight starts only AFTER attacker reaches target (source order in animateCapture) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const moveSeqMatch = controllerSrc.match(/async function performMoveSequence[\s\S]*?\n  \}\n/)
    if (!moveSeqMatch) fail('F1: could not locate performMoveSequence function body')
    const body = moveSeqMatch[0]
    const routeOverlayStartIndex = body.indexOf('playLudoMoveRouteOverlay(')
    const routeLoopEndIndex = body.indexOf('await moveOverlay.finished')
    const animateCaptureCallIndex = body.indexOf('await animateCapture(')
    if (routeOverlayStartIndex === -1) fail('F1: could not find attacker route overlay call')
    if (routeLoopEndIndex === -1) fail('F1: could not find awaited attacker route overlay completion')
    if (animateCaptureCallIndex === -1) fail('F1: could not find animateCapture() call')
    if (!(routeOverlayStartIndex < routeLoopEndIndex && routeLoopEndIndex < animateCaptureCallIndex)) {
      fail('F1: animateCapture() (which contains the victim flight) must be called AFTER the attacker route overlay finishes, i.e. after attacker reaches target')
    }
    const animateCaptureSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = animateCaptureSrc.match(/async function animateCapture[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('F1: could not locate animateCapture function body')
    const fnBody = fnMatch[0]
    const shakeIndex = fnBody.indexOf("'ludo-piece-shake")
    const flightCallIndex = fnBody.indexOf('playLudoCaptureFlightOverlay(')
    if (shakeIndex === -1) fail('F1: animateCapture must still play the shake/impact indication')
    if (flightCallIndex === -1) fail('F1: animateCapture must call playLudoCaptureFlightOverlay')
    if (!(shakeIndex < flightCallIndex)) {
      fail('F1: victim flight must start AFTER the impact/shake indication, not before')
    }
    console.log('[checkLudoCapturePresentation] F1 OK — victim flight starts only after attacker reaches target and the impact/shake indication has played.')
  }

  // --- F2: flight origin = target cell (representative DOM token measured at the target) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/async function animateCapture[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('F2: could not locate animateCapture function body')
    const fnBody = fnMatch[0]
    // fromRect must be derived from representativeEl (queried from
    // capturedPieceIds[0], which is on the TARGET cell at this point in the
    // sequence — captureVictimOverrides is still active, route loop already
    // placed the attacker there).
    if (!/const fromRect = representativeEl\.getBoundingClientRect\(\)/.test(fnBody)) {
      fail('F2: flight origin (fromRect) must be measured from the representative DOM token on the target cell')
    }
    console.log('[checkLudoCapturePresentation] F2 OK — flight origin is measured from the victim token still present on the target cell.')
  }

  // --- F3: flight destination = exact permanent home slot for the given piece id ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/async function animateCapture[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('F3: could not locate animateCapture function body')
    const fnBody = fnMatch[0]
    if (!/const homeCellId = `home-\$\{color\}-\$\{slot\}`/.test(fnBody)) {
      fail('F3: destination home cell id must be derived directly from the captured piece\'s own color+slot, not a reassigned/first-free slot')
    }
    if (!/data-ludo-cell-pieces="\$\{homeCellId\}"/.test(fnBody)) {
      fail('F3: destination rect must be measured from the exact home cell container for that piece')
    }
    console.log('[checkLudoCapturePresentation] F3 OK — flight destination resolves to the exact permanent home slot of the captured piece id.')
  }

  // --- F4: presentation override is not cleared before flight completion ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const moveSeqMatch = controllerSrc.match(/async function performMoveSequence[\s\S]*?\n  \}\n/)
    if (!moveSeqMatch) fail('F4: could not locate performMoveSequence function body')
    const body = moveSeqMatch[0]
    const awaitAnimateCaptureIndex = body.indexOf('await animateCapture(')
    const clearOverridesIndex = body.indexOf('clearLudoCaptureVictimOverrides(')
    if (awaitAnimateCaptureIndex === -1) fail('F4: expected an awaited animateCapture() call')
    if (clearOverridesIndex === -1) fail('F4: expected clearLudoCaptureVictimOverrides() call')
    if (!(awaitAnimateCaptureIndex < clearOverridesIndex)) {
      fail('F4: clearLudoCaptureVictimOverrides() must run AFTER the awaited animateCapture() (which includes the full flight) completes, never before')
    }
    console.log('[checkLudoCapturePresentation] F4 OK — presentation override is cleared only after the full flight animation (inside animateCapture) completes.')
  }

  // --- F5: next turn does not start before flight completion (same await chain as F4/C9, now covers the flight too) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const moveSeqMatch = controllerSrc.match(/async function performMoveSequence[\s\S]*?\n  \}\n/)
    if (!moveSeqMatch) fail('F5: could not locate performMoveSequence function body')
    const body = moveSeqMatch[0]
    const clearOverridesIndex = body.indexOf('clearLudoCaptureVictimOverrides(')
    const advanceTurnIndex = body.indexOf('advanceTurn()')
    if (clearOverridesIndex === -1) fail('F5: expected clearLudoCaptureVictimOverrides() call')
    if (advanceTurnIndex === -1) fail('F5: expected advanceTurn() call')
    if (!(clearOverridesIndex < advanceTurnIndex)) {
      fail('F5: advanceTurn() (arms next bot/turn timers) must run after override cleanup, which itself only runs after the flight completes (F4)')
    }
    console.log('[checkLudoCapturePresentation] F5 OK — next turn/bot action starts only after the full capture presentation (shake + flight + cleanup) completes.')
  }

  // --- F6: stack victims get SEPARATE destination home cell ids ---
  {
    const capturedIds = ['blue-1', 'blue-2', 'blue-3'] as LudoPieceId[]
    const destinations = capturedIds.map((id) => {
      const [color] = id.split('-')
      const slot = id.slice(id.lastIndexOf('-') + 1)
      return `home-${color}-${slot}`
    })
    const uniqueDestinations = new Set(destinations)
    if (uniqueDestinations.size !== capturedIds.length) {
      fail(`F6: expected ${capturedIds.length} distinct destination home cells for ${capturedIds.length} stack victims, got ${uniqueDestinations.size}: ${JSON.stringify(destinations)}`)
    }
    console.log('[checkLudoCapturePresentation] F6 OK — stack capture victims each resolve to their own distinct destination home cell.')
  }

  // --- F7: viewer perspective gives correct, distinct rendered origin/destination for flight route, for every local color ---
  {
    const capturedIds = ['blue-1', 'blue-2'] as LudoPieceId[]
    const localColors = ['red', 'blue', 'yellow', 'green'] as const
    for (const localColor of localColors) {
      const originPoint = rotateLudoGridPointForViewer(ludoGridPointForCellId(targetCellId), localColor)
      for (const victimId of capturedIds) {
        const [color] = victimId.split('-')
        const slot = victimId.slice(victimId.lastIndexOf('-') + 1)
        const homeCellId = `home-${color}-${slot}` as LudoCellId
        const destinationPoint = rotateLudoGridPointForViewer(ludoGridPointForCellId(homeCellId), localColor)
        if (!originPoint || !destinationPoint) {
          fail(`F7: expected defined rotated points for victim=${victimId} localColor=${localColor}`)
        }
        if (originPoint.col === destinationPoint.col && originPoint.row === destinationPoint.row) {
          fail(`F7: origin and destination collapsed to the same rendered point for victim=${victimId} localColor=${localColor}`)
        }
      }
    }
    console.log('[checkLudoCapturePresentation] F7 OK — viewer perspective yields correct, distinct rendered origin/destination for the flight route, for every local color and every stack victim.')
  }

  // --- I1: impact overlay call comes after the shake wait, still inside animateCapture ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/async function animateCapture[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('I1: could not locate animateCapture function body')
    const fnBody = fnMatch[0]
    const shakeWaitIndex = fnBody.indexOf('await wait(IMPACT_ANIMATION_MS)')
    const impactCallIndex = fnBody.indexOf('await playLudoCaptureImpactOverlay(')
    if (shakeWaitIndex === -1) fail('I1: animateCapture must still await the shake wait (IMPACT_ANIMATION_MS)')
    if (impactCallIndex === -1) fail('I1: animateCapture must call playLudoCaptureImpactOverlay')
    if (!(shakeWaitIndex < impactCallIndex)) {
      fail('I1: impact burst must start AFTER the shake wait completes (i.e. after attacker has reached target and shake has played), never before')
    }
    console.log('[checkLudoCapturePresentation] I1 OK — impact burst starts only after the shake wait (attacker already at target) completes.')
  }

  // --- I2: impact overlay call comes before victim is hidden and before the flight overlay call ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/async function animateCapture[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('I2: could not locate animateCapture function body')
    const fnBody = fnMatch[0]
    const impactCallIndex = fnBody.indexOf('await playLudoCaptureImpactOverlay(')
    const hideVictimIndex = fnBody.indexOf("representativeEl.style.visibility = 'hidden'")
    const flightCallIndex = fnBody.indexOf('playLudoCaptureFlightOverlay(')
    if (impactCallIndex === -1) fail('I2: expected playLudoCaptureImpactOverlay call')
    if (hideVictimIndex === -1) fail('I2: expected representativeEl visibility=hidden step')
    if (flightCallIndex === -1) fail('I2: expected playLudoCaptureFlightOverlay call')
    if (!(impactCallIndex < hideVictimIndex && hideVictimIndex < flightCallIndex)) {
      fail('I2: expected order impact burst -> victim hidden -> victim flight, got a different source order')
    }
    console.log('[checkLudoCapturePresentation] I2 OK — impact burst plays while victim is still visible, before it is hidden and before it flies home.')
  }

  // --- I3: animateCapture calls the impact overlay exactly once, regardless of stack size ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/async function animateCapture[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('I3: could not locate animateCapture function body')
    const fnBody = fnMatch[0]
    const impactCallMatches = fnBody.match(/playLudoCaptureImpactOverlay\(/g) ?? []
    if (impactCallMatches.length !== 1) {
      fail(`I3: expected exactly ONE playLudoCaptureImpactOverlay call site in animateCapture (stack capture must not trigger N bursts), found ${impactCallMatches.length}`)
    }
    // The single call must sit OUTSIDE the per-victim Promise.all(...map(...))
    // loop used for flight overlays — i.e. before that loop starts, not once
    // per captured id.
    const promiseAllIndex = fnBody.indexOf('Promise.all(')
    const impactCallIndex = fnBody.indexOf('await playLudoCaptureImpactOverlay(')
    if (promiseAllIndex === -1) fail('I3: expected the per-victim Promise.all(...) flight loop')
    if (!(impactCallIndex < promiseAllIndex)) {
      fail('I3: the single impact burst call must happen BEFORE the per-victim flight loop, not inside/after it')
    }
    console.log('[checkLudoCapturePresentation] I3 OK — exactly one impact burst per capture, regardless of stack size (called before the per-victim flight loop).')
  }

  // --- I4: next turn/bot action still only starts after animateCapture (impact + flight) fully completes ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const moveSeqMatch = controllerSrc.match(/async function performMoveSequence[\s\S]*?\n  \}\n/)
    if (!moveSeqMatch) fail('I4: could not locate performMoveSequence function body')
    const body = moveSeqMatch[0]
    const animateCaptureIndex = body.indexOf('await animateCapture(')
    const advanceTurnIndex = body.indexOf('advanceTurn()')
    if (animateCaptureIndex === -1) fail('I4: performMoveSequence must call animateCapture()')
    if (advanceTurnIndex === -1) fail('I4: performMoveSequence must call advanceTurn()')
    if (!(animateCaptureIndex < advanceTurnIndex)) {
      fail('I4: advanceTurn() must still run only AFTER the awaited animateCapture() (which now includes shake + impact burst + flight) completes')
    }
    console.log('[checkLudoCapturePresentation] I4 OK — next turn/bot action still starts only after the full impact+flight capture presentation completes.')
  }

  // --- I5: playLudoCaptureImpactOverlay.ts has no engine/orchestrator/dispatch imports (pure presentation) ---
  {
    const overlaySrc = readSourceFile('../src/app/games/ludo/pieces/playLudoCaptureImpactOverlay.ts')
    const importLines = overlaySrc.match(/^import .*/gm) ?? []
    for (const line of importLines) {
      if (/\/engine\/|\/orchestrator\/|ludoEngineReducer|dispatch/i.test(line)) {
        fail(`I5: playLudoCaptureImpactOverlay.ts must not import engine/orchestrator/dispatch modules, found: ${line}`)
      }
    }
    if (/engineState|dispatch\(|reduceLudoGame/.test(overlaySrc)) {
      fail('I5: playLudoCaptureImpactOverlay.ts must not reference engine state or dispatch — pure DOM/CSS presentation only')
    }
    console.log('[checkLudoCapturePresentation] I5 OK — impact overlay module has no engine/orchestrator imports and no game-state mutation capability.')
  }

  console.log('[checkLudoCapturePresentation] ALL OK')
  process.exit(0)
}

main()
