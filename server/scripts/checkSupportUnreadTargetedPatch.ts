/**
 * checkSupportUnreadTargetedPatch.ts
 *
 * Regression guard за EMPIRICALLY CONFIRMED mobile-menu delayed-flicker bug:
 * refreshSupportUnread() (30s background poll, viж startSupportUnreadPolling
 * в main.ts) търсеше badge node ЕДИНСТВЕНО чрез [data-support-unread-badge],
 * markup, съществуващ САМО в desktop renderNav() template. На mobile viewport
 * този selector НИКОГА не намираше node → "badge not found" fallback →
 * unconditional пълен render() → root.innerHTML remount → отвореният mobile
 * menu <details> subtree се унищожава/пресъздава → visible flicker.
 * Потвърдено чрез реален manual reproduction: badge-not-found fallback
 * water водеше до пълен render() докато mobile menu е отворено, което
 * унищожаваше/пресъздаваше <details> subtree-a → visible flicker.
 *
 * Fix: три badge targets вече са PERSISTENT DOM nodes (винаги mounted,
 * display:none/flex toggle — Вариант A от брифа, mirror на established
 * desktop pattern), patch-нати targeted, без fallback към render() в
 * normal-mounted-lobby случая:
 *   1. [data-support-unread-badge="1"]      — desktop-only (renderNav)
 *   2. [data-mobile-menu-total-badge="1"]   — mobile aggregate (renderMobileMenu)
 *   3. [data-mobile-menu-item-badge="support"] — mobile per-item (renderMobileMenu)
 *
 * Static source-level checks (established checkLafcheTargetedRenderFix.ts
 * pattern — HTML/TS source string assertions, не реален browser DOM).
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

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
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

console.log('\n=== Support unread targeted-patch regression (mobile-menu delayed-flicker fix) ===\n')

// ─── 1. Persistent badge markup (renderLobbyScreen.ts) ─────────────────────

check('[1] Desktop support badge ([data-support-unread-badge]) е persistent (display toggle, не conditional span)', () => {
  const badgeIdx = renderSrc.indexOf('data-support-unread-badge="1"')
  assert(badgeIdx >= 0, 'data-support-unread-badge markup not found')
  const context = renderSrc.slice(badgeIdx, badgeIdx + 600)
  assert(
    /display:\$\{supportUnreadBadge !== null \? 'flex' : 'none'\}/.test(context),
    'desktop badge must use display toggle, not conditional-render ternary wrapping the whole <span>',
  )
})

check('[2] Mobile menu total badge ([data-mobile-menu-total-badge]) е PERSISTENT node (display toggle, не conditional span)', () => {
  const badgeIdx = renderSrc.indexOf('data-mobile-menu-total-badge="1"')
  assert(badgeIdx >= 0, 'data-mobile-menu-total-badge markup not found')
  const context = renderSrc.slice(Math.max(0, badgeIdx - 100), badgeIdx + 300)
  assert(
    /display:\$\{mobileMenuBadge !== null \? 'flex' : 'none'\}/.test(context),
    'mobile menu total badge must be a persistent node (display toggle), not `${cond ? span : \'\'}`',
  )
  // Regression guard срещу старата conditional-render форма.
  const oldPatternIdx = renderSrc.indexOf("mobileMenuBadge !== null ? `<span data-mobile-menu-total-badge")
  assert(oldPatternIdx === -1, 'old conditionally-rendered badge span pattern must not reappear')
})

check('[3] Mobile menu per-item support badge ([data-mobile-menu-item-badge="support"]) е PERSISTENT node', () => {
  // Обновено след residual 0->1 flicker fix — display:none<->inline-flex
  // смени на display:inline-flex (постоянно) + visibility toggle, за да
  // пази запазено layout място в flex button row-a (виж checkTopicsUnreadAggregateTargets.ts секция E).
  const fnBody = extractFunctionBlock(renderSrc, 'function mobileMenuSvgItemContent(')
  assert(fnBody.length > 0, 'mobileMenuSvgItemContent function not found')
  assert(
    fnBody.includes('display:inline-flex;visibility:${badge !== null ? \'visible\' : \'hidden\'}'),
    'per-item badge must be a persistent node with display:inline-flex + visibility toggle',
  )
})

// ─── 2. refreshTopicsUnreadDom patches all three badges without presence/absence fallback ──

check('[4] refreshTopicsUnreadDom patch-ва mobile total badge БЕЗ presence/absence structural fallback', () => {
  const fnBody = extractFunctionBlock(renderSrc, 'export function refreshTopicsUnreadDom(')
  assert(fnBody.length > 0, 'refreshTopicsUnreadDom function not found')
  assert(fnBody.includes("data-mobile-menu-total-badge"), 'refreshTopicsUnreadDom must reference the mobile total badge selector')
  assert(
    fnBody.includes('mobileMenuBadgeEl.style.display =') && fnBody.includes('mobileMenuBadgeEl.textContent ='),
    'refreshTopicsUnreadDom must patch display+textContent directly on the persistent node',
  )
})

check('[5] refreshTopicsUnreadDom patch-ва mobile per-item support badge БЕЗ presence/absence structural fallback', () => {
  // Обновено след residual 0->1 flicker fix — support item badge вече се
  // patch-ва чрез style.visibility, не style.display (виж
  // checkTopicsUnreadAggregateTargets.ts секция E за пълния context).
  const fnBody = extractFunctionBlock(renderSrc, 'export function refreshTopicsUnreadDom(')
  assert(fnBody.includes('data-mobile-menu-item-badge="support"'), 'refreshTopicsUnreadDom must reference the per-item support badge selector')
  assert(
    fnBody.includes('supportItemBadgeEl.style.visibility =') && fnBody.includes('supportItemBadgeEl.textContent ='),
    'refreshTopicsUnreadDom must patch visibility+textContent directly on the persistent per-item badge node',
  )
})

// ─── 3. refreshSupportUnread — controller wiring ────────────────────────────
//
// Extracted (ghost-unread-badge production fix) — refreshSupportUnread
// public method-ът вече е thin wrapper (`refreshSupportUnread: () => { void
// refreshSupportUnreadNow() }`), reuse-ван и от hard-delete success handler-ите
// (submitAdminHardDelete/submitAdminSupportDeleteProfile), за да refresh-нат
// badge-а веднага след delete, вместо да чакат следващия 30s polling tick.
// Targeted-patch логиката, проверявана от checks 7-9, живее сега в
// refreshSupportUnreadNow(), не в самия public method wrapper.
const refreshSupportUnreadBlock = extractFunctionBlock(controllerSrc, 'async function refreshSupportUnreadNow(): Promise<void> {')

check('[6] refreshSupportUnreadNow implementation block found', () => {
  assert(refreshSupportUnreadBlock.length > 0, 'refreshSupportUnreadNow implementation not found in createLobbyFlowController.ts')
})

check('[6b] refreshSupportUnread public method reuses refreshSupportUnreadNow (no duplicated logic)', () => {
  const publicMethodBlock = extractFunctionBlock(controllerSrc, 'refreshSupportUnread: () => {')
  assert(publicMethodBlock.includes('refreshSupportUnreadNow()'), 'refreshSupportUnread must delegate to refreshSupportUnreadNow, not duplicate the patch logic inline')
})

check('[7] refreshSupportUnread patch-ва desktop badge targeted (display+textContent, без render() веднага)', () => {
  const desktopSectionIdx = refreshSupportUnreadBlock.indexOf("querySelector<HTMLElement>('[data-support-unread-badge=")
  assert(desktopSectionIdx >= 0, 'desktop badge querySelector call missing from refreshSupportUnread')
  const nearby = refreshSupportUnreadBlock.slice(desktopSectionIdx, desktopSectionIdx + 500)
  assert(nearby.includes('desktopBadge.style.display =') && nearby.includes('desktopBadge.textContent ='), 'desktop badge must be patched via style.display + textContent')
})

check('[8] refreshSupportUnread вика refreshTopicsUnreadDom за mobile menu badge синхронизация (reuse, не дублирана логика)', () => {
  assert(refreshSupportUnreadBlock.includes('refreshTopicsUnreadDom(options.root, buildLobbyScreenState())'), 'refreshSupportUnread must reuse refreshTopicsUnreadDom, not duplicate mobile-menu badge patch logic')
})

check('[9] refreshSupportUnread НЯМА unconditional render() — fallback само ако И двата targeted пътя се провалят', () => {
  const stripped = stripComments(refreshSupportUnreadBlock)
  // Старият bug pattern: `if (badge) { patch } else { render() }` — badge
  // found/not-found директно gate-ва render(). Новият код трябва да gate-ва
  // render()-a на "нито един targeted path е успял", не "desktop badge
  // липсва" (desktop badge липсва НОРМАЛНО на mobile viewport по design).
  assert(
    stripped.includes('if (!desktopPatched && !mobilePatched)'),
    'render() fallback must require BOTH targeted paths to fail, not just the desktop-only selector',
  )
  const renderCallIdx = stripped.indexOf('render()')
  assert(renderCallIdx >= 0, 'a documented fallback render() must still exist for defense-in-depth (e.g. lobby DOM not mounted)')
})

check('[10] Без temp diagnostics logging в refreshSupportUnread (cleanup след разследването)', () => {
  assert(!refreshSupportUnreadBlock.includes('flickerLog'), 'flickerLog call must not reappear in refreshSupportUnread')
  assert(!refreshSupportUnreadBlock.includes('logAsyncStart'), 'logAsyncStart call must not reappear in refreshSupportUnread')
  assert(!refreshSupportUnreadBlock.includes('logAsyncEnd'), 'logAsyncEnd call must not reappear in refreshSupportUnread')
  assert(!refreshSupportUnreadBlock.includes('logDomPatch'), 'logDomPatch call must not reappear in refreshSupportUnread')
})

// ─── 4. Polling cadence documentation (main.ts) ─────────────────────────────

check('[11] startSupportUnreadPolling остава 30-секунден repeated interval (cadence непроменен от fix-а)', () => {
  const projectMainSrc = readFileSync(resolve(projectRoot, 'src/main.ts'), 'utf8')
  const fnBody = extractFunctionBlock(projectMainSrc, 'function startSupportUnreadPolling(): void {')
  assert(fnBody.includes('30_000'), 'support unread polling interval must remain 30 seconds (cadence documented, not changed by this fix)')
})

// ─── Финален резултат ─────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
