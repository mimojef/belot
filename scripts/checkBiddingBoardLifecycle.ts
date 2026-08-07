/**
 * checkBiddingBoardLifecycle.ts
 *
 * Regression проверки за orphaned bidding popup / bottom-hand overlay bug,
 * въведен от commit b6354f2 ("Fix game interaction click stability").
 *
 * Root cause: b6354f2 премести bid popup-а (и bottom-hand card бутоните) от
 * options.root в собствени document.body host-ове, за да оцелеят на native
 * 'click' между pointerdown/pointerup дори ако сървърен snapshot rewrite-не
 * root по средата на жеста. Страничен ефект: тъй като тези host-ове вече не
 * се "помитат" безплатно от root.innerHTML rewrite-а, cleanup-ът им зависи
 * изцяло от explicit извикване. submitServerBidAction (сървър) резолвира и
 * прехвърля фазата bidding → deal-last-3/next-round в ЕДНА атомарна стъпка
 * (finalizeServerBiddingPhase), т.е. клиентът никога не получава междинен
 * snapshot "bidding, но никой не наддава" — единственият render, в който
 * старият код чистеше popup-а (само вътре в isShowingBiddingPhase клона),
 * никога не се случва за тази транзакция. Резултат: popup-ът виси в
 * document.body през целия playing/next-round, докато страницата не се
 * презареди.
 *
 * Пази срещу връщане към този бъг:
 *  A) removeBiddingPopupOverlay() се вика безусловно на top-level, keyed
 *     директно от authoritativePhase !== 'bidding' — не само от вътрешността
 *     на isShowingBiddingPhase клона.
 *  B) Тази top-level проверка е достатъчно обща да покрие bidding→deal-last-3,
 *     bidding→next-round И bidding→playing — не е hardcode-ната само за
 *     deal-last-3.
 *  C) Fix-ът НЕ връща bidding popup HTML-а обратно в options.root.innerHTML —
 *     external-host архитектурата (и оттам dropped-click стабилизацията от
 *     b6354f2) остава непокътната.
 *  D) Dropped-click механизмите от b6354f2 (document.body host, native click
 *     wiring, data-listeners-bound guard) продължават да съществуват.
 *  E) Симетричен cleanup за bottom-hand overlay (ако е приложен) при
 *     напускане на playing фазата.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const ACTIVE_ROOM_FLOW_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts')
const PLAYING_SCREEN_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'renderPlayingScreen.ts')

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

// Намира тялото на функция по сигнатура, скачайки до края на параметър-листа
// (broene на кръгли скоби) преди да търси отварящата `{` на тялото — наивно
// "първата { след сигнатурата" се лъже от default object-literal параметри
// или inline object type annotations в параметрите.
function extractFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)

  const parenStart = src.indexOf('(', startIdx)
  assert(parenStart !== -1, `${label}: отваряща "(" не е намерена след "${signature}"`)

  let parenDepth = 0
  let parenEnd = -1
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        parenEnd = i
        break
      }
    }
  }
  assert(parenEnd !== -1, `${label}: затваряща ")" на параметър-листа не е намерена след "${signature}"`)

  const braceStart = src.indexOf('{', parenEnd)
  assert(braceStart !== -1, `${label}: отваряща "{" на тялото не е намерена след параметър-листа`)

  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        return src.slice(startIdx, i + 1)
      }
    }
  }
  throw new Error(`${label}: затваряща скоба не е намерена след "${signature}"`)
}

const activeRoomFlowSrc = await readFile(ACTIVE_ROOM_FLOW_PATH, 'utf8')
const playingScreenSrc = await readFile(PLAYING_SCREEN_PATH, 'utf8')

const renderActiveRoomScreenBody = extractFunctionBody(
  activeRoomFlowSrc,
  'function renderActiveRoomScreen(preferAnimationPatch = false): void',
  'renderActiveRoomScreen',
)

// ─── A) Top-level unconditional cleanup, keyed off authoritativePhase ──────

await check('[1] removeBiddingPopupOverlay() се вика безусловно на top-level, keyed от authoritativePhase !== \'bidding\'', () => {
  assert(
    /if \(authoritativePhase !== 'bidding'\) \{\s*removeBiddingPopupOverlay\(\)/.test(renderActiveRoomScreenBody),
    'renderActiveRoomScreen трябва да съдържа "if (authoritativePhase !== \'bidding\') { removeBiddingPopupOverlay() }" на top level',
  )
})

await check('[2] Top-level cleanup-ът е ИЗВЪН isShowingBiddingPhase/isShowingAnyDealPhase клоновете (не е render-local флаг)', () => {
  // Условието трябва да ползва суровия authoritativePhase, не isShowingBiddingPhase
  // (който може временно да е false заради застъпваща се deal анимация, докато
  // authoritativePhase вече е 'bidding' — top-level cleanup-ът не бива да се
  // лъже от това и да premahne popup-а докато бъдещ bidding render още предстои).
  // \r?\n за CRLF-съвместимост (файлът е CRLF).
  const topLevelCleanupMatch = renderActiveRoomScreenBody.match(
    /if \(authoritativePhase !== 'bidding'\) \{\r?\n\s*removeBiddingPopupOverlay\(\)/,
  )
  assert(topLevelCleanupMatch !== null, 'Точната top-level cleanup конструкция не е намерена (виж [1])')

  const isShowingBiddingPhaseIdx = renderActiveRoomScreenBody.indexOf('const isShowingBiddingPhase =')
  assert(isShowingBiddingPhaseIdx !== -1, 'isShowingBiddingPhase дефиницията трябва да съществува')
  assert(
    topLevelCleanupMatch!.index! > isShowingBiddingPhaseIdx,
    'Top-level cleanup-ът трябва да е след изчисляването на authoritativePhase-базираните флагове (ред на изпълнение)',
  )
})

// ─── B) Общо условие покрива deal-last-3 / next-round / playing еднакво ────

await check('[3] Условието не е hardcode-нато само за deal-last-3 — покрива и next-round, и playing атомарно', () => {
  // authoritativePhase !== 'bidding' е true за 'deal-last-3', 'next-round' И
  // 'playing' едновременно — един-единствен guard, не изброяване по фаза.
  assert(
    !/authoritativePhase !== 'bidding' && authoritativePhase !== 'deal-last-3'/.test(renderActiveRoomScreenBody),
    'Cleanup guard-ът не трябва да изключва deal-last-3 или next-round от общото условие',
  )
  assert(
    (renderActiveRoomScreenBody.match(/removeBiddingPopupOverlay\(\)/g) ?? []).length >= 1,
    'removeBiddingPopupOverlay() трябва да остане достижимо от renderActiveRoomScreen',
  )
})

// ─── C) Fix-ът НЕ връща popup HTML-а обратно в root.innerHTML ──────────────

await check('[4] biddingInteractionHtml НЕ е string-интерполиран обратно в options.root.innerHTML шаблона', () => {
  assert(
    !/\$\{biddingInteractionHtml\}/.test(activeRoomFlowSrc),
    'biddingInteractionHtml не трябва да е вградено директно в root template-а — това би унищожило dropped-click фикса на b6354f2',
  )
  assert(
    /syncBiddingPopupOverlay\(biddingInteractionHtml\)/.test(activeRoomFlowSrc),
    'biddingInteractionHtml трябва да продължи да минава изключително през syncBiddingPopupOverlay()',
  )
})

// ─── D) Dropped-click стабилизацията от b6354f2 остава запазена ────────────

await check('[5] External-host архитектурата (document.body, не options.root) за bidding popup е запазена', () => {
  assert(activeRoomFlowSrc.includes("const BIDDING_POPUP_HOST_ATTR = 'data-bidding-popup-host'"), 'BIDDING_POPUP_HOST_ATTR константата трябва да съществува непроменена')
  const syncBody = extractFunctionBody(activeRoomFlowSrc, 'function syncBiddingPopupOverlay(html: string): void', 'syncBiddingPopupOverlay')
  assert(/document\.body\.appendChild\(host\)/.test(syncBody), 'Popup host-ът трябва да продължи да живее в document.body, не в options.root')
})

await check('[6] Native click wiring за bid бутоните продължава да е върху document.body host-а с data-listeners-bound guard', () => {
  assert(
    activeRoomFlowSrc.includes('`[${BIDDING_POPUP_HOST_ATTR}] [data-bid-suit]`') &&
      activeRoomFlowSrc.includes('`[${BIDDING_POPUP_HOST_ATTR}] [data-bid-action]`'),
    'Bid бутоните трябва да продължат да се wire-ват спрямо document.body host-а, не root',
  )
  assert(
    activeRoomFlowSrc.includes("if (btn.dataset.listenersBound === '1') return") ,
    'data-listeners-bound guard-ът (защита срещу дублирани listeners при node reuse) трябва да остане',
  )
})

// ─── E) removeBiddingPopupOverlay е идемпотентен/безопасен ─────────────────

await check('[7] removeBiddingPopupOverlay() е безопасен, ако host-ът не съществува (optional chaining)', () => {
  const body = extractFunctionBody(activeRoomFlowSrc, 'function removeBiddingPopupOverlay(): void', 'removeBiddingPopupOverlay')
  assert(/document\.body\.querySelector\(`\[\$\{BIDDING_POPUP_HOST_ATTR\}\]`\)\?\.remove\(\)/.test(body), 'removeBiddingPopupOverlay трябва да ползва ?.remove() — безопасно, ако host-ът вече липсва')
})

// ─── F) Bottom-hand overlay симетричен cleanup ─────────────────────────────

await check('[8] removeBottomHandOverlay() е exported от renderPlayingScreen.ts', () => {
  assert(
    /export function removeBottomHandOverlay\(\): void/.test(playingScreenSrc),
    'removeBottomHandOverlay трябва да е export-нат, за да може controller-ът да го вика top-level (аналогично на removeMobilePhraseOverlay)',
  )
})

await check('[9] createActiveRoomFlowController.ts импортира и вика removeBottomHandOverlay() при !isShowingPlayingPhase', () => {
  assert(
    /import \{ renderPlayingScreen, removeBottomHandOverlay, type RenderPlayingScreenOptions \} from '\.\/renderPlayingScreen'/.test(activeRoomFlowSrc),
    'removeBottomHandOverlay трябва да е импортиран от renderPlayingScreen.ts',
  )
  const guardMatch = renderActiveRoomScreenBody.match(/if \(!isShowingPlayingPhase\) \{([\s\S]*?)\n {4}\}/)
  assert(guardMatch !== null, 'if (!isShowingPlayingPhase) { ... } блокът трябва да съществува')
  assert(
    /removeBottomHandOverlay\(\)/.test(guardMatch![1]),
    'removeBottomHandOverlay() трябва да се вика вътре в if (!isShowingPlayingPhase), редом с resetPlayingUiCache',
  )
})

await check('[10] Bottom-hand cleanup-ът не пипа dealing-специфичните dealt-card fan overlays', () => {
  // removeBottomHandOverlay трябва да сваля само interactive hand button
  // host-а (data-playing-bottom-hand-host) — не общите seat panels/dealt
  // hand fans, които трябва да останат видими през dealing фазите.
  const body = extractFunctionBody(playingScreenSrc, 'export function removeBottomHandOverlay(): void', 'removeBottomHandOverlay')
  assert(/BOTTOM_HAND_HOST_ATTR/.test(body), 'removeBottomHandOverlay трябва да таргетира само BOTTOM_HAND_HOST_ATTR host-а')
  assert(!/seat-panels-host/.test(body), 'removeBottomHandOverlay не трябва да пипа seat-panels-host')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
