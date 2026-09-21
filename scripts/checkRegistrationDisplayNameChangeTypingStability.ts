/**
 * checkRegistrationDisplayNameChangeTypingStability.ts
 *
 * INVESTIGATION (not a fix): real browser (Playwright), real production
 * code, real DOM — checks whether the SAME class of defect fixed in commit
 * 67914e3 ("fix: preserve verification code during countdown") for the
 * verification-CODE input also exists, unfixed, in the sibling
 * display-name-change input that appears when the server rejects a
 * verification attempt with DISPLAY_NAME_TAKEN
 * (createLobbyFlowController.ts's submitRegistrationVerificationCode ->
 * mode = 'displayName' branch).
 *
 * STATIC EVIDENCE (from code review, verified by this test):
 *  - renderRegistrationVerificationPopup.ts::renderDisplayNameForm renders
 *    <input data-registration-verification-display-name-input="1"> with NO
 *    value="..." binding (unlike the code input's
 *    value="${escapeHtml(state.code)}", added by 67914e3).
 *  - submitRegistrationVerificationDisplayNameChange()
 *    (createLobbyFlowController.ts) calls render() on EVERY outcome —
 *    including a second failure (invalid_display_name / still taken) while
 *    state.registrationVerification.mode stays 'displayName'.
 *  - render()'s only focus-protecting early-return guard checks
 *    `[data-lobby-auth-modal-root="1"]` (the separate login/register modal),
 *    NOT `[data-registration-verification-modal-root="1"]` — so this render
 *    is never suppressed while the display-name input has focus.
 *  - render() -> renderLobby() -> renderLobbyScreen() does
 *    `root.innerHTML = nextRootHtml` whenever the computed HTML differs from
 *    the last render (errorText/isChangingDisplayName differ on every failed
 *    resubmit) — a full subtree rebuild, not a targeted patch.
 *  - attachRegistrationVerificationPopupEventListeners() DOES call
 *    `displayNameInput?.focus()` unconditionally after every rebuild, so
 *    FOCUS itself is restored — but with no value binding, the freshly
 *    created <input> is always empty, so any text the user had already
 *    retyped is silently wiped on every failed submit of a new name.
 *
 * This test proves (or disproves) that behavior end-to-end against the REAL
 * createLobbyFlowController, driven through a fixture harness
 * (scripts/fixtures/registrationDisplayNameChangeTypingStabilityHarness.ts)
 * exactly mirroring checkRegistrationVerificationTypingStability.ts's
 * pattern.
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

type DisplayNameSubmission = { pendingRegistrationId: string; displayName: string } | null
type VerifySubmission = { pendingRegistrationId: string; code: string; rememberMe: boolean } | null

type H = {
  openRegister: () => Promise<void>
  fillRegisterFormAndSubmit: () => Promise<void>
  flush: () => Promise<void>
  fillCodeAndSubmit: (code: string) => Promise<void>
  typeDisplayNameChar: (char: string) => Promise<void>
  submitDisplayNameForm: () => Promise<void>
  getMode: () => Promise<'code' | 'displayName' | 'none'>
  isPopupOpen: () => Promise<boolean>
  getDisplayNameInputValue: () => Promise<string | null>
  getDisplayNameInputElementId: () => Promise<string | null>
  isDisplayNameInputFocused: () => Promise<boolean>
  getLastVerifySubmission: () => Promise<VerifySubmission>
  getLastDisplayNameSubmission: () => Promise<DisplayNameSubmission>
  queueVerifyResult: (result: { errorText: string | null; code?: string }) => Promise<void>
  queueDisplayNameResult: (result: { errorText: string | null; maskedEmail?: string; expiresAt?: string }) => Promise<void>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__registrationDisplayNameChangeTypingStabilityHarness'
  return {
    openRegister: () => page.evaluate((k: any) => (window as any)[k].openRegister(), w),
    fillRegisterFormAndSubmit: () => page.evaluate((k: any) => (window as any)[k].fillRegisterFormAndSubmit(), w),
    flush: () => page.evaluate((k: any) => (window as any)[k].flush(), w),
    fillCodeAndSubmit: (code) => page.evaluate(([k, c]: any) => (window as any)[k].fillCodeAndSubmit(c), [w, code] as any),
    typeDisplayNameChar: (char) => page.evaluate(([k, c]: any) => (window as any)[k].typeDisplayNameChar(c), [w, char] as any),
    submitDisplayNameForm: () => page.evaluate((k: any) => (window as any)[k].submitDisplayNameForm(), w),
    getMode: () => page.evaluate((k: any) => (window as any)[k].getMode(), w),
    isPopupOpen: () => page.evaluate((k: any) => (window as any)[k].isPopupOpen(), w),
    getDisplayNameInputValue: () => page.evaluate((k: any) => (window as any)[k].getDisplayNameInputValue(), w),
    getDisplayNameInputElementId: () => page.evaluate((k: any) => (window as any)[k].getDisplayNameInputElementId(), w),
    isDisplayNameInputFocused: () => page.evaluate((k: any) => (window as any)[k].isDisplayNameInputFocused(), w),
    getLastVerifySubmission: () => page.evaluate((k: any) => (window as any)[k].getLastVerifySubmission(), w),
    getLastDisplayNameSubmission: () => page.evaluate((k: any) => (window as any)[k].getLastDisplayNameSubmission(), w),
    queueVerifyResult: (result) => page.evaluate(([k, r]: any) => (window as any)[k].queueVerifyResult(r), [w, result] as any),
    queueDisplayNameResult: (result) => page.evaluate(([k, r]: any) => (window as any)[k].queueDisplayNameResult(r), [w, result] as any),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkRegistrationDisplayNameChangeTypingStability (INVESTIGATION) ═══\n')

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

  await page.goto('/scripts/fixtures/registrationDisplayNameChangeTypingStabilityHarness.html')
  const h = await harness(page)

  // --- A: reach the displayName mode via the real DISPLAY_NAME_TAKEN path ---
  await check('[A] real register submit -> verification popup -> DISPLAY_NAME_TAKEN switches to displayName mode', async () => {
    await h.openRegister()
    await h.fillRegisterFormAndSubmit()
    await h.flush()
    assert((await h.isPopupOpen()) === true, 'verification popup did not open after register submit')
    assert((await h.getMode()) === 'code', 'popup should start in code mode')

    await h.queueVerifyResult({ errorText: 'Това потребителско име вече е заето. Моля, изберете друго име.', code: 'DISPLAY_NAME_TAKEN' })
    await h.fillCodeAndSubmit('123456')
    await h.flush()
    assert((await h.getMode()) === 'displayName', `expected displayName mode after DISPLAY_NAME_TAKEN, got '${await h.getMode()}'`)
    assert((await h.getLastVerifySubmission())?.code === '123456', 'the real verify code submission did not carry the typed code')
  })

  // --- B: typing a new name works, node stays stable while typing ---
  let stableNodeId: string | null = null
  await check('[B] typing "N","e","w" one at a time into the display-name input never replaces its DOM node or steals focus', async () => {
    stableNodeId = await h.getDisplayNameInputElementId()
    assert(stableNodeId !== null, 'display-name input not found after switching to displayName mode')
    for (const char of ['N', 'e', 'w']) {
      await h.typeDisplayNameChar(char)
      const nodeId = await h.getDisplayNameInputElementId()
      assert(nodeId === stableNodeId, `display-name input DOM node was replaced after typing "${char}"`)
      assert((await h.isDisplayNameInputFocused()) === true, `display-name input lost focus after typing "${char}"`)
    }
    assert((await h.getDisplayNameInputValue()) === 'New', `expected 'New', got '${await h.getDisplayNameInputValue()}'`)
  })

  // --- C: THE CORE QUESTION — does a second failed submit wipe the typed value? ---
  await check('[C] submitting a new name that is ALSO rejected (invalid/still taken) — does the typed value survive the resulting render()?', async () => {
    await h.queueDisplayNameResult({ errorText: 'Невалидно потребителско име.' })
    await h.submitDisplayNameForm()
    await h.flush()
    // Whatever the outcome, we must still be in displayName mode (the
    // second failure does not bounce the user back to code mode).
    assert((await h.getMode()) === 'displayName', `expected to remain in displayName mode after a second failure, got '${await h.getMode()}'`)
    const valueAfter = await h.getDisplayNameInputValue()
    const nodeIdAfter = await h.getDisplayNameInputElementId()
    if (valueAfter !== 'New' || nodeIdAfter !== stableNodeId) {
      throw new Error(
        `CONFIRMED DEFECT: typed display name was lost after a failed resubmit. ` +
        `value before='New' after='${valueAfter}', DOM node identity stable=${nodeIdAfter === stableNodeId} ` +
        `(node id before='${stableNodeId}' after='${nodeIdAfter}'). ` +
        `Root cause: renderDisplayNameForm() in renderRegistrationVerificationPopup.ts has no value="..." binding ` +
        `on the display-name input (unlike the code input's value="\${escapeHtml(state.code)}" from commit 67914e3), ` +
        `so the full render() triggered by submitRegistrationVerificationDisplayNameChange()'s error path recreates ` +
        `an EMPTY input every time a resubmit fails.`,
      )
    }
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
