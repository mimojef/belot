import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright'

declare global {
  interface Window {
    __profileAccessBlockPopupResult?: Record<string, boolean | number>
  }
}

const port = 5198
const baseUrl = `http://127.0.0.1:${port}`

let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${name}`)
    return
  }
  failed += 1
  console.error(`  FAIL ${name}`)
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

async function waitForVite(proc: ChildProcessWithoutNullStreams): Promise<void> {
  let output = ''
  const deadline = Date.now() + 20_000
  proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  proc.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })

  while (Date.now() < deadline) {
    const plainOutput = stripAnsi(output)
    if (plainOutput.includes('Local:') || plainOutput.includes(`:${port}`)) return
    if (proc.exitCode !== null) throw new Error(`Vite exited early with code ${proc.exitCode}:\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Timed out waiting for Vite:\n${output}`)
}

async function main(): Promise<void> {
  console.log('═══ checkProfileAccessBlockPopup ═══')

  const vite = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  )

  try {
    await waitForVite(vite)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      page.on('pageerror', (error) => {
        console.error(`  browser error ${error.message}`)
      })
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      await page.addScriptTag({
        type: 'module',
        url: `${baseUrl}/scripts/profileAccessBlockPopup.browser.mjs`,
      })
      const result = await page.waitForFunction(() => window.__profileAccessBlockPopupResult !== undefined, undefined, { timeout: 10_000 })
        .then(() => page.evaluate(() => window.__profileAccessBlockPopupResult!))

      // Success path (B blocks A -> A opens B -> Затвори + Блокирай -> click Блокирай)
      check('denial popup initially shows Затвори + Блокирай', result.initialShowsCloseAndBlock === true)
      check('denial popup does NOT show Отблокирай (viewer has not blocked target)', result.initialShowsUnblock === false)
      check('success text is shown right after the authoritative call resolves', result.successTextShownImmediately === true)
      check('buttons (including Затвори) are hidden while showing success', result.buttonsHiddenOnSuccess === true)
      check('popup is still mounted immediately after success (not closed instantly)', result.popupStillMountedRightAfterSuccess === true)
      check('the authoritative block endpoint is called exactly once', result.networkCalledExactlyOnce === true)
      check('popup remains open well before the 900ms mark', result.popupStillOpenBefore900ms === true)
      check('popup auto-closes shortly after 900ms', result.popupClosedAfter900ms === true)
      check('DOM is cleared after auto-close', result.domClearedAfterAutoClose === true)

      // Failure path (server rejects the block request)
      check('failure: no fake success text is ever shown', result.failureShowsNoSuccessText === true)
      check('failure: server error message is shown', result.failureShowsErrorText === true)
      check('failure: popup stays open', result.failurePopupStillOpen === true)
      check('failure: Блокирай remains present and enabled (retryable)', result.failureBlockButtonRetryable === true)
      check('failure: Затвори remains present', result.failureCloseButtonStillPresent === true)
      check('failure: popup still open well past the 900ms success-only auto-close window', result.failurePopupStillOpenAfter900ms === true)
      check('failure: the authoritative endpoint is called exactly once (no silent retry loop)', result.failureNetworkCalledExactlyOnce === true)

      // Retry after failure
      check('retry: first failed attempt shows the error, no fake success', result.retryFirstAttemptNoFakeSuccess === true)
      check('retry: first failed attempt shows its error text', result.retryFirstAttemptShowsError === true)
      check('retry: second attempt (retry) shows success', result.retrySecondAttemptShowsSuccess === true)
      check('retry: exactly 2 network calls total (1 failed + 1 successful retry)', result.retryTotalNetworkCalls === 2)
      check('retry: popup closes after the successful retry (900ms auto-close still applies)', result.retryPopupClosedAfterSuccess === true)
    } finally {
      await browser.close()
    }
  } finally {
    vite.kill()
    if (vite.exitCode === null) {
      await Promise.race([
        once(vite, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
  }

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
