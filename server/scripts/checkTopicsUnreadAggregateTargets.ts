/**
 * checkTopicsUnreadAggregateTargets.ts
 *
 * Regression guard за два потвърдени production bug-а след persistent/
 * targeted unread badge fixes:
 *
 * (A) STATE BUG — Lafche unread contribution изчезваше напълно ("Сценарий A").
 *     Root cause: state.activeTopicId се задава при openTopic/openTopicThread,
 *     но НИКОГА не се reset-ва при напускане на Topics screen (switchToLobby/
 *     resetToLobby не го пипат) — остава stale ("бил съм там веднъж"), не
 *     отразява дали потребителят РЕАЛНО гледа темата сега. Старият guard в
 *     topic_unread_count_changed handler-а third-ваше самò activeTopicId
 *     match → всеки Lafche push минаваше през markActiveTopicSeen (force
 *     count->0) дори когато потребителят отдавна е напуснал Topics. Fix:
 *     добавен isReallyViewingThisTopic check (state.currentScreen==='topics'
 *     && state.topicsMode==='topics' && activeTopicId match) — mirror на
 *     established pattern-a в markActiveTopicSeen самата.
 *
 * (B) DOM PATCH GAP — mobile menu item "Теми" badge никога не се patch-ваше
 *     от refreshTopicsUnreadDom() ("Сценарий B"). Markup-ът
 *     (data-mobile-menu-item-badge="topics") вече беше persistent (established
 *     generic pattern в mobileMenuSvgItemContent), но helper-ът patch-ваше
 *     само total aggregate badge и support item badge — Topics item badge
 *     target изобщо липсваше от target matrix-а. Fix: добавен target,
 *     reuse-ващ ТОЧНО getTopicsTotalUnreadRaw() (СЪЩИЯТ derived source като
 *     markup-a при пълен render), не собствена формула.
 *
 * Static source-level checks (established checkLafcheTargetedRenderFix.ts
 * pattern).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('..')

const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function extractFunctionBlock(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start < 0) return ''
  const braceStart = src.indexOf('{', start)
  if (braceStart < 0) return ''
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

console.log('\n=== Topics unread aggregate target matrix regression (Lafche state bug + mobile Topics item DOM gap) ===\n')

// ─── A. State bug fix: isReallyViewingThisTopic guard ──────────────────────

const topicUnreadHandlerBlock = extractFunctionBlock(controllerSrc, "message.type === 'topic_unread_count_changed'")

check('[A1] topic_unread_count_changed handler block found', () => {
  assert(topicUnreadHandlerBlock.length > 0, 'handler not found')
})

check('[A2] Guard проверява state.currentScreen === \'topics\' (не само activeTopicId match)', () => {
  assert(
    topicUnreadHandlerBlock.includes("state.currentScreen === 'topics'") && topicUnreadHandlerBlock.includes('isReallyViewingThisTopic'),
    'the branch must verify currentScreen, not rely solely on potentially-stale activeTopicId',
  )
})

check('[A3] Guard проверява state.topicsMode === \'topics\' (stream view, не thread/personal)', () => {
  assert(topicUnreadHandlerBlock.includes("state.topicsMode === 'topics'"), 'the branch must also verify topicsMode to avoid stale-state false positives')
})

check('[A4] markActiveTopicSeen branch зависи от isReallyViewingThisTopic, не directно от message.topicId === state.activeTopicId', () => {
  assert(
    /if \(isReallyViewingThisTopic && !isGeneralTopicId\(message\.topicId\)\) \{/.test(topicUnreadHandlerBlock),
    'markActiveTopicSeen branch must be gated by isReallyViewingThisTopic, not the raw stale-prone comparison',
  )
})

check('[A5] updateTopicUnreadCount fallback path остава непроменен за non-active-viewing case', () => {
  assert(topicUnreadHandlerBlock.includes('updateTopicUnreadCount(message.topicId, message.unreadCount)'), 'the normal state-update path must remain intact')
  assert(topicUnreadHandlerBlock.includes('refreshTopicsUnreadDom(options.root, buildLobbyScreenState())'), 'targeted DOM patch attempt must remain intact')
})

// ─── B. DOM patch gap fix: mobile menu Topics item badge ───────────────────

const refreshTopicsUnreadDomBody = extractFunctionBlock(renderSrc, 'export function refreshTopicsUnreadDom(')

check('[B1] refreshTopicsUnreadDom функция намерена', () => {
  assert(refreshTopicsUnreadDomBody.length > 0, 'refreshTopicsUnreadDom not found')
})

check('[B2] refreshTopicsUnreadDom вече patch-ва data-mobile-menu-item-badge="topics"', () => {
  assert(refreshTopicsUnreadDomBody.includes('data-mobile-menu-item-badge="topics"'), 'the mobile menu Topics item badge selector must be present')
})

check('[B3] Topics item badge patch reuse-ва getTopicsTotalUnreadRaw() — единствен derived source, не собствена формула', () => {
  const idx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-item-badge="topics"')
  const section = refreshTopicsUnreadDomBody.slice(Math.max(0, idx - 400), idx)
  assert(section.includes('getTopicsTotalUnreadRaw(state)'), 'Topics item badge value must be derived from getTopicsTotalUnreadRaw(state), not a duplicated formula')
})

check('[B4] Topics item badge се patch-ва directно (style.visibility + textContent), persistent node semantics', () => {
  // Обновено след residual 0->1 flicker fix (виж секция E по-долу) —
  // display:none<->inline-flex смени на display:inline-flex (постоянно) +
  // visibility toggle. Assertion-ът тук отразява текущия pattern.
  const idx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-item-badge="topics"')
  const section = refreshTopicsUnreadDomBody.slice(idx, idx + 400)
  assert(section.includes('topicsItemBadgeEl.style.visibility =') && section.includes('topicsItemBadgeEl.textContent ='), 'Topics item badge must be patched via style.visibility + textContent on the persistent node')
})

check('[B5] Persistent markup за per-item badge (generic data-mobile-menu-item-badge="${icon}") остава непроменено', () => {
  // Обновено след residual 0->1 flicker fix — markup-ът вече е display:
  // inline-flex постоянно + visibility toggle (виж секция E по-долу).
  const fnBody = extractFunctionBlock(renderSrc, 'function mobileMenuSvgItemContent(')
  assert(
    fnBody.includes('display:inline-flex;visibility:${badge !== null ? \'visible\' : \'hidden\'}'),
    'the generic per-item badge markup (used by all icon types including topics) must remain persistent',
  )
})

// ─── C. Single source of truth (брифа §8) ───────────────────────────────────

check('[C1] getTopicsTotalUnreadRaw включва General + Personal + Lafche точно веднъж (не дублирана формула другаде за mobile item badge)', () => {
  const fnBody = extractFunctionBlock(renderSrc, 'export function getTopicsTotalUnreadRaw(')
  assert(fnBody.includes('getTopicsMessagesUnreadRaw(state)'), 'must include General contribution')
  assert(fnBody.includes('getTopicsPersonalUnreadRaw(state)'), 'must include Personal contribution')
  assert(fnBody.includes('getLafcheUnreadContribution(state)'), 'must include Lafche contribution')
})

check('[C2] mobile total badge и mobile Topics item badge и двата reuse-ват getTopicsTotalUnreadRaw()/getMobileMenuNotificationRaw() (не paralleни собствени сборове)', () => {
  const totalBadgeIdx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-total-badge="1"')
  const totalSection = refreshTopicsUnreadDomBody.slice(Math.max(0, totalBadgeIdx - 200), totalBadgeIdx)
  assert(totalSection.includes('getMobileMenuNotificationRaw(state)'), 'total badge must derive from getMobileMenuNotificationRaw(state)')

  const itemBadgeIdx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-item-badge="topics"')
  const itemSection = refreshTopicsUnreadDomBody.slice(Math.max(0, itemBadgeIdx - 400), itemBadgeIdx)
  assert(itemSection.includes('getTopicsTotalUnreadRaw(state)'), 'item badge must derive from getTopicsTotalUnreadRaw(state)')
})

// ─── D. Мarkup renders the item badge with the shared derived value (render-time consistency) ──

check('[D1] renderMobileMenu подава getTopicsTotalUnreadRaw(state) резултат към mobileMenuSvgItemContent(\'topics\', ...) при пълен render', () => {
  const fnBody = extractFunctionBlock(renderSrc, 'function renderMobileMenu(')
  assert(fnBody.includes('const topicsUnreadCount = getTopicsTotalUnreadRaw(state)'), 'full-render markup must use the same derived source')
  assert(fnBody.includes("mobileMenuSvgItemContent('topics', 'Теми', topicsUnreadCount)"), 'full-render markup must pass the derived value to the Topics menu item')
})

// ─── E. Residual 0→1 flicker fix: mobile menu ITEM badges (generic, всички
// icon types) използват visibility toggle, не display toggle ─────────────
// Root cause (потвърден чрез структурен анализ, не state/calculation bug):
// data-mobile-menu-item-badge е in-flow flex item (margin-left:auto вътре в
// display:flex parent, за разлика от data-mobile-menu-total-badge, който е
// position:absolute). Старият display:none↔inline-flex toggle вкарваше/
// махаше node-а от layout flow-а при 0↔>0 transition, причинявайки видим
// reflow на button реда в отворения mobile menu panel. Fix: display:inline-
// flex ПОСТОЯННО (запазено layout място), само visibility hidden/visible
// toggle-ва — нулев layout shift. data-mobile-menu-total-badge (absolute,
// вече без reflow проблем) НЕ е пипнат.

const mobileMenuSvgItemContentBody = extractFunctionBlock(renderSrc, 'function mobileMenuSvgItemContent(')

check('[E1] Generic per-item badge markup (mobileMenuSvgItemContent) е ВИНАГИ display:inline-flex, visibility toggle-ва', () => {
  assert(mobileMenuSvgItemContentBody.length > 0, 'mobileMenuSvgItemContent function not found')
  assert(
    mobileMenuSvgItemContentBody.includes('display:inline-flex;visibility:${badge !== null ? \'visible\' : \'hidden\'}'),
    'per-item badge must use a constant display:inline-flex with a visibility toggle, not display:none/inline-flex',
  )
  assert(
    !/display:\$\{badge !== null \? 'inline-flex' : 'none'\}/.test(mobileMenuSvgItemContentBody),
    'the old display:none<->inline-flex toggle pattern must not reappear on the per-item badge',
  )
})

check('[E2] refreshTopicsUnreadDom patch-ва support item badge чрез style.visibility, не style.display', () => {
  const idx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-item-badge="support"')
  const section = refreshTopicsUnreadDomBody.slice(idx, idx + 300)
  assert(section.includes('supportItemBadgeEl.style.visibility ='), 'support item badge must be patched via style.visibility')
  assert(!section.includes('supportItemBadgeEl.style.display ='), 'support item badge must no longer toggle style.display')
})

check('[E3] refreshTopicsUnreadDom patch-ва topics item badge чрез style.visibility, не style.display', () => {
  const idx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-item-badge="topics"')
  const section = refreshTopicsUnreadDomBody.slice(idx, idx + 300)
  assert(section.includes('topicsItemBadgeEl.style.visibility ='), 'topics item badge must be patched via style.visibility')
  assert(!section.includes('topicsItemBadgeEl.style.display ='), 'topics item badge must no longer toggle style.display')
})

check('[E4] data-mobile-menu-total-badge (absolute-positioned aggregate badge) остава непроменен — все още style.display toggle', () => {
  const idx = refreshTopicsUnreadDomBody.indexOf('data-mobile-menu-total-badge="1"')
  const section = refreshTopicsUnreadDomBody.slice(idx, idx + 300)
  assert(section.includes('mobileMenuBadgeEl.style.display ='), 'total badge (position:absolute, no reflow issue) must keep its existing display toggle, unchanged by this fix')
})

check('[E5] Persistent markup за total badge (position:absolute) остава непроменен', () => {
  const idx = renderSrc.indexOf('data-mobile-menu-total-badge="1"')
  const context = renderSrc.slice(Math.max(0, idx - 100), idx + 300)
  assert(context.includes('position:absolute'), 'total badge must remain position:absolute')
  assert(/display:\$\{mobileMenuBadge !== null \? 'flex' : 'none'\}/.test(context), 'total badge display toggle must remain unchanged')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
