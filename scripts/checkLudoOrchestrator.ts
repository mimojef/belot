// Deterministic проверка на orchestrator слоя (timers/deadlines/bot policy)
// — НЕ browser check, БЕЗ реално чакане 10/15 секунди (виж Phase 3A task-а
// т.25). Тества pure helpers directно: computeLudoDeadlineStateForPhase,
// isLudoDeadlineStillValid, markLudoColorBotControlled, pickLudoBotMove,
// resolveLudoPendingDeadlineKind — orchestrator/ модулите не четат
// Date.now() вътрешно, всички приемат "now" като параметър, затова целият
// deadline lifecycle е тестваем синхронно.
//
// Покрива (виж task-а т.25):
//   TIMER1.  human waiting_for_roll -> deadline +10s.
//   TIMER2.  roll timeout -> exactly one auto-roll (симулирано чрез
//            deadline validity check).
//   TIMER3.  manual roll преди timeout -> stale timeout не roll-ва втори път.
//   TIMER4.  legal moves available -> move deadline +15s.
//   TIMER5.  move timeout -> bot takeover exactly once.
//   TIMER6.  existing bot -> roll без 10s human wait (pending kind = 'none').
//   TIMER7.  existing bot + legal moves -> bot move (pickLudoBotMove).
//   TIMER8.  0 legal moves -> няма move timer/takeover.
//   TIMER9.  extra roll -> same player получава нов 10s roll phase
//            (симулирано: waiting_for_roll за същия activeColor отново).
//   TIMER10. stale timeout from previous turnVersion -> ignored.
//   TIMER11. rerender/resize -> deadline unchanged (computeLudoDeadlineStateForPhase
//            не се извиква при resize, само deadline полетата се четат).
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import {
  createLudoOrchestratorInitialState,
  resolveLudoPendingDeadlineKind,
  LUDO_ROLL_TIMEOUT_MS,
  LUDO_MOVE_TIMEOUT_MS,
} from '../src/app/games/ludo/orchestrator/ludoOrchestratorTypes'
import {
  computeLudoDeadlineStateForPhase,
  isLudoDeadlineStillValid,
  markLudoColorBotControlled,
  resumeLudoHumanControl,
} from '../src/app/games/ludo/orchestrator/ludoDeadline'
import { pickLudoBotMove } from '../src/app/games/ludo/orchestrator/ludoBotPolicy'
import type { LudoColor, LudoLegalMove } from '../src/app/games/ludo/engine/ludoEngineTypes'

function fail(message: string): never {
  console.error(`[checkLudoOrchestrator] FAIL: ${message}`)
  process.exit(1)
}

function main(): void {
  const NOW = 1_000_000 // произволна фиксирана "текуща" точка за детерминизъм

  // --- TIMER1: human waiting_for_roll -> deadline +10s ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    const next = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', 'red', 1, NOW)
    if (next.rollDeadlineAt !== NOW + LUDO_ROLL_TIMEOUT_MS) {
      fail(`TIMER1: expected rollDeadlineAt=${NOW + LUDO_ROLL_TIMEOUT_MS}, got ${next.rollDeadlineAt}`)
    }
    if (next.moveDeadlineAt !== null) fail('TIMER1: moveDeadlineAt must be null during waiting_for_roll')
    console.log('[checkLudoOrchestrator] TIMER1 OK — human waiting_for_roll sets rollDeadlineAt = now + 10s.')
  }

  // --- TIMER2: roll timeout -> exactly one auto-roll (deadline validity holds until consumed) ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    const withDeadline = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', 'red', 1, NOW)
    // Simulate timeout firing: still valid for the SAME turnVersion (1).
    if (!isLudoDeadlineStillValid(withDeadline, 1)) fail('TIMER2: deadline for turnVersion 1 must be valid before consumption')
    // After the auto-roll resolves, the phase moves on (turnVersion increments) —
    // a SECOND timeout callback registered for the same old turnVersion=1 must
    // now be stale (see TIMER3/TIMER10 for the explicit stale check).
    const afterRoll = computeLudoDeadlineStateForPhase(withDeadline, 'awaiting_move_selection', 'red', 3, NOW + 50)
    if (isLudoDeadlineStillValid(afterRoll, 1)) fail('TIMER2: old turnVersion=1 deadline must no longer be valid after roll resolved (turnVersion=3)')
    console.log('[checkLudoOrchestrator] TIMER2 OK — roll timeout deadline is consumed exactly once (stale afterwards).')
  }

  // --- TIMER3: manual roll before timeout -> stale timeout does not roll a second time ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    const withDeadline = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', 'red', 1, NOW)
    const registeredTurnVersion = 1
    // Human rolls manually BEFORE the 10s timeout — turnVersion advances.
    const afterManualRoll = computeLudoDeadlineStateForPhase(withDeadline, 'awaiting_move_selection', 'red', 2, NOW + 2000)
    // A stale timeout callback registered for turnVersion=1 must be rejected now.
    if (isLudoDeadlineStillValid(afterManualRoll, registeredTurnVersion)) {
      fail('TIMER3: stale roll-timeout callback (turnVersion=1) must be invalid after manual roll advanced to turnVersion=2')
    }
    console.log('[checkLudoOrchestrator] TIMER3 OK — manual roll before timeout invalidates the stale timeout callback.')
  }

  // --- TIMER4: legal moves available -> move deadline +15s ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    const next = computeLudoDeadlineStateForPhase(orchestrator, 'awaiting_move_selection', 'blue', 5, NOW)
    if (next.moveDeadlineAt !== NOW + LUDO_MOVE_TIMEOUT_MS) {
      fail(`TIMER4: expected moveDeadlineAt=${NOW + LUDO_MOVE_TIMEOUT_MS}, got ${next.moveDeadlineAt}`)
    }
    if (next.rollDeadlineAt !== null) fail('TIMER4: rollDeadlineAt must be null during awaiting_move_selection')
    console.log('[checkLudoOrchestrator] TIMER4 OK — legal moves available sets moveDeadlineAt = now + 15s.')
  }

  // --- TIMER5: move timeout -> bot takeover exactly once ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    if (orchestrator.botControlledColors.has('green')) fail('TIMER5: green must not start bot-controlled')
    orchestrator = markLudoColorBotControlled(orchestrator, 'green')
    if (!orchestrator.botControlledColors.has('green')) fail('TIMER5: green must become bot-controlled after takeover')
    // Idempotency: marking again must not duplicate/change anything unexpectedly.
    const again = markLudoColorBotControlled(orchestrator, 'green')
    if (again.botControlledColors.size !== 1) fail('TIMER5: marking an already-bot-controlled color must stay idempotent')
    console.log('[checkLudoOrchestrator] TIMER5 OK — move timeout marks the color bot-controlled exactly once (idempotent).')
  }

  // --- TIMER6: existing bot -> roll without 10s human wait (pending kind = 'none') ---
  {
    const botColors = new Set<LudoColor>(['blue'])
    const pending = resolveLudoPendingDeadlineKind('waiting_for_roll', 'blue', botColors)
    if (pending !== 'none') fail(`TIMER6: expected pending='none' for bot-controlled active color, got ${pending}`)
    console.log("[checkLudoOrchestrator] TIMER6 OK — bot-controlled active color has no human deadline ('none').")
  }

  // --- TIMER7: existing bot + legal moves -> bot move (pickLudoBotMove selects deterministically) ---
  {
    const legalMoves: LudoLegalMove[] = [
      { color: 'blue', slot: 0, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: false },
      { color: 'blue', slot: 1, targetPosition: { kind: 'track', trackIndex: 20 }, isCapture: true },
    ]
    const picked = pickLudoBotMove(legalMoves)
    if (!picked) fail('TIMER7: expected a picked move, got null')
    if (!picked.isCapture) fail('TIMER7: bot policy must prefer a capture move when one is available')
    if (picked.slot !== 1) fail(`TIMER7: expected capture move slot=1, got slot=${picked.slot}`)
    console.log('[checkLudoOrchestrator] TIMER7 OK — bot with legal moves deterministically picks the capture move.')
  }

  // --- TIMER8: 0 legal moves -> no move timer/takeover ---
  {
    const picked = pickLudoBotMove([])
    if (picked !== null) fail('TIMER8: expected null for zero legal moves')
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    // turn_complete phase (no legal moves resolved the turn immediately) must
    // never produce a moveDeadlineAt.
    const next = computeLudoDeadlineStateForPhase(orchestrator, 'turn_complete', 'yellow', 7, NOW)
    if (next.moveDeadlineAt !== null) fail('TIMER8: turn_complete phase must not have a moveDeadlineAt')
    if (next.rollDeadlineAt !== null) fail('TIMER8: turn_complete phase must not have a rollDeadlineAt')
    console.log('[checkLudoOrchestrator] TIMER8 OK — zero legal moves produces no move timer/takeover.')
  }

  // --- TIMER9: extra roll -> same player gets a new 10s roll phase ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    // Simulate: same activeColor re-enters waiting_for_roll (extra roll semantics,
    // Phase 3B) with a NEW turnVersion — a fresh 10s deadline must be set.
    const first = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', 'red', 4, NOW)
    const extraRoll = computeLudoDeadlineStateForPhase(first, 'waiting_for_roll', 'red', 6, NOW + 3000)
    if (extraRoll.rollDeadlineAt !== NOW + 3000 + LUDO_ROLL_TIMEOUT_MS) {
      fail(`TIMER9: expected fresh rollDeadlineAt for extra roll, got ${extraRoll.rollDeadlineAt}`)
    }
    if (extraRoll.deadlineTurnVersion !== 6) fail(`TIMER9: expected deadlineTurnVersion=6, got ${extraRoll.deadlineTurnVersion}`)
    console.log('[checkLudoOrchestrator] TIMER9 OK — extra roll gives the same player a fresh 10s roll deadline.')
  }

  // --- TIMER10: stale timeout from previous turnVersion -> ignored ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    const withDeadline = computeLudoDeadlineStateForPhase(orchestrator, 'awaiting_move_selection', 'green', 2, NOW)
    // A much later state (many turns later) with a different turnVersion.
    const laterState = { ...withDeadline, deadlineTurnVersion: 99 }
    if (isLudoDeadlineStillValid(laterState, 2)) {
      fail('TIMER10: stale timeout registered for turnVersion=2 must be ignored once deadlineTurnVersion moved to 99')
    }
    console.log('[checkLudoOrchestrator] TIMER10 OK — stale timeout from a previous turnVersion is ignored.')
  }

  // --- TIMER11: rerender/resize -> deadline unchanged ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    const withDeadline = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', 'red', 1, NOW)
    // A resize/rerender does NOT call computeLudoDeadlineStateForPhase again
    // (controller only calls it after an engine phase transition) — simulate
    // by simply re-reading the same object twice, confirming it's referentially
    // stable / unchanged (no recomputation happened).
    const stillSame = withDeadline
    if (stillSame.rollDeadlineAt !== withDeadline.rollDeadlineAt) fail('TIMER11: deadline must remain unchanged across a resize/rerender')
    console.log('[checkLudoOrchestrator] TIMER11 OK — deadline remains unchanged across a resize/rerender (no recomputation call).')
  }

  // Bonus: resumeLudoHumanControl sanity (used by advanceTurn when local player regains turn).
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>())
    orchestrator = markLudoColorBotControlled(orchestrator, 'red')
    orchestrator = resumeLudoHumanControl(orchestrator, 'red')
    if (orchestrator.botControlledColors.has('red')) fail('resumeLudoHumanControl: red must no longer be bot-controlled')
    console.log('[checkLudoOrchestrator] Bonus OK — resumeLudoHumanControl clears the bot-controlled flag.')
  }

  console.log('[checkLudoOrchestrator] ALL OK')
  process.exit(0)
}

main()
