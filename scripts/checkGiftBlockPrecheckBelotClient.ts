/**
 * checkGiftBlockPrecheckBelotClient.ts
 *
 * Белот (играч И зрител) — client-side проверка за блокиране преди отваряне
 * на table gift селектора. Real browser (Playwright) + РЕАЛНИЯ
 * createActiveRoomFlowController през scripts/fixtures/activeRoomSpectatorHarness.ts
 * (onProfileByIdLoad е управляем stub на GET /api/profiles/:id).
 *
 * За role ∈ {participant, spectator}:
 *   [1]  без блокиране → 1 profile load за точния получател, селекторът се отваря
 *   [2]  profile_blocked_by_viewer → съществуващият popup "Този потребител е блокиран от Вас.", без селектор
 *   [3]  profile_blocked_viewer → "Този потребител ви е блокирал.", без селектор
 *   [4]  мрежова грешка → toast, без селектор и без block popup
 *   [5]  loading индикатор върху иконата докато проверката лети; повторни
 *        кликове (същата/друга икона) не пращат втора проверка
 *   [6]  остарял резултат след изход/смяна на стаята → нищо не се отваря
 *   [7]  остарял резултат след смяна на играча на мястото → нищо не се отваря
 *   [8]  сървърен отказ с code (block след отваряне) → селекторът се затваря, popup за СЪЩИЯ получател
 *   [9]  остарял сървърен отказ (друг requestId) → игнориран
 *   [10] отказ без code (напр. баланс) → непроменено поведение (грешка в селектора)
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${label}`) } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: unknown, msg: string): void {
  if (!condition) throw new Error(msg)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
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

const BY_VIEWER_TEXT = 'Този потребител е блокиран от Вас.'
const VIEWER_TEXT = 'Този потребител ви е блокирал.'

console.log('\ncheckGiftBlockPrecheckBelotClient\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`
  browser = await chromium.launch()

  for (const role of ['participant', 'spectator'] as const) {
    console.log(`=== ${role} ===`)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })

    const roomId = `room-${role}`
    const enter = async (rid: string) => {
      if (role === 'spectator') {
        await call(page, (h: H, r: string) => h.enterAsSpectator(r, h.playingGame()), rid)
        await waitUntil(() => call(page, (h: H) => ['bottom', 'right', 'top', 'left'].every((s) => h.fanMetrics(s)?.visible === 8)))
      } else {
        await call(page, (h: H, r: string) => h.enterAsParticipant(r, 'bottom'), rid)
        await call(page, (h: H, r: string) => h.applyParticipantSnapshot(r, h.playingGame()), rid)
        await waitUntil(() => call(page, (h: H) => ['right', 'top', 'left'].every((s) => h.fanMetrics(s)?.visible === 8)))
      }
      await sleep(1_200)
    }
    const applySeats = (seats: unknown) => role === 'spectator'
      ? call(page, (h: H, a: any) => h.applySpectatorSnapshot(a.roomId, h.playingGame(), a.seats), { roomId, seats })
      : call(page, (h: H, a: any) => h.applyParticipantSnapshot(a.roomId, h.playingGame(), a.seats), { roomId, seats })
    const modal = () => call(page, (h: H) => h.tableGiftModalInfo())
    const popup = () => call(page, (h: H) => h.profileAccessBlockPopupInfo())
    const loads = () => call(page, (h: H) => h.getProfileLoadRequests() as string[])
    const setMode = (mode: string) => call(page, (h: H, m: string) => h.setProfileLoadMode(m), mode)
    const closePopup = async () => {
      if ((await popup()).visible) await page.locator('[role="dialog"] [data-profile-access-block-close="1"]').click()
    }
    const closeModal = async () => {
      if ((await modal()).open) await page.locator('[data-table-gift-modal-close="1"]').click()
    }
    const sends = async () => (await call(page, (h: H) => h.getCalls())).filter((c: any) => c.name === 'sendTableGift')

    await enter(roomId)

    await check(`[${role} 1] без блокиране: 1 проверка за точния получател, селекторът се отваря`, async () => {
      await setMode('ok')
      const before = (await loads()).length
      await call(page, (h: H) => h.clickGiftIcon('top'))
      await waitUntil(async () => (await modal()).pickIds.length > 0)
      const after = await loads()
      assert(after.length === before + 1 && after.at(-1) === 'profile-top', `loads=${JSON.stringify(after)}`)
      assert(!(await popup()).visible, 'block popup must not show')
      await closeModal()
    })

    for (const [n, code, text] of [['2', 'profile_blocked_by_viewer', BY_VIEWER_TEXT], ['3', 'profile_blocked_viewer', VIEWER_TEXT]] as const) {
      await check(`[${role} ${n}] ${code}: съществуващият popup ("${text}"), без селектор`, async () => {
        await setMode(code)
        await call(page, (h: H) => h.clickGiftIcon('right'))
        await waitUntil(async () => (await popup()).visible)
        const info = await popup()
        assert(info.text.includes(text), `popup text=${info.text}`)
        await sleep(200)
        assert(!(await modal()).open, 'gift selector must not open')
        await closePopup()
      })
    }

    await check(`[${role} 4] мрежова грешка: toast, без селектор и без block popup`, async () => {
      await setMode('error')
      await call(page, (h: H) => h.clickGiftIcon('left'))
      await waitUntil(async () => (await call(page, (h: H) => h.tableGiftToastText())) !== null)
      assert((await call(page, (h: H) => h.tableGiftToastText())) === 'Няма връзка със сървъра.', 'toast text')
      await sleep(200)
      assert(!(await modal()).open, 'selector must not open')
      assert(!(await popup()).visible, 'block popup must not show without confirmed block')
    })

    await check(`[${role} 5] loading индикатор + повторни кликове не пращат втора проверка`, async () => {
      await setMode('deferred')
      const before = (await loads()).length
      await call(page, (h: H) => h.clickGiftIcon('top'))
      const css = await call(page, (h: H) => h.giftPrecheckPendingCss())
      assert(css !== null && css.includes('[data-active-room-gift-icon="top"]'), `pending css=${css}`)
      await call(page, (h: H) => { h.clickGiftIcon('top'); h.clickGiftIcon('top'); h.clickGiftIcon('right') })
      assert((await loads()).length === before + 1, `loads=${(await loads()).length - before}`)
      // Индикаторът оцелява при re-render на панелите.
      await call(page, (h: H) => h.render())
      await sleep(100)
      const animation = await page.evaluate(() => getComputedStyle(document.querySelector('[data-active-room-gift-icon="top"]')!).animationName)
      assert(animation === 'giftRecipientPrecheckPulse', `animation=${animation}`)
      await call(page, (h: H) => h.resolveDeferredProfileLoad('ok'))
      await waitUntil(async () => (await modal()).pickIds.length > 0)
      assert((await call(page, (h: H) => h.giftPrecheckPendingCss())) === null, 'indicator removed')
      await closeModal()
    })

    await check(`[${role} 6] остарял резултат след изход от масата → нищо не се отваря`, async () => {
      await setMode('deferred')
      await call(page, (h: H) => h.clickGiftIcon('top'))
      if (role === 'spectator') await call(page, (h: H) => h.exitSpectator())
      else await call(page, (h: H, r: string) => h.injectServerMessage({ type: 'left_active_room', roomId: r, penalty: null }), roomId)
      await sleep(150)
      assert((await call(page, (h: H) => h.giftPrecheckPendingCss())) === null, 'indicator cleared on exit')
      await call(page, (h: H) => h.resolveDeferredProfileLoad('profile_blocked_viewer'))
      await sleep(300)
      assert(!(await popup()).visible, 'no popup after exit')
      assert(!(await modal()).open, 'no selector after exit')
      await enter(roomId)
    })

    await check(`[${role} 7] остарял резултат след смяна на играча на мястото → нищо не се отваря`, async () => {
      await setMode('deferred')
      await call(page, (h: H) => h.clickGiftIcon('top'))
      const seats = await call(page, (h: H) => h.makeSeats())
      ;(seats as any[]).find((s) => s.seat === 'top').profileId = 'profile-top-replacement'
      await applySeats(seats)
      await call(page, (h: H) => h.resolveDeferredProfileLoad('profile_blocked_by_viewer'))
      await sleep(300)
      assert(!(await popup()).visible, 'no popup for replaced occupant')
      assert(!(await modal()).open, 'no selector for replaced occupant')
      await applySeats(await call(page, (h: H) => h.makeSeats()))
      await sleep(300)
    })

    await check(`[${role} 8] сървърен отказ с code → селекторът се затваря, popup за СЪЩИЯ получател`, async () => {
      await setMode('ok')
      await call(page, (h: H) => h.clickGiftIcon('right'))
      await waitUntil(async () => (await modal()).pickIds.length > 0)
      await call(page, (h: H) => h.pickTableGift('gift-rose'))
      const send = (await sends()).at(-1)
      assert(send && send.args[1] === 'profile-right', `send=${JSON.stringify(send)}`)
      await call(page, (h: H, m: unknown) => h.injectServerMessage(m), {
        type: 'table_gift_send_result', roomId, requestId: send.args[3], ok: false,
        message: VIEWER_TEXT, code: 'profile_blocked_viewer',
      })
      await waitUntil(async () => (await popup()).visible)
      assert((await popup()).text.includes(VIEWER_TEXT), 'popup text')
      assert(!(await modal()).open, 'selector closed')
      const blockButton = await page.locator('[data-profile-access-block-block]').getAttribute('data-profile-access-block-block')
      assert(blockButton === 'profile-right', `popup recipient=${blockButton}`)
      await closePopup()
    })

    await check(`[${role} 9] остарял сървърен отказ (друг requestId) → игнориран`, async () => {
      await call(page, (h: H) => h.clickGiftIcon('top'))
      await waitUntil(async () => (await modal()).pickIds.length > 0)
      await call(page, (h: H) => h.pickTableGift('gift-rose'))
      await call(page, (h: H, m: unknown) => h.injectServerMessage(m), {
        type: 'table_gift_send_result', roomId, requestId: 'stale-request-id', ok: false,
        message: BY_VIEWER_TEXT, code: 'profile_blocked_by_viewer',
      })
      await sleep(300)
      assert(!(await popup()).visible, 'stale reject must not open popup')
      assert((await modal()).open, 'selector stays open')
      await closeModal()
    })

    await check(`[${role} 10] отказ без code → непроменено поведение (грешката остава в селектора)`, async () => {
      await call(page, (h: H) => h.clickGiftIcon('left'))
      await waitUntil(async () => (await modal()).pickIds.length > 0)
      await call(page, (h: H) => h.pickTableGift('gift-rose'))
      const send = (await sends()).at(-1)
      await call(page, (h: H, m: unknown) => h.injectServerMessage(m), {
        type: 'table_gift_send_result', roomId, requestId: send.args[3], ok: false, message: 'Нямаш достатъчно жълтици.',
      })
      await sleep(300)
      const info = await modal()
      assert(info.open && info.text.includes('Нямаш достатъчно жълтици.'), `modal=${JSON.stringify(info)}`)
      assert(!(await popup()).visible, 'no block popup')
      await closeModal()
    })

    await check(`[${role}] без page errors`, () => {
      assert(pageErrors.length === 0, pageErrors.join(' | '))
    })
    await context.close()
  }
} finally {
  await browser?.close().catch(() => undefined)
  await vite?.close().catch(() => undefined)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
