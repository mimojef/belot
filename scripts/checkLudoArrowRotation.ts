// Deterministic проверка на dice arrow rotation state contract-а (виж
// task-а: "стрелките трябва да се въртят САМО когато конкретният играч
// реално трябва да хвърли зар"). НЕ browser/pixel test — тества самото
// правило (shouldRotateArrows computation) directно чрез симулирана
// LudoGameScreenState + source review на renderLudoDiceControl.ts, за да
// потвърди, че CSS animation е окачена ЕДИНСТВЕНО на shouldRotateArrows
// (не isRolling/isDiceRolling/isActive/diceControl presence самостоятелно).
//
// Покрива (виж task-а т.9):
//   A1. waiting_for_roll -> arrows rotating (за активния играч).
//   A2. rolling -> arrows static.
//   A3. awaiting_move_selection -> arrows static (ТОЧНО бъгът, който се
//       поправя тук — преди тази промяна arrows се рестартираха тук).
//   A4. move_resolving -> arrows static.
//   A5. turn_complete -> arrows static.
//   A6. next player's waiting_for_roll -> само неговите arrows rotating
//       (другите 3 цвята остават static, дори ако бяха active преди).
//   A7. human timeout auto-roll спира rotation (turnPhase 'rolling' по
//       време на auto-roll flight, идентично на manual click path).
//   A8. bot roll спира rotation и тя не се рестартира при move phase (bot
//       минава през СЪЩОТО shouldRotateArrows правило, без отделна логика).
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { LudoColor, LudoTurnPhase } from '../src/app/games/ludo/engine/ludoEngineTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoArrowRotation] FAIL: ${message}`)
  process.exit(1)
}

// Огледало на renderLudoGameScreen.ts::renderPlayerPanelSlot изчислението
// (виж task-а т.2: "shouldRotateArrows = activeColor===playerColor &&
// turnPhase==='waiting_for_roll'") — тествано тук изолирано от DOM/render
// markup, самото ПРАВИЛО.
function shouldRotateArrows(activeColor: LudoColor, turnPhase: LudoTurnPhase, playerColor: LudoColor): boolean {
  return activeColor === playerColor && turnPhase === 'waiting_for_roll'
}

function main(): void {
  const ALL_COLORS: LudoColor[] = ['red', 'blue', 'yellow', 'green']

  // --- A1: waiting_for_roll -> arrows rotating (active player only) ---
  {
    if (!shouldRotateArrows('red', 'waiting_for_roll', 'red')) {
      fail('A1: expected rotating arrows for the active player during waiting_for_roll')
    }
    for (const other of ALL_COLORS.filter((c) => c !== 'red')) {
      if (shouldRotateArrows('red', 'waiting_for_roll', other)) {
        fail(`A1: expected STATIC arrows for non-active player ${other} during red's waiting_for_roll`)
      }
    }
    console.log('[checkLudoArrowRotation] A1 OK — waiting_for_roll rotates arrows for the active player only.')
  }

  // --- A2: rolling -> arrows static ---
  {
    if (shouldRotateArrows('red', 'rolling', 'red')) {
      fail('A2: expected static arrows during rolling phase (dice flight in progress)')
    }
    console.log('[checkLudoArrowRotation] A2 OK — rolling phase keeps arrows static.')
  }

  // --- A3: awaiting_move_selection -> arrows static (the actual bug being fixed) ---
  {
    if (shouldRotateArrows('red', 'awaiting_move_selection', 'red')) {
      fail('A3: expected static arrows during awaiting_move_selection — this is the exact regression the fix addresses')
    }
    console.log('[checkLudoArrowRotation] A3 OK — awaiting_move_selection keeps arrows static (previously the bug restarted them here).')
  }

  // --- A4: move_resolving -> arrows static ---
  {
    if (shouldRotateArrows('red', 'move_resolving', 'red')) {
      fail('A4: expected static arrows during move_resolving')
    }
    console.log('[checkLudoArrowRotation] A4 OK — move_resolving keeps arrows static.')
  }

  // --- A5: turn_complete -> arrows static ---
  {
    if (shouldRotateArrows('red', 'turn_complete', 'red')) {
      fail('A5: expected static arrows during turn_complete')
    }
    console.log('[checkLudoArrowRotation] A5 OK — turn_complete keeps arrows static.')
  }

  // --- A6: next player's waiting_for_roll -> only their arrows rotating ---
  {
    // Turn advances from red to blue, both re-entering waiting_for_roll for
    // their respective turns.
    if (shouldRotateArrows('blue', 'waiting_for_roll', 'red')) {
      fail('A6: red must NOT rotate once it is blue\'s waiting_for_roll turn')
    }
    if (!shouldRotateArrows('blue', 'waiting_for_roll', 'blue')) {
      fail('A6: blue MUST rotate during its own waiting_for_roll turn')
    }
    for (const other of ['yellow', 'green'] as LudoColor[]) {
      if (shouldRotateArrows('blue', 'waiting_for_roll', other)) {
        fail(`A6: ${other} must not rotate while it is blue's turn`)
      }
    }
    console.log('[checkLudoArrowRotation] A6 OK — after turn advances, only the new active player\'s arrows rotate.')
  }

  // --- A7: human timeout auto-roll stops rotation (source review) ---
  {
    const controllerSrc = readFileSync(
      join(__dirname, '../src/app/games/ludo/createLudoFlowController.ts'),
      'utf8',
    )
    // handleRollTimeout (10s auto-roll) must route through performRollSequence,
    // the SAME function used by manual clicks and bot rolls — which dispatches
    // ROLL_STARTED, moving engineState.turnPhase to 'rolling' BEFORE any
    // flight/render happens. Since shouldRotateArrows reads turnPhase directly
    // (not a separate isDiceRolling flag), the auto-roll path automatically
    // stops rotation the instant ROLL_STARTED resolves — no special-casing
    // needed, proven by the single shared dispatch path.
    if (!/async function handleRollTimeout[\s\S]*?await performRollSequence\(engineState\.activeColor\)/.test(controllerSrc)) {
      fail('A7: handleRollTimeout (10s auto-roll) must call performRollSequence — the same shared roll path used by manual clicks')
    }
    if (!/type: 'ROLL_STARTED'/.test(controllerSrc)) {
      fail('A7: performRollSequence must dispatch ROLL_STARTED, which is what flips turnPhase to \'rolling\' and stops arrow rotation via shouldRotateArrows')
    }
    console.log('[checkLudoArrowRotation] A7 OK — human timeout auto-roll shares performRollSequence, so ROLL_STARTED stops rotation exactly like a manual click.')
  }

  // --- A8: bot roll stops rotation and it does not restart during move phase (source review) ---
  {
    const controllerSrc = readFileSync(
      join(__dirname, '../src/app/games/ludo/createLudoFlowController.ts'),
      'utf8',
    )
    // performBotTurnStep also calls performRollSequence for the roll phase —
    // same shared path as A7. And crucially, renderPlayerPanelSlot's
    // shouldRotateArrows condition depends ONLY on turnPhase (not on
    // isDiceRolling, not on botControlledColors) — so once turnPhase leaves
    // 'waiting_for_roll' for ANY reason (bot roll included), arrows go
    // static and stay static through awaiting_move_selection/move_resolving,
    // never restarting until the NEXT waiting_for_roll phase.
    if (!/async function performBotTurnStep[\s\S]*?await performRollSequence\(color\)/.test(controllerSrc)) {
      fail('A8: performBotTurnStep must call performRollSequence — the same shared roll path, no separate bot-only rotation logic')
    }
    const screenSrc = readFileSync(
      join(__dirname, '../src/app/games/ludo/renderLudoGameScreen.ts'),
      'utf8',
    )
    if (!/shouldRotateArrows: isActive && state\.turnPhase === 'waiting_for_roll'/.test(screenSrc)) {
      fail('A8: shouldRotateArrows must depend ONLY on isActive + turnPhase===\'waiting_for_roll\' — no botControlledColors/isDiceRolling branch that could restart rotation for bots differently than humans')
    }
    console.log('[checkLudoArrowRotation] A8 OK — bot roll stops rotation via the same turnPhase-based rule, with no separate bot logic and no restart during move phase.')
  }

  // --- Extra: CSS animation is wired to shouldRotateArrows, not isRolling/isDiceRolling (source review) ---
  {
    const diceControlSrc = readFileSync(
      join(__dirname, '../src/app/games/ludo/dice/renderLudoDiceControl.ts'),
      'utf8',
    )
    if (!/\$\{shouldRotateArrows \? 'animation:ludo-dice-arrows-spin[\s\S]*?: ''\}/.test(diceControlSrc)) {
      fail('Extra: renderLudoDiceControl must gate the arrow-spin animation on shouldRotateArrows, not on isRolling/isDiceRolling')
    }
    // Only check for FUNCTIONAL references (interface field, destructured
    // variable) — explanatory comments mentioning the old flag by name for
    // historical context are fine and expected.
    if (/isRolling:\s*boolean|const \{[^}]*\bisRolling\b/.test(diceControlSrc)) {
      fail('Extra: renderLudoDiceControl.ts must no longer functionally reference the old isRolling flag — it must be fully replaced by shouldRotateArrows')
    }
    console.log('[checkLudoArrowRotation] Extra OK — arrow-spin CSS animation is gated exclusively on shouldRotateArrows; the old isRolling flag is gone.')
  }

  console.log('[checkLudoArrowRotation] ALL OK')
  process.exit(0)
}

main()
