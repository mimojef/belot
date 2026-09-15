// Deterministic проверка на timer/orchestrator state isolation-а между
// HUMAN GAMEPLAY DEADLINE (10s roll / 15s move) и BOT THINK DELAY (~700ms) —
// виж task-а: "усещане, че bot think delay е започнал да се използва като
// countdown duration" след "ВЪРНИ СЕ" reclaim.
//
// Root cause, потвърден чрез audit + реален browser measurement (виж
// отчета): createLudoFlowController.ts::handleMoveTimeout() викаше directно
// render() СЛЕД markLudoColorBotControlled(), БЕЗ scheduleNextDeadline()
// между тях — turnStartedAt оставаше STALE (все още сочещ към момента,
// когато 15s human move deadline-ът стартира), докато
// currentTurnCountdownMs() вече computed 700ms (LUDO_BOT_THINK_DELAY_MS,
// защото botControlledColors вече включва color-а точно преди този render).
// clampedTurnDelayMs(~15000ms stale elapsed, 700ms нов duration) clamp-ва
// до 700 — invalid "stale elapsed срещу нов кратък duration" combination
// (макар не directно visible зад bot-takeover popup-а по време на самия
// takeover момент). Fix: scheduleNextDeadline() ПРЕДИ render() тук, same
// established pattern като performRollSequence/performMoveSequence/
// advanceTurn (вече имплементиран за timer-sync fix-а в предходна задача).
//
// currentTurnCountdownMs() самата функция е ВИНАГИ computed LIVE спрямо
// текущия engineState.turnPhase/activeColor/orchestrator.botControlledColors
// (никога cache-вана стойност) — структурно тя не може да "carry-over"
// стара стойност между turns. Реалният риск беше единствено timing-ът,
// кога render() чете тази функция спрямо кога turnStartedAt е синхронизиран.
//
// Покрива (виж task-а т.10):
//   BT1.  human roll deadline = 10000ms преди takeover.
//   BT2.  human move deadline = 15000ms преди takeover.
//   BT3.  temporary bot control използва bot delay (700ms presentation),
//         без да mutate-ва бъдещ human duration (currentTurnCountdownMs
//         computation е pure спрямо текущия state, не stored/carried).
//   BT4.  след reclaim human roll = 10000ms.
//   BT5.  след reclaim human move = 15000ms.
//   BT6.  true bot turn (BLUE/YELLOW/GREEN) не променя duration на
//         следващия human turn (всеки turn computed независимо).
//   BT7.  няма stale turnCountdownMs след actor transition — source review:
//         currentTurnCountdownMs() е винаги computed at render time, никога
//         stored в field/variable, пренасяна между render() извиквания.
//   BT8.  няма stale turnStartedAt/negative delay след reclaim —
//         handleMoveTimeout() вика scheduleNextDeadline() ПРЕДИ render()
//         (source review на самия fix).
//   BT9.  repeated takeover/reclaim запазва 10s/15s всеки път (pure state
//         simulation на 2 последователни takeover/reclaim цикъла).
//   BT10. няма duplicate timeout/action — scheduleNextDeadline() вътре в
//         handleMoveTimeout() arm-ва pendingBotHandle, но performMoveSequence
//         (директно awaited от handleMoveTimeout чрез
//         performBotMoveForCurrentPhase) вика clearScheduledTimers() в
//         рамките на СЪЩИЯ синхронен JS tick, преди какъвто и да е await —
//         pendingBotHandle никога реално не fire-ва.
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
  LUDO_BOT_THINK_DELAY_MS,
} from '../src/app/games/ludo/orchestrator/ludoOrchestratorTypes'
import {
  computeLudoDeadlineStateForPhase,
  markLudoColorBotControlled,
  resumeLudoHumanControl,
} from '../src/app/games/ludo/orchestrator/ludoDeadline'
import type { LudoColor } from '../src/app/games/ludo/engine/ludoEngineTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoBotTimerIsolation] FAIL: ${message}`)
  process.exit(1)
}

// Нормализира CRLF -> LF при четене (виж checkLudoCapturePresentation.ts/
// checkLudoReclaimFlow.ts коментара за пълния rationale).
function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

// Огледало на createLudoFlowController.ts::currentTurnCountdownMs() —
// чиста функция за pure state тестване, identична логика.
function computeTurnCountdownMs(
  turnPhase: 'waiting_for_roll' | 'awaiting_move_selection' | 'rolling' | 'move_resolving' | 'turn_complete',
  activeColor: LudoColor,
  botControlledColors: ReadonlySet<LudoColor>,
): number {
  const pending = resolveLudoPendingDeadlineKind(turnPhase, activeColor, botControlledColors)
  if (pending === 'roll') return LUDO_ROLL_TIMEOUT_MS
  if (pending === 'move') return LUDO_MOVE_TIMEOUT_MS
  return LUDO_BOT_THINK_DELAY_MS
}

function main(): void {
  const NOW = 3_000_000
  const LOCAL_COLOR: LudoColor = 'red'
  const TRUE_BOT_COLORS: LudoColor[] = ['blue', 'yellow', 'green']

  // --- BT1: human roll deadline = 10000ms преди takeover ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    const duration = computeTurnCountdownMs('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (duration !== LUDO_ROLL_TIMEOUT_MS) fail(`BT1: expected human roll duration=${LUDO_ROLL_TIMEOUT_MS}ms preceding any takeover, got ${duration}`)
    const deadlineState = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', LOCAL_COLOR, 1, NOW)
    if (deadlineState.rollDeadlineAt !== NOW + LUDO_ROLL_TIMEOUT_MS) {
      fail(`BT1: expected rollDeadlineAt=${NOW + LUDO_ROLL_TIMEOUT_MS}, got ${deadlineState.rollDeadlineAt}`)
    }
    console.log('[checkLudoBotTimerIsolation] BT1 OK — human roll deadline = 10000ms before any takeover.')
  }

  // --- BT2: human move deadline = 15000ms преди takeover ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    const duration = computeTurnCountdownMs('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (duration !== LUDO_MOVE_TIMEOUT_MS) fail(`BT2: expected human move duration=${LUDO_MOVE_TIMEOUT_MS}ms preceding any takeover, got ${duration}`)
    const deadlineState = computeLudoDeadlineStateForPhase(orchestrator, 'awaiting_move_selection', LOCAL_COLOR, 2, NOW)
    if (deadlineState.moveDeadlineAt !== NOW + LUDO_MOVE_TIMEOUT_MS) {
      fail(`BT2: expected moveDeadlineAt=${NOW + LUDO_MOVE_TIMEOUT_MS}, got ${deadlineState.moveDeadlineAt}`)
    }
    console.log('[checkLudoBotTimerIsolation] BT2 OK — human move deadline = 15000ms before any takeover.')
  }

  // --- BT3: temporary bot control uses bot delay WITHOUT mutating a future human duration ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    const botTurnDuration = computeTurnCountdownMs('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (botTurnDuration !== LUDO_BOT_THINK_DELAY_MS) {
      fail(`BT3: expected temporary-bot-controlled turn duration=${LUDO_BOT_THINK_DELAY_MS}ms, got ${botTurnDuration}`)
    }
    // Compute what a FUTURE human turn (after eventual reclaim) would be —
    // this must be independent of the bot duration just computed above
    // (currentTurnCountdownMs is pure/live, no shared mutable field).
    const afterReclaim = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    const futureHumanDuration = computeTurnCountdownMs('waiting_for_roll', LOCAL_COLOR, afterReclaim.botControlledColors)
    if (futureHumanDuration !== LUDO_ROLL_TIMEOUT_MS) {
      fail(`BT3: bot think delay (${LUDO_BOT_THINK_DELAY_MS}ms) must NOT leak into the future human duration — expected ${LUDO_ROLL_TIMEOUT_MS}ms, got ${futureHumanDuration}`)
    }
    console.log('[checkLudoBotTimerIsolation] BT3 OK — temporary bot control uses the 700ms think delay without mutating any future human duration.')
  }

  // --- BT4: after reclaim, human roll = 10000ms ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    const duration = computeTurnCountdownMs('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (duration !== LUDO_ROLL_TIMEOUT_MS) fail(`BT4: expected 10000ms roll duration after reclaim, got ${duration}`)
    const deadlineState = computeLudoDeadlineStateForPhase(orchestrator, 'waiting_for_roll', LOCAL_COLOR, 5, NOW)
    if (deadlineState.rollDeadlineAt !== NOW + LUDO_ROLL_TIMEOUT_MS) {
      fail(`BT4: expected fresh rollDeadlineAt=${NOW + LUDO_ROLL_TIMEOUT_MS} after reclaim, got ${deadlineState.rollDeadlineAt}`)
    }
    console.log('[checkLudoBotTimerIsolation] BT4 OK — after reclaim, human roll deadline is 10000ms (not 700ms).')
  }

  // --- BT5: after reclaim, human move = 15000ms ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    const duration = computeTurnCountdownMs('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (duration !== LUDO_MOVE_TIMEOUT_MS) fail(`BT5: expected 15000ms move duration after reclaim, got ${duration}`)
    const deadlineState = computeLudoDeadlineStateForPhase(orchestrator, 'awaiting_move_selection', LOCAL_COLOR, 6, NOW)
    if (deadlineState.moveDeadlineAt !== NOW + LUDO_MOVE_TIMEOUT_MS) {
      fail(`BT5: expected fresh moveDeadlineAt=${NOW + LUDO_MOVE_TIMEOUT_MS} after reclaim, got ${deadlineState.moveDeadlineAt}`)
    }
    console.log('[checkLudoBotTimerIsolation] BT5 OK — after reclaim, human move deadline is 15000ms (not 700ms).')
  }

  // --- BT6: a true bot's turn does not change the NEXT human's duration ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    // BLUE (true bot) plays its own waiting_for_roll/awaiting_move_selection turns.
    const blueRollDuration = computeTurnCountdownMs('waiting_for_roll', 'blue', orchestrator.botControlledColors)
    const blueMoveDuration = computeTurnCountdownMs('awaiting_move_selection', 'blue', orchestrator.botControlledColors)
    if (blueRollDuration !== LUDO_BOT_THINK_DELAY_MS) fail(`BT6: expected blue (true bot) roll duration=${LUDO_BOT_THINK_DELAY_MS}ms, got ${blueRollDuration}`)
    if (blueMoveDuration !== LUDO_BOT_THINK_DELAY_MS) fail(`BT6: expected blue (true bot) move duration=${LUDO_BOT_THINK_DELAY_MS}ms, got ${blueMoveDuration}`)
    // Turn advances to RED (local human, never bot-controlled in this scenario).
    const redRollDuration = computeTurnCountdownMs('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (redRollDuration !== LUDO_ROLL_TIMEOUT_MS) {
      fail(`BT6: BLUE's bot think delay must not carry over to RED's turn — expected ${LUDO_ROLL_TIMEOUT_MS}ms, got ${redRollDuration}`)
    }
    console.log('[checkLudoBotTimerIsolation] BT6 OK — a true bot turn (BLUE) does not change the following human (RED) turn\'s duration.')
  }

  // --- BT7: no stale turnCountdownMs after actor transition (source review — always computed live) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/function currentTurnCountdownMs\(\): number \{[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('BT7: could not locate currentTurnCountdownMs function body')
    const fnBody = fnMatch[0]
    // Must read engineState.turnPhase/activeColor and orchestrator.botControlledColors
    // DIRECTLY (live), never reference a locally-scoped mutable "last computed" cache.
    if (!/resolveLudoPendingDeadlineKind\(engineState\.turnPhase, engineState\.activeColor, orchestrator\.botControlledColors\)/.test(fnBody)) {
      fail('BT7: currentTurnCountdownMs must compute its result LIVE from engineState/orchestrator, not from a cached/stored value')
    }
    // No module-level "let cachedTurnCountdownMs" or similar carry-over variable should exist.
    if (/let\s+cachedTurnCountdownMs|let\s+lastTurnCountdownMs/.test(controllerSrc)) {
      fail('BT7: found a suspicious cached/carried-over turnCountdownMs variable — countdown duration must always be computed live, never stored across renders')
    }
    console.log('[checkLudoBotTimerIsolation] BT7 OK — turnCountdownMs is always computed live from current state, never a stale carried-over value.')
  }

  // --- BT8: no stale turnStartedAt/negative delay after reclaim (source review of the handleMoveTimeout fix) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/async function handleMoveTimeout\(\): Promise<void> \{[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('BT8: could not locate handleMoveTimeout function body')
    const fnBody = fnMatch[0]
    const scheduleIndex = fnBody.indexOf('scheduleNextDeadline()')
    const renderIndex = fnBody.indexOf('render()')
    if (scheduleIndex === -1) fail('BT8: handleMoveTimeout must call scheduleNextDeadline() (this is the root-cause fix — it was missing before)')
    if (renderIndex === -1) fail('BT8: handleMoveTimeout must call render()')
    if (!(scheduleIndex < renderIndex)) {
      fail('BT8: scheduleNextDeadline() must be called BEFORE render() in handleMoveTimeout — otherwise turnStartedAt stays stale (from the just-expired 15s human deadline) while turnCountdownMs already reflects the new 700ms bot delay, producing an invalid stale-elapsed-vs-short-duration animation-delay')
    }
    console.log('[checkLudoBotTimerIsolation] BT8 OK — handleMoveTimeout synchronizes turnStartedAt via scheduleNextDeadline() before rendering, eliminating the stale-delay root cause.')
  }

  // --- BT9: repeated takeover/reclaim preserves 10s/15s every time (pure state simulation) ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      // Takeover.
      orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
      const botDuration = computeTurnCountdownMs('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
      if (botDuration !== LUDO_BOT_THINK_DELAY_MS) {
        fail(`BT9 cycle ${cycle}: expected bot think delay=${LUDO_BOT_THINK_DELAY_MS}ms during takeover, got ${botDuration}`)
      }
      // Reclaim.
      orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
      const rollDuration = computeTurnCountdownMs('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
      const moveDuration = computeTurnCountdownMs('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
      if (rollDuration !== LUDO_ROLL_TIMEOUT_MS) {
        fail(`BT9 cycle ${cycle}: expected roll duration=${LUDO_ROLL_TIMEOUT_MS}ms after reclaim, got ${rollDuration} (duration drift across repeated cycles)`)
      }
      if (moveDuration !== LUDO_MOVE_TIMEOUT_MS) {
        fail(`BT9 cycle ${cycle}: expected move duration=${LUDO_MOVE_TIMEOUT_MS}ms after reclaim, got ${moveDuration} (duration drift across repeated cycles)`)
      }
    }
    console.log('[checkLudoBotTimerIsolation] BT9 OK — 3 repeated takeover/reclaim cycles all preserve exact 10s/15s human durations, no drift.')
  }

  // --- BT10: no duplicate timeout/action (source review — clearScheduledTimers runs synchronously before any await) ---
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const moveSeqMatch = controllerSrc.match(/async function performMoveSequence[\s\S]*?\n  \}\n/)
    if (!moveSeqMatch) fail('BT10: could not locate performMoveSequence function body')
    const moveSeqBody = moveSeqMatch[0]
    const isAnimatingTrueIndex = moveSeqBody.indexOf('isAnimatingMove = true')
    const clearTimersIndex = moveSeqBody.indexOf('clearScheduledTimers()')
    const firstAwaitIndex = moveSeqBody.indexOf('await ')
    if (isAnimatingTrueIndex === -1 || clearTimersIndex === -1 || firstAwaitIndex === -1) {
      fail('BT10: expected isAnimatingMove=true, clearScheduledTimers(), and at least one await in performMoveSequence')
    }
    if (!(isAnimatingTrueIndex < clearTimersIndex && clearTimersIndex < firstAwaitIndex)) {
      fail('BT10: expected isAnimatingMove=true and clearScheduledTimers() to run BEFORE the first await — this guarantees any pendingBotHandle armed by handleMoveTimeout\'s scheduleNextDeadline() is cleared synchronously, in the same JS tick, before it could ever fire and cause a duplicate bot action')
    }
    // Also confirm performBotTurnStep has the isAnimatingMove guard, as a second line of defense.
    const botStepMatch = controllerSrc.match(/async function performBotTurnStep\(\): Promise<void> \{[\s\S]*?\n  \}\n/)
    if (!botStepMatch) fail('BT10: could not locate performBotTurnStep function body')
    if (!/if \(isAnimatingMove\) return/.test(botStepMatch[0])) {
      fail('BT10: performBotTurnStep must guard against isAnimatingMove as defense-in-depth against a duplicate bot action')
    }
    console.log('[checkLudoBotTimerIsolation] BT10 OK — no duplicate timeout/action: clearScheduledTimers() runs synchronously before any await, and performBotTurnStep has a redundant isAnimatingMove guard.')
  }

  console.log('[checkLudoBotTimerIsolation] ALL OK')
  process.exit(0)
}

main()
