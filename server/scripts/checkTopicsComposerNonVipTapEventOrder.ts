/**
 * Regression guard за mobile non-VIP Topics composer tap bug — две итерации:
 *
 * Итерация 1 (send бутон): VIP-required popup се отваряше на `pointerdown`
 * за composer textarea И send бутона — backdrop-ът (position:fixed;inset:0)
 * се озоваваше под все още допрения пръст, следващият synthetic `click` от
 * СЪЩИЯ tap падаше directno върху backdrop-а и веднага затваряше popup-а.
 * Fix: send бутонът мина на `click` (mirror на established image-pick
 * бутона).
 *
 * Итерация 2 (textarea): Send бутонът се оправи, но textarea-та все още
 * отваряше popup-а на `pointerdown` — идентичен bug, различен елемент. Root
 * cause за защо textarea НЕ можеше просто да мине на `click` като send
 * бутона: `preventDefault()` на `pointerdown`/`mousedown` е ЕДИНСТВЕНИЯТ
 * начин да се спре browser-native focus (→ mobile keyboard) на editable-
 * looking елемент — `click` идва СЛЕД focus вече се е случил, твърде късно.
 * Fix: РАЗДЕЛЕНИ handler-и — pointerdown прави САМО preventDefault() (спира
 * focus/keyboard, НЕ отваря popup), отделен click handler отваря popup-а
 * (изчаква пълен press-release цикъл, елиминирайки same-tap self-close race).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('..')

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

console.log('\n=== Topics composer non-VIP tap event order (mobile popup-closes-itself regression) ===\n')

const composerStart = renderSrc.indexOf('─── Composer (Етап 2)')
const vipPopupStart = renderSrc.indexOf('─── VIP popup (Етап 2)')
const composerBlock = composerStart >= 0 && vipPopupStart > composerStart
  ? renderSrc.slice(composerStart, vipPopupStart)
  : ''

check('[1] Composer wiring block found (source structure unchanged)', () => {
  assert(composerBlock.length > 0, 'Composer (Етап 2) wiring block not found between its header comment and VIP popup section')
})

// ─── A/B/C: root non-VIP textarea — pointerdown must NOT open popup, click must ──

check('[A] Root non-VIP textarea pointerdown handler does NOT call onTopicComposerNonVipTap (must only preventDefault to block focus)', () => {
  const pointerdownHandler = composerBlock.match(/topicsComposerTextEl\?\.addEventListener\('pointerdown', \(event\) => \{[\s\S]*?\}\)/)?.[0] ?? ''
  assert(pointerdownHandler.length > 0, 'textarea must still have a pointerdown handler (needed to preventDefault the native focus)')
  assert(pointerdownHandler.includes('event.preventDefault()'), 'textarea pointerdown handler must call preventDefault() to block native focus/mobile keyboard')
  assert(
    !pointerdownHandler.includes('onTopicComposerNonVipTap'),
    'textarea pointerdown handler must NOT open the VIP popup — regression: opening on pointerdown puts the backdrop under the still-touching finger, and the same tap\'s synthetic click on release lands on the backdrop and closes it immediately',
  )
})

check('[B] Root non-VIP textarea is readonly, not disabled (renderTopicsScreen.ts)', () => {
  const composerFn = topicsScreenSrc.match(/function renderTopicsComposer[\s\S]*?\n\}/)?.[0] ?? ''
  assert(composerFn.length > 0, 'renderTopicsComposer function not found')
  assert(/\$\{isVip \? '' : 'readonly'\}/.test(composerFn), 'textarea must render readonly (not disabled) for non-VIP — visually normal field, disabled would also suppress click events needed to open the popup')
  assert(!/\$\{isVip \? '' : 'disabled'\}/.test(composerFn), 'textarea must not be disabled for non-VIP — disabled elements do not reliably dispatch click events across browsers')
})

check('[C] Root non-VIP textarea click handler opens VIP popup (completed tap, not pointerdown)', () => {
  const clickHandler = composerBlock.match(/topicsComposerTextEl\?\.addEventListener\('click', \(event\) => \{[\s\S]*?\}\)/)?.[0] ?? ''
  assert(clickHandler.length > 0, 'textarea must have a click handler that opens the VIP popup')
  assert(clickHandler.includes('options.onTopicComposerNonVipTap()'), 'textarea click handler must call onTopicComposerNonVipTap to open the VIP popup')
})

// ─── D: Send button stays click-based (iteration 1 fix, must not regress) ──

check('[D] Send button non-VIP interception remains click-based, not pointerdown', () => {
  assert(
    !/topicsComposerSendBtn\?\.addEventListener\('pointerdown'/.test(composerBlock),
    'send button must NOT intercept on pointerdown — iteration 1 regression',
  )
  const sendClickHandler = composerBlock.match(/topicsComposerSendBtn\?\.addEventListener\('click', \(event\) => \{[\s\S]*?\}\)/)?.[0] ?? ''
  assert(sendClickHandler.includes('event.preventDefault()'), 'send button click handler must preventDefault to stop native submit for non-VIP')
  assert(sendClickHandler.includes('options.onTopicComposerNonVipTap()'), 'send button click handler must still route through the shared VIP-gate callback')
})

// ─── E: VIP textarea stays fully editable, no interception at all ──

check('[E] VIP (non-locked) branch never attaches non-VIP interception listeners to the textarea', () => {
  const elseBranch = composerBlock.match(/\} else \{[\s\S]*?\n {6}\}/)?.[0] ?? ''
  assert(elseBranch.length > 0, 'VIP (else) branch not found in composer wiring')
  assert(!elseBranch.includes('onTopicComposerNonVipTap'), 'VIP branch must never call onTopicComposerNonVipTap — VIP users must get normal typing/focus/send, no popup')
  assert(elseBranch.includes('submitTextareaOnEnter'), 'VIP branch must still wire normal Enter-to-submit behavior')
})

// ─── F: reply composer parity — never mounts as readonly/locked for non-VIP ──

check('[F] Reply composer textarea has no VIP-locked/readonly escape hatch — gated at the Reply button level instead, so it never mounts this bug', () => {
  const replyComposerFn = topicsScreenSrc.match(/function renderInlineReplyComposer[\s\S]*?\n\}/)?.[0]
    ?? topicsScreenSrc.match(/data-topics-reply-composer-text="1"[\s\S]{0,400}/)?.[0]
    ?? ''
  assert(replyComposerFn.length > 0, 'reply composer render code not found')
  assert(!replyComposerFn.includes('readonly'), 'reply composer textarea must never render readonly — it only mounts for VIP viewers (non-VIP click on Reply opens the VIP popup instead of the composer, see onTopicReplyClick)')

  const replyComposerWiring = renderSrc.match(/const textarea = form\.querySelector<HTMLTextAreaElement>\('\[data-topics-reply-composer-text="1"\]'\)[\s\S]{0,600}/)?.[0] ?? ''
  assert(replyComposerWiring.length > 0, 'reply composer wiring block not found in renderLobbyScreen.ts')
  assert(!replyComposerWiring.includes('onTopicComposerNonVipTap') && !replyComposerWiring.includes('NonVipTap'), 'reply composer textarea wiring must not attach any non-VIP tap interception — the composer is never rendered for non-VIP in the first place')
})

check('[G] Reply gating happens at the "Отговори" button (click-based), before the composer ever mounts', () => {
  assert(renderSrc.includes(`root.querySelectorAll<HTMLButtonElement>('[data-topic-message-reply]').forEach((btn) => {`), 'Reply button wiring not found')
  const replyButtonWiring = renderSrc.match(/root\.querySelectorAll<HTMLButtonElement>\('\[data-topic-message-reply\]'\)\.forEach\(\(btn\) => \{[\s\S]{0,200}?\}\)/)?.[0] ?? ''
  assert(/addEventListener\('click'/.test(replyButtonWiring), 'Reply button must use click, not pointerdown')
})

// ─── image picker: unaffected (already click-based, no regression) ──

check('[Image picker unaffected] Image-pick button (already correct reference pattern) still uses click', () => {
  assert(
    /imagePickBtn\?\.addEventListener\('click'/.test(renderSrc),
    'image-pick button must remain click-based — reference pattern this fix now matches for the send button and textarea',
  )
})

check('[VIP popup close unaffected] VIP popup backdrop/close wiring unchanged (fix must not touch popup close semantics)', () => {
  assert(renderSrc.includes(`root.querySelector<HTMLElement>('[data-topics-vip-popup-backdrop="1"]')?.addEventListener('click', (event) => {`), 'backdrop close handler must remain click-based, unmodified')
  assert(renderSrc.includes(`if (event.target === event.currentTarget) options.onTopicsVipPopupClose()`), 'backdrop close must still require the click to land directly on the backdrop, not a bubbled child click')
})

// ─── G (spec): "+" Create Topic stays click-based ──

check('[G2] "+" Create Topic button remains click-based (not pointerdown)', () => {
  assert(
    renderSrc.includes(`root.querySelector<HTMLButtonElement>('[data-topics-create="1"]')?.addEventListener('click', () => {`),
    '"+" Create Topic button must stay click-based',
  )
})

// ─── H: no timeout/synthetic-click suppression hacks anywhere in the fix ──

check('[H] No setTimeout/timestamp-suppression/UA-detection hacks in the composer wiring block', () => {
  assert(!/setTimeout/.test(composerBlock), 'composer wiring must not use setTimeout hacks to work around event ordering')
  assert(!composerBlock.includes('navigator.userAgent'), 'composer wiring must not use UA detection for mobile-only behavior')
  assert(!/Date\.now\(\)|performance\.now\(\)/.test(composerBlock), 'composer wiring must not use timestamp-based suppression to distinguish real clicks from synthetic ones')
  assert(!composerBlock.includes('stopPropagation'), 'this fix should not need stopPropagation — plain event-order separation (pointerdown vs click) is sufficient')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
