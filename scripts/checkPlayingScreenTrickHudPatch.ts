/**
 * checkPlayingScreenTrickHudPatch.ts
 *
 * Regression test за Fix №2 (playing/trick/HUD render performance):
 * renderPlayingScreen.ts вече не прави безусловен `root.innerHTML=` rebuild
 * на всеки playing render. FULL rebuild става само при shell-структурна
 * промяна (playingShellKey); при same-shell renders trick и HUD региони се
 * пренаписват само при собствена dirty-key/HTML промяна.
 *
 * Пази срещу връщане към:
 *  A) безусловен full rebuild (загуба на цялата оптимизация);
 *  B) включване на transient animation-progress полета (animateNewest /
 *     newestEntryElapsedMs / completedTrickEntryElapsedMs) в trickStableKey
 *     — това би прекъснало CSS entry анимацията (negative animation-delay
 *     техника), защото би тригернало DOM rewrite по средата ѝ;
 *  C) нов early return, който прескача downstream playing side effects
 *     (bottom hand sync, mobile trick sync, seat panels, listener binding,
 *     animatePlayedCardFromHand/scheduleCompletedTrickCollection тригери);
 *  D) преместване на isCollectingTrickOnEntry guard-а след новата логика.
 *
 * Source-text проверка (established стил, виж checkPlayingHandCardIdentityFix.ts)
 * — jsdom не е налична зависимост в проекта.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'renderPlayingScreen.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

const source = await readFile(RENDER_PATH, 'utf8')

await check(
  '[1] data-trick-patch-host="1" присъства върху desktop trick container в renderPlayingStage',
  () => {
    const fnStart = source.indexOf('function renderPlayingStage')
    assert(fnStart !== -1, 'function renderPlayingStage not found')
    const fnBody = source.slice(fnStart, fnStart + 1000)
    assert(
      fnBody.includes('data-trick-patch-host="1"'),
      'expected data-trick-patch-host="1" attribute on the trick wrapper div inside renderPlayingStage',
    )
  },
)

await check(
  '[2] trick DOM write е gate-нат зад trickStableKey !== cache.lastTrickStableKey сравнение (не безусловен)',
  () => {
    assert(
      source.includes('trickStableKey !== cache.lastTrickStableKey'),
      'expected an explicit trickStableKey !== cache.lastTrickStableKey guard before writing to the trick patch host',
    )
  },
)

await check(
  '[3] trickStableKey включва getTrickKey(displayedPlays), localSeat и cache.flyingCardPlayKey',
  () => {
    const keyStart = source.indexOf('const trickStableKey =')
    assert(keyStart !== -1, 'const trickStableKey definition not found')
    const keyDef = source.slice(keyStart, keyStart + 220)
    assert(keyDef.includes('getTrickKey(displayedPlays)'), 'trickStableKey no longer derives from getTrickKey(displayedPlays)')
    assert(keyDef.includes('localSeat'), 'trickStableKey no longer includes localSeat')
    assert(keyDef.includes('cache.flyingCardPlayKey'), 'trickStableKey no longer includes cache.flyingCardPlayKey')
  },
)

await check(
  '[4] trickStableKey НЕ включва transient animation-progress полета (animateNewest / newestEntryElapsedMs / completedTrickEntryElapsedMs)',
  () => {
    const keyStart = source.indexOf('const trickStableKey =')
    assert(keyStart !== -1, 'const trickStableKey definition not found')
    const keyDef = source.slice(keyStart, keyStart + 220)
    assert(
      !keyDef.includes('animateNewest') &&
        !keyDef.includes('newestEntryElapsedMs') &&
        !keyDef.includes('completedTrickEntryElapsedMs'),
      'trickStableKey includes a transient animation-progress field — this would rewrite the trick DOM mid-entry-animation',
    )
  },
)

await check(
  '[5] HUD write е gate-нат зад rendered-HTML equality (scoreHudHtml !== cache.lastScoreHudRenderedHtml), не безусловен',
  () => {
    assert(
      source.includes('scoreHudHtml !== cache.lastScoreHudRenderedHtml'),
      'expected an explicit scoreHudHtml !== cache.lastScoreHudRenderedHtml guard before replacing the ScoreHud node',
    )
  },
)

await check(
  '[6] playingShellKey включва всичките 7 договорени shell inputs',
  () => {
    const keyStart = source.indexOf('const playingShellKey = [')
    assert(keyStart !== -1, 'const playingShellKey array literal not found')
    const keyEnd = source.indexOf(".join('|')", keyStart)
    assert(keyEnd !== -1, "playingShellKey .join('|') not found")
    const keyDef = source.slice(keyStart, keyEnd)
    for (const field of [
      'mobileLayoutAttribute',
      'screenHeightStyle',
      'tableBackground',
      'String(scaledStageWidth)',
      'String(scaledStageHeight)',
      'String(stageScale)',
      'fixedLayerInsetStyle',
    ]) {
      assert(keyDef.includes(field), `playingShellKey missing expected field: ${field}`)
    }
  },
)

await check(
  '[7] isCollectingTrickOnEntry early-return guard остава ПРЕДИ новата shell/trick/HUD patch логика',
  () => {
    const guardIndex = source.indexOf('if (isCollectingTrickOnEntry) {')
    const newLogicIndex = source.indexOf('const needsFullPlayingShellRebuild')
    assert(guardIndex !== -1, 'isCollectingTrickOnEntry guard not found')
    assert(newLogicIndex !== -1, 'needsFullPlayingShellRebuild logic not found')
    assert(
      guardIndex < newLogicIndex,
      'isCollectingTrickOnEntry guard must run before the shell/trick/HUD patch decision, not after',
    )
  },
)

await check(
  '[8] няма нов early return между shell/trick/HUD patch логиката и downstream side effects (bottom hand sync и т.н.)',
  () => {
    const flowStart = source.indexOf('const needsFullPlayingShellRebuild')
    const flowEnd = source.indexOf('const bottomHandHost = syncBottomHandOverlay')
    assert(flowStart !== -1, 'needsFullPlayingShellRebuild not found')
    assert(flowEnd !== -1, 'syncBottomHandOverlay call not found')
    assert(flowEnd > flowStart, 'expected syncBottomHandOverlay to appear after the shell/trick/HUD patch block')
    const flowSection = source.slice(flowStart, flowEnd)
    assert(
      !/\breturn\b/.test(flowSection),
      'found a return statement inside the new shell/trick/HUD patch logic — this would skip unconditional downstream side effects for some render path',
    )
    assert(
      source.includes('scheduleCompletedTrickCollection('),
      'scheduleCompletedTrickCollection trigger no longer present downstream',
    )
    assert(
      source.includes('animatePlayedCardFromHand('),
      'animatePlayedCardFromHand trigger no longer present downstream',
    )
  },
)

await check(
  '[9] липсващ expected patch-node (invariant violation) тригерира FULL rebuild fallback, не silent no-op',
  () => {
    const fallbackCheckPattern = 'if ((needsTrickWrite && !trickHost) || (needsHudWrite && !scoreHudNode))'
    const fallbackCheckIndex = source.indexOf(fallbackCheckPattern)
    assert(fallbackCheckIndex !== -1, 'expected explicit missing-patch-node fallback condition not found')
    const fallbackBody = source.slice(fallbackCheckIndex, fallbackCheckIndex + 700)
    assert(
      fallbackBody.includes('performFullPlayingShellRebuild()'),
      'missing-patch-node branch does not call performFullPlayingShellRebuild() — would silently skip the DOM write while the cache still advances, permanently desyncing DOM from cache',
    )
  },
)

await check(
  '[10] cache (lastTrickStableKey / lastScoreHudRenderedHtml) се обновява САМО вътре в блока, потвърдил че съответният patch node съществува — никога преди/извън тази проверка',
  () => {
    const trickWriteIndex = source.indexOf('if (needsTrickWrite && trickHost) {')
    assert(trickWriteIndex !== -1, 'guarded trick write block (if (needsTrickWrite && trickHost)) not found')
    const trickBlock = source.slice(trickWriteIndex, trickWriteIndex + 300)
    const trickCacheIdx = trickBlock.indexOf('cache.lastTrickStableKey = trickStableKey')
    const trickWriteIdx = trickBlock.indexOf('trickHost.innerHTML =')
    assert(trickCacheIdx !== -1, 'cache.lastTrickStableKey assignment not found inside the guarded trick write block')
    assert(trickWriteIdx !== -1, 'trickHost.innerHTML write not found inside the guarded trick write block')
    assert(
      trickCacheIdx < trickWriteIdx,
      'cache.lastTrickStableKey must be set inside the confirmed-non-null (needsTrickWrite && trickHost) branch',
    )

    const hudWriteIndex = source.indexOf('if (needsHudWrite && scoreHudNode) {')
    assert(hudWriteIndex !== -1, 'guarded HUD write block (if (needsHudWrite && scoreHudNode)) not found')
    const hudBlock = source.slice(hudWriteIndex, hudWriteIndex + 200)
    const hudCacheIdx = hudBlock.indexOf('cache.lastScoreHudRenderedHtml = scoreHudHtml')
    const hudWriteIdx = hudBlock.indexOf('scoreHudNode.outerHTML =')
    assert(hudCacheIdx !== -1, 'cache.lastScoreHudRenderedHtml assignment not found inside the guarded HUD write block')
    assert(hudWriteIdx !== -1, 'scoreHudNode.outerHTML write not found inside the guarded HUD write block')
    assert(
      hudCacheIdx < hudWriteIdx,
      'cache.lastScoreHudRenderedHtml must be set inside the confirmed-non-null (needsHudWrite && scoreHudNode) branch',
    )
  },
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
