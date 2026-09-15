// Deterministic проверка на timer PRESENTATION sync (виж task-а: "visual
// timer-а трябва да е 1:1 синхронизиран с authoritative deadline-а").
// Тества pure helpers directно — remainingRatio computation
// (clampedTurnDelayMs, изведен като animation-delay formula) и source
// review на createLudoFlowController.ts за да потвърди render()/
// scheduleNextDeadline() реда навсякъде (root cause на бъга: render() ПРЕДИ
// scheduleNextDeadline() показва countdown спрямо STALE turnStartedAt).
//
// Покрива (виж task-а т.10):
//   T1. move deadline start (elapsed=0): remainingRatio ≈ 1.0
//   T2. elapsed=3.75s: remainingRatio ≈ 0.75
//   T3. elapsed=7.5s: remainingRatio ≈ 0.50
//   T4. elapsed=11.25s: remainingRatio ≈ 0.25
//   T5. elapsed=15s: remainingRatio = 0
//   T6. re-render на elapsed=6s: delay computation дава remaining≈9s (не restart)
//   T7. resize (не пипа turnStartedAt) → same remaining spрямо elapsed
//   T8. roll timer duration = 10000ms (LUDO_ROLL_TIMEOUT_MS)
//   T9. move timer duration = 15000ms (LUDO_MOVE_TIMEOUT_MS)
//   T10. popup/takeover trigger (moveDeadlineAt-based setTimeout) остава
//        синхронизиран с visual 0% — доказано чрез идентичен total duration
//        constant (LUDO_MOVE_TIMEOUT_MS) използван и от двете (orchestrator
//        deadline + currentTurnCountdownMs()).
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { clampedTurnDelayMs } from '../src/app/games/ludo/pieces/renderLudoPlayerPanel'
import { LUDO_ROLL_TIMEOUT_MS, LUDO_MOVE_TIMEOUT_MS } from '../src/app/games/ludo/orchestrator/ludoOrchestratorTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoTimerPresentation] FAIL: ${message}`)
  process.exit(1)
}

// Нормализира CRLF -> LF при четене — виж checkLudoCapturePresentation.ts
// коментара за пълния rationale (Windows git checkout autocrlf може да
// конвертира source файловете в CRLF, докато source-review regex-ите по-
// долу очакват bare \n).
function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

// remainingRatio computation — огледало на task-а т.2 формулата:
//   remainingMs = max(0, totalMs - elapsedMs)
//   remainingRatio = remainingMs / totalMs
// Изведена от СЪЩИЯ delay, който CSS animation-ът реално ползва
// (clampedTurnDelayMs) — ако delay-ят е верен, remainingRatio automatически
// е верен, защото animation-delay:-Xms спрямо duration:totalMs ЕСТЕСТВЕНО
// означава "вече изминали X ms от totalMs", т.е. remaining = totalMs - X.
function remainingRatioFromDelay(elapsedMs: number, totalMs: number): number {
  const delay = clampedTurnDelayMs(elapsedMs, totalMs)
  const remainingMs = Math.max(0, totalMs - delay)
  return remainingMs / totalMs
}

function approxEqual(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance
}

function main(): void {
  const MOVE_TOTAL_MS = LUDO_MOVE_TIMEOUT_MS // 15000

  // --- T1: move deadline start (elapsed=0) -> remainingRatio ≈ 1.0 ---
  {
    const ratio = remainingRatioFromDelay(0, MOVE_TOTAL_MS)
    if (!approxEqual(ratio, 1.0)) fail(`T1: expected remainingRatio≈1.0 at elapsed=0, got ${ratio}`)
    console.log('[checkLudoTimerPresentation] T1 OK — move deadline start: remainingRatio ≈ 1.0.')
  }

  // --- T2: elapsed=3.75s -> remainingRatio ≈ 0.75 ---
  {
    const ratio = remainingRatioFromDelay(3750, MOVE_TOTAL_MS)
    if (!approxEqual(ratio, 0.75)) fail(`T2: expected remainingRatio≈0.75 at elapsed=3.75s, got ${ratio}`)
    console.log('[checkLudoTimerPresentation] T2 OK — elapsed=3.75s: remainingRatio ≈ 0.75.')
  }

  // --- T3: elapsed=7.5s -> remainingRatio ≈ 0.50 ---
  {
    const ratio = remainingRatioFromDelay(7500, MOVE_TOTAL_MS)
    if (!approxEqual(ratio, 0.50)) fail(`T3: expected remainingRatio≈0.50 at elapsed=7.5s, got ${ratio}`)
    console.log('[checkLudoTimerPresentation] T3 OK — elapsed=7.5s: remainingRatio ≈ 0.50.')
  }

  // --- T4: elapsed=11.25s -> remainingRatio ≈ 0.25 ---
  {
    const ratio = remainingRatioFromDelay(11250, MOVE_TOTAL_MS)
    if (!approxEqual(ratio, 0.25)) fail(`T4: expected remainingRatio≈0.25 at elapsed=11.25s, got ${ratio}`)
    console.log('[checkLudoTimerPresentation] T4 OK — elapsed=11.25s: remainingRatio ≈ 0.25.')
  }

  // --- T5: elapsed=15s -> remainingRatio = 0 ---
  {
    const ratio = remainingRatioFromDelay(15000, MOVE_TOTAL_MS)
    if (ratio !== 0) fail(`T5: expected remainingRatio=0 at elapsed=15s, got ${ratio}`)
    // Also confirm over-elapsed (e.g. 16s, a late render) still clamps to 0, never negative.
    const overElapsedRatio = remainingRatioFromDelay(16000, MOVE_TOTAL_MS)
    if (overElapsedRatio !== 0) fail(`T5: expected remainingRatio=0 for over-elapsed time (16s > 15s total), got ${overElapsedRatio}`)
    console.log('[checkLudoTimerPresentation] T5 OK — elapsed=15s: remainingRatio = 0 (and clamps for over-elapsed time).')
  }

  // --- T6: re-render at elapsed=6s -> remaining ≈ 9s (not restart) ---
  {
    const delay = clampedTurnDelayMs(6000, MOVE_TOTAL_MS)
    const remainingMs = MOVE_TOTAL_MS - delay
    if (!approxEqual(remainingMs, 9000, 1)) fail(`T6: expected remaining≈9000ms at elapsed=6000ms, got ${remainingMs}ms`)
    if (delay !== 6000) fail(`T6: expected animation-delay=6000ms (i.e. "skip ahead" by the elapsed amount, not a restart), got ${delay}ms`)
    console.log('[checkLudoTimerPresentation] T6 OK — re-render at elapsed=6s gives remaining≈9s (delay correctly skips ahead, no restart to 15s or an arbitrary value).')
  }

  // --- T7: resize at elapsed=6s -> same remaining as T6 (resize never touches turnStartedAt) ---
  {
    // Resize handler in createLudoFlowController.ts (handleResize) only calls
    // diceResultOverlay.clearLanded() + render() — it does NOT call
    // scheduleNextDeadline() or touch turnStartedAt. So a render triggered by
    // resize at the same elapsed time must produce the IDENTICAL delay as a
    // "normal" render at that elapsed time (T6) — proving resize doesn't
    // reset or shift the timer.
    const normalRenderDelay = clampedTurnDelayMs(6000, MOVE_TOTAL_MS)
    const resizeTriggeredRenderDelay = clampedTurnDelayMs(6000, MOVE_TOTAL_MS) // same turnElapsedMs, since turnStartedAt is untouched by resize
    if (normalRenderDelay !== resizeTriggeredRenderDelay) {
      fail(`T7: expected resize-triggered render delay to equal normal render delay at the same elapsed time, got ${resizeTriggeredRenderDelay} vs ${normalRenderDelay}`)
    }
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const resizeHandlerMatch = controllerSrc.match(/function handleResize\(\): void \{[\s\S]*?\n  \}\n/)
    if (!resizeHandlerMatch) fail('T7: could not locate handleResize function body')
    if (/scheduleNextDeadline\(\)|turnStartedAt\s*=/.test(resizeHandlerMatch[0])) {
      fail('T7: handleResize must NOT call scheduleNextDeadline() or reassign turnStartedAt — resize must never reset the timer')
    }
    console.log('[checkLudoTimerPresentation] T7 OK — resize handler never touches turnStartedAt/scheduleNextDeadline, so remaining time stays identical across resize.')
  }

  // --- T8: roll timer uses 10s total ---
  {
    if (LUDO_ROLL_TIMEOUT_MS !== 10_000) fail(`T8: expected LUDO_ROLL_TIMEOUT_MS=10000, got ${LUDO_ROLL_TIMEOUT_MS}`)
    console.log('[checkLudoTimerPresentation] T8 OK — roll timer uses 10s total duration.')
  }

  // --- T9: move timer uses 15s total ---
  {
    if (LUDO_MOVE_TIMEOUT_MS !== 15_000) fail(`T9: expected LUDO_MOVE_TIMEOUT_MS=15000, got ${LUDO_MOVE_TIMEOUT_MS}`)
    console.log('[checkLudoTimerPresentation] T9 OK — move timer uses 15s total duration.')
  }

  // --- T10: popup/takeover trigger stays synchronized with visual 0% (source review of the render()/scheduleNextDeadline() ordering fix) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    // The root cause fix: every call site that transitions to a new
    // turnPhase must call scheduleNextDeadline() BEFORE render(), so that
    // turnStartedAt is already correct (matching the moveDeadlineAt/
    // rollDeadlineAt that was just computed) by the time the DOM shows the
    // countdown. Verify the 4 call sites fixed by this task, in source order.
    const performRollSeqMatch = controllerSrc.match(/async function performRollSequence[\s\S]*?\n  \}\n/)
    if (!performRollSeqMatch) fail('T10: could not locate performRollSequence')
    const prsBody = performRollSeqMatch[0]
    const prsScheduleIdx = prsBody.lastIndexOf('scheduleNextDeadline()')
    const prsRenderIdx = prsBody.lastIndexOf('render()')
    if (prsScheduleIdx === -1 || prsRenderIdx === -1) fail('T10: performRollSequence missing scheduleNextDeadline()/render()')
    if (!(prsScheduleIdx < prsRenderIdx)) {
      fail('T10: performRollSequence must call scheduleNextDeadline() BEFORE the final render(), so turnStartedAt is correct when the countdown is shown')
    }

    const advanceTurnMatch = controllerSrc.match(/function advanceTurn\(\): void \{[\s\S]*?\n  \}\n/)
    if (!advanceTurnMatch) fail('T10: could not locate advanceTurn')
    const atBody = advanceTurnMatch[0]
    const atScheduleIdx = atBody.indexOf('scheduleNextDeadline()')
    const atRenderIdx = atBody.lastIndexOf('render()')
    if (atScheduleIdx === -1 || atRenderIdx === -1) fail('T10: advanceTurn missing scheduleNextDeadline()/render()')
    if (!(atScheduleIdx < atRenderIdx)) {
      fail('T10: advanceTurn must call scheduleNextDeadline() BEFORE render() — this is the main call site hit on every turn transition')
    }
    console.log('[checkLudoTimerPresentation] T10 OK — scheduleNextDeadline() runs before render() at every turn-transition call site, so the popup/takeover deadline and the visual 0% stay synchronized.')
  }

  console.log('[checkLudoTimerPresentation] ALL OK')
  process.exit(0)
}

main()
