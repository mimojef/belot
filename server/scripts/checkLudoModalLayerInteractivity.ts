/**
 * checkLudoModalLayerInteractivity.ts
 *
 * Regression test за bug-а "Ludo dice button изглежда активен, но click/tap
 * не прави нищо, случайно след emoji reaction / spectator viewers list
 * interaction" (live-confirmed чрез elementFromPoint diagnostic — topmost
 * element над dice button-а беше `[data-ludo-modal-layer="1"]`).
 *
 * ROOT CAUSE (виж createLudoFlowController.ts::syncModalLayerInteractivity
 * doc коментара за пълния анализ): modalLayerRoot е ЕДИН fullscreen
 * container, споделен между "истински" модали (settings/exit-confirm/
 * game-end/bot-takeover backdrop-и) И леки floating panels (emoji picker,
 * spectator viewers popover). Старата логика
 * (`childElementCount > 0 ? 'auto' : 'none'`) броеше и двете категории
 * безразборно — ако emoji-picker/viewer-popover бяха mount-нати в момента,
 * в който НЯКОЙ ДРУГ, несвързан call site (напр. bot-takeover-backdrop
 * defensive cleanup-ът, който тече на ВСЕКИ authoritative snapshot)
 * пресмяташе interactivity-то, root-ът погрешно ставаше pointer-events:
 * auto — и оставаше stuck така (emoji/viewer close пътищата никога не
 * викат тая функция), swallow-вайки ВСИЧКИ click-ове над целия viewport
 * (вкл. dice button-а), докато следваща authoritative snapshot случайно не
 * го reset-неше обратно.
 *
 * FIX: root-ът вече е ПОСТОЯННО pointer-events:none (hardcoded веднъж, при
 * създаването му) — всеки реален consumer (settings/exit-confirm/game-end/
 * bot-takeover backdrop, emoji-picker panel, spectator-viewers-popover
 * panel) вече носи СОБСТВЕН explicit pointer-events:auto на собствения си
 * top-level елемент, значи е clickable независимо от root-а (стандартно
 * CSS: descendant pointer-events:auto override-ва ancestor pointer-events:
 * none). syncModalLayerInteractivity() е оставена като no-op stub (не
 * изтрита), за да не се пипат ~10-те съществуващи call site-а.
 *
 * Покрива:
 *   [S1] Source review — modalLayerRoot.style.cssText hardcode-ва
 *        pointer-events:none безусловно (не template literal branch)
 *   [S2] Source review — syncModalLayerInteractivity() body вече НЕ
 *        реферира childElementCount (старата buggy логика премахната)
 *   [S3] Source review — всичките 4 "истински" модал mount функции
 *        (settings/exit-confirm/game-end/bot-takeover) продължават да
 *        задават собствен pointerEvents='auto' на backdrop-а си
 *        (regression guard — фиксът не е счупил тях)
 *   [S4] Source review — emoji-picker/viewer-popover mount функциите
 *        продължават да задават собствен pointerEvents='auto' на панела
 *        си (regression guard)
 *   [B1] Real-browser (Playwright) DOM mechanism test — OLD
 *        childElementCount-based logic РЕАЛНО репродуцира бъга
 *        (elementFromPoint над dice button връща modal-layer root)
 *   [B2] Real-browser DOM mechanism test — NEW (fixed, permanent-none)
 *        logic оставя dice button напълно clickable след leight-panel
 *        (emoji picker) open+unrelated-sync+close цикъл
 *   [B3] Същото за spectator-viewers-popover-стил panel — потвърждава
 *        ОБЩ root cause между emoji и viewer list (task-а §2)
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
const controllerPath = resolve(projectRoot, 'src/app/games/ludo/createLudoFlowController.ts')
const controllerSrc = readFileSync(controllerPath, 'utf8')

console.log('\ncheckLudoModalLayerInteractivity\n')

// ═══════════════════════════════════════════════════════════════════════
// S1-S4: source review
// ═══════════════════════════════════════════════════════════════════════
console.log('=== S1-S4: source review ===')

await check('[S1] modalLayerRoot.style.cssText hardcode-ва pointer-events:none безусловно', () => {
  assert(
    /modalLayerRoot\.style\.cssText = `position:fixed;inset:0;z-index:\$\{LUDO_MODAL_LAYER_Z_INDEX\};pointer-events:none;`/.test(controllerSrc),
    'очаквано hardcoded pointer-events:none в modalLayerRoot inline style-а',
  )
})

await check('[S2] syncModalLayerInteractivity() вече НЕ реферира childElementCount (старата buggy логика премахната)', () => {
  const fnMatch = /function syncModalLayerInteractivity\(\): void \{[\s\S]*?\n {2}\}/.exec(controllerSrc)
  assert(fnMatch !== null, 'функцията трябва да съществува (запазена като no-op stub)')
  assert(!/childElementCount/.test(fnMatch![0]), 'функцията НЕ трябва вече да реферира childElementCount')
})

await check('[S3] "истинските" модали (settings/exit-confirm/game-end/bot-takeover) продължават сами да задават pointerEvents=\'auto\' на backdrop-а си', () => {
  const occurrences = controllerSrc.match(/backdrop\.style\.pointerEvents = 'auto'/g) ?? []
  assert(occurrences.length >= 4, `очаквани поне 4 backdrop.style.pointerEvents='auto' site-а (settings/exit-confirm/game-end/bot-takeover), намерени ${occurrences.length}`)
})

await check("[S4] emoji-picker/viewer-popover панелите продължават сами да задават pointerEvents='auto'", () => {
  const occurrences = controllerSrc.match(/panel\.style\.pointerEvents = 'auto'/g) ?? []
  assert(occurrences.length >= 2, `очаквани поне 2 panel.style.pointerEvents='auto' site-а (emoji picker + viewer popover), намерени ${occurrences.length}`)
})

// ═══════════════════════════════════════════════════════════════════════
// B1-B3: real-browser DOM mechanism test (Playwright) — синтетична
// минимална фикстура, която възпроизвежда ТОЧНО CSS/DOM механизма (не
// пълния production controller/match/WS stack — виж doc коментара горе за
// scope rationale) — истински browser layout/hit-testing engine, не jsdom
// (jsdom не поддържа реален layout/elementFromPoint).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== B1-B3: real-browser DOM mechanism (Playwright) ===')

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent(`
    <!DOCTYPE html>
    <html><body>
      <button id="dice-button" style="position:fixed;top:100px;left:100px;width:50px;height:50px;">Roll</button>
    </body></html>
  `)

  // Установява modalLayerRoot fixture-а еднократно (mirror на реалната
  // createLudoFlowController.ts инициализация). ВАЖНО: page.evaluate() тук
  // взима STRING, не compiled TS function reference — tsx/esbuild wrap-ва
  // compiled functions с __name(...) helper (source-map/debug convention),
  // който не съществува в изолирания browser context, в който Playwright
  // re-evaluate-ва serialized function-и — string evaluation го заобикаля
  // изцяло (browser-ът парсва суровия JS текст директно, никакъв Node-side
  // build step не го пипа).
  await page.evaluate(`
    (function () {
      var modalLayerRoot = document.createElement('div');
      modalLayerRoot.setAttribute('data-ludo-modal-layer', '1');
      modalLayerRoot.style.cssText = 'position:fixed;inset:0;z-index:10000;pointer-events:none;';
      document.body.appendChild(modalLayerRoot);
      window.__modalLayerRoot = modalLayerRoot;
    })()
  `)

  function evaluateModalLayerScenario(panelAttr: string, useOldBuggyLogic: boolean, panelStyle: string): Promise<{
    topIsModalLayer: boolean
    topIsButton: boolean
    topId: string | null
    rootPointerEvents: string
  }> {
    return page.evaluate(`
      (function () {
        var modalLayerRoot = window.__modalLayerRoot;
        modalLayerRoot.style.pointerEvents = 'none';
        var sync = ${useOldBuggyLogic}
          ? function () { modalLayerRoot.style.pointerEvents = modalLayerRoot.childElementCount > 0 ? 'auto' : 'none'; }
          : function () { /* no-op — mirror на production fix-а */ };
        // Mount leight panel (emoji picker/viewer popover) — самата тя носи
        // собствен pointer-events:auto, НЕ вика sync сама (mirror на
        // mountEmojiPicker/mountSpectatorViewersPopover).
        var panel = document.createElement('div');
        panel.setAttribute(${JSON.stringify(panelAttr)}, '1');
        panel.style.cssText = ${JSON.stringify(panelStyle)};
        modalLayerRoot.appendChild(panel);
        // Несвързан defensive cleanup call (mirror на bot-takeover-backdrop
        // cleanup-а в applyAuthoritativeTransition, тече на ВСЕКИ snapshot).
        sync();
        // Панелът се затваря (mirror на closeEmojiPicker/
        // closeSpectatorViewersPopover) — remove без sync call.
        panel.remove();
        var button = document.getElementById('dice-button');
        var rect = button.getBoundingClientRect();
        var top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          topIsModalLayer: top === modalLayerRoot,
          topIsButton: top === button,
          topId: top ? (top.id || top.getAttribute('data-ludo-modal-layer')) : null,
          rootPointerEvents: modalLayerRoot.style.pointerEvents,
        };
      })()
    `)
  }

  const EMOJI_PANEL_STYLE = 'position:fixed;bottom:0;left:0;width:200px;height:80px;pointer-events:auto;'
  const VIEWER_PANEL_STYLE = 'position:fixed;top:40px;right:0;width:220px;height:160px;pointer-events:auto;'

  await check('[B1] OLD childElementCount-based logic РЕАЛНО репродуцира бъга (dice button става unclickable след leight-panel open+unrelated-sync+close)', async () => {
    const result = await evaluateModalLayerScenario('data-ludo-emoji-picker', true, EMOJI_PANEL_STYLE)
    assert(result.rootPointerEvents === 'auto', `OLD logic трябва да остави root-а pointer-events:auto, получено ${result.rootPointerEvents}`)
    assert(result.topIsModalLayer, `OLD logic трябва да репродуцира бъга (elementFromPoint връща modal-layer root), топ елемент: ${result.topId}`)
  })

  await check('[B2] NEW (fixed) no-op logic оставя dice button напълно clickable след emoji-picker-стил open+close', async () => {
    const result = await evaluateModalLayerScenario('data-ludo-emoji-picker', false, EMOJI_PANEL_STYLE)
    assert(result.rootPointerEvents === 'none', `NEW logic трябва root-ът да остане pointer-events:none, получено ${result.rootPointerEvents}`)
    assert(result.topIsButton, 'NEW logic трябва dice button да е topmost/clickable')
  })

  await check('[B3] Същия mechanism/fix важи и за spectator-viewers-popover-стил panel (общ root cause с emoji, task-а §2)', async () => {
    const result = await evaluateModalLayerScenario('data-ludo-spectator-viewers-popover', false, VIEWER_PANEL_STYLE)
    assert(result.rootPointerEvents === 'none', `viewer-popover сценарий: root-ът трябва да остане pointer-events:none, получено ${result.rootPointerEvents}`)
    assert(result.topIsButton, 'viewer-popover сценарий: dice button трябва да е topmost/clickable')
  })
} finally {
  await browser.close()
}

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1
