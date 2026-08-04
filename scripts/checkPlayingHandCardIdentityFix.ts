/**
 * checkPlayingHandCardIdentityFix.ts
 *
 * Regression test за production сигнали, че по време на playing фазата
 * понякога се изиграва различна карта от натиснатата, или карта се изиграва
 * без съзнателно натискане. Пълната диагностика е в
 * server/scripts/checkGameplayActionStaleConnectionGuard.ts (server-side
 * причинител) и в крайния отчет от диагностиката на playing фазата.
 *
 * Този файл покрива конкретен, доказан чрез четене на кода client-side
 * дефект в src/app/activeRoom/renderPlayingScreen.ts:
 *
 *   Преди фикса, освен per-button 'click' listener-а (cardId затворен в
 *   closure при render), имаше и ВТОРИ, ДЕЛЕГИРАН 'pointerup' listener върху
 *   контейнера на ръката, който определяше коя карта е натисната чрез LIVE
 *   DOM lookup в момента на release: `event.target.closest('.play-hand-
 *   card--active')`.
 *
 *   renderPlayingScreen() прави `root.innerHTML = ...` — пълно пресъздаване
 *   на DOM-а на ръката — при ВСЕКИ re-render, а re-render-и се случват по
 *   причини несвързани с текущия жест на потребителя: всеки нов сървърен
 *   snapshot, viewport resize/orientationchange (обичайно на Android при
 *   показване/скриване на адресната лента по време на touch-drag), и
 *   завършване на trick-collection/played-card-fly анимации. Ако такъв
 *   re-render се случи между pointerdown и pointerup, делегираният listener
 *   резолвва каквато и да е карта в момента стои на същите екранни
 *   координати — не непременно натиснатата.
 *
 *   'click' няма този проблем: браузърът синтезира 'click' само ако
 *   елементът, върху който е паднал press-ът, все още е закачен в DOM-а при
 *   release. Ако re-render го е премахнал междувременно, 'click' изобщо не
 *   се задейства (jest е "изгубен tap", не грешна карта) — safe failure
 *   mode вместо силентно грешно избрана карта.
 *
 * Jsdom не е налична зависимост в проекта, затова — по established стила на
 * check скриптовете тук (виж checkGiftNotificationModalFix.ts) — това е
 * source-text проверка върху реалния файл, не DOM симулация.
 *
 * Покрива:
 *  [1] Делегираният 'pointerup' + `.closest('.play-hand-card--active')`
 *      live-lookup pattern е премахнат от renderPlayingScreen.ts.
 *  [2] Няма никакъв `addEventListener('pointerup'` в play-hand-card секцията
 *      на файла (нито делегиран, нито per-button — per-button pointerup би
 *      имал СЪЩИЯ проблем, защото pointerup винаги прави live hit-test,
 *      за разлика от 'click').
 *  [3] per-button 'click' listener-ът остава, с cardId взет от
 *      `button.dataset.cardId` В render-time closure (не пре-четен в
 *      handler-а).
 *  [4] Всяка hand-card кутия все още носи стабилен `data-card-id` атрибут
 *      (server-issued card id, не array index).
 *  [5] `canSubmitHandCard` продължава да реvalидира и срещу `sortedHand`
 *      (картата е в ръката), и срещу `validCardIds` (легалност) — defense
 *      in depth, независимо от кой event я е тригернал.
 *  [6] `handleHandCardChoice`/submission гейтват с `cache.pendingPlayCardSent`
 *      — все още предпазва от двойно изпращане.
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
  '[1] no delegated live-DOM-lookup pointerup handler resolving card identity via event.target.closest(...)',
  () => {
    const liveLookupPattern = /target\.closest<HTMLButtonElement>\(\s*['"]\.play-hand-card--active['"]\s*\)/
    assert(
      !liveLookupPattern.test(source),
      'found event.target.closest(...) live card-identity lookup — this is the exact pattern that lets a mid-gesture re-render resolve pointerup to the wrong card',
    )
  },
)

await check(
  "[2] no addEventListener('pointerup', ...) at all in the hand-card wiring section (per-button pointerup would have the identical live-hit-test problem)",
  () => {
    const wiringStart = source.indexOf('function handleHandCardChoice')
    assert(wiringStart !== -1, 'could not locate function handleHandCardChoice')
    const handWiringSection = source.slice(wiringStart, wiringStart + 1200)
    assert(
      !handWiringSection.includes("addEventListener('pointerup'"),
      'a pointerup listener still exists in the hand-card wiring section',
    )
  },
)

await check(
  "[3] per-button 'click' listener remains, with cardId captured from button.dataset.cardId at render time (closure)",
  () => {
    const clickWiringPattern = /const cardId = button\.dataset\.cardId\s*\n\s*if \(!cardId\) \{\s*\n\s*return\s*\n\s*\}\s*\n\s*\n\s*button\.addEventListener\('click', \(\) => \{\s*\n\s*handleHandCardChoice\(button, cardId\)/
    assert(
      clickWiringPattern.test(source),
      'expected per-button click listener with closure-bound cardId (button.dataset.cardId read once at render time, then passed to handleHandCardChoice) not found in the expected shape',
    )
  },
)

await check(
  '[4] hand card buttons carry a stable server-issued data-card-id attribute (not array index)',
  () => {
    assert(
      source.includes('data-card-id="${escapeHtml(card.id)}"'),
      'expected data-card-id="${escapeHtml(card.id)}" on rendered hand card buttons',
    )
  },
)

await check(
  '[5] canSubmitHandCard still re-validates against both sortedHand (card is actually in hand) and validCardIds (legality) — independent of which event triggered submission',
  () => {
    const fnStart = source.indexOf('function canSubmitHandCard')
    assert(fnStart !== -1, 'canSubmitHandCard function not found')
    const fnBody = source.slice(fnStart, fnStart + 400)
    assert(fnBody.includes('validCardIds'), 'canSubmitHandCard no longer checks validCardIds')
    assert(fnBody.includes('sortedHand.some'), 'canSubmitHandCard no longer checks sortedHand membership')
  },
)

await check(
  '[6] submission still gated by cache.pendingPlayCardSent (prevents double-submit regardless of how many events resolve to a choice)',
  () => {
    const fnStart = source.indexOf('function submitHandCardFromButton')
    assert(fnStart !== -1, 'submitHandCardFromButton function not found')
    const fnBody = source.slice(fnStart, fnStart + 300)
    assert(fnBody.includes('cache.pendingPlayCardSent'), 'submitHandCardFromButton no longer checks cache.pendingPlayCardSent')
  },
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
