/**
 * checkLudoMoveAnimationSurvivesRerender.ts
 *
 * Regression test за bug-а "пионката изчезва по средата на move/hop
 * анимацията точно когато emoji reaction cleanup-ът приключи, после пак се
 * появява" (task: "emoji cleanup убива pawn move animation").
 *
 * ROOT CAUSE (виж playLudoMoveRouteOverlay.ts doc коментара за пълния
 * анализ): движещата се пионка/trail nodes-и по-рано се appendваха ВЪТРЕ в
 * `[data-ludo-effects-overlay="1"]`, който е част от board-овия markup —
 * т.е. дете на createLudoFlowController.ts::options.root, чийто innerHTML
 * СЕ ЗАМЕСТВА ЦЯЛОСТНО при ВСЕКИ render() call (emoji reaction cleanup,
 * viewer popover toggle, gift overlay sync, spectator viewer update — и
 * самите gameplay render()-и). Board rebuild detach-ваше overlay div-а (и
 * moving/trail децата му) от документа по средата на WAAPI анимацията —
 * detached node продължава "тихо" да тече вътрешно (animation.finished пак
 * се resolve-ва накрая, `suppressedPieceIds` пак се разчиства, следващ
 * render разкрива пионката на финалната ѝ позиция — от там "изчезва после
 * се появява" симптомът), но е НЕВИДИМА, докато не дойде следващ render.
 *
 * ДОКАЗАНО е (виж B1/B2 по-долу), че проблемът е ОБЩ render-lifecycle
 * проблем, НЕ emoji-specific: КОЙТО И ДА Е unrelated render() на
 * options.root по средата на анимацията чупи presentation-а по абсолютно
 * същия механизъм — emoji cleanup е просто НАЙ-ЛЕСНИЯТ начин да го
 * repro-неш (кратък fixed timeout), не единствената причина.
 *
 * FIX: mirror на established pattern-а на playLudoCaptureFlightOverlay.ts/
 * playLudoDiceFlightOverlay.ts/dice-result-overlay controller-а (всички
 * ВЕЧЕ живееха на document.body точно по тая причина) — moving/trail
 * nodes-ите вече се appendват directno на document.body (sibling на
 * options.root, никога пипнати от generic render()), позиционирани с
 * position:fixed чрез сурови (viewport-absolute) getBoundingClientRect()
 * координати. Клетъчните lookup-и (`root.querySelector(
 * '[data-ludo-cell-pieces=...]')`) остават directно спрямо `root` — те се
 * извикват ФРЕШ на всяка route стъпка, значи дори board rebuild
 * междувременно (същия layout, нови DOM nodes) не чупи следващото
 * измерване. Гейм логика (legal moves, route calculation, server
 * snapshots, turn timers, auto-move) НЕ е пипната — фиксът е изцяло
 * presentation/DOM-hosting.
 *
 * Покрива:
 *   [S1] Source review — createPieceNode() ползва position:fixed (не
 *        position:absolute)
 *   [S2] Source review — main функцията appendва moving node-а directno на
 *        document.body (не на `[data-ludo-effects-overlay="1"]`)
 *   [S3] Source review — playTrail() appendва trail node-а directno на
 *        document.body
 *   [S4] Source review — cellCenter() смята viewport-absolute координати
 *        (getBoundingClientRect() директно, без overlay-relative
 *        subtraction) — старата overlay-relative математика е премахната
 *   [S5] Source review — cleanup() чисти stray nodes от document.body (не
 *        от overlay-a)
 *   [S6] Source review — файлът вече изобщо НЕ реферира
 *        `[data-ludo-effects-overlay="1"]` за placement (нулева
 *        зависимост от board-nested container-а)
 *   [B1] Real-browser (Playwright) DOM mechanism test — OLD board-nested
 *        pattern РЕАЛНО репродуцира бъга: mid-animation root.innerHTML
 *        replace (mirror на render()) detach-ва moving node-а
 *        (isConnected: true -> false)
 *   [B2] Real-browser DOM mechanism test — NEW document.body-hosted
 *        pattern оцелява СЪЩИЯ mid-animation root.innerHTML replace
 *        (isConnected остава true през цялото "движение", node-ът се
 *        премахва самò едва при explicit animation-finished cleanup)
 *   [B3] Общ render-lifecycle проблем, не emoji-specific: НЯКОЛКО
 *        последователни unrelated root re-renders (mirror на gift overlay
 *        sync + spectator viewer update + viewer popover toggle) по
 *        средата на "анимацията" — document.body-hosted node оцелява
 *        всичките, финалната позиция остава коректна, node-ът се появява
 *        точно веднъж (не duplicate) през целия сценарий
 *
 * Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

const projectRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length) ?? resolve(process.cwd(), '..'))
const overlayPath = resolve(projectRoot, 'src/app/games/ludo/pieces/playLudoMoveRouteOverlay.ts')
const overlaySrc = readFileSync(overlayPath, 'utf8')

console.log('\ncheckLudoMoveAnimationSurvivesRerender\n')

// ═══════════════════════════════════════════════════════════════════════
// S1-S6: source review
// ═══════════════════════════════════════════════════════════════════════
console.log('=== S1-S6: source review ===')

await check('[S1] createPieceNode() ползва position:fixed (не position:absolute)', () => {
  const fnMatch = /function createPieceNode\([\s\S]*?\n\}/.exec(overlaySrc)
  assert(fnMatch !== null, 'createPieceNode() трябва да съществува')
  assert(/position:fixed;/.test(fnMatch![0]), 'createPieceNode() трябва да задава position:fixed')
  assert(!/position:absolute;/.test(fnMatch![0]), 'createPieceNode() вече НЕ трябва да задава position:absolute')
})

await check('[S2] main функцията appendва moving node-а directno на document.body', () => {
  assert(
    /document\.body\.appendChild\(moving\)/.test(overlaySrc),
    'очаквано document.body.appendChild(moving) в playLudoMoveRouteOverlay()',
  )
  assert(
    !/overlay\.appendChild\(moving\)/.test(overlaySrc),
    'вече НЕ трябва да съществува overlay.appendChild(moving) (board-nested placement премахнат)',
  )
})

await check('[S3] playTrail() appendва trail node-а directno на document.body', () => {
  const fnMatch = /function playTrail\([\s\S]*?\n\}/.exec(overlaySrc)
  assert(fnMatch !== null, 'playTrail() трябва да съществува')
  assert(/document\.body\.appendChild\(trail\)/.test(fnMatch![0]), 'playTrail() трябва да appendва directno на document.body')
})

await check('[S4] cellCenter() смята viewport-absolute координати (без overlay-relative subtraction)', () => {
  const fnMatch = /function cellCenter\([\s\S]*?\n\}/.exec(overlaySrc)
  assert(fnMatch !== null, 'cellCenter() трябва да съществува')
  assert(/getBoundingClientRect\(\)/.test(fnMatch![0]), 'cellCenter() трябва да ползва getBoundingClientRect()')
  assert(!/overlayRect/.test(fnMatch![0]), 'cellCenter() вече НЕ трябва да смята overlay-relative координати (overlayRect)')
  assert(!fnMatch![0].includes('overlay: HTMLElement'), 'cellCenter() вече НЕ трябва да приема overlay параметър')
})

await check('[S5] cleanup() чисти stray nodes от document.body (не от overlay-a)', () => {
  const fnMatch = /const cleanup = \(\) => \{[\s\S]*?\n  \}/.exec(overlaySrc)
  assert(fnMatch !== null, 'cleanup() трябва да съществува')
  assert(/document\.body\.querySelectorAll/.test(fnMatch![0]), 'cleanup() трябва да query-ва document.body')
  assert(!/overlay\.querySelectorAll/.test(fnMatch![0]), 'cleanup() вече НЕ трябва да query-ва overlay-a')
})

await check('[S6] файлът вече изобщо НЕ прави querySelector за `[data-ludo-effects-overlay="1"]` (само историческо обяснение в doc коментар е ОК)', () => {
  assert(
    !/querySelector[^\n]*data-ludo-effects-overlay/.test(overlaySrc),
    'playLudoMoveRouteOverlay.ts вече не трябва да прави querySelector за board-nested effects-overlay container-а',
  )
})

// ═══════════════════════════════════════════════════════════════════════
// B1-B3: real-browser DOM mechanism test (Playwright) — синтетична
// минимална фикстура, която възпроизвежда ТОЧНО DOM механизма (mid-
// animation innerHTML replace на "board root"-а, mirror на
// createLudoFlowController.ts::render()), не пълния production
// controller/match/WS stack (виж checkLudoModalLayerInteractivity.ts за
// established scope rationale в тоя проект) — истински browser layout/
// isConnected semantics, не jsdom.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== B1-B3: real-browser DOM mechanism (Playwright) ===')

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent(`
    <!DOCTYPE html>
    <html><body>
      <div id="app-root">
        <div data-ludo-cell-pieces="cell-a" style="position:fixed;left:50px;top:50px;width:10px;height:10px;"></div>
        <div data-ludo-cell-pieces="cell-b" style="position:fixed;left:250px;top:50px;width:10px;height:10px;"></div>
        <div data-ludo-effects-overlay="1" style="position:absolute;inset:0;"></div>
      </div>
    </body></html>
  `)

  const BOARD_MARKUP = `
    <div data-ludo-cell-pieces="cell-a" style="position:fixed;left:50px;top:50px;width:10px;height:10px;"></div>
    <div data-ludo-cell-pieces="cell-b" style="position:fixed;left:250px;top:50px;width:10px;height:10px;"></div>
    <div data-ludo-effects-overlay="1" style="position:absolute;inset:0;"></div>
  `

  await check('[B1] OLD board-nested pattern: mid-animation root.innerHTML replace detach-ва moving node-а (isConnected true -> false)', async () => {
    const result = await page.evaluate(`
      (function () {
        var root = document.getElementById('app-root');
        var overlay = root.querySelector('[data-ludo-effects-overlay="1"]');
        var moving = document.createElement('div');
        moving.setAttribute('data-ludo-moving-piece', 'r1');
        moving.style.cssText = 'position:absolute;left:50px;top:50px;';
        overlay.appendChild(moving);
        var connectedBefore = moving.isConnected;
        // Симулира unrelated render() по средата на "анимацията" (mirror на
        // emoji-reaction-cleanup/viewer-popover/gift-sync path-овете, всички
        // от които правят пълен root.innerHTML replace).
        root.innerHTML = ${JSON.stringify(BOARD_MARKUP)};
        var connectedAfter = moving.isConnected;
        return { connectedBefore: connectedBefore, connectedAfter: connectedAfter };
      })()
    `) as { connectedBefore: boolean; connectedAfter: boolean }
    assert(result.connectedBefore === true, 'moving node трябва да е свързан веднага след append')
    assert(result.connectedAfter === false, `OLD pattern трябва да РЕПРОДУЦИРА бъга (node detached след rerender), получено isConnected=${result.connectedAfter}`)
  })

  await check('[B2] NEW document.body-hosted pattern оцелява СЪЩИЯ mid-animation root.innerHTML replace (isConnected остава true)', async () => {
    const result = await page.evaluate(`
      (function () {
        var root = document.getElementById('app-root');
        var moving = document.createElement('div');
        moving.setAttribute('data-ludo-moving-piece', 'r1');
        moving.style.cssText = 'position:fixed;left:50px;top:50px;';
        document.body.appendChild(moving);
        var connectedBefore = moving.isConnected;
        // Същия unrelated root rerender като в B1 — сега moving node-ът е
        // sibling на root, не дете, значи не е засегнат.
        root.innerHTML = ${JSON.stringify(BOARD_MARKUP)};
        var connectedAfter = moving.isConnected;
        moving.remove();
        var connectedAfterCleanup = moving.isConnected;
        return { connectedBefore: connectedBefore, connectedAfter: connectedAfter, connectedAfterCleanup: connectedAfterCleanup };
      })()
    `) as { connectedBefore: boolean; connectedAfter: boolean; connectedAfterCleanup: boolean }
    assert(result.connectedBefore === true, 'moving node трябва да е свързан веднага след append')
    assert(result.connectedAfter === true, `NEW pattern трябва да ОЦЕЛЕЕ unrelated rerender-а (node остава свързан), получено isConnected=${result.connectedAfter}`)
    assert(result.connectedAfterCleanup === false, 'explicit cleanup (animation-finished remove()) трябва пак да работи нормално')
  })

  await check('[B3] Общ render-lifecycle проблем (не emoji-specific): document.body-hosted node оцелява НЯКОЛКО последователни unrelated rerenders, появява се точно веднъж', async () => {
    const result = await page.evaluate(`
      (function () {
        var root = document.getElementById('app-root');
        var moving = document.createElement('div');
        moving.setAttribute('data-ludo-moving-piece', 'r1');
        moving.style.cssText = 'position:fixed;left:50px;top:50px;';
        document.body.appendChild(moving);
        var connectedTrace = [];
        // Mirror на 3 различни unrelated render()-causing UI пътища, всичките
        // способни да се случат по средата на едно и също move: gift overlay
        // sync, spectator viewer count update, viewer popover toggle.
        var triggers = ['gift-sync', 'spectator-viewer-update', 'viewer-popover-toggle'];
        for (var i = 0; i < triggers.length; i++) {
          root.innerHTML = ${JSON.stringify(BOARD_MARKUP)};
          connectedTrace.push(moving.isConnected);
        }
        var duplicateCount = document.body.querySelectorAll('[data-ludo-moving-piece="r1"]').length;
        moving.remove();
        return { connectedTrace: connectedTrace, duplicateCount: duplicateCount };
      })()
    `) as { connectedTrace: boolean[]; duplicateCount: number }
    assert(result.connectedTrace.every((c) => c === true), `node трябва да остане свързан през ВСИЧКИ unrelated rerenders, получена трасировка: ${JSON.stringify(result.connectedTrace)}`)
    assert(result.duplicateCount === 1, `node трябва да съществува точно веднъж (без duplicate), получено ${result.duplicateCount}`)
  })
} finally {
  await browser.close()
}

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1
