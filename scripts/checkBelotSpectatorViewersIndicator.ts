/**
 * checkBelotSpectatorViewersIndicator.ts
 *
 * Belot viewer-indicator ("{име} гледа вашата игра") — client side. Real
 * browser (Playwright), real production код (createActiveRoomFlowController +
 * renderBelotSpectatorViewers) през activeRoomSpectatorHarness.ts.
 *
 *   [C1]  0 spectators -> няма икона
 *   [C2]  1+ -> иконата е видима (Belot asset)
 *   [C3]  spectator (controlledSeat=null) -> никога икона/звук
 *   [C4]  desktop: горе вдясно, без overlap с HUD/горен профил/контроли
 *   [C5]  mobile 390x844: горе вдясно, safe-area, без overlap
 *   [C6]  без CSS mirror/rotate
 *   [C7]  click отваря списъка "{име} гледа вашата игра."
 *   [C8]  click извън затваря; click върху иконата toggle-ва
 *   [C9]  имената са escape-нати
 *   [C10] live update при отворен списък
 *   [C11] последният излиза -> икона + popover изчезват
 *   [C12] update-ът не прави пълен gameplay render (root непокътнат)
 *   [C13] cleanup при изход от активната стая
 *   [C14] scoring/match-ended пазят иконата докато списъкът не е празен
 *   [A1-A5] звук само при реален 0 -> 1+ (не при hydration/resume/1 -> 2;
 *           изключена настройка го спира)
 *   [R1]  source review
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('waitUntil: timed out')
}
function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = any

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__activeRoomSpectatorHarness
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}


const ICON_URL = '/images/belot/belot-spectator-viewer.webp'
const SOUND_SRC = '/audio/game-sounds/spectator-viewer-appears.mp3'
type R = { left: number; top: number; right: number; bottom: number; width: number; height: number } | null
function overlaps(a: R, b: R): boolean {
  if (!a || !b) return false
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
const presence = (roomId: string, names: string[]) => ({
  type: 'belot_room_spectators',
  roomId,
  spectators: names.map((displayName, i) => ({ profileId: `spec-${i}-${displayName.length}`, displayName })),
})

console.log('\ncheckBelotSpectatorViewersIndicator\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`
  browser = await chromium.launch()

  async function newPage(mobile = false): Promise<Page> {
    const context = await browser!.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })
    ;(page as any).__pageErrors = pageErrors
    await call(page, (h: H) => h.setGameSoundsEnabledFn(true))
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: unexpected page errors: ${errors.join(' | ')}`)
  }
  async function enterParticipantPlaying(page: Page, roomId: string): Promise<void> {
    await call(page, (h: H, r: string) => h.enterAsParticipant(r, 'bottom'), roomId)
    await call(page, (h: H, r: string) => h.applyParticipantSnapshot(r, h.playingGame()), roomId)
    await waitUntil(() => call(page, (h: H) => h.viewerIndicatorInfo().topProfile !== null))
    await sleep(4_800) // deal catch-up settles
  }
  const inject = (page: Page, message: unknown) => call(page, (h: H, m: unknown) => h.injectServerMessage(m), message)
  const info = (page: Page) => call(page, (h: H) => h.viewerIndicatorInfo())
  const plays = (page: Page) => call(page, (h: H, src: string) => h.getAudioPlays().filter((s: string) => s === src).length, SOUND_SRC)

  // ── Desktop: C1-C4, C6-C13 ──────────────────────────────────────────────
  {
    const page = await newPage()
    await enterParticipantPlaying(page, 'room-v')

    await check('[C1] 0 spectators -> no icon (also after an explicit empty list)', async () => {
      assertEqual((await info(page)).icon, null, 'no icon before any list')
      await inject(page, presence('room-v', []))
      assertEqual((await info(page)).icon, null, 'no icon for []')
    })

    await check('[C12] presence update never triggers a full gameplay render (root untouched)', async () => {
      await call(page, (h: H) => h.startRootMutationCount())
      await inject(page, presence('room-v', ['Ани']))
      await sleep(400)
      const mutations = await call(page, (h: H) => h.stopRootMutationCount())
      assertEqual(mutations, 0, 'root childList mutations')
      assertEqual((await info(page)).iconInRoot, false, 'icon is a body-level overlay, not part of the phase render')
    })

    await check('[C2/C4] 1+ spectators -> icon visible top-right (desktop), no overlap with HUD/top profile/controls', async () => {
      const i = await info(page)
      assert(i.icon !== null, 'icon visible')
      assertEqual(i.imgSrc, ICON_URL, 'Belot asset (not Ludo)')
      assert(Math.abs(i.viewport.width - i.icon!.right - 10) <= 2, `right gap ${i.viewport.width - i.icon!.right}`)
      assert(i.icon!.top >= 8 && i.icon!.top <= 12, `top ${i.icon!.top}`)
      assert(i.icon!.width >= 48 && i.icon!.width <= 56, `size ${i.icon!.width}`)
      for (const [name, rect] of [['HUD', i.hud], ['top profile', i.topProfile], ['leave', i.leave], ['settings', i.settings]] as const) {
        assert(!overlaps(i.icon, rect), `icon overlaps ${name}: ${JSON.stringify(rect)}`)
      }
    })

    await check('[C6] no CSS mirror/rotate on the icon', async () => {
      const i = await info(page)
      assert(i.iconTransform === 'none' && i.imgTransform === 'none', `transforms ${i.iconTransform} / ${i.imgTransform}`)
      assert(!/scaleX|rotate|matrix/.test(i.styleText), 'no transform styles')
    })

    await check('[C7] click opens the list: "{name} гледа вашата игра."', async () => {
      await call(page, (h: H) => h.clickViewerIcon())
      const i = await info(page)
      assert(i.popover !== null, 'popover open')
      assertEqual(JSON.stringify(i.popoverRows), JSON.stringify(['Ани гледа вашата игра.']), 'rows')
      assert(i.popover!.top >= i.icon!.bottom, 'popover below the icon')
      assert(Math.abs(i.popover!.right - i.icon!.right) <= 2, 'popover right-aligned with the icon')
    })

    await check('[C10/C9] live update while open; names are escaped', async () => {
      await inject(page, presence('room-v', ['Ани', '<img src=x onerror=alert(1)>']))
      const i = await info(page)
      assertEqual(i.popoverRows.length, 2, 'two rows live')
      assert(i.popoverRows[1] === '<img src=x onerror=alert(1)> гледа вашата игра.', `escaped text row: ${i.popoverRows[1]}`)
      assert(i.popoverHtml.includes('&lt;img'), 'escaped HTML')
      assertEqual(i.popoverHasImg, false, 'no injected element')
    })

    await check('[C8] outside click closes; icon click toggles', async () => {
      await call(page, (h: H) => h.clickOutsideViewers())
      assertEqual((await info(page)).popover, null, 'closed by outside click')
      await call(page, (h: H) => h.clickViewerIcon())
      assert((await info(page)).popover !== null, 'reopened by icon click')
      await call(page, (h: H) => h.clickViewerIcon())
      assertEqual((await info(page)).popover, null, 'closed by second icon click')
    })

    await check('[C11] last spectator leaves -> icon + popover removed', async () => {
      await call(page, (h: H) => h.clickViewerIcon())
      await inject(page, presence('room-v', []))
      const i = await info(page)
      assertEqual(i.icon, null, 'icon removed')
      assertEqual(i.popover, null, 'popover removed')
    })

    await check('[C-room] presence for another room is ignored', async () => {
      await inject(page, presence('room-other', ['Боби']))
      assertEqual((await info(page)).icon, null, 'no icon from another room')
    })

    await check('[C13] cleanup on active-room exit (left_active_room)', async () => {
      await inject(page, presence('room-v', ['Ани']))
      await call(page, (h: H) => h.clickViewerIcon())
      assert((await info(page)).popover !== null, 'precondition: open')
      await inject(page, { type: 'left_active_room', roomId: 'room-v' })
      const i = await info(page)
      assertEqual(i.icon, null, 'icon removed on exit')
      assertEqual(i.popover, null, 'popover removed on exit')
    })
    assertNoPageErrors(page, 'desktop')
    await page.close()
  }

  // ── C3 spectator ────────────────────────────────────────────────────────
  await check('[C3] spectator (controlledSeat=null) never sees the viewer icon', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsSpectator('room-s', h.playingGame()))
    await inject(page, presence('room-s', ['Ани']))
    await sleep(200)
    assertEqual((await info(page)).icon, null, 'no icon for spectator')
    assertEqual(await plays(page), 0, 'no sound for spectator')
    assertNoPageErrors(page, 'C3')
    await page.close()
  })

  // ── C14 scoring / match-ended ───────────────────────────────────────────
  await check('[C14] scoring and match-ended keep the icon while the list is non-empty', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-f', 'bottom'))
    await call(page, (h: H) => h.applyParticipantSnapshot('room-f', h.scoringGame()))
    await inject(page, presence('room-f', ['Ани']))
    await waitUntil(() => call(page, (h: H) => h.scoringPanelText().length > 0))
    assert((await info(page)).icon !== null, 'icon on scoring')
    await call(page, (h: H) => h.applyParticipantSnapshot('room-f', h.matchEndedGame()))
    await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.length > 0))
    assert((await info(page)).icon !== null, 'icon on match-ended')
    assertEqual(await call(page, (h: H) => h.hasMatchEndedActionButtons()), true, 'participant match-ended controls unchanged')
    await inject(page, presence('room-f', []))
    assertEqual((await info(page)).icon, null, 'icon gone when list empties')
    assertNoPageErrors(page, 'C14')
    await page.close()
  })

  // ── C5 mobile ───────────────────────────────────────────────────────────
  await check('[C5] mobile: icon top-right, safe-area aware, no overlap with top profile/HUD', async () => {
    const page = await newPage(true)
    await enterParticipantPlaying(page, 'room-m')
    await inject(page, presence('room-m', ['Ани']))
    const i = await info(page)
    assert(i.icon !== null, 'icon visible on mobile')
    assert(i.icon!.right <= i.viewport.width - 8 && i.icon!.right >= i.viewport.width - 14, `right edge ${i.icon!.right}/${i.viewport.width}`)
    assert(i.icon!.top >= 8 && i.icon!.top <= 14, `top ${i.icon!.top}`)
    assert(i.icon!.width >= 32 && i.icon!.width <= 48, `mobile size ${i.icon!.width}`)
    assert(!overlaps(i.icon, i.topProfile), `overlaps top profile ${JSON.stringify(i.topProfile)} icon ${JSON.stringify(i.icon)}`)
    assert(!overlaps(i.icon, i.hud), 'overlaps HUD')
    await call(page, (h: H) => h.clickViewerIcon())
    const j = await info(page)
    assert(j.popover !== null && j.popover!.left >= 0 && j.popover!.right <= j.viewport.width, 'popover fits the viewport')
    assertNoPageErrors(page, 'C5')
    await page.close()
  })

  // ── Sound A1-A5 ─────────────────────────────────────────────────────────
  await check('[A2/A1/A4/A3/A5] sound only on a real 0 -> 1+ transition', async () => {
    const page = await newPage()
    await enterParticipantPlaying(page, 'room-a')
    // A2: initial hydration with spectators -> no sound
    await inject(page, presence('room-a', ['Ани']))
    assertEqual(await plays(page), 0, 'A2 initial hydration silent')
    // A1: 1 -> 0 -> 1 plays once
    await inject(page, presence('room-a', []))
    await inject(page, presence('room-a', ['Ани']))
    assertEqual(await plays(page), 1, 'A1 0 -> 1 plays once')
    // A4: 1 -> 2 and refresh do not play
    await inject(page, presence('room-a', ['Ани', 'Боби']))
    await inject(page, presence('room-a', ['Ани', 'Боби']))
    assertEqual(await plays(page), 1, 'A4 1 -> 2 / refresh silent')
    // A3: reconnect/resume -> next list is hydration (even 0 -> 1)
    await inject(page, presence('room-a', []))
    await call(page, (h: H) => h.setConnectionStateFn(false))
    await call(page, (h: H) => h.setConnectionStateFn(true))
    await inject(page, presence('room-a', ['Ани']))
    assertEqual(await plays(page), 1, 'A3 resume hydration silent')
    // A5: sound setting OFF suppresses a real 0 -> 1
    await call(page, (h: H) => h.setGameSoundsEnabledFn(false))
    await inject(page, presence('room-a', []))
    await inject(page, presence('room-a', ['Ани']))
    assertEqual(await plays(page), 1, 'A5 setting OFF suppresses')
    await call(page, (h: H) => h.setGameSoundsEnabledFn(true))
    assert((await info(page)).icon !== null, 'icon still shown with sound off')
    assertNoPageErrors(page, 'sound')
    await page.close()
  })

  await check('[R1] source review: Belot asset/audio paths, no Ludo imports, overlay sync without phase render', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const read = async (rel: string) => (await readFile(join(here, '..', ...rel.split('/')), 'utf8')).replace(/\r\n/g, '\n')
    const renderer = await read('src/app/activeRoom/renderBelotSpectatorViewers.ts')
    assert(renderer.includes(`'${ICON_URL}'`) && renderer.includes(`'${SOUND_SRC}'`), 'Belot asset paths')
    assert(!/games\/ludo|ludo-spectator/.test(renderer.replace(/^\/\/.*$/gm, '')), 'no Ludo code/asset references')
    const controller = await read('src/app/activeRoom/createActiveRoomFlowController.ts')
    const apply = controller.slice(controller.indexOf('function applyBelotRoomSpectators('), controller.indexOf('// Targeted ticker за tournament attendance'))
    assert(!apply.includes('scheduleActiveRoomRender') && !apply.includes('renderActiveRoomScreen'), 'no phase render on presence update')
    assert(apply.includes('activeRoomState.controlledSeat === null) return'), 'spectator ignores presence')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
