import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

declare global {
  interface Window {
    __protectedStaffBlockNoticeResult?: Record<string, unknown>
  }
}

// Client страна на защитата "екип Pika.bg" (pika_team / marketing) срещу
// блокиране: server отговор 403 code PROTECTED_STAFF_PROFILE -> централен
// informational popup ("Не можете да блокирате профил от екипа на Pika.bg." +
// OK) през ВСИЧКИ реални block entry points (lobby profile popup, lobby
// access-denial, in-game profile popup, in-game access-denial).

const port = 5199
const baseUrl = `http://127.0.0.1:${port}`
const EXPECTED_TEXT = 'Не можете да блокирате профил от екипа на Pika.bg.'

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

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const next = source.indexOf('\n  async function ', start + signature.length)
  const nextSync = source.indexOf('\n  function ', start + signature.length)
  const ends = [next, nextSync].filter((index) => index > 0)
  return source.slice(start, ends.length ? Math.min(...ends) : undefined)
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
    await new Promise((r) => setTimeout(r, 100))
  }

  throw new Error(`Timed out waiting for Vite:\n${output}`)
}

function checkSourceWiring(): void {
  console.log('── source wiring (all real block entry points) ──')
  const main = read('src/main.ts')
  const submit = main.slice(main.indexOf('async function submitProfileBlock('), main.indexOf('async function readChatConversationsResponse('))
  check('[S1] submitProfileBlock reads `code` and branches on PROTECTED_STAFF_PROFILE', /code\?: string/.test(submit) && submit.includes('data.code === PROTECTED_STAFF_PROFILE_ERROR_CODE'))
  check('[S2] submitProfileBlock shows the central notice and returns protectedStaffProfile: true',
    submit.includes('showProtectedStaffBlockNotice(message)') && submit.includes('protectedStaffProfile: true'))
  const blockFetches = [...main.matchAll(/\/api\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/block`/g)].length
  check('[S3] submitProfileBlock is the single client call to POST /api/profiles/:id/block', blockFetches === 1 && submit.includes('/block`'))
  check('[S4] lobby wiring (profile popup + access-denial) uses submitProfileBlock', main.includes('onBlockProfile: (profileId) => submitProfileBlock(profileId),'))
  check('[S5] in-game access-denial wiring uses submitProfileBlock', main.includes('onBlockProfileFull: (profileId) => submitProfileBlock(profileId),'))
  check('[S6] in-game profile popup wiring suppresses the inline message for protected profiles',
    main.includes("if ('ok' in result && !result.ok) return { message: result.protectedStaffProfile ? null : result.message }"))

  const lobby = read('src/app/lobby/createLobbyFlowController.ts')
  const blockProfile = functionBody(lobby, 'async function blockProfile(profileId: string)')
  check('[S7] lobby profile popup blockProfile() stops on protectedStaffProfile before inline/limit handling',
    blockProfile.includes('if (result.protectedStaffProfile) return') &&
    blockProfile.indexOf('if (result.protectedStaffProfile) return') < blockProfile.indexOf('state.friendActionMessage = result.message'))
  const lobbyDenial = functionBody(lobby, 'async function blockFromAccessDenialPopup(profileId: string)')
  check('[S8] lobby access-denial releases blockSubmitting with no inline text for protected profiles',
    lobbyDenial.includes('blockSubmitting: false') && lobbyDenial.includes('blockErrorText: result.protectedStaffProfile ? null : result.message'))

  const activeRoom = read('src/app/activeRoom/createActiveRoomFlowController.ts')
  const gameDenial = functionBody(activeRoom, 'function blockFromProfileAccessBlockPopup(profileId: string)')
  check('[S9] in-game access-denial releases blockSubmitting with no inline text for protected profiles',
    gameDenial.includes('blockSubmitting: false') && /blockErrorText: result\.protectedStaffProfile\s*\?\s*null/.test(gameDenial))

  const popup = read('src/ui/overlays/renderPlayerProfilePopup.ts')
  check('[S10] "Блокирай" button is not pre-hidden by role (client never decides protection)',
    popup.includes('${profile.profileId && profile.isBlockedByMe !== null ? `') &&
    !/pika_team|marketing|PROTECTED_STAFF/.test(popup.slice(popup.indexOf('data-player-profile-block=') - 400, popup.indexOf('data-player-profile-block='))))
}

async function main(): Promise<void> {
  console.log('═══ checkProtectedStaffBlockNotice ═══')
  checkSourceWiring()

  console.log('── real DOM (Vite + Chromium) ──')
  const vite = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  )

  try {
    await waitForVite(vite)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const pageErrors: string[] = []
      page.on('pageerror', (error) => { pageErrors.push(error.message) })
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      // Изолираме harness-а от реалното приложение (main.ts монтира lobby-то
      // в #app) — тестваме само споделените модули в чист body.
      await page.evaluate(() => { document.body.innerHTML = '' })
      await page.addScriptTag({ type: 'module', url: `${baseUrl}/scripts/protectedStaffBlockNotice.browser.mjs` })
      const result = await page.waitForFunction(() => window.__protectedStaffBlockNoticeResult !== undefined, undefined, { timeout: 15_000 })
        .then(() => page.evaluate(() => window.__protectedStaffBlockNoticeResult!))

      if (result.fatal) {
        check(`browser harness ran without a fatal error (${String(result.fatal)})`, false)
      } else {
        check('[N1] constants: code PROTECTED_STAFF_PROFILE + exact message', result.constants === true)
        check('[N2] notice text is exactly "Не можете да блокирате профил от екипа на Pika.bg."', result.noticeText === EXPECTED_TEXT)
        check('[N3] notice has exactly one button labelled OK', result.noticeOkLabel === 'OK' && result.noticeButtonCount === 1)
        check('[N4] notice is a single instance mounted in document.body', result.noticeSingleInstance === true && result.noticeInBody === true)
        check('[N5] notice z-index is above the in-game profile overlay (99998)', typeof result.noticeZIndex === 'number' && (result.noticeZIndex as number) > 99998)
        check('[N6] notice does not mention "модератор"', result.noticeNoModeratorWord === true)
        check('[N7] OK closes the notice', result.noticeOkCloses === true)
        check('[N8] backdrop click closes the notice', result.noticeBackdropCloses === true)
        check('[N9] notice escapes HTML in the message', result.noticeEscapesHtml === true)

        check('[G1] in-game profile popup: "Блокирай" is visible and enabled (not pre-hidden)', result.inGameBlockButtonVisible === true)
        check('[G2] in-game profile popup: protected response shows the notice (1 request)', result.inGameNoticeShown === true && result.inGameCalls === 1)
        check('[G3] in-game profile popup: notice is on top of the 99998 overlay and clickable', result.inGameNoticeOnTop === true && result.inGameNoticeAboveOverlay === true)
        check('[G4] in-game profile popup: no duplicated inline text; overlay stays open', result.inGameNoInlineText === true && result.inGameOverlayStillOpen === true)
        check('[G5] in-game profile popup: "Блокирай" is enabled again (loading released)', result.inGameBlockButtonReusable === true)
        check('[G6] in-game profile popup: OK closes only the notice', result.inGameOkCloses === true)

        check('[D1] access-denial popup: protected response shows the notice (1 request)', result.denialNoticeShown === true && result.denialCalls === 1)
        check('[D2] access-denial popup: notice is on top and clickable', result.denialNoticeOnTop === true)
        check('[D3] access-denial popup: stays open with no duplicated inline text', result.denialPopupStillOpen === true && result.denialNoInlineText === true)
        check('[D4] access-denial popup: "Блокирай" is enabled again (blockSubmitting released)', result.denialLoadingReleased === true)
        check('[D5] access-denial popup: OK closes the notice', result.denialOkCloses === true)
      }
      check('no browser page errors from the harness modules', !pageErrors.some((message) => /protectedStaff|renderSeatProfileOverlay|renderProfileAccessBlockPopup/.test(message)))
    } finally {
      await browser.close()
    }
  } finally {
    vite.kill()
    if (vite.exitCode === null) {
      await Promise.race([
        once(vite, 'exit'),
        new Promise((r) => setTimeout(r, 2_000)),
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
