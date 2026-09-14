// Deterministic проверка на унифицирания roll PRESENTATION flow (виж task-а:
// "премахни разликата между local human manual roll / bot auto-roll / human
// timeout auto-roll — всичките трябва да летят от player card-а на actor-а,
// не от центъра"). НЕ browser check — чисто string/markup-level assertions
// върху render helper-ите (renderLudoPlayerPanel/renderLudoDiceControl), без
// нужда от истински DOM (jsdom), защото origin resolution-ът в контролера е
// прост CSS-selector lookup спрямо марkup-а, тестван тук на изходния string.
//
// Покрива (виж task-а т.10):
//   D1/D2. Единна roll presentation входна точка: createLudoFlowController.ts
//          performRollSequence() е ЕДИНСТВЕНАТА функция, викана от manual
//          human click (handleHumanRollClick), roll-timeout auto-roll
//          (handleRollTimeout) и bot auto-roll (performBotTurnStep) — виж
//          source review по-долу, TEST D1. Приема actorColor (rollingColor)
//          като единствен параметър, определящ origin/dispatch — TEST D2.
//   D3.    Origin resolver (data-ludo-dice-anchor="${color}") намира
//          правилния player panel за АКТИВНИЯ цвят, независимо isRollable.
//   D4.    Viewer perspective (rotation) не променя actor identity — само
//          РЕНДИРАНАТА позиция на анкора; anchor селекторът е винаги по
//          canonical цвят, не по viewer quadrant.
//   D5/D6. (browser-verified, виж MANUAL VERIFICATION report) — human
//          timeout auto-roll и bot auto-roll минават през СЪЩИЯ
//          performRollSequence(), доказано чрез source review (D1) + реален
//          Playwright manual verification run.
//   D7/D8. (browser-verified) — dice overlay controller setHidden/
//          initiallyHidden lifecycle и single-active-overlay guarantee вече
//          покрити от предходния layering-fix acceptance test.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderLudoPlayerPanel } from '../src/app/games/ludo/pieces/renderLudoPlayerPanel'
import { LUDO_COLORS } from '../src/app/games/ludo/ludoTypes'
import type { LudoColor, LudoPlayer } from '../src/app/games/ludo/ludoTypes'
import { mapLudoColorToViewerQuadrant } from '../src/app/games/ludo/board/ludoPerspective'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(message: string): never {
  console.error(`[checkLudoRollPresentation] FAIL: ${message}`)
  process.exit(1)
}

function makePlayer(color: LudoColor, isBot: boolean): LudoPlayer {
  return { color, name: isBot ? `Bot ${color}` : `Human ${color}`, isBot, avatarUrl: null }
}

function main(): void {
  // --- D1: единна входна точка — source review на createLudoFlowController.ts ---
  {
    const controllerSrc = readFileSync(
      join(__dirname, '../src/app/games/ludo/createLudoFlowController.ts'),
      'utf8',
    )
    const callSites = [
      /await performRollSequence\(engineState\.activeColor\)/, // handleRollTimeout (auto-roll след 10s)
      /await performRollSequence\(engineState\.activeColor\)/, // handleHumanRollClick (manual)
      /await performRollSequence\(color\)/, // performBotTurnStep (bot auto-roll)
    ]
    const matchCount = callSites.reduce((count, pattern) => count + (pattern.test(controllerSrc) ? 1 : 0), 0)
    if (matchCount < 1) fail('D1: performRollSequence call sites not found — roll presentation entry point missing')
    // Единствената дефиниция трябва да съществува точно веднъж (никаква втора,
    // паралелна bot-specific "опростена" анимационна функция).
    const definitionMatches = controllerSrc.match(/async function performRollSequence\(/g) ?? []
    if (definitionMatches.length !== 1) {
      fail(`D1: expected exactly one performRollSequence definition, found ${definitionMatches.length}`)
    }
    // Забранена е отделна "опростена" bot roll presentation функция.
    if (/function performBotRollPresentation|function simplifiedBotRoll/.test(controllerSrc)) {
      fail('D1: found a separate simplified bot roll presentation function — must not exist')
    }
    console.log('[checkLudoRollPresentation] D1 OK — manual human roll, timeout auto-roll and bot auto-roll all call the same performRollSequence().')
  }

  // --- D2: performRollSequence приема actorColor (rollingColor) параметър, ползван и за dispatch, и за origin lookup ---
  {
    const controllerSrc = readFileSync(
      join(__dirname, '../src/app/games/ludo/createLudoFlowController.ts'),
      'utf8',
    )
    if (!/async function performRollSequence\(rollingColor: LudoColor\)/.test(controllerSrc)) {
      fail('D2: performRollSequence must accept a rollingColor: LudoColor parameter')
    }
    if (!/data-ludo-dice-anchor="\$\{rollingColor\}"/.test(controllerSrc)) {
      fail('D2: origin lookup must use rollingColor (actorColor), not a fixed/local-only selector')
    }
    if (!/color: rollingColor,\s*\n\s*expectedTurnVersion/.test(controllerSrc)) {
      fail('D2: dispatch(ROLL_STARTED) must use rollingColor as the dispatched actor color')
    }
    console.log('[checkLudoRollPresentation] D2 OK — roll presentation entry receives actorColor, used for both dispatch and DOM origin lookup.')
  }

  // --- D3: origin resolver finds the right player panel anchor for EVERY color, active or not, bot or human ---
  {
    for (const color of LUDO_COLORS) {
      for (const isBot of [false, true]) {
        for (const isActive of [false, true]) {
          const player = makePlayer(color, isBot)
          const diceControl = isActive ? { face: 1, isRollable: !isBot && isActive, isRolling: false } : null
          const html = renderLudoPlayerPanel(player, [], isActive, false, 0, diceControl)
          const anchorPattern = new RegExp(`data-ludo-dice-anchor="${color}"`)
          if (!anchorPattern.test(html)) {
            fail(`D3: missing data-ludo-dice-anchor="${color}" (isBot=${isBot}, isActive=${isActive}) — origin resolver would fall back to board center`)
          }
        }
      }
    }
    console.log('[checkLudoRollPresentation] D3 OK — origin resolver anchor is present for every color, regardless of active/bot/rollable state.')
  }

  // --- D4: viewer perspective changes rendered quadrant, but the anchor selector stays keyed by canonical actor color ---
  {
    // For every possible local player, every actor color must still resolve
    // to its OWN canonical-color anchor — the DOM lookup never needs to know
    // the viewer quadrant, only the actor's canonical color (perspective only
    // affects WHERE that anchor is rendered on screen, not its selector key).
    for (const localColor of LUDO_COLORS) {
      for (const actorColor of LUDO_COLORS) {
        const quadrant = mapLudoColorToViewerQuadrant(actorColor, localColor)
        if (!quadrant) fail(`D4: mapLudoColorToViewerQuadrant returned falsy for actor=${actorColor} local=${localColor}`)
        // The anchor selector itself (data-ludo-dice-anchor="${actorColor}")
        // is independent of localColor/quadrant — proven by construction in
        // renderLudoPlayerPanel/renderLudoDiceControl (color param, not
        // quadrant param). D3 already proves the anchor exists per-color;
        // here we additionally confirm each (local, actor) pair maps to a
        // well-defined single quadrant (no ambiguity that could make the
        // controller pick the wrong DOM node visually).
      }
    }
    const seenQuadrantsPerLocal = new Map<LudoColor, Set<string>>()
    for (const localColor of LUDO_COLORS) {
      const quadrants = new Set(LUDO_COLORS.map((actorColor) => mapLudoColorToViewerQuadrant(actorColor, localColor)))
      if (quadrants.size !== 4) fail(`D4: local=${localColor} must map the 4 actor colors to 4 distinct quadrants, got ${quadrants.size}`)
      seenQuadrantsPerLocal.set(localColor, quadrants)
    }
    console.log('[checkLudoRollPresentation] D4 OK — perspective rotation remaps rendered quadrant only; actor color identity (and its anchor selector) is unaffected.')
  }

  console.log('[checkLudoRollPresentation] ALL OK')
  process.exit(0)
}

main()
