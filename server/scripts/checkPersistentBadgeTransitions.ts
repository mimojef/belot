/**
 * checkPersistentBadgeTransitions.ts
 *
 * Regression guard за втория empirically confirmed flicker instance:
 * refreshTopicsUnreadDom() все още third-ваше structural fallback (presence/
 * absence mismatch → allPatchedSafely=false → render()/scheduleRender())
 * за data-topics-general-badge и data-topics-lafche-badge — тия nodes бяха
 * conditionally rendered (count>0 ? span : ''), не persistent. Manual
 * reproduction потвърди: 0→1 Topics unread transition (badge appears)
 * → structural fallback → render() → root.innerHTML remount → отвореният
 * mobile menu <details> subtree унищожен → visible flicker. 1→2 transition
 * (вече съществуващ badge, само число се сменя) НЕ third-ваше fallback,
 * значи не flicker-ваше — точно тази асиметрия доказа кой node е причината.
 *
 * Fix: и двата node-а вече PERSISTENT (Вариант A — display:none/inline-flex
 * toggle, mirror на established data-mobile-menu-total-badge pattern),
 * layout-aware (липсата им, докато НЕ сме на Topics screen, е ОЧАКВАНА —
 * viж isOnTopicsScreen guard в refreshTopicsUnreadDom).
 *
 * Второ намерено свързано: refreshSupportUnread() third-ваше aggregate
 * return value-то на refreshTopicsUnreadDom() като "success/failure" сигнал
 * за СВОИТЕ targets (mobile total/item badge) — ако Topics-specific badges
 * structural fail-нат (independent причина), mobilePatched невярно ставаше
 * false, дори support targets да са patch-нати успешно. Fix: refreshSupportUnread
 * вече проверява directно дали mobile total/item badge nodes съществуват,
 * не разчита на aggregate boolean-a.
 *
 * Static source-level checks (established checkLafcheTargetedRenderFix.ts /
 * checkSupportUnreadTargetedPatch.ts pattern).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('..')

const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const topicsScreenSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderTopicsScreen.ts'), 'utf8')

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

console.log('\n=== Persistent badge transitions (0->1->2->0) regression ===\n')

// ─── 1. Markup: General/Lafche badges са вече persistent ──────────────────

check('[1] data-topics-general-badge е PERSISTENT node (display toggle, не conditional-render ternary)', () => {
  const idx = topicsScreenSrc.indexOf('data-topics-general-badge="1"')
  assert(idx >= 0, 'data-topics-general-badge markup not found')
  const context = topicsScreenSrc.slice(idx, idx + 300)
  assert(
    /display:\$\{generalUnreadBadge !== null \? 'inline-flex' : 'none'\}/.test(context),
    'general badge must use display toggle on a persistent node, not `${cond ? span : \'\'}`',
  )
  const oldPatternIdx = topicsScreenSrc.indexOf('generalUnreadBadge !== null ? `<span data-topics-general-badge')
  assert(oldPatternIdx === -1, 'old conditionally-rendered general badge span pattern must not reappear')
})

check('[2] data-topics-lafche-badge е PERSISTENT node (display toggle, не conditional-render ternary)', () => {
  const idx = topicsScreenSrc.indexOf('data-topics-lafche-badge="1"')
  assert(idx >= 0, 'data-topics-lafche-badge markup not found')
  const context = topicsScreenSrc.slice(idx, idx + 250)
  assert(
    /display:\$\{lafcheHasUnread \? 'inline-block' : 'none'\}/.test(context),
    'lafche badge must use display toggle on a persistent node, not `${cond ? span : \'\'}`',
  )
  const oldPatternIdx = topicsScreenSrc.indexOf('lafcheHasUnread ? `<span data-topics-lafche-badge')
  assert(oldPatternIdx === -1, 'old conditionally-rendered lafche badge span pattern must not reappear')
})

// ─── 2. refreshTopicsUnreadDom: layout-aware, без structural fallback за нормални count промени ──

const refreshTopicsUnreadDomBody = extractFunctionBlock(renderSrc, 'export function refreshTopicsUnreadDom(')

check('[3] refreshTopicsUnreadDom функция намерена', () => {
  assert(refreshTopicsUnreadDomBody.length > 0, 'refreshTopicsUnreadDom not found')
})

check('[4] General badge се patch-ва directно (style.display + textContent), без presence/absence guard', () => {
  const idx = refreshTopicsUnreadDomBody.indexOf('generalBadgeEl')
  assert(idx >= 0, 'generalBadgeEl reference missing')
  const section = refreshTopicsUnreadDomBody.slice(idx, idx + 400)
  assert(section.includes('generalBadgeEl.style.display =') && section.includes('generalBadgeEl.textContent ='), 'general badge must be patched via style.display + textContent unconditionally when the node exists')
  assert(
    !/\(generalBadgeEl !== null\) !== \(generalBadgeText !== null\)/.test(refreshTopicsUnreadDomBody),
    'old presence/absence structural-fallback check for general badge must be removed',
  )
})

check('[5] Lafche badge се patch-ва directно (style.display), без presence/absence guard', () => {
  const idx = refreshTopicsUnreadDomBody.indexOf('lafcheBadgeEl')
  assert(idx >= 0, 'lafcheBadgeEl reference missing')
  const section = refreshTopicsUnreadDomBody.slice(idx, idx + 300)
  assert(section.includes("lafcheBadgeEl.style.display = lafcheHasUnread"), 'lafche badge must be patched via style.display unconditionally when the node exists')
  assert(
    !/\(lafcheBadgeEl !== null\) !== lafcheHasUnread/.test(refreshTopicsUnreadDomBody),
    'old presence/absence structural-fallback check for lafche badge must be removed',
  )
})

check('[6] Layout-aware guard: General/Lafche badge липса НЕ е failure освен ако сме на Topics screen', () => {
  assert(refreshTopicsUnreadDomBody.includes('isOnTopicsScreen'), 'isOnTopicsScreen layout guard missing')
  assert(refreshTopicsUnreadDomBody.includes("root.querySelector('[data-topics-screen=\"1\"]') !== null"), 'isOnTopicsScreen must check for the Topics screen mount marker')
})

// ─── 3. refreshSupportUnread — decoupled от Topics badge aggregate result ──

const refreshSupportUnreadBlock = extractFunctionBlock(controllerSrc, "refreshSupportUnread: () => {")

check('[7] refreshSupportUnread handler намерен', () => {
  assert(refreshSupportUnreadBlock.length > 0, 'refreshSupportUnread not found')
})

check('[8] refreshSupportUnread проверява mobile target nodes директно, не разчита само на refreshTopicsUnreadDom aggregate return', () => {
  assert(
    refreshSupportUnreadBlock.includes("querySelector('[data-mobile-menu-total-badge=\"1\"]') !== null"),
    'refreshSupportUnread must directly check for the mobile total badge node',
  )
  assert(
    refreshSupportUnreadBlock.includes("querySelector('[data-mobile-menu-item-badge=\"support\"]') !== null"),
    'refreshSupportUnread must directly check for the mobile per-item support badge node',
  )
})

check('[9] mobilePatched не е директно равно на refreshTopicsUnreadDom() call резултата (decoupled)', () => {
  assert(
    !/const mobilePatched = refreshTopicsUnreadDom\(/.test(refreshSupportUnreadBlock),
    'mobilePatched must not be assigned directly from refreshTopicsUnreadDom() return value — it must check its own targets independently',
  )
})

check('[10] Fallback render() зависи явно от individual target flags (desktopPatched/mobileTotalBadgeFound/mobileItemBadgeFound)', () => {
  const idx = refreshSupportUnreadBlock.indexOf('if (!desktopPatched && !mobilePatched)')
  assert(idx >= 0, 'fallback render() condition not found')
  const section = refreshSupportUnreadBlock.slice(Math.max(0, idx - 700), idx + 50)
  assert(section.includes('mobileTotalBadgeFound') && section.includes('mobileItemBadgeFound'), 'fallback render() gating must be derived from individual target flags')
})

// ─── 4. Mobile menu total/item badges остават persistent (регресия срещу вече поправеното) ──

check('[11] Mobile menu total badge остава PERSISTENT (не regressed обратно към conditional span)', () => {
  const idx = renderSrc.indexOf('data-mobile-menu-total-badge="1"')
  assert(idx >= 0, 'data-mobile-menu-total-badge markup not found')
  const context = renderSrc.slice(Math.max(0, idx - 100), idx + 300)
  assert(/display:\$\{mobileMenuBadge !== null \? 'flex' : 'none'\}/.test(context), 'mobile menu total badge must remain a persistent node')
})

check('[12] Mobile menu per-item support badge остава PERSISTENT (не regressed)', () => {
  // Обновено след residual 0->1 flicker fix — display:none<->inline-flex
  // смени на display:inline-flex (постоянно) + visibility toggle (виж
  // checkTopicsUnreadAggregateTargets.ts секция E).
  const fnBody = extractFunctionBlock(renderSrc, 'function mobileMenuSvgItemContent(')
  assert(
    fnBody.includes('display:inline-flex;visibility:${badge !== null ? \'visible\' : \'hidden\'}'),
    'per-item badge must remain a persistent node with display:inline-flex + visibility toggle',
  )
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
