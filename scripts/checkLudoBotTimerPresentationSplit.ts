// Проверка на "bot timer presentation" фикса — разделя ДВЕ различни
// семантики, които до момента споделяха едно visual poле (turnCountdownMs):
//   (A) HUMAN REACTION DEADLINE (10s roll / 15s move) — реален player
//       countdown, трябва да се вижда като намаляващ timer (ring/fill drain
//       animation).
//   (B) BOT THINK DELAY (~700ms LUDO_BOT_THINK_DELAY_MS) — вътрешна пауза
//       преди bot action (истински bot ИЛИ temporary-bot-controlled local
//       player), presentation-only детайл, НЕ player-facing timeout. НЕ
//       трябва да се вижда като бързо изтичащ 100%→0% countdown.
//
// Root cause на визуалния бъг (потвърден визуално от потребителя): и двете
// семантики споделяха turnCountdownMs полето, подадено directно към
// renderLudoPlayerPanel-овия countdown ring/fill animation duration — затова
// bot-controlled играчи (истински ботове ИЛИ sticky-takeover-нат local
// player зад "ВЪРНИ СЕ" popup-а) визуално показваха countdown, "изгарящ" за
// ~700ms, вместо да останат static.
//
// Fix: ново state поле isHumanCountdownActive (LudoGameScreenState), computed
// от createLudoFlowController.ts::currentScreenState() чрез
// resolveLudoPendingDeadlineKind(...) !== 'none' — true само когато
// turnCountdownMs реално представлява (A), false когато е (B).
// renderLudoPlayerPanel приема нов isCountdownActive параметър: false →
// countdown ring/fill се рендира STATIC (без animation, пълен/100%), вместо
// с drain анимация. LUDO_BOT_THINK_DELAY_MS/bot action scheduling
// (scheduleNextDeadline/pendingBotHandle) остават НАПЪЛНО непроменени —
// само presentation слоят е засегнат.
//
// Покрива (виж task-а):
//   VP1. human waiting_for_roll → countdown active, 10000ms.
//   VP2. human awaiting_move_selection → countdown active, 15000ms.
//   VP3. true bot waiting_for_roll → bot delay 700ms, presentation inactive.
//   VP4. true bot move decision → bot delay 700ms, presentation inactive.
//   VP5. temporary bot-controlled human → presentation inactive while
//        bot-controlled.
//   VP6. after reclaim → human countdown presentation active again.
//   VP7. BLUE/YELLOW/GREEN bot turns do not mutate next RED human countdown
//        presentation state.
//   VP8. desktop and mobile use the SAME isCountdownActive contract (single
//        source of truth passed into both ring and fill markup).
//   VP9. repeated takeover/reclaim does not re-enable the 700ms visual
//        countdown after subsequent reclaims.
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
import { markLudoColorBotControlled, resumeLudoHumanControl } from '../src/app/games/ludo/orchestrator/ludoDeadline'
import { renderLudoPlayerPanel } from '../src/app/games/ludo/pieces/renderLudoPlayerPanel'
import { createLudoMockPlayers } from '../src/app/games/ludo/mock/ludoMockState'
import type { LudoColor } from '../src/app/games/ludo/engine/ludoEngineTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoBotTimerPresentationSplit] FAIL: ${message}`)
  process.exit(1)
}

// Нормализира CRLF -> LF при четене (виж checkLudoBotTimerIsolation.ts и
// сестрите му за пълния rationale).
function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

// Огледало на createLudoFlowController.ts::currentScreenState() computation
// на isHumanCountdownActive — pure помощна функция за детерминистично тестване.
function computeIsHumanCountdownActive(
  turnPhase: 'waiting_for_roll' | 'awaiting_move_selection' | 'rolling' | 'move_resolving' | 'turn_complete',
  activeColor: LudoColor,
  botControlledColors: ReadonlySet<LudoColor>,
): boolean {
  return resolveLudoPendingDeadlineKind(turnPhase, activeColor, botControlledColors) !== 'none'
}

function main(): void {
  const LOCAL_COLOR: LudoColor = 'red'
  const TRUE_BOT_COLORS: LudoColor[] = ['blue', 'yellow', 'green']
  const players = createLudoMockPlayers()

  // --- VP1: human waiting_for_roll -> countdown active, 10000ms ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    const active = computeIsHumanCountdownActive('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (!active) fail('VP1: expected countdown presentation ACTIVE for human waiting_for_roll')
    const pending = resolveLudoPendingDeadlineKind('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (pending !== 'roll') fail(`VP1: expected pending='roll', got ${pending}`)
    console.log('[checkLudoBotTimerPresentationSplit] VP1 OK — human waiting_for_roll: countdown active, 10000ms.')
  }

  // --- VP2: human awaiting_move_selection -> countdown active, 15000ms ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    const active = computeIsHumanCountdownActive('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (!active) fail('VP2: expected countdown presentation ACTIVE for human awaiting_move_selection')
    const pending = resolveLudoPendingDeadlineKind('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (pending !== 'move') fail(`VP2: expected pending='move', got ${pending}`)
    console.log('[checkLudoBotTimerPresentationSplit] VP2 OK — human awaiting_move_selection: countdown active, 15000ms.')
  }

  // --- VP3: true bot waiting_for_roll -> bot delay 700ms, presentation inactive ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    const active = computeIsHumanCountdownActive('waiting_for_roll', 'blue', orchestrator.botControlledColors)
    if (active) fail('VP3: expected countdown presentation INACTIVE for a true bot (blue) waiting_for_roll')
    const pending = resolveLudoPendingDeadlineKind('waiting_for_roll', 'blue', orchestrator.botControlledColors)
    if (pending !== 'none') fail(`VP3: expected pending='none' (bot-controlled), got ${pending}`)
    console.log('[checkLudoBotTimerPresentationSplit] VP3 OK — true bot waiting_for_roll: 700ms think delay, presentation inactive.')
  }

  // --- VP4: true bot move decision -> bot delay 700ms, presentation inactive ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    const active = computeIsHumanCountdownActive('awaiting_move_selection', 'green', orchestrator.botControlledColors)
    if (active) fail('VP4: expected countdown presentation INACTIVE for a true bot (green) awaiting_move_selection')
    console.log('[checkLudoBotTimerPresentationSplit] VP4 OK — true bot move decision: 700ms think delay, presentation inactive.')
  }

  // --- VP5: temporary bot-controlled human -> presentation inactive while bot-controlled ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    const activeWhileTakenOver = computeIsHumanCountdownActive('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (activeWhileTakenOver) fail('VP5: expected countdown presentation INACTIVE for temporary-bot-controlled local player')
    const activeWhileWaitingForRoll = computeIsHumanCountdownActive('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (activeWhileWaitingForRoll) fail('VP5: expected countdown presentation INACTIVE for temporary-bot-controlled local player in waiting_for_roll too')
    console.log('[checkLudoBotTimerPresentationSplit] VP5 OK — temporary bot-controlled human: countdown presentation inactive while bot-controlled.')
  }

  // --- VP6: after reclaim -> human countdown presentation active again ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
    orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
    const activeRoll = computeIsHumanCountdownActive('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    const activeMove = computeIsHumanCountdownActive('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
    if (!activeRoll) fail('VP6: expected countdown presentation ACTIVE for roll after reclaim')
    if (!activeMove) fail('VP6: expected countdown presentation ACTIVE for move after reclaim')
    console.log('[checkLudoBotTimerPresentationSplit] VP6 OK — after reclaim: human countdown presentation active again (roll + move).')
  }

  // --- VP7: BLUE/YELLOW/GREEN bot turns do not mutate next RED human presentation state ---
  {
    const orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    for (const botColor of TRUE_BOT_COLORS) {
      const botRollActive = computeIsHumanCountdownActive('waiting_for_roll', botColor, orchestrator.botControlledColors)
      const botMoveActive = computeIsHumanCountdownActive('awaiting_move_selection', botColor, orchestrator.botControlledColors)
      if (botRollActive) fail(`VP7: expected ${botColor} (true bot) roll presentation INACTIVE`)
      if (botMoveActive) fail(`VP7: expected ${botColor} (true bot) move presentation INACTIVE`)
    }
    // botControlledColors set is untouched by iterating bot turns above — RED's turn is computed fresh.
    const redActive = computeIsHumanCountdownActive('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
    if (!redActive) fail('VP7: BLUE/YELLOW/GREEN bot turns must not leave RED (human) countdown presentation inactive')
    console.log('[checkLudoBotTimerPresentationSplit] VP7 OK — BLUE/YELLOW/GREEN bot turns do not mutate next RED human countdown presentation.')
  }

  // --- VP8: desktop and mobile use the SAME isCountdownActive contract ---
  // renderLudoPlayerPanel е ЕДИНСТВЕНИЯТ render модул за player card-а — И
  // desktop footer fill, И mobile SVG ring се рендират от СЪЩАТА функция,
  // управлявани от СЪЩИЯ isCountdownActive параметър (source review + actual
  // render output diff за двата layout режима).
  {
    const panelSrc = readSourceFile('../src/app/games/ludo/pieces/renderLudoPlayerPanel.ts')
    if (!/isCountdownActive\s*=\s*true/.test(panelSrc)) {
      fail('VP8: expected renderLudoPlayerPanel to declare an isCountdownActive parameter')
    }
    // И ring (mobile), И fill (desktop) блоковете трябва да разклоняват на
    // isCountdownActive — ако само единия го прави, contract-ът е разделен.
    const ringBlockMatch = panelSrc.match(/data-ludo-seat-countdown-ring[\s\S]*?<\/svg>/)
    const fillBlockMatch = panelSrc.match(/data-ludo-seat-countdown-fill[\s\S]*?<\/div>/)
    if (!ringBlockMatch) fail('VP8: could not locate mobile countdown ring markup block')
    if (!fillBlockMatch) fail('VP8: could not locate desktop countdown fill markup block')
    if (!/isCountdownActive/.test(ringBlockMatch[0])) fail('VP8: mobile countdown ring markup must branch on isCountdownActive')
    if (!/isCountdownActive/.test(fillBlockMatch[0])) fail('VP8: desktop countdown fill markup must branch on isCountdownActive')

    // Actual render output check: bot-controlled (isCountdownActive=false) на
    // desktop (compact=false) не трябва да съдържа animation:ludo-seat-
    // countdown-drain; mobile (compact=true) не трябва да съдържа animation:
    // ludo-seat-countdown-ring-drain.
    const desktopBotHtml = renderLudoPlayerPanel(players.blue, [], true, false, 0, null, LUDO_BOT_THINK_DELAY_MS, false)
    if (desktopBotHtml.includes('ludo-seat-countdown-drain')) {
      fail('VP8: desktop bot-controlled render output must NOT include the countdown drain animation when isCountdownActive=false')
    }
    const mobileBotHtml = renderLudoPlayerPanel(players.blue, [], true, true, 0, null, LUDO_BOT_THINK_DELAY_MS, false)
    if (mobileBotHtml.includes('ludo-seat-countdown-ring-drain')) {
      fail('VP8: mobile bot-controlled render output must NOT include the countdown ring drain animation when isCountdownActive=false')
    }
    // Sanity: human-controlled (isCountdownActive=true) DOES include the animations.
    const desktopHumanHtml = renderLudoPlayerPanel(players.red, [], true, false, 0, null, LUDO_ROLL_TIMEOUT_MS, true)
    if (!desktopHumanHtml.includes('ludo-seat-countdown-drain')) {
      fail('VP8: desktop human-controlled render output must include the countdown drain animation when isCountdownActive=true')
    }
    const mobileHumanHtml = renderLudoPlayerPanel(players.red, [], true, true, 0, null, LUDO_ROLL_TIMEOUT_MS, true)
    if (!mobileHumanHtml.includes('ludo-seat-countdown-ring-drain')) {
      fail('VP8: mobile human-controlled render output must include the countdown ring drain animation when isCountdownActive=true')
    }
    console.log('[checkLudoBotTimerPresentationSplit] VP8 OK — desktop and mobile share the same isCountdownActive contract (verified in actual render output).')
  }

  // --- VP9: repeated takeover/reclaim does not re-enable the 700ms visual countdown ---
  {
    let orchestrator = createLudoOrchestratorInitialState(new Set<LudoColor>(TRUE_BOT_COLORS))
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      orchestrator = markLudoColorBotControlled(orchestrator, LOCAL_COLOR)
      const activeDuringTakeover = computeIsHumanCountdownActive('awaiting_move_selection', LOCAL_COLOR, orchestrator.botControlledColors)
      if (activeDuringTakeover) fail(`VP9 cycle ${cycle}: expected countdown presentation INACTIVE during bot takeover`)
      orchestrator = resumeLudoHumanControl(orchestrator, LOCAL_COLOR)
      const activeAfterReclaim = computeIsHumanCountdownActive('waiting_for_roll', LOCAL_COLOR, orchestrator.botControlledColors)
      if (!activeAfterReclaim) fail(`VP9 cycle ${cycle}: expected countdown presentation ACTIVE after reclaim`)
    }
    console.log('[checkLudoBotTimerPresentationSplit] VP9 OK — repeated takeover/reclaim does not re-enable the 700ms visual countdown; each reclaim restores active presentation cleanly.')
  }

  // --- Source review: currentScreenState() wires isHumanCountdownActive from resolveLudoPendingDeadlineKind ---
  // NOTE: a later presentation-gate refactor introduced displayedTurnPresentation()/
  // liveTurnPresentationSnapshot() as the single point where ALL turn-display fields
  // (activeColor/turnPhase/turnStartedAt/turnCountdownMs/isHumanCountdownActive) are
  // read together — either the frozen presentationGateSnapshot during an in-flight
  // move/forfeit animation, or the live engineState-derived snapshot otherwise. This
  // check therefore verifies the field still traces back to a LIVE
  // resolveLudoPendingDeadlineKind(...) computation, just no longer inlined directly
  // in currentScreenState() itself — currentScreenState() now reads it off that
  // gate-aware snapshot instead, which is the correct, intentional architecture.
  {
    const controllerSrc = readSourceFile('../src/app/games/ludo/createLudoFlowController.ts')
    const fnMatch = controllerSrc.match(/function currentScreenState\(\): LudoGameScreenState \{[\s\S]*?\n  \}\n/)
    if (!fnMatch) fail('Source review: could not locate currentScreenState function body')
    if (!/isHumanCountdownActive:\s*turnDisplay\.isHumanCountdownActive/.test(fnMatch[0])) {
      fail('Source review: currentScreenState() must read isHumanCountdownActive off the gate-aware turn-presentation snapshot (turnDisplay), not a separately stored/cached field')
    }
    if (!/isHumanCountdownActive:\s*resolveLudoPendingDeadlineKind\(engineState\.turnPhase, engineState\.activeColor, orchestrator\.botControlledColors\) !== 'none'/.test(controllerSrc)) {
      fail('Source review: the turn-presentation snapshot feeding currentScreenState() must compute isHumanCountdownActive from resolveLudoPendingDeadlineKind(...) !== \'none\', live, not a stored/cached field')
    }
    if (!/function displayedTurnPresentation\(\) \{\s*return presentationGateSnapshot \?\? liveTurnPresentationSnapshot\(\)/.test(controllerSrc)) {
      fail('Source review: displayedTurnPresentation() must return the frozen presentationGateSnapshot when a gate is open, else the live snapshot — otherwise currentScreenState() could read stale live values during an in-flight animation')
    }
    // Bot action scheduling itself must remain untouched — LUDO_BOT_THINK_DELAY_MS
    // usage in scheduleNextDeadline() must be unchanged (still arms pendingBotHandle).
    if (!/pendingBotHandle = setTimeout\(\(\) => \{[\s\S]*?\}, LUDO_BOT_THINK_DELAY_MS\)/.test(controllerSrc)) {
      fail('Source review: scheduleNextDeadline() must still arm pendingBotHandle with LUDO_BOT_THINK_DELAY_MS — bot scheduling itself must not be touched by the presentation fix')
    }
    console.log('[checkLudoBotTimerPresentationSplit] Source review OK — isHumanCountdownActive is computed live (via the gate-aware turn-presentation snapshot); bot action scheduling (700ms) is untouched.')
  }

  console.log('[checkLudoBotTimerPresentationSplit] ALL OK')
  process.exit(0)
}

main()
