/**
 * checkRegistrationVerificationTypingStability.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * a production bug (reported after deploying Email Verification + Remember
 * Me, SHA 3aeacaa): the "Потвърдете имейла си" verification popup opened,
 * the code email arrived, focus could enter the field — but every digit
 * typed into the 6-digit code input vanished almost immediately, making it
 * impossible to type the code.
 *
 * ROOT CAUSE (proven, not assumed): startRegistrationVerificationCountdown()
 * (createLobbyFlowController.ts) called the full render() every 1000ms while
 * the popup was open, to keep the "Изпрати отново (Ns)" countdown text live.
 * render() -> renderLobby() -> renderLobbyScreen(options.root, ...), which
 * bakes renderRegistrationVerificationPopup(state.registrationVerification)
 * directly into the root's nextRootHtml string. Because the countdown text
 * depends on state.registrationVerification.nowMs (bumped every tick),
 * nextRootHtml differed from lastRenderedRootHtml on almost every tick, so
 * renderLobbyScreen's skip-if-unchanged guard never caught it and
 * `root.innerHTML = nextRootHtml` ran every second — destroying and
 * recreating the ENTIRE lobby DOM subtree, including
 * <input data-registration-verification-code-input="1">, which had no
 * value="..." binding at all, so the freshly created node was always empty.
 *
 * FIX (targeted patch, not a focus-restore hack — same pattern already used
 * elsewhere in this file, e.g. checkTournamentPartnerSearchTyping.ts):
 * startRegistrationVerificationCountdown()'s interval no longer calls
 * render() at all. A new patchRegistrationVerificationCountdown()
 * (renderRegistrationVerificationPopup.ts) updates ONLY the resend button's
 * text/disabled state directly via the DOM — the <input> is never touched by
 * the interval, so it is never recreated and never loses focus/caret. As
 * defense-in-depth for any OTHER legitimate full render that might occur
 * while the popup is open (a WS event, a badge update, etc.), the typed code
 * is now also mirrored into state.registrationVerification.code and baked
 * back into the template via value="..." — so even a real full rebuild would
 * not lose it.
 *
 * This test drives the REAL createLobbyFlowController + REAL DOM through a
 * fixture harness (scripts/fixtures/registrationVerificationTypingStabilityHarness.ts):
 * opens the verification popup via a real register-form submit, types the
 * code character-by-character via real 'input' event dispatches, and waits
 * through multiple REAL 1-second countdown ticks (no fake timers) — then
 * asserts DOM node identity (a stamped per-node marker, re-read after every
 * tick) plus document.activeElement and the input's value, not just "the
 * value looks right".
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type VerifySubmission = { pendingRegistrationId: string; code: string; rememberMe: boolean } | null

type H = {
  openRegister: () => Promise<void>
  fillRegisterFormAndSubmit: () => Promise<void>
  flush: () => Promise<void>
  waitRealMs: (ms: number) => Promise<void>
  typeChar: (char: string) => Promise<void>
  pasteValue: (value: string) => Promise<void>
  submitCodeForm: () => Promise<void>
  clickResend: () => Promise<void>
  clickClose: () => Promise<void>
  getCodeInputValue: () => Promise<string | null>
  getCodeInputElementId: () => Promise<string | null>
  isCodeInputFocused: () => Promise<boolean>
  isPopupOpen: () => Promise<boolean>
  getResendButtonText: () => Promise<string | null>
  getResendButtonDisabled: () => Promise<boolean | null>
  hasTwentyFourHourText: () => Promise<boolean>
  getLastVerifySubmission: () => Promise<VerifySubmission>
  getResendCallCount: () => Promise<number>
  queueVerifyResult: (result: { errorText: string | null; code?: string }) => Promise<void>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__registrationVerificationTypingStabilityHarness'
  return {
    openRegister: () => page.evaluate((k: any) => (window as any)[k].openRegister(), w),
    fillRegisterFormAndSubmit: () => page.evaluate((k: any) => (window as any)[k].fillRegisterFormAndSubmit(), w),
    flush: () => page.evaluate((k: any) => (window as any)[k].flush(), w),
    waitRealMs: (ms) => page.evaluate(([k, m]: any) => (window as any)[k].waitRealMs(m), [w, ms] as any),
    typeChar: (char) => page.evaluate(([k, c]: any) => (window as any)[k].typeChar(c), [w, char] as any),
    pasteValue: (value) => page.evaluate(([k, v]: any) => (window as any)[k].pasteValue(v), [w, value] as any),
    submitCodeForm: () => page.evaluate((k: any) => (window as any)[k].submitCodeForm(), w),
    clickResend: () => page.evaluate((k: any) => (window as any)[k].clickResend(), w),
    clickClose: () => page.evaluate((k: any) => (window as any)[k].clickClose(), w),
    getCodeInputValue: () => page.evaluate((k: any) => (window as any)[k].getCodeInputValue(), w),
    getCodeInputElementId: () => page.evaluate((k: any) => (window as any)[k].getCodeInputElementId(), w),
    isCodeInputFocused: () => page.evaluate((k: any) => (window as any)[k].isCodeInputFocused(), w),
    isPopupOpen: () => page.evaluate((k: any) => (window as any)[k].isPopupOpen(), w),
    getResendButtonText: () => page.evaluate((k: any) => (window as any)[k].getResendButtonText(), w),
    getResendButtonDisabled: () => page.evaluate((k: any) => (window as any)[k].getResendButtonDisabled(), w),
    hasTwentyFourHourText: () => page.evaluate((k: any) => (window as any)[k].hasTwentyFourHourText(), w),
    getLastVerifySubmission: () => page.evaluate((k: any) => (window as any)[k].getLastVerifySubmission(), w),
    getResendCallCount: () => page.evaluate((k: any) => (window as any)[k].getResendCallCount(), w),
    queueVerifyResult: (result) => page.evaluate(([k, r]: any) => (window as any)[k].queueVerifyResult(r), [w, result] as any),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkRegistrationVerificationTypingStability ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()

  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 480, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/registrationVerificationTypingStabilityHarness.html')
  const h = await harness(page)

  // --- A: real register submit opens the verification popup on the real path ---
  await check('[A] submitting the register form opens the verification popup (real submitRegister -> openRegistrationVerificationPopup path)', async () => {
    await h.openRegister()
    await h.fillRegisterFormAndSubmit()
    await h.flush()
    assert((await h.isPopupOpen()) === true, 'verification popup did not open after register submit')
    assert((await h.getCodeInputValue()) === '', 'code input should start empty on a fresh pending registration')
  })

  await check('[A2] "Кодът е валиден 24 часа." text is visible in the popup', async () => {
    assert((await h.hasTwentyFourHourText()) === true, '24h validity text not found in the popup')
  })

  // --- B: typing survives every keystroke (DOM node identity + focus) ---
  let stableNodeId: string | null = null
  await check('[B] typing "1","2","3" one at a time never replaces the <input> DOM node or steals focus', async () => {
    stableNodeId = await h.getCodeInputElementId()
    assert(stableNodeId !== null, 'code input not found after opening the popup')
    for (const char of ['1', '2', '3']) {
      await h.typeChar(char)
      const nodeId = await h.getCodeInputElementId()
      assert(nodeId === stableNodeId, `code input DOM node was replaced after typing "${char}" (node id changed: ${stableNodeId} -> ${nodeId})`)
      assert((await h.isCodeInputFocused()) === true, `code input lost focus after typing "${char}"`)
    }
    assert((await h.getCodeInputValue()) === '123', `expected code input value '123', got '${await h.getCodeInputValue()}'`)
  })

  // --- C: THE CORE REGRESSION — value survives multiple real countdown ticks ---
  const resendTextBeforeTicks = await h.getResendButtonText()
  await check('[C] code input value survives 2+ real 1-second countdown ticks (the production bug: full render() every tick wiped the value)', async () => {
    await h.waitRealMs(1150)
    assert((await h.getCodeInputValue()) === '123', `code input value was wiped by a countdown tick (expected '123', got '${await h.getCodeInputValue()}')`)
    assert((await h.getCodeInputElementId()) === stableNodeId, 'code input DOM node was replaced by a countdown tick')
    assert((await h.isCodeInputFocused()) === true, 'code input lost focus after a countdown tick')

    await h.waitRealMs(1150)
    assert((await h.getCodeInputValue()) === '123', `code input value was wiped by a second countdown tick (expected '123', got '${await h.getCodeInputValue()}')`)
    assert((await h.getCodeInputElementId()) === stableNodeId, 'code input DOM node was replaced by a second countdown tick')
    assert((await h.isCodeInputFocused()) === true, 'code input lost focus after a second countdown tick')
  })

  await check('[C2] the countdown itself is still functionally alive (resend label actually ticked down) even though the input was untouched', async () => {
    const resendTextAfterTicks = await h.getResendButtonText()
    assert(resendTextBeforeTicks !== resendTextAfterTicks, `resend countdown label did not change across 2+ real ticks (stuck at "${resendTextAfterTicks}") — countdown must keep working, just without touching the input`)
    assert((await h.getResendButtonDisabled()) === true, 'resend button should still be disabled (well inside the 60s cooldown)')
  })

  // --- D: append more digits after the ticks, keep ticking, value still holds ---
  await check('[D] appending "456" after the ticks and waiting through another tick keeps the full "123456"', async () => {
    for (const char of ['4', '5', '6']) {
      await h.typeChar(char)
    }
    assert((await h.getCodeInputValue()) === '123456', `expected '123456', got '${await h.getCodeInputValue()}'`)
    await h.waitRealMs(1150)
    assert((await h.getCodeInputValue()) === '123456', `code input value was wiped after appending digits and another tick (got '${await h.getCodeInputValue()}')`)
    assert((await h.getCodeInputElementId()) === stableNodeId, 'code input DOM node was replaced after appending digits and another tick')
    assert((await h.isCodeInputFocused()) === true, 'code input lost focus after appending digits and another tick')
  })

  // --- E: paste still works and is sanitized to 6 digits ---
  await check('[E] pasting a noisy 6-digit code sanitizes to digits-only and keeps the same DOM node', async () => {
    await h.pasteValue('65-43 21')
    assert((await h.getCodeInputValue()) === '654321', `expected sanitized paste '654321', got '${await h.getCodeInputValue()}'`)
    assert((await h.getCodeInputElementId()) === stableNodeId, 'code input DOM node was replaced by a paste')
  })

  // --- F: Enter/form submit still works and submits the sanitized code ---
  await check('[F] submitting the form sends the sanitized code to verify and closes the popup on success', async () => {
    await h.submitCodeForm()
    await h.flush()
    const submission = await h.getLastVerifySubmission()
    assert(submission !== null && submission.code === '654321', `expected verify submission with code '654321', got ${JSON.stringify(submission)}`)
    assert((await h.isPopupOpen()) === false, 'popup should close after a successful verification')
  })

  // --- G: opening a NEW pending registration resets the code state ---
  await check('[G] a fresh registration (new pending) starts with an empty code input, not the previous one', async () => {
    await h.openRegister()
    await h.fillRegisterFormAndSubmit()
    await h.flush()
    assert((await h.isPopupOpen()) === true, 'verification popup did not reopen for the second registration')
    assert((await h.getCodeInputValue()) === '', `expected empty code input on a new pending registration, got '${await h.getCodeInputValue()}'`)
  })

  // --- H: closing the popup does not leave a leaked interval throwing errors ---
  await check('[H] closing the popup stops the countdown cleanly (no errors across a further real tick)', async () => {
    await h.clickClose()
    assert((await h.isPopupOpen()) === false, 'popup did not close')
    await h.waitRealMs(1150)
  })

  await check('Няма JS грешки в конзолата през целия сценарий', () => {
    assert(errors.length === 0, `console errors: ${errors.join('; ')}`)
  })

  await context.close()

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
