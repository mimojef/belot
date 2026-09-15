// Deterministic проверка на "ВЪРНИ СЕ" reclaim flow-а (виж task-а: bot
// takeover-ът беше sticky — местото никога не се връщаше на local human).
// Комбинира pure orchestrator тестове (markLudoColorBotControlled/
// resumeLudoHumanControl — вече съществуващи helpers, вече използвани в
// checkLudoOrchestrator.ts TIMER5/Bonus) с source-review проверки на
// новата safe-reclaim логика в createLudoFlowController.ts (кога reclaim-ът
// реално се прилага, guard-а срещу прекъсване на активна bot анимация,
// popup button text/behavior wiring).
//
// Покрива (виж task-а т.9):
//   R1.  human move timeout -> temporary bot takeover = true -> popup visible.
//   R2.  button label = "Върни се".
//   R3.  click "Върни се" -> temporary bot takeover се отменя
//        (resumeLudoHumanControl removes the color from botControlledColors).
//   R4.  true bot players (never local) не се променят от resumeLudoHumanControl.
//   R5.  ако bot action вече е започнало (isAnimatingMove/isDiceRolling),
//        reclaim НЕ прекъсва текущия sequence — source review потвърждава
//        guard-а вътре в scheduleNextDeadline() е turnPhase==='waiting_for_roll'
//        specific, не безусловно.
//   R6.  след текущия sequence следващата human decision phase е
//        human-controlled (pendingHumanReclaimColor се consume-ва в
//        scheduleNextDeadline(), единствената точка, викана само на вече
//        завършени state transitions).
//   R7.  след reclaim нормалните 10s/15s deadlines отново работят
//        (computeLudoDeadlineStateForPhase се вика СЛЕД reclaim-а е
//        приложен, четейки актуализирания orchestrator.botControlledColors).
//   R8.  при нов timeout takeover може да се случи отново
//        (markLudoColorBotControlled след resumeLudoHumanControl работи
//        нормално — не е permanently disabled).
//   R9.  popup/overlay hidden state (areGameplayOverlaysHiddenForPopup,
//        diceResultOverlay.setHidden) се clean-up-ва при click, идентично
//        на стария dismiss handler.
//   R10. няма duplicate roll/move/turn advance — pendingHumanReclaimColor
//        се null-ва веднага след consume, reclaim guard-ът explicit проверява
//        pendingHumanReclaimColor === engineState.activeColor (никога не
//        reclaim-ва грешен/друг цвят).
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createLudoOrchestratorInitialState,
  resolveLudoPendingDeadlineKind,
  LUDO_ROLL_TIMEOUT_MS,
  LUDO_MOVE_TIMEOUT_MS,
} from '../src/app/games/ludo/orchestrator/ludoOrchestratorTypes'
import {
  computeLudoDeadlineStateForPhase,
  markLudoColorBotControlled,
  resumeLudoHumanControl,
} from '../src/app/games/ludo/orchestrator/ludoDeadline'
import type { LudoColor } from '../src/app/games/ludo/engine/ludoEngineTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoReclaimFlow] FAIL: ${message}`)
  process.exit(1)
}

// Нормализира CRLF -> LF при четене (виж checkLudoCapturePresentation.ts/
// checkLudoTimerPresentation.ts коментара за пълния rationale — Windows git
// checkout autocrlf прави source-review regex-ите чупливи иначе).
function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function main(): void {
  const NOW = 2_000_000
  const LOCAL_COLOR: LudoColor = 'red'
  const TRUE_BOT_COLORS: LudoColor[] = ['blue', 'yellow', 'green']

  // --- R1: human move timeout -> temporary bot takeover = true (orchestrator level) ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    if (orchestrator.botControlledColors.has(LOCAL_COLOR)) {
      fail('R1: local color must NOT start bot-controlled')
    }
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    if (!orchestrator.botControlledColors.has(LOCAL_COLOR)) {
      fail('R1: expected local color to become bot-controlled after move timeout (markLudoColorBotControlled)')
    }
    console.log('[checkLudoReclaimFlow] R1 OK — human move timeout marks local color as (temporary) bot-controlled.')

    // Popup visibility itself is a controller-level boolean (showBotTakeoverPopup)
    // set in handleMoveTimeout — verified via source review here.
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    if (!/async function handleMoveTimeout[\s\S]*?showBotTakeoverPopup = true/.test(controllerSrc)) {
      fail('R1: handleMoveTimeout must set showBotTakeoverPopup = true')
    }
    console.log('[checkLudoReclaimFlow] R1 OK — handleMoveTimeout shows the bot-takeover popup.')
  }

  // --- R2: button label = "Върни се" ---
  {
    const popupSrc = readSourceFile('../src/app/games/ludo/renderLudoBotTakeoverPopup.ts')
    if (!/data-ludo-bot-takeover-dismiss="1"[\s\S]*?>Върни се<\/button>/.test(popupSrc)) {
      fail('R2: expected the bot-takeover popup button label to be "Върни се"')
    }
    if (/>Разбрах<\/button>/.test(popupSrc)) {
      fail('R2: old "Разбрах" label must no longer be present')
    }
    console.log('[checkLudoReclaimFlow] R2 OK — button label is "Върни се".')
  }

  // --- R3: resumeLudoHumanControl removes the color from botControlledColors ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    if (orchestrator.botControlledColors.has(LOCAL_COLOR)) {
      fail('R3: expected local color to no longer be bot-controlled after resumeLudoHumanControl')
    }
    console.log('[checkLudoReclaimFlow] R3 OK — "Върни се" (resumeLudoHumanControl) cancels the temporary bot takeover.')
  }

  // --- R4: true bot players are never touched by resumeLudoHumanControl ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    for (const trueBotColor of TRUE_BOT_COLORS) {
      if (!orchestrator.botControlledColors.has(trueBotColor)) {
        fail(`R4: expected true bot player ${trueBotColor} to remain bot-controlled after reclaiming a DIFFERENT color (local)`)
      }
    }
    // Also confirm resumeLudoHumanControl called with a true-bot color would
    // remove IT specifically — proving the function itself has no special-
    // cased "only local" logic; the SAFETY comes from the controller only
    // ever calling it with localColor (verified in R9/R10 source review),
    // not from the orchestrator helper itself refusing true bots.
    const removingATrueBot = resumeLudoHumanControl(orchestrator, TRUE_BOT_COLORS[0]!)
    if (removingATrueBot.botControlledColors.has(TRUE_BOT_COLORS[0]!)) {
      fail('R4: resumeLudoHumanControl must remove whatever color it is explicitly called with (generic helper)')
    }
    console.log('[checkLudoReclaimFlow] R4 OK — reclaiming local color leaves true bot players untouched; the safety is in the controller always calling this with localColor only.')
  }

  // --- R5: reclaim does not interrupt an already-started bot roll->move sequence (source review) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const scheduleFnMatch = controllerSrc.match(/function scheduleNextDeadline\(\): void \{[\s\S]*?\n  \}\n/)
    if (!scheduleFnMatch) fail('R5: could not locate scheduleNextDeadline function body')
    const body = scheduleFnMatch[0]
    if (!/pendingHumanReclaimColor !== null/.test(body)) {
      fail('R5: scheduleNextDeadline must check pendingHumanReclaimColor')
    }
    if (!/engineState\.turnPhase === 'waiting_for_roll'/.test(body)) {
      fail('R5: reclaim application must be guarded by turnPhase===\'waiting_for_roll\' — applying it during awaiting_move_selection would interrupt a bot that already rolled and is mid-move-selection')
    }
    // Confirm the guard appears BEFORE resumeLudoHumanControl is called —
    // i.e. the check gates the call, not the other way around.
    const guardIndex = body.indexOf("engineState.turnPhase === 'waiting_for_roll'")
    const resumeCallIndex = body.indexOf('resumeLudoHumanControl(')
    if (guardIndex === -1 || resumeCallIndex === -1 || !(guardIndex < resumeCallIndex)) {
      fail('R5: expected the waiting_for_roll guard to precede the resumeLudoHumanControl() call')
    }
    console.log('[checkLudoReclaimFlow] R5 OK — reclaim is only applied when turnPhase is waiting_for_roll, never interrupting an already-started bot roll->move sequence.')
  }

  // --- R6: next human decision phase is human-controlled after reclaim (state-level proof) ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    // Simulate: pending reclaim consumed at the next waiting_for_roll boundary.
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    const pending = resolveLudoPendingDeadlineKind('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (pending !== 'roll') {
      fail(`R6: expected pending='roll' (human deadline) for the local color's next waiting_for_roll after reclaim, got ${pending}`)
    }
    console.log('[checkLudoReclaimFlow] R6 OK — after reclaim, the next waiting_for_roll decision phase for local color is human-controlled (pending=\'roll\', not \'none\').')
  }

  // --- R7: normal 10s/15s deadlines re-arm after reclaim (computeLudoDeadlineStateForPhase reads the updated orchestrator) ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    const afterRollPhase = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', LOCAL_COLOR, 7, NOW)
    if (afterRollPhase.rollDeadlineAt !== NOW + LUDO_ROLL_TIMEOUT_MS) {
      fail(`R7: expected fresh 10s rollDeadlineAt after reclaim, got ${afterRollPhase.rollDeadlineAt}`)
    }
    const afterMovePhase = computeLudoDeadlineStateForPhase(orchestrator, 'awaiting_move_selection', LOCAL_COLOR, 8, NOW)
    if (afterMovePhase.moveDeadlineAt !== NOW + LUDO_MOVE_TIMEOUT_MS) {
      fail(`R7: expected fresh 15s moveDeadlineAt after reclaim, got ${afterMovePhase.moveDeadlineAt}`)
    }
    console.log('[checkLudoReclaimFlow] R7 OK — after reclaim, normal 10s roll / 15s move deadlines re-arm correctly (not derived from stale takeover state).')
  }

  // --- R8: a NEW timeout can mark the same color bot-controlled again after a previous reclaim ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    if (orchestrator.botControlledColors.has(LOCAL_COLOR)) fail('R8: expected local color to be human-controlled right after reclaim')
    // A second, later move timeout re-marks it — proving reclaim is not a
    // one-time "permanently exempt from takeover" flag.
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    if (!orchestrator.botControlledColors.has(LOCAL_COLOR)) {
      fail('R8: expected local color to become bot-controlled again on a SECOND move timeout after a previous reclaim')
    }
    console.log('[checkLudoReclaimFlow] R8 OK — after reclaim, a subsequent timeout can mark the local color bot-controlled again (repeatable).')
  }

  // --- R9: popup/overlay hidden state is cleaned up on "Върни се" click (source review) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const clickHandlerMatch = controllerSrc.match(
      /data-ludo-bot-takeover-dismiss="1"\]'\)\?\.addEventListener\('click', \(\) => \{[\s\S]*?\n    \}\)\n/,
    )
    if (!clickHandlerMatch) fail('R9: could not locate the bot-takeover dismiss button click handler')
    const handlerBody = clickHandlerMatch[0]
    if (!/showBotTakeoverPopup = false/.test(handlerBody)) fail('R9: click handler must set showBotTakeoverPopup = false')
    if (!/diceResultOverlay\.setHidden\(false\)/.test(handlerBody)) fail('R9: click handler must unhide the dice overlay (diceResultOverlay.setHidden(false))')
    if (!/areGameplayOverlaysHiddenForPopup = false/.test(handlerBody)) fail('R9: click handler must clear areGameplayOverlaysHiddenForPopup (capture impact/flight overlays)')
    if (!/data-ludo-bot-takeover-backdrop="1"[\s\S]*?remove\(\)/.test(handlerBody)) fail('R9: click handler must remove the popup backdrop element (no ghost popup)')
    console.log('[checkLudoReclaimFlow] R9 OK — "Върни се" click cleans up popup + gameplay overlay hidden-state exactly like the previous dismiss behavior.')
  }

  // --- R10: no duplicate roll/move/turn-advance — reclaim is consumed exactly once and only for the matching color ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const scheduleFnMatch = controllerSrc.match(/function scheduleNextDeadline\(\): void \{[\s\S]*?\n  \}\n/)
    if (!scheduleFnMatch) fail('R10: could not locate scheduleNextDeadline function body')
    const body = scheduleFnMatch[0]
    if (!/pendingHumanReclaimColor === engineState\.activeColor/.test(body)) {
      fail('R10: reclaim must only apply when pendingHumanReclaimColor matches the CURRENT activeColor — otherwise it could wrongly reclaim a different color\'s turn')
    }
    if (!/pendingHumanReclaimColor = null/.test(body)) {
      fail('R10: pendingHumanReclaimColor must be nulled out immediately after being consumed, to avoid re-applying it on a later unrelated waiting_for_roll')
    }
    // Consumption (the null assignment) must happen inside the SAME guarded
    // block as the resumeLudoHumanControl call — not as a separate, later
    // unconditional reset that could race with a second click.
    const guardBlockMatch = body.match(/if \(\s*\n\s*pendingHumanReclaimColor !== null[\s\S]*?\n\s*\)\s*\{[\s\S]*?\n\s*\}/)
    if (!guardBlockMatch) fail('R10: could not locate the guarded reclaim application block')
    if (!/pendingHumanReclaimColor = null/.test(guardBlockMatch[0])) {
      fail('R10: pendingHumanReclaimColor = null must be INSIDE the same guarded if-block as resumeLudoHumanControl, not a separate unconditional statement')
    }
    console.log('[checkLudoReclaimFlow] R10 OK — reclaim is consumed exactly once, only for the matching active color, preventing duplicate roll/move/turn-advance from a stale reclaim flag.')
  }

  console.log('[checkLudoReclaimFlow] ALL OK')
  process.exit(0)
}

main()
